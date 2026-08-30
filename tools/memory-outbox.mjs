// The production/Cloudflare bundle resolves the workspace package name.  The
// repository root intentionally does not depend on every workspace package,
// so standalone Node/Vitest runs use the package's source as a local fallback
// without adding a root runtime dependency.
const { MemoryEventSchema } = await import("@cs-coach/memory")
  .catch(() => import("../libs/memory/src/index.ts"));

/**
 * The Durable Object checkpoint saver deliberately owns a different keyspace
 * from this outbox.  Keeping the prefixes explicit makes it hard to
 * accidentally prune a checkpoint while compacting memory events.
 */
export const MEMORY_OUTBOX_VERSION = "memory-outbox.v1";
export const MEMORY_OUTBOX_PREFIX = "coach-agent:memory-outbox:";
export const MEMORY_OUTBOX_ENTRY_PREFIX = `${MEMORY_OUTBOX_PREFIX}entry:`;
export const MEMORY_OUTBOX_STATUS = Object.freeze({
  PENDING: "PENDING",
  DELIVERED: "DELIVERED",
  RETRY: "RETRY",
  DEAD_LETTER: "DEAD_LETTER",
});

export const DEFAULT_MEMORY_OUTBOX_MAX_ATTEMPTS = 5;
export const DEFAULT_MEMORY_OUTBOX_BASE_DELAY_MS = 1_000;
export const DEFAULT_MEMORY_OUTBOX_MAX_DELAY_MS = 60_000;
export const DEFAULT_MEMORY_OUTBOX_BATCH_SIZE = 16;
export const MAX_MEMORY_OUTBOX_EVENT_BYTES = 32 * 1024;
export const MAX_MEMORY_OUTBOX_ERROR_CODE = 80;
export const DEFAULT_MEMORY_OUTBOX_PRUNE_BATCH = 100;
export const MAX_MEMORY_OUTBOX_PRUNE_BATCH = 1_000;
export const MAX_MEMORY_OUTBOX_RETAINED_TERMINAL = 10_000;

/** The small storage surface implemented by Cloudflare Durable Object storage. */
/** @typedef {{ get: Function, put: Function, delete?: Function, list: Function }} MemoryOutboxStorage */

/**
 * @typedef {Object} MemoryOutboxEntry
 * @property {typeof MEMORY_OUTBOX_VERSION} schemaVersion
 * @property {string} entryId
 * @property {import("@cs-coach/memory").MemoryEvent} event
 * @property {"PENDING"|"DELIVERED"|"RETRY"|"DEAD_LETTER"} status
 * @property {number} attemptCount
 * @property {string|null} nextAttemptAt
 * @property {string|null} lastErrorCode
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string|null} deliveredAt
 */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nowMilliseconds(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function iso(value) {
  return new Date(nowMilliseconds(value)).toISOString();
}

function pruneCutoff(value) {
  if (value === undefined) return undefined;
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error("INVALID_MEMORY_OUTBOX_PRUNE_CUTOFF");
  return parsed;
}

function pruneLimit(value, fallback = DEFAULT_MEMORY_OUTBOX_PRUNE_BATCH) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new Error("INVALID_MEMORY_OUTBOX_PRUNE_LIMIT");
  return Math.min(value, MAX_MEMORY_OUTBOX_PRUNE_BATCH);
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function retainedLimit(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new Error("INVALID_MEMORY_OUTBOX_MAX_RETAINED");
  return Math.min(value, MAX_MEMORY_OUTBOX_RETAINED_TERMINAL);
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function encoded(value) {
  return encodeURIComponent(String(value));
}

function entryKey(entryId) {
  return `${MEMORY_OUTBOX_ENTRY_PREFIX}${encoded(entryId)}`;
}

function errorCode(error) {
  const candidate = error && typeof error === "object" && "code" in error
    ? error.code
    : error && typeof error === "object" && "name" in error
      ? error.name
      : "SINK_ERROR";
  const normalized = String(candidate ?? "SINK_ERROR")
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, MAX_MEMORY_OUTBOX_ERROR_CODE);
  return normalized || "SINK_ERROR";
}

function sortedEntries(values) {
  return values
    .filter(Boolean)
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.entryId.localeCompare(right.entryId),
    );
}

