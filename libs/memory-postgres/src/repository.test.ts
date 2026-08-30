import { describe, expect, it } from "vitest";
import {
  MemoryReducer,
  MEMORY_PROPOSAL_VERSION,
  MemoryProposalSchema,
  MemoryWritePolicy,
  buildMemoryProposal,
  type MemoryEvent,
  type MemoryProposal,
  type MemoryRecord,
  MemoryRecordSchema,
} from "@cs-coach/memory";
import type { SqlExecutor, SqlResult } from "./executor";
import { MemoryRowValidationError, PostgresMemoryRepository, SemanticUnavailableError } from "./index";

const userId = "user-1";

function makeProposal(suffix = "1", demoContentHash = `demo-${suffix}`) {
  return buildMemoryProposal({
    userId,
    sessionId: `session-${suffix}`,
    demoContentHash,
    cueCase: {
      schemaVersion: "cue-case.v1",
      caseId: `case-${suffix}`,
      cueId: `cue-${suffix}`,
      pedagogyMode: "INTRODUCE",
      status: "AWAITING_CONFIRMATION",
      claims: [],
      capabilities: [],
      diagnosticResult: {
        resultId: `diagnostic-${suffix}`,
        capabilityId: "VERIFY_TRADE_ASSUMPTION",
        cueId: `cue-${suffix}`,
        hingeId: `hinge-${suffix}`,
        status: "SUPPORTED",
        evidenceRefs: [],
        measurements: [],
        explanation: "已完成有界诊断",
        limitations: [],
      },
      verdict: {
        type: "BELIEF_INCORRECT",
        confidence: 0.8,
        hingeId: `hinge-${suffix}`,
        diagnosticResultId: `diagnostic-${suffix}`,
        claimIds: [],
        evidenceRefs: [],
        limitations: [],
        revision: 0,
        explanation: "已完成有界判断",
      },
      baselineNarrationAvailable: true,
      attemptBudget: { reflection: 0, diagnostic: 0, disagreement: 0, alternateDiagnostic: 0 },
      limitations: [],
    } as Parameters<typeof buildMemoryProposal>[0]["cueCase"],
    learningThread: {
      threadId: `thread-${suffix}`,
      scope: "SESSION",
      hingeCode: "TRADE_TIMING",
      trigger: { situation: "接触后队友仍可补枪", conditions: ["队友在附近"] },
      userModel: { goal: "拿到击杀", belief: "我必须马上继续打" },
      diagnosis: { type: "TIMING", summary: "需要先等补枪窗口", confidence: 0.8 },
      transferRule: { ruleId: `rule-${suffix}`, when: "有队友可补枪时", do: "先保持可交易角度", refs: [], confidence: 0.75, limitations: [] },
      evidenceCueIds: [`cue-${suffix}`],
      successfulCueIds: [],
      conflictingCueIds: [],
      status: "TAUGHT",
    } as Parameters<typeof buildMemoryProposal>[0]["learningThread"],
    outcomeGateStatus: "COMPLETE",
    createdAt: `2026-08-28T00:00:0${suffix}.000Z`,
  });
}

function makeRecord(suffix = "1", active = true): MemoryRecord {
  const proposal = makeProposal(suffix);
  const policy = new MemoryWritePolicy();
  const decision = policy.decide({ proposal });
  const record = new MemoryReducer().reduce({ userId, proposal, decision: { ...decision, status: active ? "EMERGING" : decision.status }, now: "2026-08-28T00:00:10.000Z" });
  if (!record) throw new Error("fixture record was not reduced");
  return MemoryRecordSchema.parse({ ...record, status: active ? "EMERGING" : record.status, active }) as unknown as MemoryRecord;
}

function makeEvent(proposal = makeProposal()): MemoryEvent {
  return {
    schemaVersion: "memory-event.v1",
    eventId: `event-${proposal.origin.cueId}`,
    type: proposal.eventType,
    userId,
    sessionId: proposal.origin.sessionId,
    demoContentHash: proposal.origin.demoContentHash,
    proposalId: proposal.proposalId,
    idempotencyKey: proposal.idempotencyKey,
    producerVersion: proposal.producerVersion,
    payload: proposal,
    createdAt: proposal.createdAt,
  };
}

