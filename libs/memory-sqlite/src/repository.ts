import {
  MEMORY_EVENT_VERSION,
  MEMORY_PROPOSAL_VERSION,
  MemoryAuthorizationSchema,
  MemoryEventSchema,
  MemoryReducer,
  MemoryWritePolicy,
  parseMemoryEvent,
  parseMemoryRecord,
  stableMemoryToken,
  type LearningThreadQuery,
  type MemoryAuthorization,
  type MemoryAuthorizationStore,
  type MemoryConfirmation,
  type MemoryCorrectionInput,
  type MemoryDeleteInput,
  type MemoryEmbeddingWrite,
  type MemoryEvent,
  type MemoryProposal,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryRepository,
  type MemoryWriteDecision,
  type SemanticMemoryQuery,
} from "@cs-coach/memory";
import type { DatabaseSync } from "node:sqlite";
import {
  SqliteDatabaseOwner,
  getSqliteDatabaseOwner,
  type SqliteDatabaseOptions,
} from "./database";

const MAX_QUERY_LIMIT = 100;
const MAX_SEMANTIC_CANDIDATES = 1_000;
const FORBIDDEN_KEYS = new Set([
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

function nowIso(): string {
  return new Date().toISOString();
}
function boundedLimit(
  value: number | undefined,
  fallback = MAX_QUERY_LIMIT,
): number {
  return Math.max(
    1,
    Math.min(
      Number.isInteger(value) ? Number(value) : fallback,
      MAX_QUERY_LIMIT,
    ),
  );
}
function assertId(value: string, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 256 || normalized.includes("\0"))
    throw new Error(`INVALID_${field.toUpperCase()}`);
  return normalized;
}
function assertSafeJson(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): void {
  if (typeof value === "string" && value.length > 1_200)
    throw new Error("PERSISTED_TEXT_TOO_LONG");
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("PERSISTED_JSON_CYCLE");
  if (depth > 7) throw new Error("PERSISTED_JSON_TOO_DEEP");
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error("PERSISTED_ARRAY_TOO_LONG");
    for (const item of value) assertSafeJson(item, depth + 1, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key))
        throw new Error(`FORBIDDEN_PERSISTED_FIELD:${key}`);
      assertSafeJson(item, depth + 1, seen);
    }
  }
  seen.delete(value);
  if (depth === 0 && Buffer.byteLength(JSON.stringify(value)) > 64 * 1024)
    throw new Error("PERSISTED_JSON_TOO_LARGE");
}
function encodeJson(value: unknown): string {
  assertSafeJson(value);
  return JSON.stringify(value);
}
function parseRecordJson(value: unknown, userId: string): MemoryRecord {
  if (typeof value !== "string") throw new Error("SQLITE_INVALID_RECORD_ROW");
  const record = parseMemoryRecord(JSON.parse(value));
  if (record.userId !== userId)
    throw new Error("SQLITE_USER_BOUNDARY_VIOLATION");
  return record;
}
function asArray<T>(
  value: T | readonly T[] | undefined,
): readonly T[] | undefined {
  return value === undefined
    ? undefined
    : Array.isArray(value)
      ? (value as readonly T[])
      : [value as T];
}
function matches(record: MemoryRecord, query?: MemoryQuery): boolean {
  if (!query) return record.status !== "DELETED";
  if (!query.includeDeleted && record.status === "DELETED") return false;
  if (
    query.activeOnly &&
    (!record.active ||
      ["DELETED", "DISPUTED", "SUPERSEDED", "ARCHIVED", "RESOLVED"].includes(
        record.status,
      ))
  )
    return false;
  const kinds = asArray(query.kind);
  if (kinds && !kinds.includes(record.kind)) return false;
  const statuses = asArray(query.status);
  if (statuses && !statuses.includes(record.status)) return false;
  if (query.logicalKey && query.logicalKey !== record.logicalKey) return false;
  if (
    (query.taxonomyCode || query.hingeCode) &&
    (query.taxonomyCode ?? query.hingeCode) !== record.thread?.hingeCode
  )
    return false;
  if (query.mapName && query.mapName !== record.scopeContext?.mapName)
    return false;
  if (query.side && query.side !== record.scopeContext?.side) return false;
  if (query.roleCode && query.roleCode !== record.scopeContext?.roleCode)
    return false;
  if (
    query.userGoal &&
    !record.thread?.userModel.goal
      ?.toLowerCase()
      .includes(query.userGoal.toLowerCase())
  )
    return false;
  if (query.since && record.updatedAt < query.since) return false;
  if (
    query.minConfidence !== undefined &&
    Math.max(
      record.thread?.diagnosis.confidence ?? 0,
      record.thread?.transferRule.confidence ?? 0,
      record.verdict?.confidence ?? 0,
    ) < query.minConfidence
  )
    return false;
  return true;
}
function isAuthorized(
  db: DatabaseSync,
  userId: string,
  allowRevoked = false,
): boolean {
  const row = db
    .prepare("SELECT memory_enabled,consent FROM app_users WHERE user_id=?")
    .get(userId) as { memory_enabled?: number; consent?: string } | undefined;
  return Boolean(
    row &&
      ((row.memory_enabled === 1 && row.consent === "GRANTED") ||
        (allowRevoked &&
          (row.consent === "GRANTED" || row.consent === "REVOKED"))),
  );
}
function requireAuthorization(
  db: DatabaseSync,
  userId: string,
  allowRevoked = false,
): void {
  if (!isAuthorized(db, userId, allowRevoked))
    throw new Error("MEMORY_CONSENT_REVOKED");
}
function requireAfterUserDeletion(
  db: DatabaseSync,
  userId: string,
  createdAt: string,
  deletionOperation = false,
): void {
  if (deletionOperation) return;
  const row = db
    .prepare("SELECT memory_deleted_at FROM app_users WHERE user_id=?")
    .get(userId) as { memory_deleted_at?: string | null } | undefined;
  const marker = row?.memory_deleted_at;
  if (marker && createdAt <= marker)
    throw new Error("MEMORY_EVENT_BEFORE_USER_DELETION");
}
function currentByMemory(
  db: DatabaseSync,
  userId: string,
  memoryId: string,
): MemoryRecord | undefined {
  const row = db
    .prepare(
      "SELECT record_json FROM memory_records WHERE user_id=? AND memory_id=?",
    )
    .get(userId, memoryId) as { record_json?: string } | undefined;
  return row?.record_json
    ? parseRecordJson(row.record_json, userId)
    : undefined;
}
function currentByLogical(
  db: DatabaseSync,
  userId: string,
  logicalKey: string,
): MemoryRecord | undefined {
  const row = db
    .prepare(
      "SELECT record_json FROM memory_records WHERE user_id=? AND logical_key=?",
    )
    .get(userId, logicalKey) as { record_json?: string } | undefined;
  return row?.record_json
    ? parseRecordJson(row.record_json, userId)
    : undefined;
}
function redactedEvent(event: MemoryEvent): MemoryEvent {
  const type = event.type ?? event.eventType;
  return {
    schemaVersion: MEMORY_EVENT_VERSION,
    eventId: event.eventId,
    ...(event.type ? { type: event.type } : {}),
    ...(event.eventType ? { eventType: event.eventType } : {}),
    userId: event.userId,
    sessionId: event.sessionId,
    ...(event.demoContentHash
      ? { demoContentHash: event.demoContentHash }
      : {}),
    ...(event.proposalId ? { proposalId: event.proposalId } : {}),
    ...(event.targetMemoryId ? { targetMemoryId: event.targetMemoryId } : {}),
    ...(event.operation ? { operation: event.operation } : {}),
    idempotencyKey: event.idempotencyKey,
    producerVersion: event.producerVersion,
    payload: {
      reason:
        type === "SESSION_COMPLETED" ? "SESSION_COMPLETED" : "MEMORY_DELETED",
    },
    createdAt: event.createdAt,
  };
}
function vectorBlob(values: readonly number[]): {
  blob: Uint8Array;
  norm: number;
} {
  if (!values.length || values.length > 16_384)
    throw new Error("INVALID_EMBEDDING_DIMENSION");
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  let squared = 0;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new Error("INVALID_EMBEDDING_VALUE");
    view.setFloat32(index * 4, value, true);
  });
  for (let index = 0; index < values.length; index += 1) {
    const canonical = view.getFloat32(index * 4, true);
    squared += canonical * canonical;
  }
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm === 0)
    throw new Error("INVALID_EMBEDDING_NORM");
  return { blob: new Uint8Array(buffer), norm };
}
function decodeVector(blob: unknown, dimension: number): number[] | undefined {
  const bytes =
    blob instanceof Uint8Array
      ? blob
      : Buffer.isBuffer(blob)
        ? new Uint8Array(blob)
        : undefined;
  if (!bytes || dimension <= 0 || bytes.byteLength !== dimension * 4)
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: number[] = [];
  for (let index = 0; index < dimension; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) return undefined;
    result.push(value);
  }
  return result;
}