function deepForbiddenKey(value, seen = new Set()) {
  if (!isRecord(value) && !Array.isArray(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  const forbidden = new Set([
    "rawDemo",
    "raw_demo",
    "demoBytes",
    "demo_bytes",
    "frames",
    "fullReplay",
    "full_replay",
    "replay",
    "ticks",
    "tickStream",
    "tick_stream",
    "prompt",
    "chainOfThought",
    "chain_of_thought",
    "cot",
    "cookie",
    "apiKey",
    "api_key",
    "secret",
  ]);
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = deepForbiddenKey(item, seen);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (forbidden.has(key)) return key;
    const nested = deepForbiddenKey(nestedValue, seen);
    if (nested) return nested;
  }
  return null;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function normalizeProposalTimestamps(value) {
  if (Array.isArray(value)) return value.map(normalizeProposalTimestamps);
  if (!isRecord(value)) return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "createdAt" && value.schemaVersion === "memory-proposal.v1") continue;
    next[key] = key === "proposal" ? normalizeProposalTimestamps(child) : child;
  }
  return next;
}

function equivalentEvent(left, right) {
  const comparable = (event) => {
    const {
      eventId: _eventId,
      idempotencyKey: _idempotencyKey,
      createdAt: _createdAt,
      attemptCount: _attemptCount,
      nextAttemptAt: _nextAttemptAt,
      ...rest
    } = event;
    void _eventId;
    void _idempotencyKey;
    void _createdAt;
    void _attemptCount;
    void _nextAttemptAt;
    return { ...rest, payload: normalizeProposalTimestamps(rest.payload) };
  };
  return stableJson(comparable(left)) === stableJson(comparable(right));
}

function parsedEvent(input) {
  const event = MemoryEventSchema.parse(input);
  const forbidden = deepForbiddenKey(event);
  if (forbidden) throw new Error(`MEMORY_EVENT_FORBIDDEN_FIELD:${forbidden}`);
  if (byteLength(event) > MAX_MEMORY_OUTBOX_EVENT_BYTES) {
    throw new Error("MEMORY_EVENT_TOO_LARGE");
  }
  return event;
}

/**
 * Replace a queued event's payload with a minimal, still schema-valid
 * envelope once consent/deletion invalidates it.  Keeping the event and
 * idempotency metadata lets operators inspect delivery state without leaving
 * user-authored correction text or proposal snapshots in Durable Object
 * storage.  Management target/operation fields are opaque routing metadata
 * and are retained so the redacted envelope remains parseable.
 */
function redactedMemoryEvent(event) {
  const type = event.type ?? event.eventType;
  const payload = type === "SESSION_COMPLETED"
    ? { reason: "SESSION_COMPLETED" }
    : { reason: "MEMORY_DELETED" };
  return parsedEvent({
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    ...(event.type ? { type: event.type } : {}),
    ...(event.eventType ? { eventType: event.eventType } : {}),
    userId: event.userId,
    sessionId: event.sessionId,
    ...(event.demoContentHash ? { demoContentHash: event.demoContentHash } : {}),
    ...(event.proposalId ? { proposalId: event.proposalId } : {}),
    ...(event.targetMemoryId ? { targetMemoryId: event.targetMemoryId } : {}),
    ...(event.operation ? { operation: event.operation } : {}),
    idempotencyKey: event.idempotencyKey,
    producerVersion: event.producerVersion,
    payload,
    createdAt: event.createdAt,
  });
}

function normalizeEntry(value) {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== MEMORY_OUTBOX_VERSION) return undefined;
  if (typeof value.entryId !== "string" || !value.entryId) return undefined;
  const event = parsedEvent(value.event);
  if (!Object.values(MEMORY_OUTBOX_STATUS).includes(value.status)) return undefined;
  if (!Number.isInteger(value.attemptCount) || value.attemptCount < 0) return undefined;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return undefined;
  return {
    schemaVersion: MEMORY_OUTBOX_VERSION,
    entryId: value.entryId,
    event,
    status: value.status,
    attemptCount: value.attemptCount,
    nextAttemptAt: value.nextAttemptAt === null || value.nextAttemptAt === undefined ? null : String(value.nextAttemptAt),
    lastErrorCode: value.lastErrorCode === null || value.lastErrorCode === undefined ? null : errorCode({ code: value.lastErrorCode }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    deliveredAt: value.deliveredAt === null || value.deliveredAt === undefined ? null : String(value.deliveredAt),
  };
}

