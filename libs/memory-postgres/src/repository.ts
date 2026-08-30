import {
  MemoryEventSchema,
  MemoryIdSchema,
  MemoryProposalSchema,
  MemorySourceRefSchema,
  MemoryWritePolicy,
  MemoryReducer,
  parseMemoryEvent,
  stableMemoryToken,
  type MemoryAuthorization,
  type MemoryConfirmation,
  type MemoryCorrectionInput,
  type MemoryDeleteInput,
  type MemoryEvent,
  type MemoryProposal,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryRepository,
  type MemoryWriteDecision,
  type SemanticMemoryQuery,
  type LearningThreadQuery,
} from "@cs-coach/memory";
import type { SqlExecutor, SqlResult } from "./executor";
import { withSqlTransaction } from "./executor";
import {
  MemoryRowValidationError,
  MemoryUserMismatchError,
  SemanticUnavailableError,
  VectorUnavailableError,
} from "./errors";
import {
  embeddingToVectorLiteral,
  validateEmbeddingInput,
  type MemoryEmbedding,
  type MemoryEmbeddingInput,
  MAX_EMBEDDING_DIMENSION,
} from "./embedding";
import { decodeJson, isObject, parseMemoryRow, parseSourceRef, parseThreadRow, type SqlRow } from "./row-validation";

const MAX_QUERY_LIMIT = 100;
const DEFAULT_MEMORY_PRUNE_BATCH = 100;
const MAX_MEMORY_PRUNE_BATCH = 1_000;
const AUTHORIZED_MEMORY_PREDICATE = "EXISTS (SELECT 1 FROM app_users AS authorized_user WHERE authorized_user.user_id = $1 AND authorized_user.memory_enabled = TRUE AND authorized_user.consent = 'GRANTED')";
// The deletion-only channel must remain available after a deployment flag is
// turned off.  `memory_enabled` is intentionally not part of this predicate:
// a previously persisted principal may have that compatibility bit cleared
// while its records still require privacy erasure.  Normal recall/write paths
// continue to use AUTHORIZED_MEMORY_PREDICATE, which still requires both the
// feature bit and GRANTED consent.
const DELETION_MEMORY_PREDICATE = "EXISTS (SELECT 1 FROM app_users AS authorized_user WHERE authorized_user.user_id = $1 AND authorized_user.consent IN ('GRANTED', 'REVOKED'))";
// A user-wide purge leaves a deletion generation on app_users. Normally every
// old current row is tombstoned in that same transaction; this predicate is a
// second retrieval guard for a partially materialized/racing row and allows
// only records written after an explicit later opt-in generation.
const RECORD_AFTER_DELETION_PREDICATE = "(memory_records.updated_at > COALESCE((SELECT authorized_user.memory_deleted_at FROM app_users AS authorized_user WHERE authorized_user.user_id = $1), '-infinity'::timestamptz))";
const ALIASED_RECORD_AFTER_DELETION_PREDICATE = "(r.updated_at > COALESCE((SELECT authorized_user.memory_deleted_at FROM app_users AS authorized_user WHERE authorized_user.user_id = $1), '-infinity'::timestamptz))";
const ACTIVE_MEMORY_STATUS_PREDICATE = "status IN ('OBSERVED', 'REPEATED', 'IMPROVING', 'STABLE', 'EMERGING', 'ACTIVE', 'CONFIRMED')";
const ALIASED_ACTIVE_MEMORY_STATUS_PREDICATE = "r.status IN ('OBSERVED', 'REPEATED', 'IMPROVING', 'STABLE', 'EMERGING', 'ACTIVE', 'CONFIRMED')";
// Keep an invalidated event parseable while removing proposal/correction
// content.  Opaque routing/idempotency fields are retained so a dead-letter
// row can still be audited without becoming a source of user text.  A
// SESSION_COMPLETED envelope has its own strict metadata payload; all other
// event types receive the bounded deletion marker.
const REDACTED_EVENT_PAYLOAD_SQL = `jsonb_strip_nulls(jsonb_build_object(
  'schemaVersion', 'memory-event.v1',
  'eventId', event_id,
  'type', event_type,
  'eventType', event_type,
  'userId', user_id,
  'sessionId', session_id,
  'demoContentHash', demo_content_hash,
  'proposalId', proposal_id,
  'targetMemoryId', target_memory_id,
  'operation', operation,
  'idempotencyKey', idempotency_key,
  'producerVersion', producer_version,
  'payload', CASE WHEN event_type = 'SESSION_COMPLETED'
    THEN jsonb_build_object('reason', 'SESSION_COMPLETED')
    ELSE jsonb_build_object('reason', 'MEMORY_DELETED') END,
  'createdAt', created_at::text
))`;

export interface MemoryObservationInput {
  readonly observationId?: string;
  readonly sessionId: string;
  readonly cueId: string;
  readonly taxonomyCode: string;
  readonly demoContentHash: string;
  readonly memoryId?: string;
  readonly sourceRef?: unknown;
  readonly payload?: unknown;
  readonly createdAt?: string;
}

export interface MemoryObservation {
  readonly userId: string;
  readonly observationId: string;
  readonly sessionId: string;
  readonly cueId: string;
  readonly taxonomyCode: string;
  readonly demoContentHash: string;
  readonly memoryId?: string;
  readonly sourceRef?: ReturnType<typeof parseSourceRef>;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface ObservationWriteResult {
  readonly inserted: boolean;
  readonly observation: MemoryObservation;
}

export interface AppendEventResult {
  readonly inserted: boolean;
  readonly event: MemoryEvent;
}

export interface PostgresMemoryRepositoryOptions {
  readonly executor: SqlExecutor;
  readonly now?: () => string;
  readonly reducer?: MemoryReducer;
  readonly policy?: MemoryWritePolicy;
  /** Set false when deployment intentionally has not run the optional vector migration. */
  readonly vectorAvailable?: boolean;
}

/**
 * Explicit, bounded retention controls for the PostgreSQL adapter.
 *
 * A cutoff is deliberately optional at the type level so callers can use a
 * shared options object, but `pruneMemory` is a no-op until one is supplied.
 * Accepted records, tombstones and current revisions are never selected by
 * this operation.
 */
export interface MemoryPruneOptions {
  readonly cutoff?: string;
  readonly maxCandidates?: number;
  readonly maxEvents?: number;
  readonly maxRevisions?: number;
}

export interface MemoryPruneResult {
  readonly candidateRecords: number;
  readonly events: number;
  readonly revisions: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function text(value: string, field: string, max = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`INVALID_${field.toUpperCase()}`);
  return normalized;
}

function scopedId(value: string, field: string): string {
  if (!MemoryIdSchema.safeParse(value).success) throw new Error(`INVALID_${field.toUpperCase()}`);
  return value.trim();
}

function boundedLimit(limit: number | undefined, fallback = MAX_QUERY_LIMIT): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit <= 0) return 1;
  return Math.min(limit, MAX_QUERY_LIMIT);
}

function pruneCutoff(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("INVALID_PRUNE_CUTOFF");
  const normalized = text(value, "prune_cutoff", 128);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new Error("INVALID_PRUNE_CUTOFF");
  return new Date(timestamp).toISOString();
}

function boundedPruneLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MEMORY_PRUNE_BATCH;
  if (!Number.isInteger(value) || value < 0) throw new Error("INVALID_PRUNE_LIMIT");
  return Math.min(value, MAX_MEMORY_PRUNE_BATCH);
}

function affectedRows(result: SqlResult | undefined): number {
  if (!result) return 0;
  if (result.rowCount !== undefined) return Math.max(0, Number(result.rowCount));
  return result.rows.length;
}

function postgresBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function asList<T>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

const FORBIDDEN_PERSISTED_KEYS = new Set([
  "rawDemo",
  "raw_demo",
  "frames",
  "ticks",
  "tickStream",
  "tick_stream",
  "fullReplay",
  "full_replay",
  "replay",
  "demoBytes",
  "demo_bytes",
  "cookie",
  "prompt",
  "chainOfThought",
  "chain_of_thought",
  "cot",
  "apiKey",
  "api_key",
  "secret",
]);

const MAX_PERSISTED_JSON_BYTES = 16 * 1024;
const MAX_PERSISTED_EVENT_BYTES = 32 * 1024;

function assertSafeJson(value: unknown, depth = 0, seen = new Set<unknown>()): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > 1_200) throw new Error("PERSISTED_TEXT_TOO_LONG");
    return;
  }
  if (seen.has(value)) throw new Error("PERSISTED_JSON_CYCLE");
  seen.add(value);
  if (depth > 5) throw new Error("PERSISTED_JSON_TOO_DEEP");
  if (Array.isArray(value)) {
    if (depth === 0) throw new Error("INVALID_PERSISTED_JSON");
    if (value.length > 64) throw new Error("PERSISTED_ARRAY_TOO_LONG");
    for (const item of value) assertSafeJson(item, depth + 1, seen);
    seen.delete(value);
    if (depth === 0 && JSON.stringify(value).length > MAX_PERSISTED_JSON_BYTES) throw new Error("PERSISTED_JSON_TOO_LARGE");
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PERSISTED_KEYS.has(key)) throw new Error(`FORBIDDEN_PERSISTED_FIELD:${key}`);
    assertSafeJson(child, depth + 1, seen);
  }
  seen.delete(value);
  if (depth === 0 && JSON.stringify(value).length > MAX_PERSISTED_JSON_BYTES) throw new Error("PERSISTED_JSON_TOO_LARGE");
}

function eventType(event: MemoryEvent): string {
  return (event.type ?? event.eventType) as string;
}

function requireUser(userId: string): string {
  return scopedId(userId, "user_id");
}

function parseEventRow(row: unknown, userId: string): MemoryEvent {
  if (!isObject(row)) throw new MemoryRowValidationError(userId, "PostgreSQL returned an invalid event row");
  const payload = decodeJson(row.event_payload ?? row.eventPayload ?? row.payload ?? row.event);
  const parsed = MemoryEventSchema.safeParse(payload);
  if (!parsed.success || parsed.data.userId !== userId) {
    throw new MemoryRowValidationError(userId, "PostgreSQL returned an invalid event envelope");
  }
  return parseMemoryEvent(parsed.data);
}

