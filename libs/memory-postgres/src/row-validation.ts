import {
  MemoryLearningThreadSchema,
  MemoryRecordSchema,
  MemorySourceRefSchema,
  parseLearningThread,
  type MemoryRecord,
} from "@cs-coach/memory";
import { MemoryRowValidationError } from "./errors";

export type SqlRow = Record<string, unknown>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function textOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : String(value);
}

function jsonField(row: SqlRow, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in row) return decodeJson(row[key]);
  }
  return undefined;
}

function recordPayloadFromColumns(row: SqlRow): unknown {
  const direct = jsonField(row, "record_payload", "recordPayload", "payload", "record");
  if (direct !== undefined && isObject(direct) && "schemaVersion" in direct) return direct;

  return {
    schemaVersion: row.schemaVersion ?? row.schema_version,
    memoryId: row.memoryId ?? row.memory_id,
    userId: row.userId ?? row.user_id,
    kind: row.kind,
    source: row.source,
    scope: row.scope,
    logicalKey: row.logicalKey ?? row.logical_key,
    status: row.status,
    active: row.active,
    revision: row.revision,
    ...(textOrUndefined(row.content) ? { content: textOrUndefined(row.content) } : {}),
    ...(textOrUndefined(row.summary) ? { summary: textOrUndefined(row.summary) } : {}),
    ...(jsonField(row, "thread", "thread_payload") !== undefined ? { thread: jsonField(row, "thread", "thread_payload") } : {}),
    claims: jsonField(row, "claims", "claims_json") ?? [],
    ...(jsonField(row, "verdict", "verdict_json") !== undefined ? { verdict: jsonField(row, "verdict", "verdict_json") } : {}),
    ...(jsonField(row, "transferRule", "transfer_rule_json") !== undefined ? { transferRule: jsonField(row, "transferRule", "transfer_rule_json") } : {}),
    ...(jsonField(row, "preference", "preference_json") !== undefined ? { preference: jsonField(row, "preference", "preference_json") } : {}),
    facts: jsonField(row, "facts", "facts_json") ?? [],
    inferences: jsonField(row, "inferences", "inferences_json") ?? [],
    advice: jsonField(row, "advice", "advice_json") ?? [],
    evidence: jsonField(row, "evidence", "evidence_json") ?? [],
    counterEvidenceRefs: jsonField(row, "counterEvidenceRefs", "counter_evidence_refs_json") ?? [],
    sourceRefs: jsonField(row, "sourceRefs", "source_refs_json") ?? [],
    demoContentHashes: jsonField(row, "demoContentHashes", "demo_content_hashes_json") ?? [],
    corrections: jsonField(row, "corrections", "corrections_json") ?? [],
    ...(textOrUndefined(row.previousRevisionId ?? row.previous_revision_id) ? { previousRevisionId: textOrUndefined(row.previousRevisionId ?? row.previous_revision_id) } : {}),
    createdAt: textOrUndefined(row.createdAt ?? row.created_at),
    updatedAt: textOrUndefined(row.updatedAt ?? row.updated_at),
    ...(textOrUndefined(row.confirmedAt ?? row.confirmed_at) ? { confirmedAt: textOrUndefined(row.confirmedAt ?? row.confirmed_at) } : {}),
    ...(textOrUndefined(row.deletedAt ?? row.deleted_at) ? { deletedAt: textOrUndefined(row.deletedAt ?? row.deleted_at) } : {}),
    ...(jsonField(row, "tombstone", "tombstone_json") !== undefined ? { tombstone: jsonField(row, "tombstone", "tombstone_json") } : {}),
    limitations: jsonField(row, "limitations", "limitations_json") ?? [],
    producerVersion: row.producerVersion ?? row.producer_version,
    lastIdempotencyKey: row.lastIdempotencyKey ?? row.last_idempotency_key,
  };
}

/** Parse every JSONB/array field and validate the complete domain envelope. */
export function parseMemoryRow(row: unknown, userId: string): MemoryRecord {
  if (!isObject(row)) throw new MemoryRowValidationError(userId);
  const rowUserId = row.userId ?? row.user_id;
  if (rowUserId !== undefined && String(rowUserId) !== userId) {
    throw new MemoryRowValidationError(userId, "PostgreSQL row crossed the requested user boundary");
  }
  const parsed = MemoryRecordSchema.safeParse(recordPayloadFromColumns(row));
  if (!parsed.success || parsed.data.userId !== userId) {
    throw new MemoryRowValidationError(userId);
  }
  return parsed.data as unknown as MemoryRecord;
}

export function parseThreadRow(row: unknown, userId: string): NonNullable<MemoryRecord["thread"]> {
  if (!isObject(row)) throw new MemoryRowValidationError(userId);
  const rowUserId = row.userId ?? row.user_id;
  if (rowUserId !== undefined && String(rowUserId) !== userId) {
    throw new MemoryRowValidationError(userId, "PostgreSQL thread row crossed the requested user boundary");
  }
  const payload = decodeJson(row.thread_payload ?? row.threadPayload ?? row.payload ?? row.thread);
  const parsed = MemoryLearningThreadSchema.safeParse(payload);
  if (!parsed.success) throw new MemoryRowValidationError(userId, "PostgreSQL returned an invalid learning thread");
  return parseLearningThread(parsed.data) as NonNullable<MemoryRecord["thread"]>;
}

export function parseSourceRef(value: unknown, userId: string) {
  const parsed = MemorySourceRefSchema.safeParse(decodeJson(value));
  if (!parsed.success) throw new MemoryRowValidationError(userId, "PostgreSQL returned an invalid evidence reference");
  return parsed.data;
}