function eventIdentity(entry) {
  return {
    eventId: entry.event.eventId,
    idempotencyKey: entry.event.idempotencyKey,
  };
}

async function invokeSink(sink, event, entry) {
  if (typeof sink === "function") return sink(event, entry);
  if (sink && typeof sink.deliver === "function") return sink.deliver(event, entry);
  if (sink && typeof sink.send === "function") return sink.send(event, entry);
  if (sink && typeof sink.ingestEvent === "function") return sink.ingestEvent(event.userId, event);
  throw Object.assign(new Error("MEMORY_SINK_UNAVAILABLE"), { code: "SINK_UNAVAILABLE" });
}

function idempotentSinkResult(result) {
  if (!result || typeof result !== "object" || result.accepted !== false) return false;
  if (result.idempotent === true || result.converged === true) return true;
  const decision = result.decision && typeof result.decision === "object" ? result.decision : undefined;
  const decisionReason = decision?.reason;
  const resultReason = result.reason;
  const isTerminalCode = (value) => ["DUPLICATE_IDEMPOTENCY", "DELETED_TOMBSTONE"].includes(
    String(value ?? "").trim().toUpperCase(),
  );
  // A tombstone may be present even when the service reports a retryable host
  // or persistence failure. Do not hide that failure behind the terminal
  // tombstone shape; only a clean, explicitly idempotent result converges.
  if (result.errorCode !== undefined) {
    return isTerminalCode(result.errorCode) && decisionReason === undefined && resultReason === undefined;
  }
  const reason = decisionReason ?? resultReason;
  if (isTerminalCode(reason)) return true;
  if (resultReason !== undefined) return false;
  // A repeated MEMORY_DELETED control event can return the existing tombstone
  // with an ACCEPTED decision while still reporting accepted:false at the
  // service boundary. That is already the desired terminal state.
  return decision?.action === "DELETE" && decision?.status === "DELETED";
}

function consentVetoCode(value) {
  const candidate = String(value ?? "").trim().toUpperCase();
  return [
    "CONSENT_REVOKED",
    "CONSENT_REQUIRED",
    "CONSENT_VERSION_STALE",
    "MEMORY_DISABLED",
  ].includes(candidate)
    ? "CONSENT_REVOKED"
    : undefined;
}

function rejectedSinkResult(result) {
  if (!result || typeof result !== "object" || result.accepted !== false || idempotentSinkResult(result)) return;
  const rawCode = result.errorCode ?? result.reason ?? "SINK_REJECTED";
  const code = String(rawCode).replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, MAX_MEMORY_OUTBOX_ERROR_CODE) || "SINK_REJECTED";
  const consentCode = consentVetoCode(result.errorCode ?? result.reason ?? result.decision?.reason);
  if (consentCode) {
    throw Object.assign(new Error(`MEMORY_SINK_REJECTED_${consentCode}`), { code: consentCode });
  }
  throw Object.assign(new Error(`MEMORY_SINK_REJECTED_${code}`), { code: `SINK_REJECTED_${code}` });
}

async function assertSinkResult(result) {
  if (result === false) throw Object.assign(new Error("MEMORY_SINK_REJECTED"), { code: "SINK_REJECTED" });
  if (result && typeof result === "object" && typeof result.ok === "boolean" && !result.ok) {
    throw Object.assign(new Error("MEMORY_SINK_REJECTED"), { code: "SINK_REJECTED" });
  }
  // The Memory API intentionally returns HTTP 200 for a well-formed request
  // that the authorization/repository layer declined. A genuine rejection is
  // therefore a retry/dead-letter signal; the bounded error code is retained
  // for audit. Explicit idempotent convergence is handled as success above,
  // because the first attempt may already have committed the projection.
  rejectedSinkResult(result);
  if (result && typeof result === "object" && typeof result.status === "number" && result.status >= 400) {
    throw Object.assign(new Error("MEMORY_SINK_HTTP_ERROR"), { code: `HTTP_${result.status}` });
  }
  // Fetch/service-binding sinks return a Response. Inspect a JSON success
  // body because the API uses a 2xx transport response for a valid envelope
  // whose domain write may still be rejected. A malformed declared-JSON body
  // is retryable rather than silently acknowledged.
  if (result && typeof result === "object" && typeof result.status === "number" && typeof result.json === "function") {
    const contentType = result.headers?.get?.("content-type") ?? "";
    if (/application\/json/iu.test(contentType)) {
      try {
        const body = await result.json();
        rejectedSinkResult(body);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) throw error;
        throw Object.assign(new Error("MEMORY_SINK_INVALID_JSON"), { code: "SINK_INVALID_JSON" });
      }
    }
  }
}