function parseObservationRow(row: unknown, userId: string): MemoryObservation {
  if (!isObject(row)) throw new MemoryRowValidationError(userId, "PostgreSQL returned an invalid observation row");
  const rowUserId = row.user_id ?? row.userId;
  if (rowUserId !== undefined && String(rowUserId) !== userId) {
    throw new MemoryRowValidationError(userId, "PostgreSQL observation row crossed the requested user boundary");
  }
  const sourceRaw = decodeJson(row.source_ref_json ?? row.sourceRef ?? row.source_ref);
  const sourceRef = sourceRaw === undefined || sourceRaw === null ? undefined : parseSourceRef(sourceRaw, userId);
  const payloadRaw = decodeJson(row.observation_payload ?? row.payload_json ?? row.payload) ?? {};
  if (!isObject(payloadRaw)) throw new MemoryRowValidationError(userId, "PostgreSQL returned an invalid observation payload");
  const createdAtValue = row.created_at ?? row.createdAt;
  const createdAt = createdAtValue instanceof Date ? createdAtValue.toISOString() : String(createdAtValue ?? "");
  if (!createdAt) throw new MemoryRowValidationError(userId, "PostgreSQL observation has no timestamp");
  return {
    userId,
    observationId: String(row.observation_id ?? row.observationId ?? ""),
    sessionId: String(row.session_id ?? row.sessionId ?? ""),
    cueId: String(row.cue_id ?? row.cueId ?? ""),
    taxonomyCode: String(row.taxonomy_code ?? row.taxonomyCode ?? ""),
    demoContentHash: String(row.demo_content_hash ?? row.demoContentHash ?? ""),
    ...(row.memory_id ?? row.memoryId ? { memoryId: String(row.memory_id ?? row.memoryId) } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    payload: payloadRaw,
    createdAt,
  };
}

function recordValues(record: MemoryRecord): readonly unknown[] {
  return [
    record.userId,
    record.memoryId,
    record.kind,
    record.source,
    record.scope,
    record.logicalKey,
    record.status,
    record.active,
    record.revision,
    record.content ?? null,
    record.summary ?? null,
    record.thread?.threadId ?? null,
    json(record.claims),
    record.verdict ? json(record.verdict) : null,
    record.transferRule ? json(record.transferRule) : null,
    record.preference ? json(record.preference) : null,
    json(record.facts),
    json(record.inferences),
    json(record.advice),
    json(record.evidence),
    json(record.sourceRefs),
    json(record.demoContentHashes),
    json(record.corrections),
    record.previousRevisionId ?? null,
    record.createdAt,
    record.updatedAt,
    record.confirmedAt ?? null,
    record.deletedAt ?? null,
    record.tombstone ? json(record.tombstone) : null,
    json(record.limitations),
    record.producerVersion,
    record.lastIdempotencyKey,
    json(record),
  ];
}

const UPSERT_MEMORY_SQL = `
INSERT INTO memory_records (
  user_id, memory_id, kind, source, scope, logical_key, status, active,
  revision, content, summary, thread_id, claims_json, verdict_json,
  transfer_rule_json, preference_json, facts_json, inferences_json,
  advice_json, evidence_json, source_refs_json, demo_content_hashes_json,
  corrections_json, previous_revision_id, created_at, updated_at, confirmed_at,
  deleted_at, tombstone_json, limitations_json, producer_version,
  last_idempotency_key, record_payload
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,
  $16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,
  $23::jsonb,$24,$25,$26,$27,$28,$29::jsonb,$30::jsonb,$31,$32,$33::jsonb
)
ON CONFLICT (user_id, memory_id) DO UPDATE SET
  kind=EXCLUDED.kind, source=EXCLUDED.source, scope=EXCLUDED.scope,
  logical_key=EXCLUDED.logical_key, status=EXCLUDED.status, active=EXCLUDED.active,
  revision=EXCLUDED.revision, content=EXCLUDED.content, summary=EXCLUDED.summary,
  thread_id=EXCLUDED.thread_id, claims_json=EXCLUDED.claims_json,
  verdict_json=EXCLUDED.verdict_json, transfer_rule_json=EXCLUDED.transfer_rule_json,
  preference_json=EXCLUDED.preference_json, facts_json=EXCLUDED.facts_json,
  inferences_json=EXCLUDED.inferences_json, advice_json=EXCLUDED.advice_json,
  evidence_json=EXCLUDED.evidence_json, source_refs_json=EXCLUDED.source_refs_json,
  demo_content_hashes_json=EXCLUDED.demo_content_hashes_json,
  corrections_json=EXCLUDED.corrections_json,
  previous_revision_id=EXCLUDED.previous_revision_id, created_at=EXCLUDED.created_at,
  updated_at=EXCLUDED.updated_at, confirmed_at=EXCLUDED.confirmed_at,
  deleted_at=EXCLUDED.deleted_at, tombstone_json=EXCLUDED.tombstone_json,
  limitations_json=EXCLUDED.limitations_json, producer_version=EXCLUDED.producer_version,
  last_idempotency_key=EXCLUDED.last_idempotency_key, record_payload=EXCLUDED.record_payload
`;

export class PostgresMemoryRepository implements MemoryRepository {
  private readonly executor: SqlExecutor;
  private readonly clock: () => string;
  private readonly reducer: MemoryReducer;
  private readonly policy: MemoryWritePolicy;
  private readonly vectorAvailable: boolean;

  constructor(options: PostgresMemoryRepositoryOptions);
  constructor(executor: SqlExecutor, options?: Omit<PostgresMemoryRepositoryOptions, "executor">);
  constructor(
    optionsOrExecutor: PostgresMemoryRepositoryOptions | SqlExecutor,
    overrides?: Omit<PostgresMemoryRepositoryOptions, "executor">,
  ) {
    const options: PostgresMemoryRepositoryOptions = "executor" in optionsOrExecutor
      ? optionsOrExecutor
      : { executor: optionsOrExecutor, ...(overrides ?? {}) };
    this.executor = options.executor;
    this.clock = options.now ?? nowIso;
    this.reducer = options.reducer ?? new MemoryReducer();
    this.policy = options.policy ?? new MemoryWritePolicy();
    this.vectorAvailable = options.vectorAvailable ?? true;
  }

  /**
   * Serialize writes for a logical aggregate even when the row does not yet
   * exist. `SELECT ... FOR UPDATE` cannot lock a missing row, so two first
   * observations would otherwise both compute revision 1 and one could lose
   * the other's Demo provenance. PostgreSQL's transaction-scoped advisory
   * lock gives us a stable, user-scoped lock without a second source table.
   */
  private async lockLogicalKey(executor: SqlExecutor, userId: string, logicalKey: string): Promise<void> {
    await executor.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
      [userId, logicalKey],
    );
  }

  private async assertAuthorization(executor: SqlExecutor, userId: string, allowRevokedForDelete = false): Promise<void> {
    const result = await executor.query<SqlRow>(
      "SELECT user_id, memory_enabled, consent FROM app_users WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    const row = result.rows[0];
    const consent = String(row?.consent ?? "");
    const memoryEnabled = postgresBoolean(row?.memory_enabled ?? row?.memoryEnabled);
    const consentAllowed = consent === "GRANTED" || (allowRevokedForDelete && consent === "REVOKED");
    // A privacy operation is allowed for either explicit consent state even
    // when the legacy memory_enabled bit is false.  This is what keeps
    // individual/delete-all erasure usable while MEMORY_ENABLED is off; no
    // non-delete operation passes allowRevokedForDelete.
    const deletionOnlyAllowed = allowRevokedForDelete && (consent === "GRANTED" || consent === "REVOKED");
    if (!row || (!memoryEnabled && !deletionOnlyAllowed) || !consentAllowed) {
      throw new Error("MEMORY_CONSENT_REVOKED");
    }
  }

  private async assertAfterUserDeletion(
    executor: SqlExecutor,
    userId: string,
    event: Pick<MemoryEvent, "createdAt"> & Partial<Pick<MemoryEvent, "type" | "eventType">>,
  ): Promise<void> {
    if ((event.type ?? event.eventType) === "MEMORY_DELETED") return;
    const result = await executor.query<{ memory_deleted_at?: string | Date | null }>(
      "SELECT memory_deleted_at FROM app_users WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    const marker = result.rows[0]?.memory_deleted_at;
    if (marker === undefined || marker === null) return;
    const markerMs = marker instanceof Date ? marker.getTime() : Date.parse(String(marker));
    const eventMs = Date.parse(event.createdAt);
    // A deletion marker is a fail-closed boundary. Do not let malformed
    // timestamps turn a late event into a fresh aggregate after purge. Trusted
    // producers use current ISO UTC timestamps; a future-clock/generation
    // proof remains a deployment-level limitation documented in the ADR.
    if (!Number.isFinite(markerMs) || !Number.isFinite(eventMs)) {
      throw new Error("MEMORY_DELETED_TOMBSTONE");
    }
    if (eventMs <= markerMs) {
      throw new Error("MEMORY_DELETED_TOMBSTONE");
    }
  }

  private async current(
    executor: SqlExecutor,
    userId: string,
    selector: { memoryId?: string; logicalKey?: string },
    forUpdate = false,
    requireAuthorization = false,
  ): Promise<MemoryRecord | undefined> {
    const value = selector.memoryId ?? selector.logicalKey;
    if (!value) return undefined;
    const field = selector.memoryId ? "memory_id" : "logical_key";
    const suffix = forUpdate ? " FOR UPDATE" : "";
    const authorization = requireAuthorization
      ? ` AND ${AUTHORIZED_MEMORY_PREDICATE} AND ${RECORD_AFTER_DELETION_PREDICATE}`
      : "";
    const result = await executor.query<SqlRow>(
      `SELECT record_payload, user_id FROM memory_records WHERE user_id = $1 AND ${field} = $2${authorization} LIMIT 1${suffix}`,
      [userId, value],
    );
    const row = result.rows[0];
    return row ? parseMemoryRow(row, userId) : undefined;
  }

  private async hasTombstone(executor: SqlExecutor, userId: string, logicalKey: string): Promise<boolean> {
    const result = await executor.query<SqlRow>(
      "SELECT user_id, memory_id FROM memory_tombstones WHERE user_id = $1 AND logical_key = $2 LIMIT 1",
      [userId, logicalKey],
    );
    return result.rows.length > 0;
  }

  private async receipt(executor: SqlExecutor, userId: string, idempotencyKey: string): Promise<MemoryRecord | undefined> {
    const result = await executor.query<SqlRow>(
      "SELECT result_payload, user_id FROM memory_write_receipts WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1",
      [userId, idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const payload = decodeJson(row.result_payload ?? row.resultPayload);
    if (payload === null || payload === undefined) return undefined;
    return parseMemoryRow({ record_payload: payload, user_id: userId }, userId);
  }

  async getMemoryVersion(userIdInput: string, memoryIdInput?: string): Promise<number> {
    const userId = requireUser(userIdInput);
    const memoryId = memoryIdInput === undefined ? undefined : scopedId(memoryIdInput, "memory_id");
    const result = await this.executor.query<{ version: number | string | null }>(
      memoryId
        ? "SELECT COALESCE(MAX(revision), 0) AS version FROM memory_records WHERE user_id = $1 AND memory_id = $2"
        : "SELECT COALESCE(MAX(revision), 0) AS version FROM memory_records WHERE user_id = $1",
      memoryId ? [userId, memoryId] : [userId],
    );
    return Number(result.rows[0]?.version ?? 0);
  }

  async getRecordVersion(userIdInput: string, memoryIdInput: string, revision?: number, allowRevokedForDeletion = false): Promise<MemoryRecord | undefined> {
    const userId = requireUser(userIdInput);
    const memoryId = scopedId(memoryIdInput, "memory_id");
    const authorizationPredicate = allowRevokedForDeletion ? DELETION_MEMORY_PREDICATE : AUTHORIZED_MEMORY_PREDICATE;
    const result = revision === undefined
      ? await this.executor.query<SqlRow>(
          `SELECT record_payload, user_id FROM memory_records WHERE user_id = $1 AND memory_id = $2 AND ${authorizationPredicate}${allowRevokedForDeletion ? "" : ` AND ${RECORD_AFTER_DELETION_PREDICATE}`} LIMIT 1`,
          [userId, memoryId],
        )
      : await this.executor.query<SqlRow>(
          `SELECT record_payload, user_id FROM memory_record_revisions WHERE user_id = $1 AND memory_id = $2 AND revision = $3 AND ${AUTHORIZED_MEMORY_PREDICATE} LIMIT 1`,
          [userId, memoryId, revision],
        );
    const row = result.rows[0];
    return row ? parseMemoryRow(row, userId) : undefined;
  }

  async getPreferences(userIdInput: string): Promise<readonly MemoryRecord[]> {
    const userId = requireUser(userIdInput);
    const result = await this.executor.query<SqlRow>(
      `SELECT record_payload, user_id FROM memory_records WHERE user_id = $1 AND ${AUTHORIZED_MEMORY_PREDICATE} AND ${RECORD_AFTER_DELETION_PREDICATE} AND kind = ANY($2::text[]) AND status <> 'DELETED' ORDER BY updated_at DESC, memory_id LIMIT $3`,
      [userId, ["PREFERENCE", "COACHING_PREFERENCE"], MAX_QUERY_LIMIT],
    );
    return result.rows.map((row) => parseMemoryRow(row, userId));
  }

  async findByLogicalKey(userIdInput: string, logicalKeyInput: string): Promise<MemoryRecord | undefined> {
    const userId = requireUser(userIdInput);
    const logicalKey = scopedId(logicalKeyInput, "logical_key");
    return this.current(this.executor, userId, { logicalKey }, false, true);
  }

  async appendEventDetailed(userIdInput: string, eventInput: MemoryEvent): Promise<AppendEventResult> {
    const userId = requireUser(userIdInput);
    const parsed = MemoryEventSchema.parse(eventInput) as unknown as MemoryEvent;
    if (parsed.userId !== userId) throw new MemoryUserMismatchError();
    const eventId = scopedId(parsed.eventId, "event_id");
    const idempotencyKey = scopedId(parsed.idempotencyKey, "idempotency_key");
    const payload = json(parsed);
    if (new TextEncoder().encode(payload).byteLength > MAX_PERSISTED_EVENT_BYTES) throw new Error("MEMORY_EVENT_TOO_LARGE");
    // Event append is itself an authorization boundary.  Locking the
    // principal row in the same transaction makes a concurrent consent
    // revoke linearizable: either the append commits before the revoke, or
    // it observes REVOKED and writes nothing.  Deletion is the sole operation
    // permitted for a revoked principal so the privacy channel remains open.
    const allowRevokedForDelete = eventType(parsed) === "MEMORY_DELETED" || parsed.operation === "DELETE";
    return withSqlTransaction(this.executor, async (tx) => {
      await this.assertAuthorization(tx, userId, allowRevokedForDelete);
      await this.assertAfterUserDeletion(tx, userId, parsed);
      const managementOperation = parsed.operation === "CORRECT" || parsed.operation === "CONFIRM" || parsed.operation === "DELETE";
      if (managementOperation) {
        if (!parsed.targetMemoryId) throw new Error("MEMORY_MANAGEMENT_TARGET_REQUIRED");
        const target = await tx.query<{ status?: string; user_id?: string }>(
          "SELECT status, user_id FROM memory_records WHERE user_id = $1 AND memory_id = $2 FOR UPDATE",
          [userId, parsed.targetMemoryId],
        );
        if (!target.rows[0]) throw new Error("MEMORY_MANAGEMENT_TARGET_NOT_FOUND");
        if (String(target.rows[0].user_id ?? userId) !== userId) {
          throw new MemoryRowValidationError(userId, "PostgreSQL management target crossed the requested user boundary");
        }
        if (target.rows[0].status === "DELETED" && parsed.operation !== "DELETE") {
          throw new Error("MEMORY_DELETED_TOMBSTONE");
        }
      }
      if (!allowRevokedForDelete) {
        // Reject late correction/diagnosis payloads before they enter the
        // durable event log.  A tombstone is a privacy boundary, not merely
        // a projection status; retaining an old correction body in
        // memory_events would make a deleted user's text recoverable.
        if (parsed.targetMemoryId) {
          const target = await tx.query<{ status?: string; user_id?: string }>(
            "SELECT status, user_id FROM memory_records WHERE user_id = $1 AND memory_id = $2 FOR UPDATE",
            [userId, parsed.targetMemoryId],
          );
          if (target.rows[0]?.status === "DELETED") throw new Error("MEMORY_DELETED_TOMBSTONE");
        }
        const payloadObject = parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
          ? parsed.payload as Record<string, unknown>
          : undefined;
        const proposalCandidate = payloadObject?.proposal && typeof payloadObject.proposal === "object" && !Array.isArray(payloadObject.proposal)
          ? payloadObject.proposal as Record<string, unknown>
          : payloadObject;
        const logicalKey = typeof proposalCandidate?.logicalKey === "string" ? proposalCandidate.logicalKey : undefined;
        if (logicalKey) {
          const tombstone = await tx.query<{ memory_id?: string; user_id?: string }>(
            "SELECT memory_id, user_id FROM memory_tombstones WHERE user_id = $1 AND logical_key = $2 LIMIT 1",
            [userId, logicalKey],
          );
          if (tombstone.rows[0]) throw new Error("MEMORY_DELETED_TOMBSTONE");
        }
      }
      const result = await tx.query<SqlRow>(
        `INSERT INTO memory_events (
          user_id, event_id, session_id, demo_content_hash, proposal_id,
          target_memory_id, event_type, operation, idempotency_key,
          producer_version, event_payload, attempt_count, next_attempt_at,
          status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
        ON CONFLICT DO NOTHING
        RETURNING event_payload, user_id, TRUE AS inserted`,
        [
          userId,
          eventId,
          parsed.sessionId,
          parsed.demoContentHash ?? null,
          parsed.proposalId ?? null,
          parsed.targetMemoryId ?? null,
          eventType(parsed),
          parsed.operation ?? null,
          idempotencyKey,
          parsed.producerVersion,
          payload,
          parsed.attemptCount ?? 0,
          parsed.nextAttemptAt ?? null,
          "POSTED",
          parsed.createdAt,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        // Both event_id and idempotency_key are uniqueness boundaries. Read the
        // exact conflicting row back without ever widening the user scope.
        const existingByEvent = await tx.query<SqlRow>(
          "SELECT event_payload, user_id FROM memory_events WHERE user_id = $1 AND event_id = $2 LIMIT 1",
          [userId, eventId],
        );
        const existingRow = existingByEvent.rows[0] ?? (await tx.query<SqlRow>(
          "SELECT event_payload, user_id FROM memory_events WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1",
          [userId, idempotencyKey],
        )).rows[0];
        if (!existingRow) throw new Error("EVENT_INSERT_DID_NOT_RETURN_ROW");
        return { inserted: false, event: parseEventRow(existingRow, userId) };
      }
      return {
        inserted: row.inserted !== false && row.inserted !== "false",
        event: parseEventRow(row, userId),
      };
    });
  }

  async appendEvent(userId: string, event: MemoryEvent): Promise<MemoryEvent> {
    return (await this.appendEventDetailed(userId, event)).event;
  }

  async markEventConsumed(userIdInput: string, eventIdInput: string, consumedAt = this.clock()): Promise<void> {
    const userId = requireUser(userIdInput);
    const eventId = scopedId(eventIdInput, "event_id");
    await this.executor.query(
      `UPDATE memory_events
          SET status = 'CONSUMED', consumed_at = $3, next_attempt_at = NULL
          WHERE user_id = $1 AND event_id = $2 AND status <> 'DEAD_LETTER'`,
      [userId, eventId, consumedAt],
    );
  }

  async markEventFailed(
    userIdInput: string,
    eventIdInput: string,
    options: { terminal?: boolean; nextAttemptAt?: string; errorCode?: string } = {},
  ): Promise<void> {
    const userId = requireUser(userIdInput);
    const eventId = scopedId(eventIdInput, "event_id");
    const errorCode = options.errorCode ? text(options.errorCode, "event_error_code", 80) : null;
    await this.executor.query(
      `UPDATE memory_events
          SET status = CASE WHEN $3::boolean THEN 'DEAD_LETTER' ELSE 'RETRY' END,
              attempt_count = LEAST(attempt_count + 1, 100),
              next_attempt_at = $4,
              last_error_code = $5
        WHERE user_id = $1 AND event_id = $2 AND status NOT IN ('CONSUMED', 'DEAD_LETTER')`,
      [userId, eventId, options.terminal === true, options.nextAttemptAt ?? null, errorCode],
    );
  }

  /**
   * Apply an explicit, bounded retention pass for one user.
   *
   * This is intentionally never called from normal reads or writes. Without a
   * cutoff there is no SQL at all, which keeps retention opt-in and prevents a
   * malformed/default job from becoming a destructive full-table cleanup.
   * Candidate payloads are compacted while their current key/revision row is
   * retained. Removing a candidate row would let a late event recreate the
   * same logical key as a new aggregate, so this pass intentionally never
   * deletes from memory_records. Event cleanup is limited to terminal rows;
   * revision cleanup always preserves the current revision. Tombstones and
   * active current records are not selected by any statement.
   */
  async pruneMemory(userIdInput: string, options: MemoryPruneOptions = {}): Promise<MemoryPruneResult> {
    const userId = requireUser(userIdInput);
    const cutoff = pruneCutoff(options.cutoff);
    const empty: MemoryPruneResult = { candidateRecords: 0, events: 0, revisions: 0 };
    if (!cutoff) return empty;

    const candidateLimit = boundedPruneLimit(options.maxCandidates);
    const eventLimit = boundedPruneLimit(options.maxEvents);
    const revisionLimit = boundedPruneLimit(options.maxRevisions);

    return withSqlTransaction(this.executor, async (tx) => {
      const candidateResult = candidateLimit === 0
        ? undefined
        : await tx.query(
            `WITH candidate_rows AS (
               SELECT memory_id
                 FROM memory_records
                WHERE user_id = $1
                  AND status = 'CANDIDATE'
                  AND active = FALSE
                  AND updated_at < $2
                ORDER BY updated_at ASC, memory_id ASC
               LIMIT $3
             )
             UPDATE memory_records AS memory
                SET content = NULL,
                    summary = NULL,
                    thread_id = NULL,
                    claims_json = '[]'::jsonb,
                    verdict_json = NULL,
                    transfer_rule_json = NULL,
                    preference_json = NULL,
                    facts_json = '[]'::jsonb,
                    inferences_json = '[]'::jsonb,
                    advice_json = '[]'::jsonb,
                    evidence_json = '[]'::jsonb,
                    source_refs_json = '[]'::jsonb,
                    demo_content_hashes_json = '[]'::jsonb,
                    corrections_json = '[]'::jsonb,
                    previous_revision_id = NULL,
                    limitations_json = jsonb_build_array(
                      'Candidate payload pruned; logical key retained to prevent late-event resurrection.'
                    ),
                    updated_at = $2,
                    record_payload = jsonb_build_object(
                      'schemaVersion', 'memory-record.v1',
                      'memoryId', memory.memory_id,
                      'userId', memory.user_id,
                      'kind', memory.kind,
                      'source', memory.source,
                      'scope', memory.scope,
                      'logicalKey', memory.logical_key,
                      'status', 'CANDIDATE',
                      'active', FALSE,
                      'revision', memory.revision,
                      'claims', '[]'::jsonb,
                      'facts', '[]'::jsonb,
                      'inferences', '[]'::jsonb,
                      'advice', '[]'::jsonb,
                      'evidence', '[]'::jsonb,
                      'sourceRefs', '[]'::jsonb,
                      'demoContentHashes', '[]'::jsonb,
                      'corrections', '[]'::jsonb,
                      'occurrenceCount', 0,
                      'successfulApplicationCount', 0,
                      'conflictingApplicationCount', 0,
                      'createdAt', memory.record_payload->'createdAt',
                      'updatedAt', to_jsonb($2::text),
                      'limitations', jsonb_build_array(
                        'Candidate payload pruned; logical key retained to prevent late-event resurrection.'
                      ),
                      'producerVersion', memory.producer_version,
                      'lastIdempotencyKey', memory.last_idempotency_key
                    )
              FROM candidate_rows
             WHERE memory.user_id = $1
               AND memory.memory_id = candidate_rows.memory_id
             RETURNING memory.memory_id`,
            [userId, cutoff, candidateLimit],
          );

      const eventResult = eventLimit === 0
        ? undefined
        : await tx.query(
            `WITH event_rows AS (
               SELECT event_id
                 FROM memory_events
                WHERE user_id = $1
                  AND status IN ('CONSUMED', 'DEAD_LETTER')
                  AND created_at < $2
                ORDER BY created_at ASC, event_id ASC
                LIMIT $3
             )
             DELETE FROM memory_events AS memory_event
              USING event_rows
              WHERE memory_event.user_id = $1
                AND memory_event.event_id = event_rows.event_id
             RETURNING memory_event.event_id`,
            [userId, cutoff, eventLimit],
          );

      const revisionResult = revisionLimit === 0
        ? undefined
        : await tx.query(
            `WITH revision_rows AS (
               SELECT old_revision.user_id, old_revision.memory_id, old_revision.revision
                 FROM memory_record_revisions AS old_revision
                 INNER JOIN memory_records AS current_memory
                   ON current_memory.user_id = old_revision.user_id
                  AND current_memory.memory_id = old_revision.memory_id
                WHERE old_revision.user_id = $1
                  AND current_memory.user_id = $1
                  AND old_revision.created_at < $2
                  AND old_revision.revision < current_memory.revision
                ORDER BY old_revision.created_at ASC,
                         old_revision.memory_id ASC,
                         old_revision.revision ASC
                LIMIT $3
             )
             DELETE FROM memory_record_revisions AS old_revision
              USING revision_rows
              WHERE old_revision.user_id = $1
                AND old_revision.memory_id = revision_rows.memory_id
                AND old_revision.revision = revision_rows.revision
             RETURNING old_revision.memory_id, old_revision.revision`,
            [userId, cutoff, revisionLimit],
          );

      return {
        candidateRecords: affectedRows(candidateResult),
        events: affectedRows(eventResult),
        revisions: affectedRows(revisionResult),
      };
    });
  }

  private async saveRecord(executor: SqlExecutor, record: MemoryRecord, proposal: MemoryProposal): Promise<void> {
    await executor.query(UPSERT_MEMORY_SQL, recordValues(record));
    if (record.status === "DELETED") {
      // A user deletion is a data-erasure boundary. Keep the minimal current
      // tombstone, but remove old revision payloads and denormalized preference
      // rows so deleted content cannot be recovered through a side table.
      // The reduced tombstone deliberately clears sourceRefs. Use the
      // pre-delete proposal provenance as the fallback so observations that
      // were written with memory_id=NULL but only a source_ref_json are erased
      // by an individual delete as well.
      const deletionSourceRefs = record.sourceRefs.length > 0
        ? record.sourceRefs
        : proposal.origin.typedSourceRefs;
      await executor.query(
        "DELETE FROM memory_record_revisions WHERE user_id = $1 AND memory_id = $2",
        [record.userId, record.memoryId],
      );
      await executor.query(
        "DELETE FROM memory_evidence_refs WHERE user_id = $1 AND memory_id = $2",
        [record.userId, record.memoryId],
      );
      await executor.query(
        `DELETE FROM memory_observations
          WHERE user_id = $1
            AND (
              memory_id = $2
              OR observation_payload->>'memoryId' = $2
              OR observation_payload->>'logicalKey' = $3
              OR observation_payload->'proposal'->>'memoryId' = $2
              OR observation_payload->'proposal'->>'logicalKey' = $3
              OR EXISTS (
                SELECT 1
                 FROM jsonb_array_elements($4::jsonb) AS source_ref
                 WHERE (source_ref_json IS NOT NULL
                   AND source_ref_json->>'sessionId' = source_ref->>'sessionId'
                   AND source_ref_json->>'cueId' = source_ref->>'cueId'
                   AND source_ref_json->>'demoContentHash' = source_ref->>'demoContentHash')
                    OR (session_id = source_ref->>'sessionId'
                   AND cue_id = source_ref->>'cueId'
                   AND demo_content_hash = source_ref->>'demoContentHash')
              )
            )`,
        [record.userId, record.memoryId, record.logicalKey, json(deletionSourceRefs)],
      );
      await executor.query(
        "DELETE FROM learning_threads WHERE user_id = $1 AND memory_id = $2",
        [record.userId, record.memoryId],
      );
      await executor.query(
        "DELETE FROM memory_write_receipts WHERE user_id = $1 AND memory_id = $2",
        [record.userId, record.memoryId],
      );
      // Keep only a minimal, parseable event envelope for idempotency/audit.
      // The old proposal/body may contain user text; retaining it would make
      // a successful deletion recoverable through the event log.
      await executor.query(
        `UPDATE memory_events
            SET event_payload = ${REDACTED_EVENT_PAYLOAD_SQL}
          WHERE user_id = $1
            AND (
              target_memory_id = $2
              OR event_payload->>'targetMemoryId' = $2
              OR event_payload->>'memoryId' = $2
              OR event_payload->>'logicalKey' = $3
              OR event_payload->'proposal'->>'targetMemoryId' = $2
              OR event_payload->'proposal'->>'logicalKey' = $3
              OR event_payload->'payload'->>'targetMemoryId' = $2
              OR event_payload->'payload'->>'logicalKey' = $3
              OR event_payload->'payload'->'proposal'->>'targetMemoryId' = $2
              OR event_payload->'payload'->'proposal'->>'logicalKey' = $3
            )`,
        [record.userId, record.memoryId, record.logicalKey],
      );
      const preferenceKey = proposal.preference?.key;
      if (preferenceKey) {
        await executor.query(
          "DELETE FROM user_preferences WHERE user_id = $1 AND preference_key = $2",
          [record.userId, preferenceKey],
        );
      }
    }
    await executor.query(
      `INSERT INTO memory_record_revisions (user_id, memory_id, revision, record_payload, created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (user_id, memory_id, revision) DO NOTHING`,
      [record.userId, record.memoryId, record.revision, json(record), record.updatedAt],
    );

    if (record.thread) {
      await executor.query(
        `INSERT INTO learning_threads
          (user_id, memory_id, thread_id, logical_key, status, active, revision, thread_payload, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT (user_id, thread_id) DO UPDATE SET
           memory_id=EXCLUDED.memory_id, logical_key=EXCLUDED.logical_key,
           status=EXCLUDED.status, active=EXCLUDED.active, revision=EXCLUDED.revision,
           thread_payload=EXCLUDED.thread_payload, updated_at=EXCLUDED.updated_at`,
        [
          record.userId,
          record.memoryId,
          record.thread.threadId,
          record.logicalKey,
          record.status,
          record.active,
          record.revision,
          json(record.thread),
          record.updatedAt,
        ],
      );
    }

    for (const ref of record.evidence) {
      await executor.query(
        `INSERT INTO memory_evidence_refs
          (user_id, memory_id, namespace, ref_id, demo_content_hash, session_id, cue_id, source_ref_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT (user_id, memory_id, namespace, ref_id, demo_content_hash) DO NOTHING`,
        [record.userId, record.memoryId, ref.namespace, ref.refId, ref.demoContentHash, ref.sessionId, ref.cueId, json(ref), record.updatedAt],
      );
    }

    if (record.preference) {
      await executor.query(
        `INSERT INTO user_preferences (user_id, preference_key, value_json, source, refs_json, label, updated_at)
         VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7)
         ON CONFLICT (user_id, preference_key) DO UPDATE SET
           value_json=EXCLUDED.value_json, source=EXCLUDED.source, refs_json=EXCLUDED.refs_json,
           label=EXCLUDED.label, updated_at=EXCLUDED.updated_at`,
        [record.userId, record.preference.key, json(record.preference.value), record.preference.source, json(record.preference.refs), record.preference.label ?? null, record.updatedAt],
      );
    }

    if (record.status === "DELETED" && record.tombstone) {
      await executor.query(
        `INSERT INTO memory_tombstones
          (user_id, memory_id, logical_key, deleted_revision, deleted_at, deleted_by, reason, last_idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id, memory_id) DO NOTHING`,
        [record.userId, record.memoryId, record.logicalKey, record.revision, record.deletedAt ?? record.updatedAt, record.tombstone.deletedBy, record.tombstone.reason ?? null, record.lastIdempotencyKey],
      );
      // The vector index is derived and optional. Probe its relation before
      // issuing the UPDATE: PostgreSQL marks the whole transaction aborted on
      // a 42P01 missing-table error, so catching a direct UPDATE exception
      // would still roll back the otherwise valid core tombstone.
      const vectorTable = await executor.query<{ table_name?: unknown }>(
        "SELECT to_regclass('memory_embeddings_v1') AS table_name",
      );
      if (vectorTable.rows[0]?.table_name) {
        await executor.query(
          "UPDATE memory_embeddings_v1 SET deleted_at = $3, updated_at = $3 WHERE user_id = $1 AND memory_id = $2",
          [record.userId, record.memoryId, record.deletedAt ?? record.updatedAt],
        );
      }
    }

    // `proposal` is intentionally accepted here so the call site cannot
    // forget that the receipt belongs to the exact proposal idempotency key.
    await executor.query(
      `INSERT INTO memory_write_receipts (user_id, idempotency_key, memory_id, revision, result_payload, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
      [record.userId, proposal.idempotencyKey, record.memoryId, record.revision, json(record), record.updatedAt],
    );
  }

  async applyWriteDecision(userIdInput: string, decisionInput: MemoryWriteDecision): Promise<MemoryRecord | undefined> {
    const userId = requireUser(userIdInput);
    if (decisionInput.userId !== userId || decisionInput.proposal.userId !== userId) throw new MemoryUserMismatchError();
    const proposal = MemoryProposalSchema.parse(decisionInput.proposal) as unknown as MemoryProposal;
    const idempotencyKey = scopedId(decisionInput.idempotencyKey, "idempotency_key");
    if (decisionInput.targetMemoryId && proposal.targetMemoryId && decisionInput.targetMemoryId !== proposal.targetMemoryId) {
      throw new Error("MEMORY_TARGET_MISMATCH");
    }
    return withSqlTransaction(this.executor, async (tx) => {
      await this.assertAuthorization(tx, userId, proposal.operation === "DELETE" || proposal.eventType === "MEMORY_DELETED");
      await this.assertAfterUserDeletion(tx, userId, {
        type: proposal.eventType,
        eventType: proposal.eventType,
        createdAt: proposal.createdAt,
      });
      await this.lockLogicalKey(tx, userId, proposal.logicalKey);
      const current = await this.current(
        tx,
        userId,
        decisionInput.targetMemoryId ? { memoryId: decisionInput.targetMemoryId } : { logicalKey: proposal.logicalKey },
        true,
      );
      if (current && current.logicalKey !== proposal.logicalKey) {
        throw new Error("MEMORY_TARGET_LOGICAL_KEY_MISMATCH");
      }
      if (current?.status === "DELETED") return current;
      const tombstoned = !current && await this.hasTombstone(tx, userId, proposal.logicalKey);
      if (tombstoned) return undefined;
      // A target ID is an update/correction selector, never permission to
      // create a new aggregate under an arbitrary ID. Reject a missing target
      // before the UPSERT path can create or overwrite another logical key.
      if (decisionInput.targetMemoryId && !current) return undefined;
      const receipt = await this.receipt(tx, userId, idempotencyKey);
      if (receipt) return receipt;
      if (!decisionInput.accepted) return current;

      const domainDecision = this.policy.decide({ proposal, current, eventType: proposal.eventType });
      if (!domainDecision.accepted) return current;
      const effectiveDecision: MemoryWriteDecision = {
        ...domainDecision,
        targetMemoryId: current?.memoryId ?? decisionInput.targetMemoryId,
        revision: (current?.revision ?? 0) + 1,
      };
      const reduced = this.reducer.reduce({
        userId,
        proposal,
        decision: effectiveDecision,
        current,
        now: this.clock(),
      });
      if (!reduced) return current;
      const parsedRecord = parseMemoryRow({ record_payload: reduced, user_id: userId }, userId);
      await this.saveRecord(tx, parsedRecord, proposal);
      return parsedRecord;
    });
  }

  private queryConditions(userId: string, query: MemoryQuery | undefined, alias = ""): { where: string[]; values: unknown[] } {
    const prefix = alias ? `${alias}.` : "";
    const where = [`${prefix}user_id = $1`];
    const values: unknown[] = [userId];
    if (!query?.includeDeleted) where.push(`${prefix}status <> 'DELETED'`);
    if (query?.activeOnly) {
      where.push(`${prefix}active = TRUE`);
      where.push(prefix ? ALIASED_ACTIVE_MEMORY_STATUS_PREDICATE : ACTIVE_MEMORY_STATUS_PREDICATE);
    }
    const kinds = asList(query?.kind);
    if (kinds?.length) {
      values.push(kinds);
      where.push(`${prefix}kind = ANY($${values.length}::text[])`);
    }
    const statuses = asList(query?.status);
    if (statuses?.length) {
      values.push(statuses);
      where.push(`${prefix}status = ANY($${values.length}::text[])`);
    }
    if (query?.logicalKey) {
      values.push(query.logicalKey);
      where.push(`${prefix}logical_key = $${values.length}`);
    }
    if (query?.cursor) {
      values.push(query.cursor);
      where.push(`${prefix}memory_id > $${values.length}`);
    }
    if (query?.taxonomyCode) {
      values.push(query.taxonomyCode);
      where.push(`${prefix}record_payload->'thread'->>'hingeCode' = $${values.length}`);
    }
    if (query?.hingeCode) {
      values.push(query.hingeCode);
      where.push(`${prefix}record_payload->'thread'->>'hingeCode' = $${values.length}`);
    }
    if (query?.mapName) {
      values.push(query.mapName);
      where.push(`${prefix}record_payload->'scopeContext'->>'mapName' = $${values.length}`);
    }
    if (query?.side) {
      values.push(query.side);
      where.push(`${prefix}record_payload->'scopeContext'->>'side' = $${values.length}`);
    }
    if (query?.roleCode) {
      values.push(query.roleCode);
      where.push(`${prefix}record_payload->'scopeContext'->>'roleCode' = $${values.length}`);
    }
    if (query?.userGoal) {
      values.push(query.userGoal);
      where.push(`${prefix}record_payload->'thread'->'userModel'->>'goal' ILIKE '%' || $${values.length} || '%'`);
    }
    if (query?.since) {
      values.push(query.since);
      where.push(`${prefix}updated_at >= $${values.length}`);
    }
    if (query?.minConfidence !== undefined) {
      values.push(query.minConfidence);
      where.push(`GREATEST(COALESCE((${prefix}record_payload->'thread'->'diagnosis'->>'confidence')::double precision, 0), COALESCE((${prefix}record_payload->'thread'->'transferRule'->>'confidence')::double precision, 0), COALESCE((${prefix}record_payload->'verdict'->>'confidence')::double precision, 0)) >= $${values.length}`);
    }
    return { where, values };
  }

  async retrieveStructured(userIdInput: string, query?: MemoryQuery): Promise<readonly MemoryRecord[]> {
    const userId = requireUser(userIdInput);
    const { where, values } = this.queryConditions(userId, query);
    where.push(AUTHORIZED_MEMORY_PREDICATE);
    where.push(RECORD_AFTER_DELETION_PREDICATE);
    values.push(boundedLimit(query?.limit));
    const result = await this.executor.query<SqlRow>(
      `SELECT record_payload, user_id FROM memory_records WHERE ${where.join(" AND ")}
       ORDER BY updated_at DESC, memory_id ASC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => parseMemoryRow(row, userId));
  }

  async retrieveSemantic(userIdInput: string, query: SemanticMemoryQuery): Promise<readonly MemoryRecord[]> {
    const userId = requireUser(userIdInput);
    if (!this.vectorAvailable) throw new SemanticUnavailableError("Optional semantic index is disabled");
    if (!query.embedding || query.embedding.length === 0) {
      throw new SemanticUnavailableError("Semantic recall requires an embedding supplied by the embedding provider");
    }
    if (query.embedding.length > MAX_EMBEDDING_DIMENSION || !query.embedding.every((value) => Number.isFinite(value))) {
      throw new SemanticUnavailableError("Semantic recall received an invalid embedding");
    }
    const vector = embeddingToVectorLiteral(query.embedding);
    const where = [
      "r.user_id = $1",
      "e.user_id = $1",
      AUTHORIZED_MEMORY_PREDICATE,
      ALIASED_RECORD_AFTER_DELETION_PREDICATE,
      "e.deleted_at IS NULL",
      "e.source_revision = r.revision",
    ];
    if (!query.includeDeleted) where.push("r.status <> 'DELETED'");
    if (query.activeOnly) {
      where.push("r.active = TRUE");
      where.push(ALIASED_ACTIVE_MEMORY_STATUS_PREDICATE);
    }
    const values: unknown[] = [userId, vector];
    if (query.kind) {
      const kinds = asList(query.kind);
      values.push(kinds);
      where.push(`r.kind = ANY($${values.length}::text[])`);
    }
    if (query.status) {
      const statuses = asList(query.status);
      values.push(statuses);
      where.push(`r.status = ANY($${values.length}::text[])`);
    }
    if (query.logicalKey) {
      values.push(query.logicalKey);
      where.push(`r.logical_key = $${values.length}`);
    }
    if (query.taxonomyCode) {
      values.push(query.taxonomyCode);
      where.push(`r.record_payload->'thread'->>'hingeCode' = $${values.length}`);
    }
    if (query.hingeCode) {
      values.push(query.hingeCode);
      where.push(`r.record_payload->'thread'->>'hingeCode' = $${values.length}`);
    }
    if (query.mapName) {
      values.push(query.mapName);
      where.push(`r.record_payload->'scopeContext'->>'mapName' = $${values.length}`);
    }
    if (query.side) {
      values.push(query.side);
      where.push(`r.record_payload->'scopeContext'->>'side' = $${values.length}`);
    }
    if (query.roleCode) {
      values.push(query.roleCode);
      where.push(`r.record_payload->'scopeContext'->>'roleCode' = $${values.length}`);
    }
    if (query.userGoal) {
      values.push(query.userGoal);
      where.push(`r.record_payload->'thread'->'userModel'->>'goal' ILIKE '%' || $${values.length} || '%'`);
    }
    if (query.since) {
      values.push(query.since);
      where.push(`r.updated_at >= $${values.length}`);
    }
    if (query.minConfidence !== undefined) {
      values.push(query.minConfidence);
      where.push(`GREATEST(COALESCE((r.record_payload->'thread'->'diagnosis'->>'confidence')::double precision, 0), COALESCE((r.record_payload->'thread'->'transferRule'->>'confidence')::double precision, 0), COALESCE((r.record_payload->'verdict'->>'confidence')::double precision, 0)) >= $${values.length}`);
    }
    const scorePosition = values.length + 1;
    if (query.minScore !== undefined) {
      values.push(query.minScore);
      where.push(`(1 - (e.embedding <=> $2::vector)) >= $${scorePosition}`);
    }
    values.push(boundedLimit(query.limit));
    const limitPosition = values.length;
    try {
      const result = await this.executor.query<SqlRow>(
        `SELECT r.record_payload, r.user_id,
                (1 - (e.embedding <=> $2::vector)) AS score
           FROM memory_records r
           INNER JOIN memory_embeddings_v1 e
             ON e.user_id = r.user_id AND e.memory_id = r.memory_id
          WHERE ${where.join(" AND ")}
          ORDER BY e.embedding <=> $2::vector ASC, r.updated_at DESC
          LIMIT $${limitPosition}`,
        values,
      );
      return result.rows.map((row) => parseMemoryRow(row, userId));
    } catch (error) {
      if (error instanceof MemoryRowValidationError) throw error;
      throw new SemanticUnavailableError("Optional semantic memory search is unavailable", { cause: error });
    }
  }

  async getLearningThreads(userIdInput: string, query?: LearningThreadQuery): Promise<readonly NonNullable<MemoryRecord["thread"]>[]> {
    const userId = requireUser(userIdInput);
    const where = ["t.user_id = $1", "r.user_id = $1", "r.memory_id = t.memory_id", AUTHORIZED_MEMORY_PREDICATE, ALIASED_RECORD_AFTER_DELETION_PREDICATE];
    const values: unknown[] = [userId];
    if (!query?.includeDeleted) where.push("r.status NOT IN ('DELETED', 'DISPUTED', 'SUPERSEDED', 'ARCHIVED', 'RESOLVED')");
    if (!query?.includeCandidates) where.push("t.active = TRUE");
    if (query?.activeOnly) where.push("t.active = TRUE");
    if (query?.hingeCode) {
      values.push(query.hingeCode);
      where.push(`t.thread_payload->>'hingeCode' = $${values.length}`);
    }
    if (query?.diagnosisType) {
      values.push(query.diagnosisType);
      where.push(`t.thread_payload->'diagnosis'->>'type' = $${values.length}`);
    }
    values.push(boundedLimit(query?.limit, 100));
    const result = await this.executor.query<SqlRow>(
      `SELECT t.thread_payload, t.user_id
         FROM learning_threads t
         INNER JOIN memory_records r ON r.user_id = t.user_id AND r.memory_id = t.memory_id
        WHERE ${where.join(" AND ")}
        ORDER BY t.active DESC, t.updated_at DESC, t.thread_id ASC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => parseThreadRow(row, userId));
  }

  private managementSource(current: MemoryRecord, refs?: MemoryCorrectionInput["refs"]): NonNullable<MemoryProposal["origin"]["typedSourceRefs"]> {
    const candidate = refs?.length ? refs : current.sourceRefs;
    if (candidate.length) return candidate;
    const fallback = {
      namespace: "SESSION" as const,
      refId: current.memoryId,
      demoContentHash: current.demoContentHashes[0] ?? "memory-management",
      sessionId: "memory-management",
      cueId: "memory-management",
    };
    return [fallback];
  }

  private proposalFromCurrent(
    userId: string,
    current: MemoryRecord,
    operation: "CORRECT" | "DELETE" | "CONFIRM",
    input: MemoryCorrectionInput | MemoryDeleteInput | MemoryConfirmation | undefined,
  ): MemoryProposal {
    const createdAt = operation === "DELETE" && input && "deletedAt" in input && input.deletedAt ? input.deletedAt : operation === "CONFIRM" && input && "confirmedAt" in input && input.confirmedAt ? input.confirmedAt : this.clock();
    const suppliedCorrection = operation === "CORRECT" ? (input as MemoryCorrectionInput | undefined) : undefined;
    const source = suppliedCorrection?.refs?.length
      ? suppliedCorrection.refs
      : operation === "CORRECT"
        ? [{
            namespace: "USER_CLAIM" as const,
            refId: suppliedCorrection?.correctionId ?? `correction-${current.memoryId}-${current.revision + 1}`,
            demoContentHash: current.demoContentHashes[0] ?? "memory-management",
            sessionId: "memory-management",
            cueId: "memory-management",
            ...(current.thread?.threadId ? { threadId: current.thread.threadId } : {}),
            label: "user correction",
          }]
        : this.managementSource(current);
    const first = source[0];
    const common = {
      schemaVersion: "memory-proposal.v1" as const,
      userId,
      requestedScope: "CROSS_DEMO" as const,
      kind: current.kind,
      logicalKey: current.logicalKey,
      // Management proposals always address an existing aggregate. Keeping
      // the target in the proposal itself lets schema/policy/repository
      // boundaries reject a forged cue-shaped CORRECT/CONFIRM/DELETE before
      // it can create a new logical record.
      targetMemoryId: current.memoryId,
      ...(current.thread ? { thread: current.thread } : {}),
      claims: current.claims,
      ...(current.verdict ? { verdict: current.verdict } : {}),
      ...(current.transferRule ? { transferRule: current.transferRule } : {}),
      ...(current.preference ? { preference: current.preference } : {}),
      origin: {
        sessionId: first.sessionId,
        demoContentHash: first.demoContentHash,
        cueId: first.cueId,
        ...(first.caseId ? { caseId: first.caseId } : {}),
        ...(current.thread?.threadId ? { sourceThreadId: current.thread.threadId } : {}),
        typedSourceRefs: source,
      },
      lifecycle: operation === "DELETE" ? ("DELETED" as const) : current.status,
      consentState: "GRANTED" as const,
      producerVersion: "memory-postgres.v1",
      createdAt,
    };
    if (operation === "CORRECT") {
      const correction = input as MemoryCorrectionInput;
      const correctionId = correction.correctionId ?? `correction-${current.memoryId}-${current.revision + 1}`;
      return MemoryProposalSchema.parse({
        ...common,
        proposalId: correctionId,
        operation,
        eventType: "USER_CORRECTED_COACH",
        idempotencyKey: `correction-${userId}-${current.memoryId}-${correctionId}`,
        content: correction.content,
        correction: { correctionId, content: correction.content, source: "USER" },
      }) as unknown as MemoryProposal;
    }
    if (operation === "DELETE") {
      const deletion = input as MemoryDeleteInput | undefined;
      const idempotencyKey = `delete-${userId}-${current.memoryId}`;
      return MemoryProposalSchema.parse({
        ...common,
        proposalId: idempotencyKey,
        operation,
        eventType: "MEMORY_DELETED",
        idempotencyKey,
        ...(deletion?.reason ? { deleteReason: deletion.reason } : {}),
      }) as unknown as MemoryProposal;
    }
    const confirmation = input as MemoryConfirmation | undefined;
    const confirmationId = confirmation?.confirmationId ?? `confirm-${userId}-${current.memoryId}`;
    return MemoryProposalSchema.parse({
      ...common,
      proposalId: confirmationId,
      operation,
      eventType: "USER_CONFIRMED",
      idempotencyKey: `confirm-${userId}-${current.memoryId}`,
      lifecycle: "STABLE",
      ...(confirmation?.content ? { content: confirmation.content } : {}),
    }) as unknown as MemoryProposal;
  }

  private async applyManagement(
    userIdInput: string,
    memoryIdInput: string,
    operation: "CORRECT" | "DELETE" | "CONFIRM",
    input: MemoryCorrectionInput | MemoryDeleteInput | MemoryConfirmation | undefined,
  ): Promise<MemoryRecord | undefined> {
    const userId = requireUser(userIdInput);
    const memoryId = scopedId(memoryIdInput, "memory_id");
    // Authenticate before loading any management projection. DELETE remains
    // permitted for a REVOKED principal solely for privacy erasure.
    await this.assertAuthorization(this.executor, userId, operation === "DELETE");
    const current = await this.current(this.executor, userId, { memoryId }, false, operation !== "DELETE");
    if (!current) return undefined;
    if (current.status === "DELETED") return current;
    const proposal = this.proposalFromCurrent(userId, current, operation, input);
    const decision = this.policy.decide({ proposal, current, eventType: proposal.eventType });
    const record = this.reducer.reduce({ userId, proposal, decision, current, now: this.clock() });
    return this.applyWriteDecision(userId, { ...decision, ...(record ? { record } : {}) });
  }

  async correctMemory(userId: string, memoryId: string, correction: MemoryCorrectionInput): Promise<MemoryRecord | undefined> {
    return this.applyManagement(userId, memoryId, "CORRECT", correction);
  }

  async deleteMemory(userId: string, memoryId: string, input?: MemoryDeleteInput): Promise<MemoryRecord | undefined> {
    return this.applyManagement(userId, memoryId, "DELETE", input);
  }

  private async invalidatePendingMemoryTx(
    executor: SqlExecutor,
    userId: string,
    memoryId: string,
    logicalKey?: string,
  ): Promise<readonly string[]> {
    const keyValue = logicalKey?.trim() || "";
    const result = await executor.query<{ session_id?: string; user_id?: string }>(
      `UPDATE memory_events
          SET status = CASE WHEN status IN ('POSTED', 'RETRY') THEN 'DEAD_LETTER' ELSE status END,
              next_attempt_at = NULL,
              last_error_code = CASE WHEN status IN ('POSTED', 'RETRY') THEN 'MEMORY_DELETED' ELSE last_error_code END,
              event_payload = ${REDACTED_EVENT_PAYLOAD_SQL}
        WHERE user_id = $1
          AND event_type <> 'MEMORY_DELETED'
          AND (
            target_memory_id = $2
            OR event_payload->>'targetMemoryId' = $2
            OR event_payload->>'memoryId' = $2
            OR event_payload->>'logicalKey' = $3
            OR event_payload->'proposal'->>'targetMemoryId' = $2
            OR event_payload->'proposal'->>'memoryId' = $2
            OR event_payload->'proposal'->>'logicalKey' = $3
            OR event_payload->'payload'->>'targetMemoryId' = $2
            OR event_payload->'payload'->>'memoryId' = $2
            OR event_payload->'payload'->>'logicalKey' = $3
            OR event_payload->'payload'->'proposal'->>'targetMemoryId' = $2
            OR event_payload->'payload'->'proposal'->>'memoryId' = $2
            OR event_payload->'payload'->'proposal'->>'logicalKey' = $3
          )
        RETURNING session_id, user_id`,
      [userId, memoryId, keyValue],
    );
    const sessions = new Set<string>();
    for (const row of result.rows) {
      if (String(row.user_id ?? "") !== userId) throw new MemoryRowValidationError(userId, "PostgreSQL outbox invalidation crossed the requested user boundary");
      if (typeof row.session_id === "string" && row.session_id) sessions.add(row.session_id);
    }
    return [...sessions];
  }

  /**
   * Terminalize queued PostgreSQL consumer events for a deleted aggregate and
   * return their session IDs so a host can invalidate the corresponding DO
   * outboxes as well.
   */
  async invalidatePendingMemory(userIdInput: string, memoryIdInput: string, logicalKeyInput?: string): Promise<readonly string[]> {
    const userId = requireUser(userIdInput);
    const memoryId = scopedId(memoryIdInput, "memory_id");
    const logicalKey = logicalKeyInput === undefined ? "" : scopedId(logicalKeyInput, "logical_key");
    return withSqlTransaction(this.executor, async (tx) => {
      await this.assertAuthorization(tx, userId, true);
      return this.invalidatePendingMemoryTx(tx, userId, memoryId, logicalKey);
    });
  }

  /** Remove payload-bearing side rows after a tombstone has committed. */
  private async purgeMemoryResidueTx(
    executor: SqlExecutor,
    userId: string,
    memoryId: string,
    logicalKey: string,
    sourceRefs: readonly unknown[],
  ): Promise<void> {
    await executor.query(
      `DELETE FROM memory_observations
        WHERE user_id = $1
          AND (
            memory_id = $2
            OR observation_payload->>'memoryId' = $2
            OR observation_payload->>'logicalKey' = $3
            OR observation_payload->'proposal'->>'memoryId' = $2
            OR observation_payload->'proposal'->>'logicalKey' = $3
            OR EXISTS (
               SELECT 1 FROM jsonb_array_elements($4::jsonb) AS source_ref
               WHERE (source_ref_json IS NOT NULL
                 AND source_ref_json->>'sessionId' = source_ref->>'sessionId'
                 AND source_ref_json->>'cueId' = source_ref->>'cueId'
                 AND source_ref_json->>'demoContentHash' = source_ref->>'demoContentHash')
                  OR (session_id = source_ref->>'sessionId'
                 AND cue_id = source_ref->>'cueId'
                 AND demo_content_hash = source_ref->>'demoContentHash')
            )
          )`,
      [userId, memoryId, logicalKey, json(sourceRefs)],
    );
    await executor.query("DELETE FROM memory_record_revisions WHERE user_id = $1 AND memory_id = $2", [userId, memoryId]);
    await executor.query("DELETE FROM memory_evidence_refs WHERE user_id = $1 AND memory_id = $2", [userId, memoryId]);
    await executor.query("DELETE FROM learning_threads WHERE user_id = $1 AND memory_id = $2", [userId, memoryId]);
    await executor.query("DELETE FROM memory_write_receipts WHERE user_id = $1 AND memory_id = $2", [userId, memoryId]);
    // Probe before DELETE so an absent optional vector table cannot abort the
    // core tombstone transaction.
    const vectorTable = await executor.query<{ table_name?: unknown }>(
      "SELECT to_regclass('memory_embeddings_v1') AS table_name",
    );
    if (vectorTable.rows[0]?.table_name) {
      await executor.query("DELETE FROM memory_embeddings_v1 WHERE user_id = $1 AND memory_id = $2", [userId, memoryId]);
    }
    await this.invalidatePendingMemoryTx(executor, userId, memoryId, logicalKey);
  }

  async purgeMemoryResidue(
    userIdInput: string,
    memoryIdInput: string,
    logicalKeyInput?: string,
    sourceRefs: readonly unknown[] = [],
  ): Promise<void> {
    const userId = requireUser(userIdInput);
    const memoryId = scopedId(memoryIdInput, "memory_id");
    const logicalKey = logicalKeyInput === undefined ? "" : scopedId(logicalKeyInput, "logical_key");
    // sourceRefs is intentionally an array for jsonb_array_elements below,
    // while the shared persisted-JSON guard rejects top-level arrays used by
    // ordinary record/event payloads. Wrap this bounded field so the guard
    // still enforces aggregate size, array length, depth and forbidden keys
    // without widening the accepted top-level payload shape globally.
    assertSafeJson({ sourceRefs });
    await withSqlTransaction(this.executor, async (tx) => {
      await this.assertAuthorization(tx, userId, true);
      await this.purgeMemoryResidueTx(tx, userId, memoryId, logicalKey, sourceRefs);
    });
  }

  /**
   * User-wide cleanup that first tombstones every current record in the same
   * transaction. Tombstones remain as anti-resurrection markers, while all
   * payload-bearing side tables and non-delete event bodies are removed.
   */
  async purgeUserMemoryResidue(userIdInput: string): Promise<readonly string[]> {
    const userId = requireUser(userIdInput);
    return withSqlTransaction(this.executor, async (tx) => {
      await this.assertAuthorization(tx, userId, true);
      const deletionAt = this.clock();
      // Keep the authorization boundary closed for the whole purge
      // transaction. The service normally installs this REVOKED state before
      // calling the repository, but a concurrent explicit grant may have
      // committed in between those two operations. The principal row is
      // already locked by assertAuthorization, so this update linearizes the
      // delete-all request with every repository writer without moving the
      // trusted consent version backwards.
      await tx.query(
        `UPDATE app_users
            SET consent = 'REVOKED',
                consent_version = CASE
                  WHEN consent <> 'REVOKED' THEN COALESCE(consent_version, 0) + 1
                  ELSE consent_version
                END,
                consent_updated_at = $2,
                updated_at = $2
          WHERE user_id = $1
            AND consent <> 'REVOKED'`,
        [userId, deletionAt],
      );
      await tx.query(
        `UPDATE app_users
            SET memory_deleted_at = CASE
              WHEN memory_deleted_at IS NULL OR memory_deleted_at < $2 THEN $2
              ELSE memory_deleted_at
            END,
            updated_at = $2
          WHERE user_id = $1`,
        [userId, deletionAt],
      );

      // Lock and snapshot every current aggregate before removing any
      // denormalized rows. The user row lock above serializes this purge with
      // repository writers that honor assertAuthorization.
      const currentRows = await tx.query<SqlRow>(
        `SELECT record_payload, user_id
           FROM memory_records
          WHERE user_id = $1
            AND status <> 'DELETED'
          ORDER BY memory_id ASC
          FOR UPDATE`,
        [userId],
      );
      const currentRecords = currentRows.rows.map((row) => parseMemoryRow(row, userId));
      for (const current of currentRecords) {
        const proposal = this.proposalFromCurrent(userId, current, "DELETE", {
          reason: "用户请求清除全部长期记忆",
          deletedAt: deletionAt,
        });
        const policyDecision = this.policy.decide({ proposal, current, eventType: proposal.eventType });
        // A current non-DELETED row is the authoritative purge target. If a
        // stale receipt happens to reuse the management delete key, do not let
        // that duplicate classification leave user data recallable.
        const decision: MemoryWriteDecision = policyDecision.accepted
          ? policyDecision
          : {
              ...policyDecision,
              accepted: true,
              action: "DELETE",
              reason: "ACCEPTED",
              status: "DELETED",
              revision: current.revision + 1,
              targetMemoryId: current.memoryId,
            };
        const reduced = this.reducer.reduce({
          userId,
          proposal,
          decision,
          current,
          now: deletionAt,
        });
        if (!reduced || reduced.status !== "DELETED") throw new Error("MEMORY_PURGE_TOMBSTONE_FAILED");
        const tombstone = parseMemoryRow({ record_payload: reduced, user_id: userId }, userId);

        // Do not call saveRecord here: its optional-vector update is intended
        // for normal writes and a core-only database may not have that table.
        // This upsert still uses the exact reducer-generated record/tombstone
        // shape, then the shared residue helper removes all side rows.
        await tx.query(UPSERT_MEMORY_SQL, recordValues(tombstone));
        await tx.query(
          `INSERT INTO memory_tombstones
            (user_id, memory_id, logical_key, deleted_revision, deleted_at, deleted_by, reason, last_idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (user_id, memory_id) DO NOTHING`,
          [
            tombstone.userId,
            tombstone.memoryId,
            tombstone.logicalKey,
            tombstone.revision,
            tombstone.deletedAt ?? tombstone.updatedAt,
            tombstone.tombstone?.deletedBy ?? "USER",
            tombstone.tombstone?.reason ?? null,
            tombstone.lastIdempotencyKey,
          ],
        );
        await this.purgeMemoryResidueTx(tx, userId, current.memoryId, current.logicalKey, current.sourceRefs);
      }

      await tx.query("DELETE FROM memory_observations WHERE user_id = $1", [userId]);
      await tx.query("DELETE FROM memory_record_revisions WHERE user_id = $1", [userId]);
      await tx.query("DELETE FROM memory_evidence_refs WHERE user_id = $1", [userId]);
      await tx.query("DELETE FROM learning_threads WHERE user_id = $1", [userId]);
      await tx.query("DELETE FROM user_preferences WHERE user_id = $1", [userId]);
      await tx.query("DELETE FROM memory_write_receipts WHERE user_id = $1", [userId]);
      const vectorTable = await tx.query<{ table_name?: unknown }>(
        "SELECT to_regclass('memory_embeddings_v1') AS table_name",
      );
      if (vectorTable.rows[0]?.table_name) {
        await tx.query("DELETE FROM memory_embeddings_v1 WHERE user_id = $1", [userId]);
      }
      const events = await tx.query<{ session_id?: string; user_id?: string }>(
        `UPDATE memory_events
            SET status = CASE WHEN event_type = 'MEMORY_DELETED' THEN status ELSE 'DEAD_LETTER' END,
                next_attempt_at = NULL,
                last_error_code = CASE WHEN event_type = 'MEMORY_DELETED' THEN last_error_code ELSE 'MEMORY_DELETED' END,
                event_payload = ${REDACTED_EVENT_PAYLOAD_SQL}
          WHERE user_id = $1
          RETURNING session_id, user_id`,
        [userId],
      );
      const sessions = new Set<string>();
      for (const row of events.rows) {
        if (String(row.user_id ?? "") !== userId) throw new MemoryRowValidationError(userId, "PostgreSQL user-wide cleanup crossed the requested user boundary");
        if (typeof row.session_id === "string" && row.session_id) sessions.add(row.session_id);
      }
      return [...sessions];
    });
  }

  async confirmMemory(userId: string, memoryId: string, confirmation?: MemoryConfirmation): Promise<MemoryRecord | undefined> {
    return this.applyManagement(userId, memoryId, "CONFIRM", confirmation);
  }

  async listMemories(userId: string, query?: MemoryQuery): Promise<readonly MemoryRecord[]> {
    return this.retrieveStructured(userId, query);
  }

  async listMemoryIdsForDeletion(userIdInput: string, limit = MAX_QUERY_LIMIT): Promise<readonly string[]> {
    const userId = requireUser(userIdInput);
    const bounded = boundedLimit(limit);
    const result = await this.executor.query<{ memory_id: string; user_id: string }>(
      `SELECT memory_id, user_id
         FROM memory_records
        WHERE user_id = $1
          AND status <> 'DELETED'
          AND ${DELETION_MEMORY_PREDICATE}
        ORDER BY updated_at ASC, memory_id ASC
        LIMIT $2`,
      [userId, bounded],
    );
    return result.rows.map((row) => {
      if (String(row.user_id ?? "") !== userId || typeof row.memory_id !== "string") {
        throw new MemoryRowValidationError(userId, "PostgreSQL deletion-id query crossed the requested user boundary");
      }
      return row.memory_id;
    });
  }

  async listMemorySessionIds(userIdInput: string): Promise<readonly string[]> {
    const userId = requireUser(userIdInput);
    const result = await this.executor.query<{ session_id?: unknown; user_id?: unknown }>(
      `SELECT DISTINCT session_id, user_id
         FROM memory_events
        WHERE user_id = $1
          AND session_id NOT IN ('memory-management', 'memory-preferences')
        ORDER BY session_id ASC`,
      [userId],
    );
    const sessions = new Set<string>();
    for (const row of result.rows) {
      if (String(row.user_id ?? "") !== userId) {
        throw new MemoryRowValidationError(userId, "PostgreSQL session-id query crossed the requested user boundary");
      }
      if (typeof row.session_id === "string" && row.session_id.length > 0) sessions.add(row.session_id);
    }
    return [...sessions];
  }

  async upsertObservation(userIdInput: string, input: MemoryObservationInput): Promise<ObservationWriteResult> {
    const userId = requireUser(userIdInput);
    if (!input || !scopedId(input.sessionId, "session_id") || !scopedId(input.cueId, "cue_id") || !scopedId(input.taxonomyCode, "taxonomy_code")) {
      throw new Error("INVALID_OBSERVATION_FINGERPRINT");
    }
    const sessionId = scopedId(input.sessionId, "session_id");
    const cueId = scopedId(input.cueId, "cue_id");
    const taxonomyCode = scopedId(input.taxonomyCode, "taxonomy_code");
    const demoContentHash = text(input.demoContentHash, "demo_content_hash", 256);
    const observationId = scopedId(input.observationId ?? `observation-${stableMemoryToken(`${userId}|${sessionId}|${cueId}|${taxonomyCode}`)}`, "observation_id");
    const memoryId = input.memoryId === undefined ? undefined : scopedId(input.memoryId, "memory_id");
    const payload = input.payload ?? {};
    assertSafeJson(payload);
    const sourceRef = input.sourceRef === undefined ? undefined : MemorySourceRefSchema.parse(input.sourceRef);
    if (sourceRef && (sourceRef.demoContentHash !== demoContentHash || sourceRef.sessionId !== sessionId || sourceRef.cueId !== cueId)) {
      throw new Error("OBSERVATION_SOURCE_REF_MISMATCH");
    }
    const createdAt = input.createdAt ?? this.clock();
    if (!MemoryIdSchema.safeParse(sessionId).success || !MemoryIdSchema.safeParse(cueId).success || !Number.isFinite(Date.parse(createdAt))) throw new Error("INVALID_OBSERVATION_FINGERPRINT");
    return withSqlTransaction(this.executor, async (tx) => {
      await this.assertAuthorization(tx, userId);
      await this.assertAfterUserDeletion(tx, userId, {
        type: "CUE_DIAGNOSED",
        eventType: "CUE_DIAGNOSED",
        createdAt,
      });
      if (memoryId) {
        // Individual deletion locks the same app_users row first and then the
        // target memory row.  Mirroring that order makes delete-vs-observation
        // linearizable: either the observation sees a live target, or the
        // deletion commits first and this request is rejected.
        const targetResult = await tx.query<SqlRow>(
          `SELECT user_id, memory_id, status, tombstone_json, record_payload
             FROM memory_records
            WHERE user_id = $1 AND memory_id = $2
            FOR UPDATE`,
          [userId, memoryId],
        );
        const target = targetResult.rows[0];
        if (!target) throw new Error("MEMORY_OBSERVATION_TARGET_NOT_FOUND");
        if (target.user_id !== undefined && String(target.user_id) !== userId) {
          throw new MemoryRowValidationError(userId, "PostgreSQL observation target crossed the requested user boundary");
        }
        if (target.memory_id !== undefined && String(target.memory_id) !== memoryId) {
          throw new MemoryRowValidationError(userId, "PostgreSQL observation target crossed the requested memory boundary");
        }
        const decodedPayload = decodeJson(target.record_payload);
        const payloadRecord = isObject(decodedPayload) ? decodedPayload : undefined;
        const status = target.status ?? payloadRecord?.status;
        const tombstone = target.tombstone_json ?? payloadRecord?.tombstone;
        if (status === "DELETED" || tombstone !== undefined && tombstone !== null) {
          throw new Error("MEMORY_DELETED_TOMBSTONE");
        }
      }
      const result = await tx.query<SqlRow>(
        `INSERT INTO memory_observations
          (user_id, observation_id, session_id, cue_id, taxonomy_code, demo_content_hash, memory_id, source_ref_json, observation_payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
         ON CONFLICT (user_id, session_id, cue_id, taxonomy_code) DO NOTHING
         RETURNING user_id, observation_id, session_id, cue_id, taxonomy_code, demo_content_hash, memory_id, source_ref_json, observation_payload, created_at`,
        [userId, observationId, sessionId, cueId, taxonomyCode, demoContentHash, memoryId ?? null, sourceRef ? json(sourceRef) : null, json(payload), createdAt],
      );
      if (result.rows[0]) return { inserted: true, observation: parseObservationRow(result.rows[0], userId) };
      const existing = await tx.query<SqlRow>(
        `SELECT user_id, observation_id, session_id, cue_id, taxonomy_code, demo_content_hash, memory_id, source_ref_json, observation_payload, created_at
           FROM memory_observations
          WHERE user_id = $1 AND session_id = $2 AND cue_id = $3 AND taxonomy_code = $4
          LIMIT 1`,
        [userId, sessionId, cueId, taxonomyCode],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("OBSERVATION_INSERT_DID_NOT_RETURN_ROW");
      const existingDemoContentHash = String(row.demo_content_hash ?? row.demoContentHash ?? "").trim();
      if (existingDemoContentHash !== demoContentHash) {
        throw new Error("MEMORY_OBSERVATION_FINGERPRINT_CONFLICT");
      }
      return { inserted: false, observation: parseObservationRow(row, userId) };
    });
  }

  async recordObservation(userId: string, input: MemoryObservationInput): Promise<ObservationWriteResult> {
    return this.upsertObservation(userId, input);
  }

  async appendObservation(userId: string, input: MemoryObservationInput): Promise<ObservationWriteResult> {
    return this.upsertObservation(userId, input);
  }

  async upsertMemoryEmbedding(userIdInput: string, input: MemoryEmbeddingInput): Promise<void> {
    const userId = requireUser(userIdInput);
    const embedding = validateEmbeddingInput(userId, input);
    await withSqlTransaction(this.executor, async (tx) => {
      await this.assertAuthorization(tx, userId);
      await this.assertAfterUserDeletion(tx, userId, {
        type: "CUE_DIAGNOSED",
        eventType: "CUE_DIAGNOSED",
        createdAt: embedding.createdAt ?? this.clock(),
      });
      const current = await this.current(tx, userId, { memoryId: embedding.memoryId });
      if (!current || current.status === "DELETED") throw new VectorUnavailableError("Cannot index a missing or deleted memory");
      await tx.query(
        `INSERT INTO memory_embeddings_v1
          (user_id, memory_id, embedding, embedding_dimension, content_hash, model, source_revision, created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3::vector,$4,$5,$6,$7,$8,$8,NULL)
         ON CONFLICT (user_id, memory_id) DO UPDATE SET
           embedding=EXCLUDED.embedding, embedding_dimension=EXCLUDED.embedding_dimension,
           content_hash=EXCLUDED.content_hash, model=EXCLUDED.model,
           source_revision=EXCLUDED.source_revision, updated_at=EXCLUDED.updated_at, deleted_at=NULL`,
        [userId, embedding.memoryId, embeddingToVectorLiteral(embedding.embedding), embedding.embeddingDimension, embedding.contentHash, embedding.model, embedding.sourceRevision, embedding.createdAt ?? this.clock()],
      );
    });
  }

  async saveEmbedding(userId: string, input: MemoryEmbeddingInput): Promise<void> {
    return this.upsertMemoryEmbedding(userId, input);
  }

  async deleteMemoryEmbedding(userIdInput: string, memoryIdInput: string, deletedAt = this.clock()): Promise<void> {
    const userId = requireUser(userIdInput);
    const memoryId = scopedId(memoryIdInput, "memory_id");
    try {
      await withSqlTransaction(this.executor, async (tx) => {
        await this.assertAuthorization(tx, userId, true);
        // pgvector is an optional derived index.  Probe its relation before
        // issuing the update so a core-only deployment does not mark the
        // transaction aborted on 42P01; deletion of the canonical record is
        // already complete and should remain successful without the index.
        const vectorTable = await tx.query<{ table_name?: unknown }>(
          "SELECT to_regclass('memory_embeddings_v1') AS table_name",
        );
        if (!vectorTable.rows[0]?.table_name) return;
        await tx.query(
          "UPDATE memory_embeddings_v1 SET deleted_at = $3, updated_at = $3 WHERE user_id = $1 AND memory_id = $2",
          [userId, memoryId, deletedAt],
        );
      });
    } catch (error) {
      throw new SemanticUnavailableError("Optional semantic memory index is unavailable", { cause: error });
    }
  }
}

export const PostgresMemoryStore = PostgresMemoryRepository;
export const createPostgresMemoryRepository = (options: PostgresMemoryRepositoryOptions): PostgresMemoryRepository => new PostgresMemoryRepository(options);
