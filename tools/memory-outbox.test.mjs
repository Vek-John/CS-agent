import { describe, expect, it, vi } from "vitest";
import {
  MemoryOutbox,
  MEMORY_OUTBOX_ENTRY_PREFIX,
  MEMORY_OUTBOX_STATUS,
} from "./memory-outbox.mjs";
import { InMemoryMemoryRepository, MemoryService } from "../libs/memory/src/index.ts";

class FakeStorage {
  values = new Map();

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    return this.values.delete(key);
  }

  async list(options = {}) {
    const prefix = options.prefix ?? "";
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value)]),
    );
  }
}

function event({ eventId = "event-1", idempotencyKey = `idem-${eventId}`, sessionId = "session-1" } = {}) {
  return {
    schemaVersion: "memory-event.v1",
    eventId,
    type: "SESSION_COMPLETED",
    userId: "user-1",
    sessionId,
    idempotencyKey,
    producerVersion: "memory-outbox.test.v1",
    payload: { reason: "SESSION_COMPLETED" },
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

describe("MemoryOutbox", () => {
  it("persists enqueue before any delivery attempt", async () => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => undefined);
    const outbox = new MemoryOutbox({ storage, sink, now: () => 0 });

    const result = await outbox.enqueue(event());
    expect(result.accepted).toBe(true);
    expect(sink).not.toHaveBeenCalled();
    expect([...storage.values.keys()].some((key) => key.startsWith(MEMORY_OUTBOX_ENTRY_PREFIX))).toBe(true);
    expect((await outbox.get("event-1")).status).toBe(MEMORY_OUTBOX_STATUS.PENDING);

    const flushed = await outbox.flush({ now: 0 });
    expect(flushed).toMatchObject({ attempted: 1, delivered: 1, retried: 0, deadLettered: 0 });
    expect((await outbox.get("event-1")).status).toBe(MEMORY_OUTBOX_STATUS.DELIVERED);
  });

  it("retains a failed event for bounded retry and then dead-letters it", async () => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => { throw Object.assign(new Error("database down"), { code: "DB_UNAVAILABLE" }); });
    const outbox = new MemoryOutbox({ storage, sink, maxAttempts: 2, baseDelayMs: 10, now: () => 0 });
    await outbox.enqueue(event());

    const first = await outbox.flush({ now: 0 });
    expect(first).toMatchObject({ attempted: 1, delivered: 0, retried: 1, deadLettered: 0 });
    expect((await outbox.get("event-1")).status).toBe(MEMORY_OUTBOX_STATUS.RETRY);
    expect((await outbox.get("event-1")).lastErrorCode).toBe("DB_UNAVAILABLE");

    // Before the bounded backoff expires, no sink call is made.
    expect((await outbox.flush({ now: 9 })).attempted).toBe(0);
    const second = await outbox.flush({ now: 10 });
    expect(second).toMatchObject({ attempted: 1, delivered: 0, retried: 0, deadLettered: 1 });
    expect((await outbox.get("event-1")).status).toBe(MEMORY_OUTBOX_STATUS.DEAD_LETTER);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("does not treat an HTTP-200 accepted:false sink response as delivered", async () => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => ({ accepted: false, errorCode: "REPOSITORY_ERROR" }));
    const outbox = new MemoryOutbox({ storage, sink, maxAttempts: 1, now: () => 0 });
    await outbox.enqueue(event({ eventId: "event-rejected", idempotencyKey: "idem-rejected" }));
    const result = await outbox.flush({ now: 0 });
    expect(result).toMatchObject({ attempted: 1, delivered: 0, deadLettered: 1 });
    expect((await outbox.get("event-rejected")).status).toBe(MEMORY_OUTBOX_STATUS.DEAD_LETTER);
    expect((await outbox.get("event-rejected")).lastErrorCode).toContain("REPOSITORY_ERROR");
  });

  it("treats a MemoryService idempotent replay as delivery convergence", async () => {
    const storage = new FakeStorage();
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId: "user-1", memoryEnabled: true, consent: "GRANTED" },
    });
    const replay = {
      schemaVersion: "memory-event.v1",
      eventId: "memory-preference-response-lost",
      type: "USER_PREFERENCE_STATED",
      eventType: "USER_PREFERENCE_STATED",
      userId: "user-1",
      sessionId: "memory-preferences",
      demoContentHash: "memory-preferences",
      proposalId: "memory-preference-response-lost-proposal",
      operation: "CREATE",
      idempotencyKey: "memory-preference-response-lost-idem",
      producerVersion: "memory-outbox.test.v1",
      payload: {
        key: "explanationDepth",
        value: "DEEP",
        source: "USER_EXPLICIT",
        refs: [{
          namespace: "USER_PREFERENCE",
          refId: "preference-explanationDepth",
          demoContentHash: "memory-preferences",
          sessionId: "memory-preferences",
          cueId: "preference",
        }],
      },
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    let responseLost = true;
    const sink = vi.fn(async (event) => {
      const result = await service.ingestEvent("user-1", event);
      if (responseLost) {
        responseLost = false;
        throw new Error("transport response lost after commit");
      }
      return result;
    });
    const outbox = new MemoryOutbox({ storage, sink, maxAttempts: 2, baseDelayMs: 1_000, now: () => 0 });
    await outbox.enqueue(replay);

    const first = await outbox.flush({ now: 0 });
    expect(first).toMatchObject({ attempted: 1, delivered: 0, retried: 1, deadLettered: 0 });
    const result = await outbox.flush({ now: 1_000 });
    expect(result).toMatchObject({ attempted: 1, delivered: 1, retried: 0, deadLettered: 0 });
    expect((await outbox.get(replay.eventId)).status).toBe(MEMORY_OUTBOX_STATUS.DELIVERED);
  });

  it("inspects a fetch Response body before acknowledging delivery", async () => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => new Response(JSON.stringify({ accepted: false, errorCode: "REPOSITORY_ERROR" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const outbox = new MemoryOutbox({ storage, sink, maxAttempts: 1, now: () => 0 });
    await outbox.enqueue(event({ eventId: "event-http-rejected", idempotencyKey: "idem-http-rejected" }));
    const result = await outbox.flush({ now: 0 });
    expect(result).toMatchObject({ delivered: 0, deadLettered: 1 });
    expect((await outbox.get("event-http-rejected")).lastErrorCode).toContain("REPOSITORY_ERROR");
  });

  it("acknowledges an HTTP idempotent-convergence response", async () => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => new Response(JSON.stringify({
      accepted: false,
      idempotent: true,
      decision: { reason: "DUPLICATE_IDEMPOTENCY" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const outbox = new MemoryOutbox({ storage, sink, maxAttempts: 1, now: () => 0 });
    await outbox.enqueue(event({ eventId: "event-http-idempotent", idempotencyKey: "idem-http-idempotent" }));
    const result = await outbox.flush({ now: 0 });
    expect(result).toMatchObject({ attempted: 1, delivered: 1, deadLettered: 0 });
    expect((await outbox.get("event-http-idempotent")).status).toBe(MEMORY_OUTBOX_STATUS.DELIVERED);
  });

  it("recovers pending entries in a new outbox instance", async () => {
    const storage = new FakeStorage();
    await new MemoryOutbox({ storage, now: () => 0 }).enqueue(event());
    const sink = vi.fn(async () => undefined);
    const restarted = new MemoryOutbox({ storage, sink, now: () => 0 });

    expect((await restarted.list({ status: "PENDING" })).map((entry) => entry.entryId)).toEqual(["event-1"]);
    await restarted.flush({ now: 0 });
    expect(sink).toHaveBeenCalledTimes(1);
    expect((await restarted.get("event-1")).status).toBe(MEMORY_OUTBOX_STATUS.DELIVERED);
  });

  it("deduplicates event ID and consumer idempotency key", async () => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => undefined);
    const outbox = new MemoryOutbox({ storage, sink, now: () => 0 });
    await outbox.enqueue(event({ eventId: "event-1", idempotencyKey: "idem-same" }));
    const duplicateId = await outbox.enqueue(event({ eventId: "event-1", idempotencyKey: "idem-other" }));
    const duplicateIdempotency = await outbox.enqueue(event({ eventId: "event-2", idempotencyKey: "idem-same" }));

    expect(duplicateId.duplicate).toBe(true);
    expect(duplicateIdempotency.duplicate).toBe(true);
    expect((await outbox.list()).filter((entry) => entry.status === MEMORY_OUTBOX_STATUS.PENDING)).toHaveLength(1);
    await outbox.flush({ now: 0 });
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("rejects a duplicate key when its payload changes", async () => {
    const storage = new FakeStorage();
    const outbox = new MemoryOutbox({ storage, now: () => 0 });
    const first = {
      ...event({ eventId: "event-conflict", idempotencyKey: "idem-conflict" }),
      type: "USER_CORRECTED_COACH",
      eventType: "USER_CORRECTED_COACH",
      targetMemoryId: "memory-conflict",
      operation: "CORRECT",
      payload: {
        memoryId: "memory-conflict",
        correction: { correctionId: "correction-conflict", content: "first", source: "USER" },
      },
    };
    await outbox.enqueue(first);
    await expect(outbox.enqueue({
      ...first,
      eventId: "event-conflict-replay",
      payload: {
        memoryId: "memory-conflict",
        correction: { correctionId: "correction-conflict", content: "changed", source: "USER" },
      },
    })).rejects.toMatchObject({ code: "MEMORY_EVENT_IDEMPOTENCY_CONFLICT" });
    expect((await outbox.list()).filter((entry) => entry.status === MEMORY_OUTBOX_STATUS.PENDING)).toHaveLength(1);
  });

  it("rejects unbounded or raw replay-shaped events", async () => {
    const outbox = new MemoryOutbox({ storage: new FakeStorage() });
    await expect(outbox.enqueue({
      ...event(),
      payload: { rawDemo: "not allowed" },
    })).rejects.toThrow();
    await expect(outbox.enqueue({
      ...event(),
      payload: { content: "x".repeat(40_000) },
    })).rejects.toThrow();
  });

  it("invalidates pending entries when consent is revoked", async () => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => undefined);
    const outbox = new MemoryOutbox({ storage, sink, now: () => 0 });
    await outbox.enqueue(event({ eventId: "event-consent-revoked", idempotencyKey: "idem-consent-revoked" }));
    const invalidated = await outbox.invalidatePending();
    expect(invalidated).toHaveLength(1);
    const revoked = await outbox.get("event-consent-revoked");
    expect(revoked.status).toBe(MEMORY_OUTBOX_STATUS.DEAD_LETTER);
    expect(revoked.event.payload).toEqual({ reason: "SESSION_COMPLETED" });
    expect((await outbox.flush({ force: true })).attempted).toBe(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it("can invalidate pending entries for a deleted memory aggregate", async () => {
    const storage = new FakeStorage();
    const outbox = new MemoryOutbox({ storage, now: () => 0 });
    await outbox.enqueue({
      ...event({ eventId: "event-memory-delete", idempotencyKey: "idem-memory-delete" }),
      type: "USER_CORRECTED_COACH",
      eventType: "USER_CORRECTED_COACH",
      targetMemoryId: "memory-delete-1",
      operation: "CORRECT",
      payload: {
        memoryId: "memory-delete-1",
        correction: { correctionId: "correction-memory-delete", content: "用户修正", source: "USER" },
      },
    });
    await outbox.enqueue(event({ eventId: "event-other-memory", idempotencyKey: "idem-other-memory" }));
    const invalidated = await outbox.invalidateMemory("memory-delete-1");
    expect(invalidated).toHaveLength(1);
    const deleted = await outbox.get("event-memory-delete");
    expect(deleted.status).toBe(MEMORY_OUTBOX_STATUS.DEAD_LETTER);
    expect(deleted.event.payload).toEqual({ reason: "MEMORY_DELETED" });
    expect(deleted.event).toMatchObject({ targetMemoryId: "memory-delete-1", operation: "CORRECT" });
    expect((await outbox.get("event-other-memory")).status).toBe(MEMORY_OUTBOX_STATUS.PENDING);
  });

  it("matches a normal proposal by logicalKey even when no memoryId exists yet", async () => {
    const storage = new FakeStorage();
    const outbox = new MemoryOutbox({ storage, now: () => 0 });
    await outbox.enqueue({
      ...event({ eventId: "event-logical-delete", idempotencyKey: "idem-logical-delete" }),
      type: "USER_CORRECTED_COACH",
      eventType: "USER_CORRECTED_COACH",
      targetMemoryId: "memory-logical-target",
      operation: "CORRECT",
      payload: { logicalKey: "memory-logical-trade" },
    });
    const invalidated = await outbox.invalidateMemory("", "MEMORY_DELETED", { logicalKey: "memory-logical-trade" });
    expect(invalidated).toHaveLength(1);
    expect((await outbox.get("event-logical-delete")).status).toBe(MEMORY_OUTBOX_STATUS.DEAD_LETTER);
  });

  it("leaves a row pending when the before-send authority read is unavailable", async () => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => undefined);
    const outbox = new MemoryOutbox({ storage, sink, now: () => 0 });
    await outbox.enqueue(event({ eventId: "event-authority-unavailable" }));
    const result = await outbox.flush({ force: true, beforeSend: async () => "SKIP" });
    expect(result.attempted).toBe(0);
    expect((await outbox.get("event-authority-unavailable")).status).toBe(MEMORY_OUTBOX_STATUS.PENDING);
    expect(sink).not.toHaveBeenCalled();
  });

  it("redacts an entry when the sink reports a consent veto", async () => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => { throw Object.assign(new Error("revoked"), { code: "CONSENT_REVOKED" }); });
    const outbox = new MemoryOutbox({ storage, sink, maxAttempts: 5, now: () => 0 });
    await outbox.enqueue({
      ...event({ eventId: "event-sink-veto", idempotencyKey: "idem-sink-veto" }),
      type: "USER_CORRECTED_COACH",
      eventType: "USER_CORRECTED_COACH",
      targetMemoryId: "memory-sink-veto",
      operation: "CORRECT",
      payload: { memoryId: "memory-sink-veto", correction: { correctionId: "corr-sink-veto", content: "secret correction", source: "USER" } },
    });
    const result = await outbox.flush({ now: 0 });
    expect(result.deadLettered).toBe(1);
    const stored = await outbox.get("event-sink-veto");
    expect(stored.status).toBe(MEMORY_OUTBOX_STATUS.DEAD_LETTER);
    expect(stored.event.payload).toEqual({ reason: "MEMORY_DELETED" });
    expect(JSON.stringify(stored)).not.toContain("secret correction");
  });

  it.each(["CONSENT_REQUIRED", "MEMORY_DISABLED"])("redacts and terminalizes an HTTP-200 authorization rejection (%s)", async (reason) => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => ({ accepted: false, reason }));
    const outbox = new MemoryOutbox({ storage, sink, maxAttempts: 5, now: () => 0 });
    await outbox.enqueue({
      ...event({ eventId: `event-${reason}`, idempotencyKey: `idem-${reason}` }),
      type: "USER_CORRECTED_COACH",
      eventType: "USER_CORRECTED_COACH",
      targetMemoryId: `memory-${reason}`,
      operation: "CORRECT",
      payload: {
        memoryId: `memory-${reason}`,
        correction: { correctionId: `corr-${reason}`, content: "secret authorization payload", source: "USER" },
      },
    });
    const result = await outbox.flush({ force: true });
    expect(result.deadLettered).toBe(1);
    const stored = await outbox.get(`event-${reason}`);
    expect(stored.status).toBe(MEMORY_OUTBOX_STATUS.DEAD_LETTER);
    expect(stored.event.payload).toEqual({ reason: "MEMORY_DELETED" });
    expect(JSON.stringify(stored)).not.toContain("secret authorization payload");
  });

  it.each(["CONSENT_REQUIRED", "MEMORY_DISABLED"])("redacts and terminalizes an accepted:false errorCode veto (%s)", async (errorCode) => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => ({ accepted: false, errorCode }));
    const outbox = new MemoryOutbox({ storage, sink, maxAttempts: 5, now: () => 0 });
    await outbox.enqueue({
      ...event({ eventId: `event-error-${errorCode}`, idempotencyKey: `idem-error-${errorCode}` }),
      type: "USER_CORRECTED_COACH",
      eventType: "USER_CORRECTED_COACH",
      targetMemoryId: `memory-${errorCode}`,
      operation: "CORRECT",
      payload: {
        memoryId: `memory-${errorCode}`,
        correction: { correctionId: `corr-${errorCode}`, content: "secret error-code payload", source: "USER" },
      },
    });
    const result = await outbox.flush({ force: true });
    expect(result).toMatchObject({ delivered: 0, deadLettered: 1 });
    const stored = await outbox.get(`event-error-${errorCode}`);
    expect(stored.status).toBe(MEMORY_OUTBOX_STATUS.DEAD_LETTER);
    expect(stored.event.payload).toEqual({ reason: "MEMORY_DELETED" });
    expect(JSON.stringify(stored)).not.toContain("secret error-code payload");
  });

  it.each(["CONSENT_REQUIRED", "MEMORY_DISABLED"])("redacts and terminalizes an HTTP accepted:false errorCode veto (%s)", async (errorCode) => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => new Response(JSON.stringify({ accepted: false, errorCode }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const outbox = new MemoryOutbox({ storage, sink, maxAttempts: 5, now: () => 0 });
    await outbox.enqueue({
      ...event({ eventId: `event-http-error-${errorCode}`, idempotencyKey: `idem-http-error-${errorCode}` }),
      type: "USER_CORRECTED_COACH",
      eventType: "USER_CORRECTED_COACH",
      targetMemoryId: `memory-http-${errorCode}`,
      operation: "CORRECT",
      payload: {
        memoryId: `memory-http-${errorCode}`,
        correction: { correctionId: `corr-http-${errorCode}`, content: "secret HTTP error-code payload", source: "USER" },
      },
    });
    const result = await outbox.flush({ force: true });
    expect(result).toMatchObject({ delivered: 0, deadLettered: 1 });
    const stored = await outbox.get(`event-http-error-${errorCode}`);
    expect(stored.status).toBe(MEMORY_OUTBOX_STATUS.DEAD_LETTER);
    expect(stored.event.payload).toEqual({ reason: "MEMORY_DELETED" });
    expect(JSON.stringify(stored)).not.toContain("secret HTTP error-code payload");
  });

  it.each(["DUPLICATE_IDEMPOTENCY", "DELETED_TOMBSTONE"])("treats accepted:false %s as terminal success", async (errorCode) => {
    const storage = new FakeStorage();
    const sink = vi.fn(async () => ({ accepted: false, errorCode }));
    const outbox = new MemoryOutbox({ storage, sink, maxAttempts: 1, now: () => 0 });
    await outbox.enqueue(event({ eventId: `event-idempotent-${errorCode}`, idempotencyKey: `idem-idempotent-${errorCode}` }));
    const result = await outbox.flush({ force: true });
    expect(result).toMatchObject({ delivered: 1, deadLettered: 0, retried: 0 });
    expect((await outbox.get(`event-idempotent-${errorCode}`)).status).toBe(MEMORY_OUTBOX_STATUS.DELIVERED);
  });

  it("prunes only old terminal entries and keeps delivery work pending", async () => {
    const storage = new FakeStorage();
    const outbox = new MemoryOutbox({ storage, now: () => 0 });
    const add = async (entryId, status, createdAt) => {
      await outbox.enqueue(event({ eventId: entryId, idempotencyKey: `idem-${entryId}` }));
      const key = `${MEMORY_OUTBOX_ENTRY_PREFIX}${encodeURIComponent(entryId)}`;
      const stored = storage.values.get(key);
      storage.values.set(key, {
        ...stored,
        status,
        createdAt,
        updatedAt: createdAt,
        ...(status === MEMORY_OUTBOX_STATUS.DELIVERED ? { deliveredAt: createdAt } : {}),
      });
    };

    await add("delivered-old", MEMORY_OUTBOX_STATUS.DELIVERED, "2026-01-01T00:00:00.000Z");
    await add("dead-old", MEMORY_OUTBOX_STATUS.DEAD_LETTER, "2026-01-02T00:00:00.000Z");
    await add("delivered-new", MEMORY_OUTBOX_STATUS.DELIVERED, "2026-09-01T00:00:00.000Z");
    await add("pending-old", MEMORY_OUTBOX_STATUS.PENDING, "2026-01-03T00:00:00.000Z");
    await add("retry-old", MEMORY_OUTBOX_STATUS.RETRY, "2026-01-04T00:00:00.000Z");

    const result = await outbox.prune({ cutoff: "2026-02-01T00:00:00.000Z" });
    expect(result).toEqual({ deleted: 2, eligible: 2, skipped: 0 });
    expect(await outbox.get("delivered-old")).toBeUndefined();
    expect(await outbox.get("dead-old")).toBeUndefined();
    expect((await outbox.get("delivered-new")).status).toBe(MEMORY_OUTBOX_STATUS.DELIVERED);
    expect((await outbox.get("pending-old")).status).toBe(MEMORY_OUTBOX_STATUS.PENDING);
    expect((await outbox.get("retry-old")).status).toBe(MEMORY_OUTBOX_STATUS.RETRY);
  });

  it("uses an explicit terminal retention cap without touching pending or retry rows", async () => {
    const storage = new FakeStorage();
    const outbox = new MemoryOutbox({ storage, now: () => 0 });
    const add = async (entryId, status, createdAt) => {
      await outbox.enqueue(event({ eventId: entryId, idempotencyKey: `idem-${entryId}` }));
      const key = `${MEMORY_OUTBOX_ENTRY_PREFIX}${encodeURIComponent(entryId)}`;
      const stored = storage.values.get(key);
      storage.values.set(key, { ...stored, status, createdAt, updatedAt: createdAt });
    };
    await add("terminal-old", MEMORY_OUTBOX_STATUS.DELIVERED, "2026-01-01T00:00:00.000Z");
    await add("terminal-new", MEMORY_OUTBOX_STATUS.DEAD_LETTER, "2026-01-02T00:00:00.000Z");
    await add("terminal-newest", MEMORY_OUTBOX_STATUS.DELIVERED, "2026-01-03T00:00:00.000Z");
    await add("retry-newest", MEMORY_OUTBOX_STATUS.RETRY, "2026-01-04T00:00:00.000Z");

    await expect(outbox.prune({ maxRetained: 2, maxEntries: 1 })).resolves.toEqual({ deleted: 1, eligible: 1, skipped: 0 });
    expect(await outbox.get("terminal-old")).toBeUndefined();
    expect((await outbox.get("terminal-new")).status).toBe(MEMORY_OUTBOX_STATUS.DEAD_LETTER);
    expect((await outbox.get("terminal-newest")).status).toBe(MEMORY_OUTBOX_STATUS.DELIVERED);
    expect((await outbox.get("retry-newest")).status).toBe(MEMORY_OUTBOX_STATUS.RETRY);
  });

  it("does not prune by default and safely skips stores without delete", async () => {
    const storage = new FakeStorage();
    const outbox = new MemoryOutbox({ storage, now: () => 0 });
    await outbox.enqueue(event({ eventId: "terminal-default", idempotencyKey: "idem-terminal-default" }));
    const key = `${MEMORY_OUTBOX_ENTRY_PREFIX}${encodeURIComponent("terminal-default")}`;
    storage.values.set(key, {
      ...storage.values.get(key),
      status: MEMORY_OUTBOX_STATUS.DELIVERED,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(outbox.prune()).resolves.toEqual({ deleted: 0, eligible: 0, skipped: 0 });

    storage.delete = undefined;
    await expect(outbox.prune({ cutoff: "2026-02-01T00:00:00.000Z" })).resolves.toEqual({ deleted: 0, eligible: 1, skipped: 1 });
    expect(await outbox.get("terminal-default")).toBeTruthy();
  });
});