/**
 * A storage-backed, at-least-once outbox.  The sink is intentionally an
 * injected port: the DO can use a same-origin fetch/service binding in
 * production while tests and localhost can use a MemoryService adapter.
 * `enqueue` only acknowledges after storage.put succeeds; `flush` is always
 * best effort and never required by the caller's request path.
 */
export class MemoryOutbox {
  /**
   * @param {MemoryOutboxStorage|{storage: MemoryOutboxStorage, sink?: unknown, now?: Function, maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, batchSize?: number}} options
   * @param {unknown} [legacySink]
   * @param {object} [legacyOptions]
   */
  constructor(options, legacySink, legacyOptions = {}) {
    const config = isRecord(options) && "storage" in options
      ? options
      : { storage: options, sink: legacySink, ...legacyOptions };
    if (!config.storage || typeof config.storage.get !== "function" || typeof config.storage.put !== "function" || typeof config.storage.list !== "function") {
      throw new Error("MemoryOutbox requires storage.get/put/list");
    }
    this.storage = config.storage;
    this.sink = config.sink;
    this.now = typeof config.now === "function" ? config.now : () => Date.now();
    this.maxAttempts = boundedNumber(config.maxAttempts ?? DEFAULT_MEMORY_OUTBOX_MAX_ATTEMPTS, DEFAULT_MEMORY_OUTBOX_MAX_ATTEMPTS, 1, 100);
    this.baseDelayMs = boundedNumber(config.baseDelayMs ?? DEFAULT_MEMORY_OUTBOX_BASE_DELAY_MS, DEFAULT_MEMORY_OUTBOX_BASE_DELAY_MS, 0, DEFAULT_MEMORY_OUTBOX_MAX_DELAY_MS);
    this.maxDelayMs = Math.max(this.baseDelayMs, boundedNumber(config.maxDelayMs ?? DEFAULT_MEMORY_OUTBOX_MAX_DELAY_MS, DEFAULT_MEMORY_OUTBOX_MAX_DELAY_MS, 0, 86_400_000));
    this.batchSize = boundedNumber(config.batchSize ?? DEFAULT_MEMORY_OUTBOX_BATCH_SIZE, DEFAULT_MEMORY_OUTBOX_BATCH_SIZE, 1, 128);
    this.tail = Promise.resolve();
  }

  /** Change the delivery port after a request-derived same-origin sink is known. */
  setSink(sink) {
    this.sink = sink;
    return this;
  }

  serialize(value) {
    return JSON.parse(JSON.stringify(value));
  }