function makeProfileProposal(): MemoryProposal {
  return MemoryProposalSchema.parse({
    schemaVersion: MEMORY_PROPOSAL_VERSION,
    proposalId: "profile-proposal-local",
    userId,
    operation: "CREATE",
    eventType: "USER_PROFILE_STATED",
    requestedScope: "CROSS_DEMO",
    kind: "PROFILE",
    logicalKey: "profile-local-user-1",
    claims: [],
    profile: {
      role: "support",
      preferredMap: "Mirage",
      learningGoal: "提高补枪时机",
    },
    origin: {
      sessionId: "user-profile",
      demoContentHash: "user-profile",
      cueId: "profile",
      typedSourceRefs: [{
        namespace: "USER_PROFILE",
        refId: "profile-local-ref",
        demoContentHash: "user-profile",
        sessionId: "user-profile",
        cueId: "profile",
      }],
    },
    lifecycle: "CONFIRMED",
    consentState: "GRANTED",
    producerVersion: "memory-management.v1",
    idempotencyKey: "memory-profile-local",
    createdAt: "2026-08-28T00:00:00.000Z",
  }) as unknown as MemoryProposal;
}

function makeProfileRecord(): MemoryRecord {
  const proposal = makeProfileProposal();
  const decision = new MemoryWritePolicy().decide({ proposal });
  const record = new MemoryReducer().reduce({
    userId,
    proposal,
    decision,
    now: "2026-08-28T00:00:10.000Z",
  });
  if (!record) throw new Error("profile fixture was not reduced");
  return MemoryRecordSchema.parse(record) as unknown as MemoryRecord;
}

class FakeExecutor implements SqlExecutor {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  private readonly handler: (text: string, values: readonly unknown[]) => Promise<SqlResult> | SqlResult;

  constructor(handler: (text: string, values: readonly unknown[]) => Promise<SqlResult> | SqlResult) {
    this.handler = handler;
  }

  async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ text, values });
    return (await this.handler(text, values)) as SqlResult<Row>;
  }
}