export interface SqliteMemoryRepositoryOptions extends SqliteDatabaseOptions {
  owner?: SqliteDatabaseOwner;
  now?: () => string;
  reducer?: MemoryReducer;
  policy?: MemoryWritePolicy;
}
export interface SqliteMemoryObservationInput {
  observationId?: string;
  sessionId: string;
  cueId: string;
  taxonomyCode: string;
  demoContentHash: string;
  memoryId?: string;
  sourceRef?: unknown;
  payload?: unknown;
  createdAt?: string;
}
export interface SqliteMemoryObservation {
  userId: string;
  observationId: string;
  sessionId: string;
  cueId: string;
  taxonomyCode: string;
  demoContentHash: string;
  memoryId?: string;
  sourceRef?: unknown;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface SqliteObservationWriteResult {
  inserted: boolean;
  observation: SqliteMemoryObservation;
}

export class SqliteMemoryAuthorizationConflictError extends Error {
  readonly code = "MEMORY_AUTHORIZATION_CONFLICT" as const;

  constructor() {
    super("MEMORY_AUTHORIZATION_CONFLICT");
    this.name = "SqliteMemoryAuthorizationConflictError";
  }
}

export class SqliteMemoryRepository
  implements MemoryRepository, MemoryAuthorizationStore
{
  readonly owner: SqliteDatabaseOwner;
  private readonly clock: () => string;
  private readonly reducer: MemoryReducer;
  private readonly policy: MemoryWritePolicy;
  constructor(options: SqliteMemoryRepositoryOptions = {}) {
    this.owner = options.owner ?? getSqliteDatabaseOwner(options);
    this.clock = options.now ?? nowIso;
    this.reducer = options.reducer ?? new MemoryReducer();
    this.policy = options.policy ?? new MemoryWritePolicy();
  }
  async getAuthorization(
    userIdInput: string,
  ): Promise<MemoryAuthorization | undefined> {
    const userId = assertId(userIdInput, "user_id");
    const row = this.owner.db
      .prepare(
        "SELECT user_id,memory_enabled,consent,consent_version,updated_at FROM app_users WHERE user_id=?",
      )
      .get(userId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return MemoryAuthorizationSchema.parse({
      schemaVersion: "memory-authorization.v1",
      userId: row.user_id,
      memoryEnabled: row.memory_enabled === 1,
      featureFlag: row.memory_enabled === 1,
      consent: row.consent,
      consentGranted: row.consent === "GRANTED",
      consentVersion: row.consent_version,
      updatedAt: row.updated_at,
    }) as MemoryAuthorization;
  }
  async setAuthorization(
    userIdInput: string,
    authorizationInput: MemoryAuthorization,
  ): Promise<void> {
    const userId = assertId(userIdInput, "user_id");
    const authorization = MemoryAuthorizationSchema.parse({
      ...authorizationInput,
      userId,
    }) as MemoryAuthorization;
    if (authorizationInput.userId !== userId) throw new Error("USER_MISMATCH");
    await this.owner.enqueueWrite((db) => {
      const enabled =
        authorization.memoryEnabled ?? authorization.featureFlag ?? false;
      const version = authorization.consentVersion ?? 0;
      const updatedAt = authorization.updatedAt ?? this.clock();
      const previous = db
        .prepare(
          "SELECT consent_version,consent,memory_enabled FROM app_users WHERE user_id=?",
        )
        .get(userId) as
        | {
            consent_version?: number;
            consent?: string;
            memory_enabled?: number;
          }
        | undefined;
      if (previous) {
        const currentVersion = Number(previous.consent_version ?? 0);
        const identical =
          currentVersion === version &&
          previous.consent === authorization.consent &&
          (previous.memory_enabled === 1) === Boolean(enabled);
        if (
          version < currentVersion ||
          (version === currentVersion && !identical)
        ) {
          throw new SqliteMemoryAuthorizationConflictError();
        }
      }
      db.prepare(
        "INSERT INTO app_users(user_id,memory_enabled,consent,consent_version,updated_at,memory_deleted_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT(user_id) DO UPDATE SET memory_enabled=excluded.memory_enabled,consent=excluded.consent,consent_version=excluded.consent_version,updated_at=excluded.updated_at",
      ).run(userId, enabled ? 1 : 0, authorization.consent, version, updatedAt);
    });
  }
  async getMemoryVersion(
    userIdInput: string,
    memoryIdInput?: string,
  ): Promise<number> {
    const userId = assertId(userIdInput, "user_id");
    if (!isAuthorized(this.owner.db, userId)) return 0;
    const row = memoryIdInput
      ? this.owner.db
          .prepare(
            "SELECT MAX(revision) version FROM memory_records WHERE user_id=? AND memory_id=?",
          )
          .get(userId, assertId(memoryIdInput, "memory_id"))
      : this.owner.db
          .prepare(
            "SELECT MAX(revision) version FROM memory_records WHERE user_id=?",
          )
          .get(userId);
    return Number((row as { version?: number } | undefined)?.version ?? 0);
  }
  async getRecordVersion(
    userIdInput: string,
    memoryIdInput: string,
    revision?: number,
    allowRevokedForDeletion = false,
  ): Promise<MemoryRecord | undefined> {
    const userId = assertId(userIdInput, "user_id"),
      memoryId = assertId(memoryIdInput, "memory_id");
    if (!isAuthorized(this.owner.db, userId, allowRevokedForDeletion))
      return undefined;
    if (revision === undefined)
      return currentByMemory(this.owner.db, userId, memoryId);
    const row = this.owner.db
      .prepare(
        "SELECT record_json FROM memory_revisions WHERE user_id=? AND memory_id=? AND revision=?",
      )
      .get(userId, memoryId, revision) as { record_json?: string } | undefined;
    return row?.record_json
      ? parseRecordJson(row.record_json, userId)
      : undefined;
  }
  async getPreferences(userId: string): Promise<readonly MemoryRecord[]> {
    return this.retrieveStructured(userId, {
      kind: ["PREFERENCE", "COACHING_PREFERENCE"],
      limit: 100,
    });
  }
  async findByLogicalKey(
    userIdInput: string,
    logicalKeyInput: string,
  ): Promise<MemoryRecord | undefined> {
    const userId = assertId(userIdInput, "user_id");
    if (!isAuthorized(this.owner.db, userId)) return undefined;
    return currentByLogical(
      this.owner.db,
      userId,
      assertId(logicalKeyInput, "logical_key"),
    );
  }
  async appendEvent(
    userIdInput: string,
    eventInput: MemoryEvent,
  ): Promise<MemoryEvent> {
    const userId = assertId(userIdInput, "user_id");
    const event = parseMemoryEvent(MemoryEventSchema.parse(eventInput));
    if (event.userId !== userId) throw new Error("USER_MISMATCH");
    encodeJson(event);
    return this.owner.enqueueWrite((db) => {
      requireAuthorization(db, userId);
      requireAfterUserDeletion(
        db,
        userId,
        event.createdAt,
        event.operation === "DELETE" ||
          (event.type ?? event.eventType) === "MEMORY_DELETED",
      );
      const existing = db
        .prepare(
          "SELECT event_json FROM memory_events WHERE user_id=? AND (event_id=? OR idempotency_key=?) LIMIT 1",
        )
        .get(userId, event.eventId, event.idempotencyKey) as
        | { event_json?: string }
        | undefined;
      if (existing?.event_json)
        return parseMemoryEvent(JSON.parse(existing.event_json));
      if (
        event.targetMemoryId &&
        ["CORRECT", "CONFIRM", "DELETE"].includes(event.operation ?? "")
      ) {
        const current = currentByMemory(db, userId, event.targetMemoryId);
        if (!current) throw new Error("MEMORY_MANAGEMENT_TARGET_NOT_FOUND");
        if (current.status === "DELETED" && event.operation !== "DELETE")
          throw new Error("MEMORY_DELETED_TOMBSTONE");
      }
      const payloadObject =
        event.payload &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : undefined;
      const proposal = (payloadObject?.proposal ??
        (payloadObject?.logicalKey ? payloadObject : undefined)) as
        | MemoryProposal
        | undefined;
      db.prepare(
        "INSERT INTO memory_events(user_id,event_id,idempotency_key,session_id,event_type,target_memory_id,logical_key,status,attempt_count,next_attempt_at,created_at,event_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        userId,
        event.eventId,
        event.idempotencyKey,
        event.sessionId,
        String(event.type ?? event.eventType),
        event.targetMemoryId ?? null,
        proposal?.logicalKey ?? null,
        "POSTED",
        event.attemptCount ?? 0,
        event.nextAttemptAt ?? null,
        event.createdAt,
        JSON.stringify(event),
      );
      return event;
    });
  }
  async markEventConsumed(
    userIdInput: string,
    eventIdInput: string,
    consumedAt = this.clock(),
  ): Promise<void> {
    const userId = assertId(userIdInput, "user_id"),
      eventId = assertId(eventIdInput, "event_id");
    await this.owner.enqueueWrite((db) => {
      requireAuthorization(db, userId);
      db.prepare(
        "UPDATE memory_events SET status='CONSUMED',consumed_at=?,error_code=NULL WHERE user_id=? AND event_id=? AND status!='DEAD_LETTER'",
      ).run(consumedAt, userId, eventId);
    });
  }
  async markEventFailed(
    userIdInput: string,
    eventIdInput: string,
    options?: {
      terminal?: boolean;
      nextAttemptAt?: string;
      errorCode?: string;
    },
  ): Promise<void> {
    const userId = assertId(userIdInput, "user_id"),
      eventId = assertId(eventIdInput, "event_id");
    await this.owner.enqueueWrite((db) => {
      requireAuthorization(db, userId);
      db.prepare(
        "UPDATE memory_events SET status=?,attempt_count=attempt_count+1,next_attempt_at=?,error_code=? WHERE user_id=? AND event_id=? AND status NOT IN ('CONSUMED','DEAD_LETTER')",
      ).run(
        options?.terminal ? "DEAD_LETTER" : "RETRY",
        options?.nextAttemptAt ?? null,
        options?.errorCode?.slice(0, 80) ?? null,
        userId,
        eventId,
      );
    });
  }
  async applyWriteDecision(
    userIdInput: string,
    decision: MemoryWriteDecision,
  ): Promise<MemoryRecord | undefined> {
    const userId = assertId(userIdInput, "user_id");
    if (decision.userId !== userId || decision.proposal.userId !== userId)
      throw new Error("USER_MISMATCH");
    encodeJson(decision.proposal);
    return this.owner.enqueueWrite((db) => {
      requireAuthorization(
        db,
        userId,
        decision.proposal.operation === "DELETE",
      );
      requireAfterUserDeletion(
        db,
        userId,
        decision.proposal.createdAt,
        decision.proposal.operation === "DELETE",
      );
      const receipt = db
        .prepare(
          "SELECT memory_id,revision FROM memory_write_receipts WHERE user_id=? AND idempotency_key=?",
        )
        .get(userId, decision.idempotencyKey) as
        | { memory_id?: string; revision?: number }
        | undefined;
      if (receipt)
        return receipt.memory_id
          ? currentByMemory(db, userId, receipt.memory_id)
          : undefined;
      const current = decision.targetMemoryId
        ? currentByMemory(db, userId, decision.targetMemoryId)
        : currentByLogical(db, userId, decision.logicalKey);
      if (current && current.logicalKey !== decision.logicalKey)
        throw new Error("MEMORY_TARGET_LOGICAL_KEY_MISMATCH");
      if (decision.targetMemoryId && !current) return undefined;
      const proposal = decision.proposal;
      const cueEvent = [
        "CUE_DIAGNOSED",
        "TRANSFER_RULE_TAUGHT",
        "TRANSFER_RULE_APPLIED",
      ].includes(proposal.eventType ?? "");
      if (cueEvent) {
        const inserted = db
          .prepare(
            "INSERT OR IGNORE INTO memory_cue_effects(user_id,session_id,cue_id,logical_key,effect_type,memory_id,producer_version,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            userId,
            proposal.origin.sessionId,
            proposal.origin.cueId,
            proposal.logicalKey,
            String(proposal.eventType),
            current?.memoryId ?? null,
            proposal.producerVersion,
            this.clock(),
          );
        if (Number(inserted.changes) === 0) {
          db.prepare(
            "INSERT INTO memory_write_receipts(user_id,idempotency_key,memory_id,revision,created_at) VALUES(?,?,?,?,?)",
          ).run(
            userId,
            decision.idempotencyKey,
            current?.memoryId ?? null,
            current?.revision ?? null,
            this.clock(),
          );
          return current;
        }
      }
      const effective = this.policy.decide({
        proposal,
        current,
        eventType: proposal.eventType,
      });
      if (!effective.accepted) {
        db.prepare(
          "INSERT INTO memory_write_receipts(user_id,idempotency_key,memory_id,revision,created_at) VALUES(?,?,?,?,?)",
        ).run(
          userId,
          decision.idempotencyKey,
          current?.memoryId ?? null,
          current?.revision ?? null,
          this.clock(),
        );
        return current;
      }
      const record = this.reducer.reduce({
        userId,
        proposal,
        decision: {
          ...effective,
          targetMemoryId: current?.memoryId ?? effective.targetMemoryId,
        },
        current,
        now: this.clock(),
      });
      if (!record) return current;
      const payload = encodeJson(record);
      db.prepare(
        "INSERT INTO memory_records(user_id,memory_id,logical_key,kind,status,active,revision,updated_at,record_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,memory_id) DO UPDATE SET logical_key=excluded.logical_key,kind=excluded.kind,status=excluded.status,active=excluded.active,revision=excluded.revision,updated_at=excluded.updated_at,record_json=excluded.record_json",
      ).run(
        userId,
        record.memoryId,
        record.logicalKey,
        record.kind,
        record.status,
        record.active ? 1 : 0,
        record.revision,
        record.updatedAt,
        payload,
      );
      db.prepare(
        "INSERT INTO memory_revisions(user_id,memory_id,revision,created_at,record_json) VALUES(?,?,?,?,?)",
      ).run(
        userId,
        record.memoryId,
        record.revision,
        record.updatedAt,
        payload,
      );
      db.prepare(
        "DELETE FROM memory_evidence WHERE user_id=? AND memory_id=?",
      ).run(userId, record.memoryId);
      for (const ref of record.evidence) {
        const refKey = `${ref.namespace}|${ref.refId}|${ref.demoContentHash}|${ref.sessionId}|${ref.cueId}`;
        db.prepare(
          "INSERT INTO memory_evidence(user_id,memory_id,ref_key,evidence_json) VALUES(?,?,?,?)",
        ).run(userId, record.memoryId, refKey, encodeJson(ref));
      }
      if (record.preference) {
        db.prepare(
          "INSERT INTO user_preferences(user_id,preference_key,value_json,source,refs_json,label,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,preference_key) DO UPDATE SET value_json=excluded.value_json,source=excluded.source,refs_json=excluded.refs_json,label=excluded.label,updated_at=excluded.updated_at",
        ).run(
          userId,
          record.preference.key,
          JSON.stringify(record.preference.value),
          record.preference.source,
          encodeJson(record.preference.refs),
          record.preference.label ?? null,
          record.updatedAt,
        );
      }
      if (record.thread) {
        db.prepare(
          "INSERT INTO learning_threads(user_id,memory_id,thread_id,logical_key,status,active,revision,thread_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,memory_id,thread_id) DO UPDATE SET logical_key=excluded.logical_key,status=excluded.status,active=excluded.active,revision=excluded.revision,thread_json=excluded.thread_json,updated_at=excluded.updated_at",
        ).run(
          userId,
          record.memoryId,
          record.thread.threadId,
          record.logicalKey,
          record.status,
          record.active ? 1 : 0,
          record.revision,
          encodeJson(record.thread),
          record.updatedAt,
        );
      }
      if (record.status === "DELETED") {
        db.prepare(
          "DELETE FROM memory_revisions WHERE user_id=? AND memory_id=? AND revision<>?",
        ).run(userId, record.memoryId, record.revision);
        db.prepare(
          "INSERT INTO memory_tombstones(user_id,memory_id,logical_key,revision,deleted_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,memory_id) DO UPDATE SET revision=excluded.revision,deleted_at=excluded.deleted_at",
        ).run(
          userId,
          record.memoryId,
          record.logicalKey,
          record.revision,
          record.deletedAt ?? record.updatedAt,
        );
        db.prepare(
          "DELETE FROM memory_embeddings WHERE user_id=? AND memory_id=?",
        ).run(userId, record.memoryId);
        db.prepare(
          "DELETE FROM memory_evidence WHERE user_id=? AND memory_id=?",
        ).run(userId, record.memoryId);
        db.prepare(
          "DELETE FROM memory_observations WHERE user_id=? AND memory_id=?",
        ).run(userId, record.memoryId);
        db.prepare(
          "DELETE FROM learning_threads WHERE user_id=? AND memory_id=?",
        ).run(userId, record.memoryId);
        if (current?.preference)
          db.prepare(
            "DELETE FROM user_preferences WHERE user_id=? AND preference_key=?",
          ).run(userId, current.preference.key);
        const events = db
          .prepare(
            "SELECT event_id,event_json FROM memory_events WHERE user_id=? AND (target_memory_id=? OR logical_key=?)",
          )
          .all(userId, record.memoryId, record.logicalKey) as Array<{
          event_id: string;
          event_json: string;
        }>;
        for (const row of events) {
          db.prepare(
            "UPDATE memory_events SET status='DEAD_LETTER',event_json=?,error_code='MEMORY_DELETED' WHERE user_id=? AND event_id=?",
          ).run(
            JSON.stringify(
              redactedEvent(parseMemoryEvent(JSON.parse(row.event_json))),
            ),
            userId,
            row.event_id,
          );
        }
      }
      db.prepare(
        "UPDATE memory_cue_effects SET memory_id=? WHERE user_id=? AND session_id=? AND cue_id=? AND logical_key=? AND effect_type=?",
      ).run(
        record.memoryId,
        userId,
        proposal.origin.sessionId,
        proposal.origin.cueId,
        proposal.logicalKey,
        String(proposal.eventType),
      );
      db.prepare(
        "INSERT INTO memory_write_receipts(user_id,idempotency_key,memory_id,revision,created_at) VALUES(?,?,?,?,?)",
      ).run(
        userId,
        decision.idempotencyKey,
        record.memoryId,
        record.revision,
        this.clock(),
      );
      return record;
    });
  }
  async retrieveStructured(
    userIdInput: string,
    query?: MemoryQuery,
  ): Promise<readonly MemoryRecord[]> {
    const userId = assertId(userIdInput, "user_id");
    if (!isAuthorized(this.owner.db, userId)) return [];
    const rows = this.owner.db
      .prepare(
        "SELECT record_json FROM memory_records WHERE user_id=? ORDER BY updated_at DESC,memory_id ASC LIMIT 1000",
      )
      .all(userId) as Array<{ record_json: string }>;
    return rows
      .map((row) => parseRecordJson(row.record_json, userId))
      .filter((record) => matches(record, query))
      .slice(0, boundedLimit(query?.limit));
  }
  async retrieveSemantic(
    userIdInput: string,
    query: SemanticMemoryQuery,
  ): Promise<readonly MemoryRecord[]> {
    const userId = assertId(userIdInput, "user_id");
    if (!isAuthorized(this.owner.db, userId) || !query.embedding) return [];
    let q;
    try {
      q = vectorBlob(query.embedding);
    } catch {
      return [];
    }
    const candidateQuery = { ...query, limit: MAX_SEMANTIC_CANDIDATES };
    const candidates = await this.retrieveStructured(userId, candidateQuery);
    if (candidates.length === 0) return [];
    const byId = new Map(candidates.map((record) => [record.memoryId, record]));
    const rows = this.owner.db
      .prepare(
        `SELECT memory_id,dimension,norm,source_revision,vector_blob FROM memory_embeddings WHERE user_id=? AND deleted_at IS NULL AND memory_id IN (${candidates.map(() => "?").join(",")})`,
      )
      .all(userId, ...candidates.map((record) => record.memoryId)) as Array<{
      memory_id: string;
      dimension: number;
      norm: number;
      source_revision: number;
      vector_blob: unknown;
    }>;
    const scored: Array<{ record: MemoryRecord; score: number }> = [];
    for (const row of rows) {
      const record = byId.get(row.memory_id);
      if (
        !record ||
        row.dimension !== query.embedding.length ||
        row.source_revision !== record.revision ||
        !Number.isFinite(row.norm) ||
        row.norm <= 0
      )
        continue;
      const vector = decodeVector(row.vector_blob, row.dimension);
      if (!vector) continue;
      let dot = 0;
      for (let i = 0; i < vector.length; i++)
        dot += vector[i] * query.embedding[i];
      const score = dot / (row.norm * q.norm);
      if (Number.isFinite(score) && score >= (query.minScore ?? -1))
        scored.push({ record, score });
    }
    return scored
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.record.updatedAt.localeCompare(a.record.updatedAt) ||
          a.record.memoryId.localeCompare(b.record.memoryId),
      )
      .slice(0, boundedLimit(query.limit))
      .map((item) => item.record);
  }
  async getLearningThreads(userId: string, query?: LearningThreadQuery) {
    const records = await this.retrieveStructured(userId, {
      ...query,
      limit: query?.limit ?? 100,
    });
    return records
      .filter(
        (record) =>
          record.thread &&
          (query?.includeCandidates || record.active) &&
          !(
            !query?.includeDeleted &&
            [
              "DELETED",
              "DISPUTED",
              "SUPERSEDED",
              "ARCHIVED",
              "RESOLVED",
            ].includes(record.status)
          ),
      )
      .filter(
        (record) =>
          !query?.diagnosisType ||
          record.thread?.diagnosis.type === query.diagnosisType,
      )
      .map((record) => record.thread!);
  }
  private managementProposal(
    userId: string,
    current: MemoryRecord,
    operation: "CORRECT" | "DELETE" | "CONFIRM",
    input?: MemoryCorrectionInput | MemoryDeleteInput | MemoryConfirmation,
  ): MemoryProposal {
    const createdAt =
      (input && "deletedAt" in input
        ? input.deletedAt
        : input && "confirmedAt" in input
          ? input.confirmedAt
          : undefined) ?? this.clock();
    const source = current.sourceRefs[0] ?? {
      namespace: "SESSION" as const,
      refId: current.memoryId,
      demoContentHash: "memory-management",
      sessionId: "memory-management",
      cueId: "memory-management",
    };
    const token = stableMemoryToken(
      `${userId}|${current.memoryId}|${operation}|${operation === "CORRECT" ? ((input as MemoryCorrectionInput).correctionId ?? (input as MemoryCorrectionInput).content) : ""}`,
    );
    return {
      schemaVersion: MEMORY_PROPOSAL_VERSION,
      proposalId: `${operation.toLowerCase()}-${token}`,
      userId,
      operation,
      eventType:
        operation === "CORRECT"
          ? "USER_CORRECTED_COACH"
          : operation === "DELETE"
            ? "MEMORY_DELETED"
            : "USER_CONFIRMED",
      targetMemoryId: current.memoryId,
      requestedScope: "CROSS_DEMO",
      kind: current.kind,
      logicalKey: current.logicalKey,
      ...(current.thread ? { thread: current.thread } : {}),
      claims: current.claims,
      ...(current.verdict ? { verdict: current.verdict } : {}),
      ...(current.transferRule ? { transferRule: current.transferRule } : {}),
      ...(current.preference ? { preference: current.preference } : {}),
      ...(current.profile ? { profile: current.profile } : {}),
      origin: {
        sessionId: source.sessionId,
        demoContentHash: source.demoContentHash,
        cueId: source.cueId,
        typedSourceRefs: current.sourceRefs.length
          ? current.sourceRefs
          : [source],
      },
      lifecycle: operation === "DELETE" ? "DELETED" : current.status,
      consentState: "GRANTED",
      producerVersion: "memory-domain.v1",
      idempotencyKey: `${operation.toLowerCase()}-idem-${token}`,
      createdAt,
      ...(operation === "CORRECT"
        ? {
            correction: {
              correctionId:
                (input as MemoryCorrectionInput).correctionId ??
                `correction-${token}`,
              content: (input as MemoryCorrectionInput).content,
              source: "USER" as const,
            },
          }
        : {}),
      ...(operation === "DELETE" &&
      (input as MemoryDeleteInput | undefined)?.reason
        ? { deleteReason: (input as MemoryDeleteInput).reason }
        : {}),
    };
  }
  private async manage(
    userIdInput: string,
    memoryIdInput: string,
    operation: "CORRECT" | "DELETE" | "CONFIRM",
    input?: MemoryCorrectionInput | MemoryDeleteInput | MemoryConfirmation,
  ): Promise<MemoryRecord | undefined> {
    const userId = assertId(userIdInput, "user_id"),
      memoryId = assertId(memoryIdInput, "memory_id");
    const current = await this.getRecordVersion(
      userId,
      memoryId,
      undefined,
      operation === "DELETE",
    );
    if (!current || current.status === "DELETED") return current;
    const proposal = this.managementProposal(userId, current, operation, input);
    const decision = this.policy.decide({
      proposal,
      current,
      eventType: proposal.eventType,
    });
    return this.applyWriteDecision(userId, {
      ...decision,
      record: this.reducer.reduce({
        userId,
        proposal,
        decision,
        current,
        now: proposal.createdAt,
      }),
    });
  }
  correctMemory(
    userId: string,
    memoryId: string,
    correction: MemoryCorrectionInput,
  ) {
    return this.manage(userId, memoryId, "CORRECT", correction);
  }
  deleteMemory(userId: string, memoryId: string, input?: MemoryDeleteInput) {
    return this.manage(userId, memoryId, "DELETE", input);
  }
  confirmMemory(
    userId: string,
    memoryId: string,
    confirmation?: MemoryConfirmation,
  ) {
    return this.manage(userId, memoryId, "CONFIRM", confirmation);
  }
  async invalidatePendingMemory(
    userIdInput: string,
    memoryIdInput: string,
    logicalKeyInput?: string,
  ): Promise<readonly string[]> {
    const userId = assertId(userIdInput, "user_id"),
      memoryId = assertId(memoryIdInput, "memory_id"),
      logicalKey = logicalKeyInput
        ? assertId(logicalKeyInput, "logical_key")
        : undefined;
    return this.owner.enqueueWrite((db) => {
      requireAuthorization(db, userId, true);
      const rows = db
        .prepare(
          "SELECT event_id,session_id,event_json FROM memory_events WHERE user_id=? AND (target_memory_id=? OR logical_key=?)",
        )
        .all(userId, memoryId, logicalKey ?? "") as Array<{
        event_id: string;
        session_id: string;
        event_json: string;
      }>;
      for (const row of rows) {
        const event = parseMemoryEvent(JSON.parse(row.event_json));
        db.prepare(
          "UPDATE memory_events SET status='DEAD_LETTER',event_json=?,error_code='MEMORY_DELETED' WHERE user_id=? AND event_id=?",
        ).run(JSON.stringify(redactedEvent(event)), userId, row.event_id);
      }
      return [
        ...new Set(
          rows
            .map((row) => row.session_id)
            .filter((id) => !id.startsWith("memory-")),
        ),
      ];
    });
  }
  async purgeMemoryResidue(
    userIdInput: string,
    memoryIdInput: string,
  ): Promise<void> {
    const userId = assertId(userIdInput, "user_id"),
      memoryId = assertId(memoryIdInput, "memory_id");
    await this.owner.enqueueWrite((db) => {
      requireAuthorization(db, userId, true);
      db.prepare(
        "DELETE FROM memory_embeddings WHERE user_id=? AND memory_id=?",
      ).run(userId, memoryId);
      db.prepare(
        "DELETE FROM memory_evidence WHERE user_id=? AND memory_id=?",
      ).run(userId, memoryId);
      db.prepare(
        "DELETE FROM memory_observations WHERE user_id=? AND memory_id=?",
      ).run(userId, memoryId);
      db.prepare(
        "DELETE FROM learning_threads WHERE user_id=? AND memory_id=?",
      ).run(userId, memoryId);
    });
  }
  async purgeUserMemoryResidue(
    userIdInput: string,
  ): Promise<readonly string[]> {
    const userId = assertId(userIdInput, "user_id");
    return this.owner.enqueueWrite((db) => {
      requireAuthorization(db, userId, true);
      const deletedAt = this.clock();
      const currentRecords = db
        .prepare(
          "SELECT record_json FROM memory_records WHERE user_id=? AND status!='DELETED' ORDER BY memory_id",
        )
        .all(userId) as Array<{ record_json: string }>;
      for (const row of currentRecords) {
        const current = parseRecordJson(row.record_json, userId);
        const proposal = this.managementProposal(userId, current, "DELETE", {
          reason: "用户请求清除全部长期记忆",
          deletedAt,
        });
        const decision = this.policy.decide({
          proposal,
          current,
          eventType: "MEMORY_DELETED",
        });
        const tombstone = this.reducer.reduce({
          userId,
          proposal,
          decision,
          current,
          now: deletedAt,
        });
        if (!tombstone || tombstone.status !== "DELETED")
          throw new Error("MEMORY_DELETE_ALL_REDUCER_FAILED");
        const payload = encodeJson(tombstone);
        db.prepare(
          "UPDATE memory_records SET kind=?,status='DELETED',active=0,revision=?,updated_at=?,record_json=? WHERE user_id=? AND memory_id=?",
        ).run(
          tombstone.kind,
          tombstone.revision,
          tombstone.updatedAt,
          payload,
          userId,
          tombstone.memoryId,
        );
        db.prepare(
          "DELETE FROM memory_revisions WHERE user_id=? AND memory_id=?",
        ).run(userId, tombstone.memoryId);
        db.prepare(
          "INSERT INTO memory_revisions(user_id,memory_id,revision,created_at,record_json) VALUES(?,?,?,?,?)",
        ).run(
          userId,
          tombstone.memoryId,
          tombstone.revision,
          tombstone.updatedAt,
          payload,
        );
        db.prepare(
          "INSERT INTO memory_tombstones(user_id,memory_id,logical_key,revision,deleted_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,memory_id) DO UPDATE SET revision=excluded.revision,deleted_at=excluded.deleted_at",
        ).run(
          userId,
          tombstone.memoryId,
          tombstone.logicalKey,
          tombstone.revision,
          deletedAt,
        );
        db.prepare(
          "INSERT OR IGNORE INTO memory_write_receipts(user_id,idempotency_key,memory_id,revision,created_at) VALUES(?,?,?,?,?)",
        ).run(
          userId,
          proposal.idempotencyKey,
          tombstone.memoryId,
          tombstone.revision,
          deletedAt,
        );
      }
      const rows = db
        .prepare(
          "SELECT DISTINCT session_id FROM memory_events WHERE user_id=?",
        )
        .all(userId) as Array<{ session_id: string }>;
      const events = db
        .prepare(
          "SELECT event_id,event_json FROM memory_events WHERE user_id=?",
        )
        .all(userId) as Array<{ event_id: string; event_json: string }>;
      for (const row of events) {
        const event = parseMemoryEvent(JSON.parse(row.event_json));
        db.prepare(
          "UPDATE memory_events SET status='DEAD_LETTER',event_json=?,error_code='USER_MEMORY_PURGED' WHERE user_id=? AND event_id=?",
        ).run(JSON.stringify(redactedEvent(event)), userId, row.event_id);
      }
      db.prepare("DELETE FROM memory_embeddings WHERE user_id=?").run(userId);
      db.prepare("DELETE FROM memory_evidence WHERE user_id=?").run(userId);
      db.prepare("DELETE FROM memory_observations WHERE user_id=?").run(userId);
      db.prepare("DELETE FROM learning_threads WHERE user_id=?").run(userId);
      db.prepare("DELETE FROM user_preferences WHERE user_id=?").run(userId);
      db.prepare(
        "UPDATE app_users SET memory_deleted_at=?,updated_at=? WHERE user_id=?",
      ).run(deletedAt, deletedAt, userId);
      return rows
        .map((row) => row.session_id)
        .filter((id) => !id.startsWith("memory-"));
    });
  }
  listMemories(userId: string, query?: MemoryQuery) {
    return this.retrieveStructured(userId, query);
  }
  async listMemoryIdsForDeletion(
    userIdInput: string,
    limit = 100,
  ): Promise<readonly string[]> {
    const userId = assertId(userIdInput, "user_id");
    if (!isAuthorized(this.owner.db, userId, true)) return [];
    return (
      this.owner.db
        .prepare(
          "SELECT memory_id FROM memory_records WHERE user_id=? AND status!='DELETED' ORDER BY memory_id LIMIT ?",
        )
        .all(userId, Math.max(0, Math.min(1000, Math.floor(limit)))) as Array<{
        memory_id: string;
      }>
    ).map((row) => row.memory_id);
  }
  async listMemorySessionIds(userIdInput: string): Promise<readonly string[]> {
    const userId = assertId(userIdInput, "user_id");
    if (!isAuthorized(this.owner.db, userId, true)) return [];
    return (
      this.owner.db
        .prepare(
          "SELECT DISTINCT session_id FROM memory_events WHERE user_id=? ORDER BY session_id",
        )
        .all(userId) as Array<{ session_id: string }>
    )
      .map((row) => row.session_id)
      .filter((id) => !id.startsWith("memory-"));
  }
  async saveEmbedding(
    userIdInput: string,
    input: MemoryEmbeddingWrite,
  ): Promise<void> {
    const userId = assertId(userIdInput, "user_id"),
      memoryId = assertId(input.memoryId, "memory_id"),
      model = assertId(input.model, "embedding_model"),
      contentHash = assertId(input.contentHash, "content_hash");
    const encoded = vectorBlob(input.embedding);
    await this.owner.enqueueWrite((db) => {
      requireAuthorization(db, userId);
      const current = currentByMemory(db, userId, memoryId);
      if (
        !current ||
        current.status === "DELETED" ||
        current.revision !== input.sourceRevision
      )
        return;
      db.prepare(
        "INSERT INTO memory_embeddings(user_id,memory_id,dimension,norm,model,content_hash,source_revision,vector_blob,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(user_id,memory_id) DO UPDATE SET dimension=excluded.dimension,norm=excluded.norm,model=excluded.model,content_hash=excluded.content_hash,source_revision=excluded.source_revision,vector_blob=excluded.vector_blob,created_at=excluded.created_at,deleted_at=NULL",
      ).run(
        userId,
        memoryId,
        input.embedding.length,
        encoded.norm,
        model,
        contentHash,
        input.sourceRevision,
        encoded.blob,
        input.createdAt ?? this.clock(),
      );
    });
  }
  async deleteMemoryEmbedding(
    userIdInput: string,
    memoryIdInput: string,
    deletedAt = this.clock(),
  ): Promise<void> {
    const userId = assertId(userIdInput, "user_id"),
      memoryId = assertId(memoryIdInput, "memory_id");
    await this.owner.enqueueWrite((db) => {
      requireAuthorization(db, userId, true);
      db.prepare(
        "UPDATE memory_embeddings SET deleted_at=? WHERE user_id=? AND memory_id=?",
      ).run(deletedAt, userId, memoryId);
    });
  }
  async exportUserData(userIdInput: string): Promise<{
    schemaVersion: "memory-export.v1";
    exportedAt: string;
    authorization?: MemoryAuthorization;
    records: readonly MemoryRecord[];
    events: readonly MemoryEvent[];
  }> {
    const userId = assertId(userIdInput, "user_id");
    if (!isAuthorized(this.owner.db, userId, true))
      return {
        schemaVersion: "memory-export.v1",
        exportedAt: this.clock(),
        records: [],
        events: [],
      };
    const authorization = await this.getAuthorization(userId);
    const records = (
      this.owner.db
        .prepare(
          "SELECT record_json FROM memory_records WHERE user_id=? ORDER BY memory_id",
        )
        .all(userId) as Array<{ record_json: string }>
    ).map((row) => parseRecordJson(row.record_json, userId));
    const events = (
      this.owner.db
        .prepare(
          "SELECT event_json FROM memory_events WHERE user_id=? ORDER BY created_at,event_id",
        )
        .all(userId) as Array<{ event_json: string }>
    ).map((row) => parseMemoryEvent(JSON.parse(row.event_json)));
    return {
      schemaVersion: "memory-export.v1",
      exportedAt: this.clock(),
      ...(authorization ? { authorization } : {}),
      records,
      events,
    };
  }
  async upsertObservation(
    userIdInput: string,
    input: SqliteMemoryObservationInput,
  ): Promise<SqliteObservationWriteResult> {
    const userId = assertId(userIdInput, "user_id"),
      sessionId = assertId(input.sessionId, "session_id"),
      cueId = assertId(input.cueId, "cue_id"),
      taxonomyCode = assertId(input.taxonomyCode, "taxonomy_code"),
      demoContentHash = assertId(input.demoContentHash, "demo_content_hash"),
      observationId = assertId(
        input.observationId ??
          `observation-${stableMemoryToken(`${userId}|${sessionId}|${cueId}|${taxonomyCode}`)}`,
        "observation_id",
      ),
      createdAt = input.createdAt ?? this.clock();
    const payload = (input.payload ?? {}) as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("INVALID_OBSERVATION_PAYLOAD");
    const sourceJson =
      input.sourceRef === undefined ? null : encodeJson(input.sourceRef);
    const payloadJson = encodeJson(payload);
    return this.owner.enqueueWrite((db) => {
      requireAuthorization(db, userId);
      if (input.memoryId) {
        const current = currentByMemory(
          db,
          userId,
          assertId(input.memoryId, "memory_id"),
        );
        if (!current || current.status === "DELETED")
          throw new Error("MEMORY_OBSERVATION_TARGET_NOT_FOUND");
      }
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO memory_observations(user_id,observation_id,memory_id,session_id,cue_id,taxonomy_code,demo_content_hash,source_ref_json,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          userId,
          observationId,
          input.memoryId ?? null,
          sessionId,
          cueId,
          taxonomyCode,
          demoContentHash,
          sourceJson,
          payloadJson,
          createdAt,
        );
      const row = db
        .prepare(
          "SELECT * FROM memory_observations WHERE user_id=? AND session_id=? AND cue_id=? AND taxonomy_code=?",
        )
        .get(userId, sessionId, cueId, taxonomyCode) as Record<string, unknown>;
      return {
        inserted: Number(result.changes) > 0,
        observation: {
          userId,
          observationId: String(row.observation_id),
          sessionId: String(row.session_id),
          cueId: String(row.cue_id),
          taxonomyCode: String(row.taxonomy_code),
          demoContentHash: String(row.demo_content_hash),
          ...(row.memory_id ? { memoryId: String(row.memory_id) } : {}),
          ...(row.source_ref_json
            ? { sourceRef: JSON.parse(String(row.source_ref_json)) }
            : {}),
          payload: JSON.parse(String(row.payload_json)) as Record<
            string,
            unknown
          >,
          createdAt: String(row.created_at),
        },
      };
    });
  }
  recordObservation(userId: string, input: SqliteMemoryObservationInput) {
    return this.upsertObservation(userId, input);
  }
  appendObservation(userId: string, input: SqliteMemoryObservationInput) {
    return this.upsertObservation(userId, input);
  }
}

export const createSqliteMemoryRepository = (
  options: SqliteMemoryRepositoryOptions = {},
): SqliteMemoryRepository => new SqliteMemoryRepository(options);