  runSerial(task) {
    const next = this.tail.then(task, task);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  async rawEntries() {
    const values = await this.storage.list({ prefix: MEMORY_OUTBOX_ENTRY_PREFIX });
    const iterable = values instanceof Map ? values.values() : Object.values(values ?? {});
    const entries = [];
    for (const value of iterable) {
      try {
        const entry = normalizeEntry(value);
        if (entry) entries.push(entry);
      } catch {
        // Invalid persisted rows are not delivered.  They are intentionally
        // retained for operator inspection rather than silently deleted.
      }
    }
    return sortedEntries(entries);
  }

  /** Return bounded, validated entries. */
  async list(options = {}) {
    const entries = await this.rawEntries();
    const statuses = options.status
      ? new Set(Array.isArray(options.status) ? options.status : [options.status])
      : null;
    const filtered = statuses ? entries.filter((entry) => statuses.has(entry.status)) : entries;
    const limit = boundedNumber(options.limit ?? 256, 256, 0, 256);
    return filtered.slice(0, limit).map((entry) => this.serialize(entry));
  }

  async get(entryId) {
    const value = await this.storage.get(entryKey(entryId));
    try {
      const entry = normalizeEntry(value);
      return entry ? this.serialize(entry) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Persist an event before any delivery attempt.  Event ID and idempotency
   * key are both dedupe keys, so a retried producer cannot create another
   * sink call even when it generates a different eventId accidentally.
   */
  enqueue(input) {
    return this.runSerial(async () => {
      const event = parsedEvent(input);
      const entries = await this.rawEntries();
      const existing = entries.find((entry) => {
        const identity = eventIdentity(entry);
        return identity.eventId === event.eventId || identity.idempotencyKey === event.idempotencyKey;
      });
      if (existing) {
        if (!equivalentEvent(existing.event, event)) {
          throw Object.assign(new Error("MEMORY_EVENT_IDEMPOTENCY_CONFLICT"), {
            code: "MEMORY_EVENT_IDEMPOTENCY_CONFLICT",
          });
        }
        return { accepted: false, duplicate: true, entry: this.serialize(existing), status: existing.status };
      }
      const timestamp = iso(this.now());
      const entry = {
        schemaVersion: MEMORY_OUTBOX_VERSION,
        entryId: event.eventId,
        event: this.serialize(event),
        status: MEMORY_OUTBOX_STATUS.PENDING,
        attemptCount: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        deliveredAt: null,
      };
      // Explicit size check includes the state envelope, not just payload.
      if (byteLength(entry) > MAX_MEMORY_OUTBOX_EVENT_BYTES) throw new Error("MEMORY_OUTBOX_ENTRY_TOO_LARGE");
      await this.storage.put(entryKey(entry.entryId), entry);
      return { accepted: true, duplicate: false, entry: this.serialize(entry), status: entry.status };
    });
  }

  due(entry, at) {
    if (entry.status !== MEMORY_OUTBOX_STATUS.PENDING && entry.status !== MEMORY_OUTBOX_STATUS.RETRY) return false;
    if (!entry.nextAttemptAt) return true;
    return Date.parse(entry.nextAttemptAt) <= at;
  }

  backoff(attemptCount) {
    const exponent = Math.max(0, Math.min(20, attemptCount - 1));
    return Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** exponent));
  }

  async persist(entry) {
    const copy = this.serialize(entry);
    if (byteLength(copy) > MAX_MEMORY_OUTBOX_EVENT_BYTES) throw new Error("MEMORY_OUTBOX_ENTRY_TOO_LARGE");
    await this.storage.put(entryKey(copy.entryId), copy);
    return copy;
  }

  async flush(options = {}) {
    return this.runSerial(async () => {
      const at = nowMilliseconds(options.now ?? this.now());
      const maxEntries = boundedNumber(options.maxEntries ?? options.limit ?? this.batchSize, this.batchSize, 0, 128);
      const force = options.force === true;
      const all = await this.rawEntries();
      const candidates = all
        .filter((entry) => force ? (entry.status === MEMORY_OUTBOX_STATUS.PENDING || entry.status === MEMORY_OUTBOX_STATUS.RETRY) : this.due(entry, at))
        .slice(0, maxEntries);
      const summary = {
        attempted: 0,
        delivered: 0,
        retried: 0,
        deadLettered: 0,
        skipped: all.length - candidates.length,
        entries: [],
      };
      if (!this.sink || candidates.length === 0) return summary;
      for (const original of candidates) {
        // Re-read the row after candidate selection.  `invalidatePending` or
        // an operator action may have won the storage race while this flush
        // was waiting on another entry; a stale in-memory candidate must not
        // be sent after it became terminal.
        const latest = await this.get(original.entryId);
        if (!latest || (latest.status !== MEMORY_OUTBOX_STATUS.PENDING && latest.status !== MEMORY_OUTBOX_STATUS.RETRY)) {
          continue;
        }
        let entry = latest;
        if (typeof options.beforeSend === "function") {
          let gateResult = true;
          try {
            gateResult = await options.beforeSend(this.serialize(entry));
          } catch {
            gateResult = false;
          }
          // `SKIP` is a transient authority/storage failure: leave the row
          // pending for a later alarm. A literal false is a terminal privacy
          // veto (for example a consent epoch mismatch).
          if (gateResult === "SKIP") continue;
          const allowed = gateResult !== false;
          if (!allowed) {
            // A consent/epoch gate can veto a selected row.  Mark it terminal
            // in this same serialized flush so a later alarm cannot replay
            // it.  The callback is intentionally evaluated immediately
            // before the attempt; it is not a best-effort preflight.
            entry = {
              ...entry,
              event: redactedMemoryEvent(entry.event),
              status: MEMORY_OUTBOX_STATUS.DEAD_LETTER,
              nextAttemptAt: null,
              lastErrorCode: "CONSENT_REVOKED",
              updatedAt: iso(at),
            };
            await this.persist(entry);
            summary.deadLettered += 1;
            summary.entries.push(this.serialize(entry));
            continue;
          }
        }
        summary.attempted += 1;
        // Mark the attempt before invoking the sink. A crash after the sink
        // accepts but before the success write therefore retries (at least
        // once); the consumer must use idempotencyKey to absorb the duplicate.
        entry = {
          ...entry,
          status: MEMORY_OUTBOX_STATUS.RETRY,
          attemptCount: entry.attemptCount + 1,
          nextAttemptAt: null,
          updatedAt: iso(at),
        };
        await this.persist(entry);
        try {
          const result = await invokeSink(this.sink, entry.event, entry);
          await assertSinkResult(result);
          entry = {
            ...entry,
            status: MEMORY_OUTBOX_STATUS.DELIVERED,
            nextAttemptAt: null,
            lastErrorCode: null,
            deliveredAt: iso(at),
            updatedAt: iso(at),
          };
          await this.persist(entry);
          summary.delivered += 1;
        } catch (error) {
          const code = errorCode(error);
          const consentVeto = code === "CONSENT_REVOKED" || code === "CONSENT_VERSION_STALE" ||
            code === "CONSENT_REQUIRED" || code === "MEMORY_DISABLED";
          const terminal = consentVeto || entry.attemptCount >= this.maxAttempts;
          entry = {
            ...entry,
            ...(consentVeto ? { event: redactedMemoryEvent(entry.event) } : {}),
            status: terminal ? MEMORY_OUTBOX_STATUS.DEAD_LETTER : MEMORY_OUTBOX_STATUS.RETRY,
            nextAttemptAt: terminal ? null : iso(at + this.backoff(entry.attemptCount)),
            lastErrorCode: code,
            updatedAt: iso(at),
          };
          await this.persist(entry);
          if (terminal) summary.deadLettered += 1;
          else summary.retried += 1;
        }
        summary.entries.push(this.serialize(entry));
      }
      return summary;
    });
  }

  /** Explicit operator/test hook to move a dead-letter entry back to retry. */
  async requeue(entryId, options = {}) {
    return this.runSerial(async () => {
      const current = await this.get(entryId);
      if (!current || current.status !== MEMORY_OUTBOX_STATUS.DEAD_LETTER) return current;
      const at = nowMilliseconds(options.now ?? this.now());
      const entry = {
        ...current,
        status: MEMORY_OUTBOX_STATUS.RETRY,
        nextAttemptAt: iso(at),
        lastErrorCode: null,
        updatedAt: iso(at),
      };
      return this.serialize(await this.persist(entry));
    });
  }

  /**
   * Permanently stop pending delivery when the user withdraws consent. Keep a
   * bounded, inspectable terminal row with a redacted event envelope rather
   * than deleting the audit trail; a later opt-in must never replay data
   * captured under the old consent or expose its payload in DO storage.
   */
  async invalidatePending(reason = "CONSENT_REVOKED", options = {}) {
    return this.runSerial(async () => {
      const at = nowMilliseconds(options.now ?? this.now());
      const entries = await this.rawEntries();
      const invalidated = [];
      for (const original of entries) {
        if (original.status !== MEMORY_OUTBOX_STATUS.PENDING && original.status !== MEMORY_OUTBOX_STATUS.RETRY &&
          original.status !== MEMORY_OUTBOX_STATUS.DELIVERED && original.status !== MEMORY_OUTBOX_STATUS.DEAD_LETTER) continue;
        const entry = {
          ...original,
          event: redactedMemoryEvent(original.event),
          ...(original.status === MEMORY_OUTBOX_STATUS.PENDING || original.status === MEMORY_OUTBOX_STATUS.RETRY
            ? {
                status: MEMORY_OUTBOX_STATUS.DEAD_LETTER,
                nextAttemptAt: null,
                lastErrorCode: errorCode({ code: reason }),
              }
            : {}),
          updatedAt: iso(at),
        };
        invalidated.push(await this.persist(entry));
      }
      return invalidated.map((entry) => this.serialize(entry));
    });
  }

  /**
   * Stop queued delivery for one deleted aggregate. Other sessions may still
   * hold a pending event; matching the bounded envelope here prevents a late
   * retry from carrying it after the management deletion. PostgreSQL's
   * tombstone remains the final guard for entries this DO cannot see.
   */
  async invalidateMemory(memoryId, reason = "MEMORY_DELETED", options = {}) {
    const target = String(memoryId ?? "").trim();
    const logicalKey = typeof options.logicalKey === "string" ? options.logicalKey.trim() : "";
    if (!target && !logicalKey) return [];
    return this.runSerial(async () => {
      const at = nowMilliseconds(options.now ?? this.now());
      const entries = await this.rawEntries();
      const invalidated = [];
      const hasTarget = (event) => {
        if (!event || typeof event !== "object") return false;
        const seen = new Set();
        const walk = (value) => {
          if (!value || typeof value !== "object" || seen.has(value)) return false;
          seen.add(value);
          if (Array.isArray(value)) return value.some(walk);
          if (target && (value.targetMemoryId === target || value.memoryId === target)) return true;
          if (logicalKey && value.logicalKey === logicalKey) return true;
          return Object.values(value).some(walk);
        };
        return walk(event);
      };
      for (const original of entries) {
        if (!hasTarget(original.event)) continue;
        const entry = {
          ...original,
          event: redactedMemoryEvent(original.event),
          ...(original.status === MEMORY_OUTBOX_STATUS.PENDING || original.status === MEMORY_OUTBOX_STATUS.RETRY
            ? {
                status: MEMORY_OUTBOX_STATUS.DEAD_LETTER,
                nextAttemptAt: null,
                lastErrorCode: errorCode({ code: reason }),
              }
            : {}),
          updatedAt: iso(at),
        };
        invalidated.push(await this.persist(entry));
      }
      return invalidated.map((entry) => this.serialize(entry));
    });
  }

  /**
   * Explicitly compact terminal rows in the outbox.
   *
   * This method is deliberately opt-in: an omitted cutoff and omitted
   * maxRetained are a no-op.  Only DELIVERED/DEAD_LETTER entries can be
   * selected; PENDING/RETRY are never candidates, even when a caller supplies
   * an aggressive retention limit.  `storage.delete` is optional because a
   * few local Durable Object fakes expose only get/put/list; those stores are
   * left untouched instead of being emulated with an unsafe overwrite.
   *
   * `cutoff` removes terminal entries created before the timestamp.
   * `maxRetained` keeps the newest terminal entries across both terminal
   * statuses.  `maxEntries` bounds one pass, so a scheduled alarm can make
   * progress without an unbounded storage operation.
   */
  async prune(options = {}) {
    return this.runSerial(async () => {
      const cutoff = pruneCutoff(options.cutoff);
      const maxRetained = retainedLimit(options.maxRetained);
      const maxEntries = pruneLimit(options.maxEntries ?? options.limit);
      const empty = { deleted: 0, eligible: 0, skipped: 0 };
      if (cutoff === undefined && maxRetained === undefined) return empty;

      const entries = await this.rawEntries();
      const terminal = entries.filter((entry) =>
        entry.status === MEMORY_OUTBOX_STATUS.DELIVERED ||
        entry.status === MEMORY_OUTBOX_STATUS.DEAD_LETTER,
      );
      const retained = maxRetained === undefined
        ? new Set()
        : new Set(terminal.slice().sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.entryId.localeCompare(left.entryId),
        ).slice(0, maxRetained).map((entry) => entry.entryId));
      const candidates = terminal
        .filter((entry) => {
          if (retained.has(entry.entryId)) return false;
          if (cutoff !== undefined && !(Date.parse(entry.createdAt) < cutoff)) return false;
          return true;
        })
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.entryId.localeCompare(right.entryId),
        )
        .slice(0, maxEntries);
      if (candidates.length === 0) return empty;
      if (typeof this.storage.delete !== "function") {
        return { deleted: 0, eligible: candidates.length, skipped: candidates.length };
      }
      let deleted = 0;
      let skipped = 0;
      for (const entry of candidates) {
        try {
          await this.storage.delete(entryKey(entry.entryId));
          deleted += 1;
        } catch {
          // Maintenance is best effort. A single storage deletion failure
          // must not turn an alarm into a failed dispatch/retry operation.
          skipped += 1;
        }
      }
      return { deleted, eligible: candidates.length, skipped };
    });
  }
}

export const MemoryOutboxStore = MemoryOutbox;
export const createMemoryOutbox = (options, sink, legacyOptions) => new MemoryOutbox(options, sink, legacyOptions);