describe("PostgresMemoryRepository SQL adapter", () => {
  it("round-trips PROFILE fields through record_payload without a profile column", async () => {
    const proposal = makeProfileProposal();
    let storedPayload: MemoryRecord | undefined;
    const executor = new FakeExecutor((text, values) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("SELECT user_id, memory_enabled, consent FROM app_users")) {
        return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
      }
      if (text.includes("SELECT memory_deleted_at FROM app_users")) return { rows: [{ memory_deleted_at: null }] };
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM memory_records") && text.includes("logical_key = $2")) {
        return { rows: storedPayload ? [{ user_id: userId, record_payload: storedPayload }] : [] };
      }
      if (text.includes("FROM memory_tombstones")) return { rows: [] };
      if (text.includes("FROM memory_write_receipts")) return { rows: [] };
      if (text.includes("INSERT INTO memory_records")) {
        storedPayload = JSON.parse(String(values[32])) as MemoryRecord;
        return { rows: [] };
      }
      if (text.includes("INSERT INTO memory_record_revisions") || text.includes("INSERT INTO memory_write_receipts")) {
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new PostgresMemoryRepository({ executor, vectorAvailable: false });
    const decision = new MemoryWritePolicy().decide({ proposal });

    await expect(repository.applyWriteDecision(userId, decision)).resolves.toMatchObject({
      kind: "PROFILE",
      status: "CONFIRMED",
      profile: proposal.profile,
    });
    await expect(repository.findByLogicalKey(userId, proposal.logicalKey)).resolves.toMatchObject({
      profile: proposal.profile,
    });
    expect(storedPayload?.profile).toEqual(proposal.profile);
  });

  it("builds targeted PROFILE management proposals without reopening PROFILE writes", () => {
    const current = makeProfileRecord();
    const repository = new PostgresMemoryRepository({
      executor: new FakeExecutor(() => {
        throw new Error("management proposal construction must not query SQL");
      }),
    });
    const internals = repository as unknown as {
      proposalFromCurrent: (
        userId: string,
        record: MemoryRecord,
        operation: "CORRECT" | "DELETE" | "CONFIRM",
        input: unknown,
      ) => MemoryProposal;
    };

    const proposals = [
      internals.proposalFromCurrent(userId, current, "CONFIRM", { confirmationId: "confirm-profile" }),
      internals.proposalFromCurrent(userId, current, "CORRECT", {
        correctionId: "correct-profile",
        content: "我主要打步枪位",
      }),
      internals.proposalFromCurrent(userId, current, "DELETE", { reason: "remove profile" }),
    ];

    expect(proposals.map(({ operation, eventType }) => ({ operation, eventType }))).toEqual([
      { operation: "CONFIRM", eventType: "USER_CONFIRMED" },
      { operation: "CORRECT", eventType: "USER_CORRECTED_COACH" },
      { operation: "DELETE", eventType: "MEMORY_DELETED" },
    ]);
    for (const proposal of proposals) {
      expect(proposal).toMatchObject({ kind: "PROFILE", targetMemoryId: current.memoryId });
      expect(proposal).not.toHaveProperty("profile");
      expect(MemoryProposalSchema.safeParse(proposal).success).toBe(true);
      expect(MemoryProposalSchema.safeParse({ ...proposal, targetMemoryId: undefined }).success).toBe(false);
      const decision = new MemoryWritePolicy().decide({ proposal, current, eventType: proposal.eventType });
      expect(decision.accepted).toBe(true);
      expect(new MemoryReducer().reduce({ userId, proposal, decision, current })).toMatchObject({
        memoryId: current.memoryId,
        kind: "PROFILE",
        status: proposal.operation === "DELETE" ? "DELETED" : "CONFIRMED",
      });
    }

    const create = makeProfileProposal();
    const { profile: _profile, ...profilelessCreate } = create;
    expect(MemoryProposalSchema.safeParse(profilelessCreate).success).toBe(false);
    expect(MemoryProposalSchema.safeParse({ ...create, eventType: "USER_CONFIRMED" }).success).toBe(false);
    expect(MemoryProposalSchema.safeParse({ ...create, operation: "UPDATE" }).success).toBe(true);
    expect(MemoryProposalSchema.safeParse({ ...profilelessCreate, operation: "UPDATE" }).success).toBe(false);
  });

  it("always scopes structured recall by user_id and validates database JSON", async () => {
    const record = makeRecord();
    const executor = new FakeExecutor((text, values) => {
      expect(text).toContain("WHERE user_id = $1");
      expect(values[0]).toBe(userId);
      return { rows: [{ user_id: userId, record_payload: record }] };
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.retrieveStructured(userId, { activeOnly: true })).resolves.toEqual([record]);

    const crossed = new FakeExecutor(() => ({ rows: [{ user_id: "other-user", record_payload: record }] }));
    await expect(new PostgresMemoryRepository({ executor: crossed }).retrieveStructured(userId)).rejects.toBeInstanceOf(MemoryRowValidationError);
  });

  it("supports a separate disputed-record recall channel for user corrections", async () => {
    const disputed = { ...makeRecord("disputed-recall"), status: "DISPUTED", active: true } as MemoryRecord;
    let queryText = "";
    const executor = new FakeExecutor((text, values) => {
      queryText = text;
      expect(values[0]).toBe(userId);
      return { rows: [{ user_id: userId, record_payload: disputed }] };
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.retrieveStructured(userId, {
      status: "DISPUTED",
      includeDeleted: false,
      activeOnly: false,
      limit: 4,
    })).resolves.toEqual([disputed]);
    expect(queryText).toContain("status = ANY");
    expect(queryText).not.toContain("status IN ('OBSERVED'");
  });

  it("uses user plus idempotency conflict handling for event replay", async () => {
    const event = makeEvent();
    let first = true;
    const executor = new FakeExecutor((text, values) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("SELECT memory_deleted_at")) return { rows: [] };
      if (text.includes("FROM app_users") && text.includes("FOR UPDATE")) return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
      if (text.includes("SELECT memory_deleted_at")) return { rows: [] };
      if (text.includes("FROM memory_tombstones")) return { rows: [] };
      if (text.includes("INSERT INTO memory_events")) {
        expect(text).toContain("ON CONFLICT DO NOTHING");
        expect(values[0]).toBe(userId);
        return { rows: [{ user_id: userId, event_payload: event, inserted: first }] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.appendEventDetailed(userId, event)).resolves.toMatchObject({ inserted: true, event });
    first = false;
    await expect(repository.appendEventDetailed(userId, event)).resolves.toMatchObject({ inserted: false, event });
    expect(executor.calls.filter((call) => call.text.includes("INSERT INTO memory_events")).length).toBe(2);
  });

  it("absorbs an event-id collision even when a producer changes its idempotency key", async () => {
    const event = makeEvent();
    const existing = { ...event, idempotencyKey: "older-idempotency-key" };
    const executor = new FakeExecutor((text, values) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("SELECT memory_deleted_at")) return { rows: [] };
      if (text.includes("FROM app_users") && text.includes("FOR UPDATE")) return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
      if (text.includes("FROM memory_tombstones")) return { rows: [] };
      if (text.includes("INSERT INTO memory_events")) return { rows: [] };
      if (text.includes("event_id = $2")) {
        expect(values).toEqual([userId, event.eventId]);
        return { rows: [{ user_id: userId, event_payload: existing }] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.appendEventDetailed(userId, event)).resolves.toMatchObject({ inserted: false, event: existing });
  });

  it("can read a redacted management event after deletion without losing its target", async () => {
    const deletedEvent: MemoryEvent = {
      ...makeEvent(),
      eventId: "deleted-redacted-event",
      type: "MEMORY_DELETED",
      eventType: "MEMORY_DELETED",
      targetMemoryId: "memory-redacted",
      operation: "DELETE",
      idempotencyKey: "deleted-redacted-idem",
      payload: { memoryId: "memory-redacted", reason: "MEMORY_DELETED" },
    };
    const executor = new FakeExecutor((text, values) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("SELECT memory_deleted_at")) return { rows: [] };
      if (text.includes("FROM app_users") && text.includes("FOR UPDATE")) return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
      if (text.includes("FROM memory_tombstones")) return { rows: [] };
      if (text.includes("FROM memory_records") && text.includes("FOR UPDATE")) return { rows: [{ user_id: userId, status: "DELETED" }] };
      if (text.includes("INSERT INTO memory_events")) return { rows: [] };
      if (text.includes("event_id = $2")) return { rows: [{ user_id: userId, event_payload: deletedEvent }] };
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.appendEventDetailed(userId, deletedEvent)).resolves.toMatchObject({
      inserted: false,
      event: { targetMemoryId: "memory-redacted", operation: "DELETE", payload: { reason: "MEMORY_DELETED" } },
    });
  });

  it("updates consumer status with an explicit user/event scope", async () => {
    const executor = new FakeExecutor((text, values) => {
      if (text.includes("SET status = 'CONSUMED'")) {
        expect(text).toContain("WHERE user_id = $1 AND event_id = $2");
        expect(values.slice(0, 2)).toEqual([userId, "event-status"]);
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("SET status = CASE")) {
        expect(text).toContain("WHERE user_id = $1 AND event_id = $2");
        expect(values.slice(0, 2)).toEqual([userId, "event-status"]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new PostgresMemoryRepository({ executor });
    await repository.markEventConsumed(userId, "event-status", "2026-08-28T00:00:00.000Z");
    await repository.markEventFailed(userId, "event-status", { errorCode: "DB_UNAVAILABLE" });
    expect(executor.calls).toHaveLength(2);
  });

  it("returns inserted=false for a duplicate observation fingerprint", async () => {
    const observationRow = {
      user_id: userId,
      observation_id: "observation-1",
      session_id: "session-1",
      cue_id: "cue-1",
      taxonomy_code: "REPEATED_PEEK",
      demo_content_hash: "demo-1",
      observation_payload: { confidence: 0.8 },
      created_at: "2026-08-28T00:00:00.000Z",
    };
    let insert = true;
    const executor = new FakeExecutor((text, values) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM app_users") && text.includes("FOR UPDATE")) return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
      if (text.includes("INSERT INTO memory_observations")) return insert ? { rows: [observationRow] } : { rows: [] };
      if (text.includes("FROM memory_observations")) {
        expect(text).toContain("user_id = $1");
        expect(values[0]).toBe(userId);
        return { rows: [observationRow] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new PostgresMemoryRepository({ executor });
    const input = { sessionId: "session-1", cueId: "cue-1", taxonomyCode: "REPEATED_PEEK", demoContentHash: "demo-1", payload: { confidence: 0.8 } };
    await expect(repository.upsertObservation(userId, input)).resolves.toMatchObject({ inserted: true });
    insert = false;
    await expect(repository.upsertObservation(userId, input)).resolves.toMatchObject({ inserted: false });
  });

  it("locks an observation memory target after the app user and before inserting", async () => {
    const observationRow = {
      user_id: userId,
      observation_id: "observation-target",
      session_id: "session-target",
      cue_id: "cue-target",
      taxonomy_code: "REPEATED_PEEK",
      demo_content_hash: "demo-target",
      memory_id: "memory-target",
      observation_payload: { confidence: 0.8 },
      created_at: "2026-08-28T00:00:00.000Z",
    };
    let targetLocked = false;
    const executor = new FakeExecutor((text, values) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM app_users") && text.includes("FOR UPDATE")) return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
      if (text.includes("FROM memory_records") && text.includes("FOR UPDATE")) {
        expect(values).toEqual([userId, "memory-target"]);
        targetLocked = true;
        return { rows: [{ user_id: userId, memory_id: "memory-target", status: "EMERGING", tombstone_json: null }] };
      }
      if (text.includes("INSERT INTO memory_observations")) {
        expect(targetLocked).toBe(true);
        return { rows: [observationRow] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.upsertObservation(userId, {
      sessionId: "session-target",
      cueId: "cue-target",
      taxonomyCode: "REPEATED_PEEK",
      demoContentHash: "demo-target",
      memoryId: "memory-target",
      payload: { confidence: 0.8 },
    })).resolves.toMatchObject({ inserted: true, observation: { memoryId: "memory-target" } });

    const authIndex = executor.calls.findIndex((call) => call.text.includes("FROM app_users") && call.text.includes("FOR UPDATE"));
    const targetIndex = executor.calls.findIndex((call) => call.text.includes("FROM memory_records") && call.text.includes("FOR UPDATE"));
    const insertIndex = executor.calls.findIndex((call) => call.text.includes("INSERT INTO memory_observations"));
    expect(authIndex).toBeGreaterThan(-1);
    expect(targetIndex).toBeGreaterThan(authIndex);
    expect(insertIndex).toBeGreaterThan(targetIndex);
  });

  it.each([
    ["missing", [], "MEMORY_OBSERVATION_TARGET_NOT_FOUND"],
    ["deleted", [{ user_id: userId, memory_id: "memory-target", status: "DELETED", tombstone_json: { deletedBy: "USER" } }], "MEMORY_DELETED_TOMBSTONE"],
    ["tombstone", [{ user_id: userId, memory_id: "memory-target", status: "EMERGING", tombstone_json: { deletedBy: "USER" } }], "MEMORY_DELETED_TOMBSTONE"],
  ])("rejects a %s observation memory target before writing", (_label, targetRows, errorCode) => {
    const executor = new FakeExecutor((text) => {
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("SELECT memory_deleted_at")) return { rows: [] };
      if (text.includes("FROM app_users") && text.includes("FOR UPDATE")) return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
      if (text.includes("FROM memory_records") && text.includes("FOR UPDATE")) return { rows: targetRows };
      if (text.includes("INSERT INTO memory_observations")) throw new Error("observation insert must not run");
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new PostgresMemoryRepository({ executor });
    return expect(repository.upsertObservation(userId, {
      sessionId: "session-target",
      cueId: "cue-target",
      taxonomyCode: "REPEATED_PEEK",
      demoContentHash: "demo-target",
      memoryId: "memory-target",
    })).rejects.toThrow(errorCode);
  });

  it("returns an explicit conflict when a duplicate observation fingerprint changes demo hash", async () => {
    const observationRow = {
      user_id: userId,
      observation_id: "observation-conflict",
      session_id: "session-conflict",
      cue_id: "cue-conflict",
      taxonomy_code: "REPEATED_PEEK",
      demo_content_hash: "demo-original",
      observation_payload: { confidence: 0.8 },
      created_at: "2026-08-28T00:00:00.000Z",
    };
    let inserted = true;
    const executor = new FakeExecutor((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("SELECT memory_deleted_at")) return { rows: [] };
      if (text.includes("FROM app_users") && text.includes("FOR UPDATE")) return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
      if (text.includes("INSERT INTO memory_observations")) return inserted ? { rows: [observationRow] } : { rows: [] };
      if (text.includes("FROM memory_observations")) return { rows: [observationRow] };
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new PostgresMemoryRepository({ executor });
    const base = { sessionId: "session-conflict", cueId: "cue-conflict", taxonomyCode: "REPEATED_PEEK", payload: { confidence: 0.8 } };
    await expect(repository.upsertObservation(userId, { ...base, demoContentHash: "demo-original" })).resolves.toMatchObject({ inserted: true });
    inserted = false;
    await expect(repository.upsertObservation(userId, { ...base, demoContentHash: "demo-other" })).rejects.toThrow("MEMORY_OBSERVATION_FINGERPRINT_CONFLICT");
  });

  it("turns an unavailable optional vector table into controlled semantic fallback", async () => {
    const executor = new FakeExecutor(() => {
      throw new Error("relation memory_embeddings_v1 does not exist");
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.retrieveSemantic(userId, { text: "trade timing", embedding: [0.1, 0.2] })).rejects.toBeInstanceOf(SemanticUnavailableError);
    const disabled = new PostgresMemoryRepository({ executor, vectorAvailable: false });
    await expect(disabled.retrieveSemantic(userId, { text: "trade timing", embedding: [0.1] })).rejects.toBeInstanceOf(SemanticUnavailableError);
  });

  it("rejects invalid embedding dimensions before SQL interpolation", async () => {
    const executor = new FakeExecutor(() => ({ rows: [] }));
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.retrieveSemantic(userId, { text: "trade timing", embedding: [Number.NaN] })).rejects.toBeInstanceOf(SemanticUnavailableError);
    expect(executor.calls).toHaveLength(0);
  });

  it("compacts old candidates without deleting their current logical-key row", async () => {
    const executor = new FakeExecutor((text, values) => {
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("UPDATE memory_records AS memory")) {
        expect(text).toContain("status = 'CANDIDATE'");
        expect(text).toContain("active = FALSE");
        expect(text).toContain("updated_at < $2");
        expect(text).not.toContain("DELETE FROM memory_records");
        expect(values[0]).toBe(userId);
        expect(values[1]).toBe("2026-08-01T00:00:00.000Z");
        expect(values[2]).toBe(7);
        return { rowCount: 2, rows: [{ memory_id: "candidate-a" }, { memory_id: "candidate-b" }] };
      }
      if (text.includes("DELETE FROM memory_events AS memory_event")) {
        expect(text).toContain("status IN ('CONSUMED', 'DEAD_LETTER')");
        expect(text).toContain("created_at < $2");
        expect(text).toContain("memory_event.user_id = $1");
        expect(values[0]).toBe(userId);
        expect(values[1]).toBe("2026-08-01T00:00:00.000Z");
        expect(values[2]).toBe(11);
        return { rowCount: 3, rows: [{ event_id: "event-a" }, { event_id: "event-b" }, { event_id: "event-c" }] };
      }
      if (text.includes("DELETE FROM memory_record_revisions AS old_revision")) {
        expect(text).toContain("old_revision.user_id = $1");
        expect(text).toContain("current_memory.user_id = $1");
        expect(text).toContain("old_revision.revision < current_memory.revision");
        expect(text).not.toContain("memory_tombstones");
        expect(values).toEqual([userId, "2026-08-01T00:00:00.000Z", 13]);
        return { rowCount: 4, rows: [{ memory_id: "memory-a", revision: 1 }] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.pruneMemory(userId, {
      cutoff: "2026-08-01T00:00:00.000Z",
      maxCandidates: 7,
      maxEvents: 11,
      maxRevisions: 13,
    })).resolves.toEqual({ candidateRecords: 2, events: 3, revisions: 4 });
  });

  it("does not run retention SQL without an explicit cutoff", async () => {
    const executor = new FakeExecutor(() => ({ rows: [] }));
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.pruneMemory(userId)).resolves.toEqual({ candidateRecords: 0, events: 0, revisions: 0 });
    expect(executor.calls).toHaveLength(0);
  });

  it("rejects invalid retention limits before opening a transaction", async () => {
    const executor = new FakeExecutor(() => ({ rows: [] }));
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.pruneMemory(userId, {
      cutoff: "2026-08-01T00:00:00.000Z",
      maxEvents: -1,
    })).rejects.toThrow("INVALID_PRUNE_LIMIT");
    expect(executor.calls).toHaveLength(0);
  });

  it("serializes first logical-key writes and rechecks durable consent inside the transaction", async () => {
    const proposal = makeProposal("locked-write", "demo-locked");
    const policy = new MemoryWritePolicy();
    const decision = policy.decide({ proposal });
    const executor = new FakeExecutor((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.startsWith("INSERT INTO app_users")) return { rows: [] };
      if (text.includes("SELECT user_id, memory_enabled, consent FROM app_users")) {
        return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
      }
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("FROM memory_records")) return { rows: [] };
      if (text.includes("FROM memory_tombstones")) return { rows: [] };
      if (text.includes("FROM memory_write_receipts")) return { rows: [] };
      return { rows: [] };
    });
    const repository = new PostgresMemoryRepository({ executor });
    const saved = await repository.applyWriteDecision(userId, decision);
    expect(saved?.revision).toBe(1);
    const authIndex = executor.calls.findIndex((call) => call.text.includes("memory_enabled, consent FROM app_users"));
    const lockIndex = executor.calls.findIndex((call) => call.text.includes("pg_advisory_xact_lock"));
    const currentIndex = executor.calls.findIndex((call) => call.text.includes("FROM memory_records"));
    expect(authIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeGreaterThan(authIndex);
    expect(currentIndex).toBeGreaterThan(lockIndex);
    expect(executor.calls.some((call) => call.text.includes("INSERT INTO memory_records"))).toBe(true);
  });

  it("rejects a direct projection whose proposal predates the user deletion marker", async () => {
    const proposal = makeProposal("7", "demo-before-delete");
    const decision = new MemoryWritePolicy().decide({ proposal });
    const executor = new FakeExecutor((text) => {
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("SELECT user_id, memory_enabled, consent FROM app_users")) {
        return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
      }
      if (text.includes("SELECT memory_deleted_at FROM app_users")) {
        return { rows: [{ memory_deleted_at: "2026-08-28T01:00:00.000Z" }] };
      }
      if (text.includes("INSERT INTO memory_records")) throw new Error("projection insert must not run");
      return { rows: [] };
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.applyWriteDecision(userId, decision)).rejects.toThrow("MEMORY_DELETED_TOMBSTONE");
    expect(executor.calls.some((call) => call.text.includes("INSERT INTO memory_records"))).toBe(false);
  });

  it("refuses projection when durable consent is revoked", async () => {
    const proposal = makeProposal("revoked-write", "demo-revoked");
    const decision = new MemoryWritePolicy().decide({ proposal });
    const executor = new FakeExecutor((text) => {
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.startsWith("INSERT INTO app_users")) return { rows: [] };
      if (text.includes("SELECT user_id, memory_enabled, consent FROM app_users")) {
        return { rows: [{ user_id: userId, memory_enabled: false, consent: "REVOKED" }] };
      }
      return { rows: [] };
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.applyWriteDecision(userId, decision)).rejects.toThrow("MEMORY_CONSENT_REVOKED");
    expect(executor.calls.some((call) => call.text.includes("INSERT INTO memory_records"))).toBe(false);
  });

  it("keeps the privacy-id enumeration available when the legacy memory flag is off", async () => {
    const executor = new FakeExecutor((text, values) => {
      if (text.includes("FROM memory_records") && text.includes("ORDER BY updated_at ASC")) {
        expect(values[0]).toBe(userId);
        // The deletion predicate must not require memory_enabled=TRUE: an
        // old row can have that compatibility bit cleared after shutdown.
        expect(text).not.toContain("authorized_user.memory_enabled = TRUE");
        return { rows: [{ user_id: userId, memory_id: "memory-privacy-id" }] };
      }
      return { rows: [] };
    });
    const repository = new PostgresMemoryRepository({ executor });
    await expect(repository.listMemoryIdsForDeletion(userId, 10)).resolves.toEqual(["memory-privacy-id"]);
  });

  for (const [label, sourceRefs] of [
    ["an empty source-ref list", []],
    ["bounded source refs", makeProposal("residue-source-ref").origin.typedSourceRefs],
  ] as const) {
    it(`purges single-memory residue with ${label}`, async () => {
      let serializedSourceRefs: unknown;
      const executor = new FakeExecutor((text, values) => {
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("SELECT user_id, memory_enabled, consent FROM app_users")) {
          return { rows: [{ user_id: userId, memory_enabled: true, consent: "GRANTED" }] };
        }
        if (text.includes("DELETE FROM memory_observations")) {
          serializedSourceRefs = values[3];
          return { rows: [] };
        }
        if (text.includes("SELECT to_regclass('memory_embeddings_v1')")) return { rows: [] };
        if (text.includes("DELETE FROM memory_") || text.includes("DELETE FROM learning_threads") || text.includes("UPDATE memory_events")) {
          return { rows: [] };
        }
        throw new Error(`unexpected SQL: ${text}`);
      });
      const repository = new PostgresMemoryRepository({ executor, vectorAvailable: false });

      await expect(repository.purgeMemoryResidue(
        userId,
        "memory-residue",
        "logical-residue",
        sourceRefs,
      )).resolves.toBeUndefined();

      expect(JSON.parse(String(serializedSourceRefs))).toEqual(sourceRefs);
      expect(executor.calls.filter((call) => call.text === "COMMIT")).toHaveLength(1);
    });
  }

  it("keeps persisted JSON safety limits on single-memory residue source refs", async () => {
    const validRef = makeProposal("unsafe-residue-source-ref").origin.typedSourceRefs[0];
    const executor = new FakeExecutor(() => {
      throw new Error("unsafe source refs must fail before SQL");
    });
    const repository = new PostgresMemoryRepository({ executor });

    await expect(repository.purgeMemoryResidue(
      userId,
      "memory-residue",
      "logical-residue",
      [{ ...validRef, prompt: "forbidden persisted field" }],
    )).rejects.toThrow("FORBIDDEN_PERSISTED_FIELD:prompt");
    await expect(repository.purgeMemoryResidue(
      userId,
      "memory-residue",
      "logical-residue",
      Array.from({ length: 65 }, () => validRef),
    )).rejects.toThrow("PERSISTED_ARRAY_TOO_LONG");
    expect(executor.calls).toHaveLength(0);
  });

  it("turns every current record into a redacted tombstone during one authorized purge transaction", async () => {
    const currentRows = [makeRecord("1"), makeRecord("2")].map((record) => ({
      user_id: userId,
      record_payload: record,
    }));
    const executor = new FakeExecutor((text, values) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("SELECT user_id, memory_enabled, consent FROM app_users")) {
        expect(text).toContain("FOR UPDATE");
        expect(values).toEqual([userId]);
        return { rows: [{ user_id: userId, memory_enabled: true, consent: "REVOKED" }] };
      }
      if (text.includes("FROM memory_records") && text.includes("status <> 'DELETED'")) {
        expect(text).toContain("status <> 'DELETED'");
        expect(text).toContain("FOR UPDATE");
        expect(values).toEqual([userId]);
        return { rows: currentRows };
      }
      if (text.includes("INSERT INTO memory_records")) return { rows: [] };
      if (text.includes("INSERT INTO memory_tombstones")) return { rows: [] };
      if (text.includes("SELECT to_regclass('memory_embeddings_v1')")) return { rows: [] };
      if (text.includes("UPDATE memory_events")) return { rows: [] };
      return { rows: [] };
    });
    const repository = new PostgresMemoryRepository({
      executor,
      now: () => "2026-08-28T01:00:00.000Z",
    });

    await expect(repository.purgeUserMemoryResidue(userId)).resolves.toEqual([]);

    expect(executor.calls.filter((call) => call.text === "BEGIN")).toHaveLength(1);
    expect(executor.calls.filter((call) => call.text === "COMMIT")).toHaveLength(1);
    expect(executor.calls.filter((call) => call.text.includes("FROM memory_records") && call.text.includes("status <> 'DELETED'"))).toHaveLength(1);
    const upserts = executor.calls.filter((call) => call.text.includes("INSERT INTO memory_records"));
    expect(upserts).toHaveLength(2);
    for (const upsert of upserts) {
      expect(upsert.values[6]).toBe("DELETED");
      expect(upsert.values[7]).toBe(false);
      expect(upsert.values[9]).toBeNull();
      expect(upsert.values[10]).toBeNull();
      expect(JSON.parse(String(upsert.values[32]))).not.toHaveProperty("content");
    }
    expect(executor.calls.filter((call) => call.text.includes("INSERT INTO memory_tombstones"))).toHaveLength(2);
    expect(executor.calls.filter((call) => call.text.includes("DELETE FROM memory_observations"))).toHaveLength(3);
    expect(executor.calls.filter((call) => call.text.includes("UPDATE memory_events"))).toHaveLength(3);
  });

  it("keeps a core-only delete transaction alive when the optional vector table is absent", async () => {
    const current = makeRecord("vectorless-delete");
    const executor = new FakeExecutor((text) => {
      if (text.includes("SELECT to_regclass('memory_embeddings_v1')")) return { rows: [] };
      return { rows: [] };
    });
    const repository = new PostgresMemoryRepository({ executor, now: () => "2026-08-28T02:00:00.000Z" });
    const internals = repository as unknown as {
      proposalFromCurrent: (userId: string, record: MemoryRecord, operation: "DELETE", input: unknown) => MemoryProposal;
      saveRecord: (executor: SqlExecutor, record: MemoryRecord, proposal: MemoryProposal) => Promise<void>;
    };
    const proposal = internals.proposalFromCurrent(userId, current, "DELETE", { reason: "core-only test" });
    const decision = new MemoryWritePolicy().decide({ proposal, current, eventType: "MEMORY_DELETED" });
    const deleted = new MemoryReducer().reduce({ userId, proposal, decision, current, now: "2026-08-28T02:00:00.000Z" });
    if (!deleted) throw new Error("delete fixture was not reduced");

    await expect(internals.saveRecord(executor, deleted, proposal)).resolves.toBeUndefined();
    const probeIndex = executor.calls.findIndex((call) => call.text.includes("SELECT to_regclass('memory_embeddings_v1')"));
    const receiptIndex = executor.calls.findIndex((call) => call.text.includes("INSERT INTO memory_write_receipts"));
    expect(probeIndex).toBeGreaterThan(-1);
    expect(receiptIndex).toBeGreaterThan(probeIndex);
    expect(executor.calls.some((call) => call.text.includes("UPDATE memory_embeddings_v1"))).toBe(false);
    expect(executor.calls.some((call) => call.text.includes("INSERT INTO memory_write_receipts"))).toBe(true);
  });
});
