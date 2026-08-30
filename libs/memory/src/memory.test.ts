import { describe, expect, it } from "vitest";
import type { CoachVerdict, CueCase, LearningThread, UserClaim } from "@cs-coach/contracts";
import {
  MEMORY_EVENT_VERSION,
  MEMORY_PROPOSAL_VERSION,
  MEMORY_RECORD_VERSION,
  MemoryBriefSchema,
  MemoryEventSchema,
  MemoryProfileSchema,
  MemoryProposalSchema,
  MemoryRecordSchema,
  MemorySourceRefSchema,
  NoopCacheProvider,
  InMemoryMemoryRepository,
  MemoryService,
  MemoryWritePolicy,
  buildMemoryProposal,
  buildAgentMemoryBrief,
  approximateMemoryBriefTokens,
  buildUserMemoryBrief,
  type MemoryEvent,
  type MemoryAuthorization,
  type MemoryPreference,
  type MemoryRecord,
  type MemoryProposal,
} from "./index";

const userId = "user-1";

function makeClaim(cueId: string): UserClaim {
  return {
    claimId: `claim-${cueId}`,
    type: "GOAL",
    content: "我想等队友补枪再处理",
    source: "USER",
    verification: "UNTESTED",
    supportingRefs: [],
    contradictingRefs: [],
    limitations: [],
    cueId,
  };
}

function makeThread(suffix = "1"): LearningThread {
  return {
    threadId: `thread-${suffix}`,
    scope: "SESSION",
    hingeCode: "TRADE_TIMING",
    trigger: { situation: "接触后队友仍可补枪", conditions: ["队友在附近"] },
    userModel: { goal: "拿到击杀", belief: "我必须马上继续打" },
    diagnosis: { type: "TIMING", summary: "需要先等补枪窗口", confidence: 0.8 },
    transferRule: {
      ruleId: "rule-trade-timing",
      when: "有队友可补枪时",
      do: "先保持可交易角度",
      refs: [],
      confidence: 0.75,
      limitations: [],
    },
    evidenceCueIds: [`cue-${suffix}`],
    successfulCueIds: [],
    conflictingCueIds: [],
    status: "TAUGHT",
  };
}

function makeCueCase(suffix = "1"): CueCase {
  const cueId = `cue-${suffix}`;
  return {
    schemaVersion: "cue-case.v1",
    caseId: `case-${suffix}`,
    cueId,
    pedagogyMode: "INTRODUCE",
    status: "AWAITING_CONFIRMATION",
    claims: [makeClaim(cueId)],
    capabilities: [],
    diagnosticResult: {
      resultId: `diagnostic-${suffix}`,
      capabilityId: "VERIFY_TRADE_ASSUMPTION",
      cueId,
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
      claimIds: [`claim-${cueId}`],
      evidenceRefs: [],
      limitations: [],
      revision: 0,
      explanation: "已完成有界判断",
    },
    baselineNarrationAvailable: true,
    attemptBudget: { reflection: 0, diagnostic: 0, disagreement: 0, alternateDiagnostic: 0 },
    limitations: [],
  };
}

function makeProposal(suffix = "1", demoHash = `demo-${suffix}`) {
  return buildMemoryProposal({
    userId,
    sessionId: `session-${suffix}`,
    demoContentHash: demoHash,
    cueCase: makeCueCase(suffix),
    learningThread: makeThread(suffix),
    outcomeGateStatus: "COMPLETE",
    createdAt: `2026-08-28T00:00:0${suffix}.000Z`,
  });
}

function makeEvent(proposal: ReturnType<typeof makeProposal>, suffix = "1"): MemoryEvent {
  return {
    schemaVersion: MEMORY_EVENT_VERSION,
    eventId: `event-${suffix}`,
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

function makeService(repository: InMemoryMemoryRepository, enabled = true) {
  return new MemoryService({
    repository,
    memoryEnabled: enabled,
    authorization: { userId, memoryEnabled: true, consent: "GRANTED" },
    now: () => "2026-08-28T00:00:10.000Z",
  });
}

describe("Memory Domain", () => {
  it("stores explicit profile fields as an immediate confirmed record and is idempotent", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = await service.setProfile(userId, { displayName: "小林", role: "support", yearsPlaying: 3 });
    expect(first.accepted).toBe(true);
    expect(first.record).toMatchObject({ kind: "PROFILE", status: "CONFIRMED", active: true, source: "USER_EXPLICIT" });
    expect(first.record?.profile).toEqual({ displayName: "小林", role: "support", yearsPlaying: 3 });
    expect(first.record?.limitations).not.toContain("No structured diagnosis was supplied.");
    expect(repository.events[0]).toMatchObject({ type: "USER_PROFILE_STATED", operation: "CREATE" });

    const retry = await service.setProfile(userId, { yearsPlaying: 3, role: "support", displayName: "小林" });
    expect(retry.accepted).toBe(false);
    expect(retry.decision.reason).toBe("DUPLICATE_IDEMPOTENCY");
    expect(repository.events.filter((event) => event.type === "USER_PROFILE_STATED")).toHaveLength(1);

    const changed = await service.setProfile(userId, { displayName: "小林", role: "rifler", yearsPlaying: 3 });
    expect(changed.accepted).toBe(true);
    expect(changed.record?.status).toBe("CONFIRMED");
    expect(changed.record?.revision).toBe(2);
    expect(await service.getProfile(userId)).toEqual({ displayName: "小林", role: "rifler", yearsPlaying: 3 });

    if (!changed.record) throw new Error("profile record was not created");
    const userBrief = buildUserMemoryBrief({ records: [changed.record] });
    expect(userBrief.memories).toHaveLength(1);
    const agentBrief = buildAgentMemoryBrief(userBrief);
    expect(agentBrief.memories).toEqual([]);
  });

  it("bounds profile fields and keeps profile reads/writes behind user consent", async () => {
    const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field${index}`, `value${index}`]));
    expect(MemoryProfileSchema.safeParse(tooMany).success).toBe(false);
    expect(MemoryProfileSchema.safeParse({ ["k".repeat(65)]: "value" }).success).toBe(false);
    expect(MemoryProfileSchema.safeParse({ field: "v".repeat(241) }).success).toBe(false);
    expect(MemoryProfileSchema.safeParse({ userId: "other-user" }).success).toBe(false);

    const disabledRepository = new InMemoryMemoryRepository();
    const disabled = new MemoryService({
      repository: disabledRepository,
      memoryEnabled: false,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED" },
    });
    const disabledResult = await disabled.setProfile(userId, { role: "support" });
    expect(disabledResult.errorCode).toBe("MEMORY_DISABLED");
    expect(disabledRepository.calls).toEqual([]);

    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    await service.setProfile(userId, { role: "support" });
    await service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "REVOKED", consentVersion: 1 });
    expect(await service.getProfile(userId)).toBeUndefined();
    const revokedResult = await service.setProfile(userId, { role: "rifler" });
    expect(revokedResult.errorCode).toBe("MEMORY_DISABLED");
    expect(repository.events.filter((event) => event.type === "USER_PROFILE_STATED")).toHaveLength(1);
  });

  it("writes an explicit user preference immediately", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const ref = {
      namespace: "USER_PREFERENCE" as const,
      refId: "pref-role",
      demoContentHash: "demo-pref",
      sessionId: "session-pref",
      cueId: "preference",
    };
    const preference: MemoryPreference = { key: "role", value: "support", source: "USER_EXPLICIT", refs: [ref] };
    const proposal = {
      schemaVersion: MEMORY_PROPOSAL_VERSION,
      proposalId: "proposal-pref",
      userId,
      operation: "CREATE" as const,
      eventType: "USER_PREFERENCE_STATED" as const,
      requestedScope: "CROSS_DEMO" as const,
      kind: "COACHING_PREFERENCE" as const,
      logicalKey: "preference:role",
      claims: [],
      preference,
      origin: { sessionId: "session-pref", demoContentHash: "demo-pref", cueId: "preference", typedSourceRefs: [ref] },
      lifecycle: "CONFIRMED" as const,
      consentState: "GRANTED" as const,
      producerVersion: "test",
      idempotencyKey: "idem-pref",
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    const result = await service.ingestEvent(userId, makeEvent(proposal, "pref"));
    expect(result.accepted).toBe(true);
    expect(result.record?.kind).toBe("COACHING_PREFERENCE");
    expect(result.record?.status).toBe("CONFIRMED");
    expect(result.record?.source).toBe("USER_EXPLICIT");
    expect(result.record?.limitations).not.toContain("No structured diagnosis was supplied.");
    expect((await repository.getPreferences(userId)).length).toBe(1);
  });

  it("keeps a single cue diagnosis as CANDIDATE only", async () => {
    const repository = new InMemoryMemoryRepository();
    const result = await makeService(repository).ingestEvent(userId, makeEvent(makeProposal("1")));
    expect(result.accepted).toBe(true);
    expect(result.record?.status).toBe("CANDIDATE");
    expect(result.record?.active).toBe(false);
    expect(result.record?.source).toBe("AGENT_INFERRED");
  });

  it("rejects a changed payload when an event idempotency key already exists", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = makeEvent(makeProposal("event-idempotency-conflict"), "event-idempotency-conflict");
    const accepted = await service.ingestEvent(userId, first);
    expect(accepted.accepted).toBe(true);
    const changed = {
      ...first,
      payload: { ...(first.payload as Record<string, unknown>), content: "不同的重放内容" },
    };
    const replay = await service.ingestEvent(userId, changed);
    expect(replay.accepted).toBe(false);
    expect(replay.errorCode).toBe("INVALID_EVENT");
    expect(repository.events).toHaveLength(1);
    expect(repository.events[0]?.payload).not.toMatchObject({ content: "不同的重放内容" });
  });

  it("rejects a learning proposal that omits the envelope event/gate proof", async () => {
    const proposal = structuredClone(makeProposal("gate-bypass")) as ReturnType<typeof makeProposal>;
    delete (proposal as Partial<typeof proposal>).eventType;
    delete (proposal as Partial<typeof proposal>).outcomeGateStatus;
    delete (proposal as Partial<typeof proposal>).verdict;
    const forged = {
      schemaVersion: MEMORY_EVENT_VERSION,
      eventId: "gate-bypass-event",
      type: "CUE_DIAGNOSED" as const,
      eventType: "CUE_DIAGNOSED" as const,
      userId,
      sessionId: proposal.origin.sessionId,
      demoContentHash: proposal.origin.demoContentHash,
      proposalId: proposal.proposalId,
      operation: proposal.operation,
      idempotencyKey: "gate-bypass-idem",
      producerVersion: proposal.producerVersion,
      payload: proposal,
      createdAt: proposal.createdAt,
    };
    expect(MemoryEventSchema.safeParse(forged).success).toBe(false);
    const repository = new InMemoryMemoryRepository();
    const result = await makeService(repository).ingestEvent(userId, forged);
    expect(result.accepted).toBe(false);
    expect(repository.calls).toEqual([]);
  });

  it("rejects management operations disguised as cue proposals before repository writes", async () => {
    const base = makeProposal("management-cue-forgery");
    const cases = [
      { operation: "CORRECT", eventType: "CUE_DIAGNOSED" },
      { operation: "CONFIRM", eventType: "TRANSFER_RULE_TAUGHT" },
      { operation: "DELETE", eventType: "TRANSFER_RULE_APPLIED" },
    ] as const;
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    for (const [index, candidate] of cases.entries()) {
      const proposal = {
        ...base,
        proposalId: `forged-management-proposal-${index}`,
        operation: candidate.operation,
        eventType: candidate.eventType,
        targetMemoryId: "memory-existing-target",
        ...(candidate.operation === "CORRECT"
          ? { correction: { correctionId: `forged-correction-${index}`, content: "forged", source: "USER" as const } }
          : {}),
      };
      const event = {
        ...makeEvent(base, `forged-management-event-${index}`),
        eventId: `forged-management-event-${index}`,
        type: candidate.eventType,
        eventType: candidate.eventType,
        operation: candidate.operation,
        targetMemoryId: "memory-existing-target",
        payload: proposal,
      } as unknown as MemoryEvent;
      expect(MemoryProposalSchema.safeParse(proposal).success).toBe(false);
      expect(MemoryEventSchema.safeParse(event).success).toBe(false);
      const result = await service.ingestEvent(userId, event);
      expect(result.accepted).toBe(false);
      expect(result.errorCode).toBe("INVALID_EVENT");
    }
    expect(MemoryProposalSchema.safeParse({
      ...base,
      operation: "DELETE",
      eventType: "MEMORY_DELETED",
      lifecycle: "DELETED",
    }).success).toBe(false);
    expect(repository.calls).toEqual([]);
  });

  it("requires a real aggregate before appending a mapped management proposal", async () => {
    const base = makeProposal("management-missing-target");
    const proposal = {
      ...base,
      operation: "CORRECT" as const,
      eventType: "USER_CORRECTED_COACH" as const,
      targetMemoryId: "memory-does-not-exist",
      correction: { correctionId: "missing-target-correction", content: "用户修正", source: "USER" as const },
    };
    const event = {
      ...makeEvent(base, "management-missing-target-event"),
      eventId: "management-missing-target-event",
      type: "USER_CORRECTED_COACH" as const,
      eventType: "USER_CORRECTED_COACH" as const,
      operation: "CORRECT" as const,
      targetMemoryId: proposal.targetMemoryId,
      payload: proposal,
    } as unknown as MemoryEvent;
    expect(MemoryEventSchema.safeParse(event).success).toBe(true);
    const repository = new InMemoryMemoryRepository();
    const result = await makeService(repository).ingestEvent(userId, event);
    expect(result.accepted).toBe(false);
    expect(result.errorCode).toBe("INVALID_EVENT");
    expect(repository.calls).toEqual(["getRecordVersion"]);
    expect(repository.calls).not.toContain("appendEvent");
    expect(repository.calls).not.toContain("applyWriteDecision");
  });

  it("rejects management policy decisions without an existing aggregate", () => {
    const proposal = {
      ...makeProposal("policy-missing-aggregate"),
      operation: "DELETE" as const,
      eventType: "MEMORY_DELETED" as const,
      targetMemoryId: "memory-missing-aggregate",
      lifecycle: "DELETED" as const,
    };
    const decision = new MemoryWritePolicy().decide({ proposal, eventType: "MEMORY_DELETED" });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("INVALID_PROPOSAL");
  });

  it("preserves the legal CORRECT plus USER_CORRECTED_COACH disagreement path", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const originalProposal = makeProposal("disagreement-base");
    const original = await service.ingestEvent(userId, makeEvent(originalProposal, "disagreement-base-event"));
    const memoryId = original.record?.memoryId as string;
    const proposal = {
      ...originalProposal,
      proposalId: "disagreement-correction-proposal",
      operation: "CORRECT" as const,
      eventType: "USER_CORRECTED_COACH" as const,
      targetMemoryId: memoryId,
      idempotencyKey: "disagreement-correction-idempotency",
      correction: { correctionId: "disagreement-correction", content: "我不同意这个判断", source: "USER" as const },
    };
    const event = {
      ...makeEvent(originalProposal, "disagreement-event"),
      eventId: "disagreement-event",
      type: "USER_CORRECTED_COACH" as const,
      eventType: "USER_CORRECTED_COACH" as const,
      operation: "CORRECT" as const,
      targetMemoryId: memoryId,
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      payload: proposal,
    } as unknown as MemoryEvent;
    expect(MemoryEventSchema.safeParse(event).success).toBe(true);
    const corrected = await service.ingestEvent(userId, event);
    expect(corrected.accepted).toBe(true);
    expect(corrected.record?.status).toBe("DISPUTED");
    expect(corrected.record?.corrections[0]?.content).toBe("我不同意这个判断");
    expect(repository.calls).toContain("appendEvent");
  });

  it("rejects SESSION_COMPLETED content-bearing payloads before append", async () => {
    const base = {
      schemaVersion: MEMORY_EVENT_VERSION,
      eventId: "invalid-session-completed",
      type: "SESSION_COMPLETED" as const,
      eventType: "SESSION_COMPLETED" as const,
      userId,
      sessionId: "session-completed-invalid",
      demoContentHash: "demo-completed-invalid",
      idempotencyKey: "session-completed-invalid-idem",
      producerVersion: "test",
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    const invalidEvents = [
      { ...base, payload: { reason: "SESSION_COMPLETED", content: "must not persist" } },
      { ...base, eventId: "invalid-session-completed-proposal", payload: { reason: "SESSION_COMPLETED", proposal: makeProposal("completion-proposal") } },
      { ...base, eventId: "invalid-session-completed-ref", payload: undefined, payloadRef: { namespace: "SESSION" as const, refId: "completion-ref", demoContentHash: "demo-completed-invalid", sessionId: base.sessionId, cueId: "session-complete" } },
    ];
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    for (const event of invalidEvents) {
      expect(MemoryEventSchema.safeParse(event).success).toBe(false);
      const result = await service.ingestEvent(userId, event);
      expect(result.accepted).toBe(false);
      expect(result.errorCode).toBe("INVALID_EVENT");
    }
    expect(repository.calls).toEqual([]);
  });

  it("promotes evidence from two distinct demos to EMERGING/active", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = makeProposal("1", "demo-a");
    const second = makeProposal("2", "demo-b");
    await service.ingestEvent(userId, makeEvent(first, "a"));
    const result = await service.ingestEvent(userId, makeEvent(second, "b"));
    expect(result.record?.status).toBe("EMERGING");
    expect(result.record?.active).toBe(true);
    expect(result.record?.demoContentHashes).toEqual(["demo-a", "demo-b"]);
  });

  it("merges concurrent Demo observations instead of losing the later hash", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = makeProposal("concurrent-a", "demo-concurrent-a");
    const second = makeProposal("concurrent-b", "demo-concurrent-b");
    await Promise.all([
      service.ingestEvent(userId, makeEvent(first, "concurrent-a")),
      service.ingestEvent(userId, makeEvent(second, "concurrent-b")),
    ]);
    const records = await repository.listMemories(userId);
    expect(records).toHaveLength(1);
    expect(records[0]?.demoContentHashes).toEqual(["demo-concurrent-a", "demo-concurrent-b"]);
  });

  it("tracks deterministic transfer applications through improving to stable", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = makeProposal("apply-1", "demo-apply-a");
    const second = makeProposal("apply-2", "demo-apply-b");
    await service.ingestEvent(userId, makeEvent(first, "apply-a"));
    await service.ingestEvent(userId, makeEvent(second, "apply-b"));
    const application = (base: MemoryProposal, suffix: string): MemoryEvent => {
      const proposal: MemoryProposal = {
        ...base,
        proposalId: `proposal-application-${suffix}`,
        operation: "UPDATE",
        eventType: "TRANSFER_RULE_APPLIED",
        applicationOutcome: "SUCCESS",
        idempotencyKey: `application-${suffix}`,
      };
      return makeEvent(proposal, `application-${suffix}`);
    };
    const improving = await service.ingestEvent(userId, application(second, "one"));
    expect(improving.record?.status).toBe("IMPROVING");
    const stable = await service.ingestEvent(userId, application(second, "two"));
    expect(stable.record?.status).toBe("STABLE");
    expect(stable.record?.successfulApplicationCount).toBe(2);
  });

  it("does not promote a transfer application from one Demo alone", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = makeProposal("single-apply", "demo-single");
    await service.ingestEvent(userId, makeEvent(first, "single-base"));
    const application: MemoryProposal = {
      ...first,
      proposalId: "proposal-single-application",
      operation: "UPDATE",
      eventType: "TRANSFER_RULE_APPLIED",
      applicationOutcome: "SUCCESS",
      idempotencyKey: "single-application",
    };
    const result = await service.ingestEvent(userId, makeEvent(application, "single-application"));
    expect(result.record?.status).toBe("CANDIDATE");
    expect(result.record?.active).toBe(false);
    expect(result.record?.successfulApplicationCount).toBe(1);
  });

  it("gives user confirmation and correction precedence with immutable revisions", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = await service.ingestEvent(userId, makeEvent(makeProposal("1")));
    const memoryId = first.record?.memoryId as string;
    const confirmed = await service.confirm(userId, memoryId);
    expect(confirmed?.status).toBe("CONFIRMED");
    const corrected = await service.correct(userId, memoryId, { content: "我当时是在等明确报点", correctionId: "correction-1" });
    expect(corrected?.revision).toBe(3);
    expect(corrected?.corrections).toHaveLength(1);
    expect(corrected?.content).toBe("我当时是在等明确报点");
    expect(corrected?.status).toBe("DISPUTED");
    expect(corrected?.active).toBe(true);
    expect(corrected?.corrections[0]?.refs[0]?.namespace).toBe("USER_CLAIM");
    const old = await repository.getRecordVersion?.(userId, memoryId, 1);
    expect(old?.content).not.toBe("我当时是在等明确报点");
    expect(old?.revision).toBe(1);
    expect(repository.events.map((event) => event.type)).toContain("USER_CONFIRMED");
    expect(repository.events.map((event) => event.type)).toContain("USER_CORRECTED_COACH");
  });

  it("does not downgrade a user-confirmed memory when later model evidence arrives", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = await service.ingestEvent(userId, makeEvent(makeProposal("confirm-first", "confirm-demo-a"), "confirm-first"));
    const memoryId = first.record?.memoryId as string;
    await service.confirm(userId, memoryId);
    const later = await service.ingestEvent(userId, makeEvent(makeProposal("confirm-later", "confirm-demo-b"), "confirm-later"));
    expect(later.record?.status).toBe("CONFIRMED");
    expect(later.record?.active).toBe(true);
  });

  it("keeps corrected content while accepting later independent evidence", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = await service.ingestEvent(userId, makeEvent(makeProposal("freeze-1", "demo-freeze-a"), "freeze-a"));
    const memoryId = first.record?.memoryId as string;
    const corrected = await service.correct(userId, memoryId, { content: "用户版本", correctionId: "freeze-correction" });
    const later = makeProposal("freeze-2", "demo-freeze-b");
    const updated = await service.ingestEvent(userId, makeEvent(later, "freeze-b"));
    expect(updated.record?.content).toBe("用户版本");
    expect(updated.record?.status).toBe("DISPUTED");
    expect(updated.record?.source).toBe("USER_CORRECTION");
    expect(updated.record?.demoContentHashes).toEqual(["demo-freeze-a", "demo-freeze-b"]);
    expect(updated.record?.revision).toBe((corrected?.revision ?? 0) + 1);
  });

  it("creates a delete tombstone and rejects replayed old events", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const event = makeEvent(makeProposal("1"));
    const first = await service.ingestEvent(userId, event);
    const memoryId = first.record?.memoryId as string;
    const deleted = await service.delete(userId, memoryId, { reason: "not useful" });
    expect(deleted?.status).toBe("DELETED");
    const replay = await service.ingestEvent(userId, event);
    expect(replay.accepted).toBe(false);
    expect(replay.record?.status).toBe("DELETED");
    expect((await repository.findByLogicalKey(userId, first.record?.logicalKey as string))?.status).toBe("DELETED");
  });

  it("allows an authenticated MEMORY_DELETED event through the revoked deletion-only gate", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = await service.ingestEvent(userId, makeEvent(makeProposal("delete-event-revoked")));
    const memoryId = first.record?.memoryId as string;
    await service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "REVOKED", consentVersion: 2 });
    const event = MemoryEventSchema.parse({
      schemaVersion: MEMORY_EVENT_VERSION,
      eventId: "delete-event-revoked-event",
      type: "MEMORY_DELETED",
      eventType: "MEMORY_DELETED",
      userId,
      sessionId: "memory-management",
      targetMemoryId: memoryId,
      operation: "DELETE",
      idempotencyKey: "delete-event-revoked-idem",
      producerVersion: "test",
      payload: { memoryId, reason: "privacy erase" },
      createdAt: "2026-08-28T00:00:03.000Z",
    });

    const result = await service.ingestEvent(userId, event);
    expect(result.accepted).toBe(true);
    expect(result.record?.status).toBe("DELETED");
  });

  it("redacts consumed event payloads during user-wide purge", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const original = await service.ingestEvent(userId, makeEvent(makeProposal("purge-redaction"), "purge-redaction"));
    expect(original.accepted).toBe(true);
    expect(JSON.stringify(repository.events)).toContain("我想等队友补枪再处理");

    await service.purgeUserMemoryResidue(userId);
    expect(JSON.stringify(repository.events)).not.toContain("我想等队友补枪再处理");
    expect(repository.events[0]?.payload).toEqual({ reason: "MEMORY_DELETED" });
  });

  it("allows an explicit user deletion after a correction", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const first = await service.ingestEvent(userId, makeEvent(makeProposal("1")));
    const memoryId = first.record?.memoryId as string;
    const corrected = await service.correct(userId, memoryId, {
      content: "用户修正后的事实",
      correctionId: "correction-before-delete",
    });
    expect(corrected?.corrections).toHaveLength(1);

    const deleted = await service.delete(userId, memoryId, { reason: "user requested deletion" });
    expect(deleted?.status).toBe("DELETED");
    expect(deleted?.active).toBe(false);
    expect((await repository.listMemories(userId)).filter((record) => record.status !== "DELETED")).toHaveLength(0);
  });

  it("invalidates a cached brief immediately after a tombstone even when host cleanup fails", async () => {
    const repository = new InMemoryMemoryRepository();
    const cached = new Map<string, unknown>();
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED", consentVersion: 1 },
      cache: {
        get: async <T>(key: string) => cached.get(key) as T | undefined,
        set: async <T>(key: string, value: T) => { cached.set(key, value); },
        delete: async (key: string) => { cached.delete(key); },
      },
      onMemoryDeleted: async () => { throw new Error("host unavailable"); },
    });
    await service.ingestEvent(userId, makeEvent(makeProposal("cache-delete-a", "demo-cache-delete-a"), "cache-delete-a"));
    const active = await service.ingestEvent(userId, makeEvent(makeProposal("cache-delete-b", "demo-cache-delete-b"), "cache-delete-b"));
    const memoryId = active.record?.memoryId as string;
    expect((await service.getBrief(userId)).memories).toHaveLength(1);

    // Host cleanup remains retryable, but the authoritative tombstone has
    // already committed and must make the old cached projection unreachable.
    await expect(service.delete(userId, memoryId, { reason: "privacy erase" })).resolves.toBeUndefined();
    expect((await repository.getRecordVersion?.(userId, memoryId))?.status).toBe("DELETED");
    expect((await service.getBrief(userId)).memories).toHaveLength(0);
  });

  it("invalidates a cached brief for a direct MEMORY_DELETED event before host cleanup", async () => {
    const repository = new InMemoryMemoryRepository();
    const cached = new Map<string, unknown>();
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED", consentVersion: 1 },
      cache: {
        get: async <T>(key: string) => cached.get(key) as T | undefined,
        set: async <T>(key: string, value: T) => { cached.set(key, value); },
        delete: async (key: string) => { cached.delete(key); },
      },
      onMemoryDeleted: async () => { throw new Error("host unavailable"); },
    });
    await service.ingestEvent(userId, makeEvent(makeProposal("direct-cache-delete-a", "demo-direct-cache-delete-a"), "direct-cache-delete-a"));
    const active = await service.ingestEvent(userId, makeEvent(makeProposal("direct-cache-delete-b", "demo-direct-cache-delete-b"), "direct-cache-delete-b"));
    const memoryId = active.record?.memoryId as string;
    expect((await service.getBrief(userId)).memories).toHaveLength(1);
    const event = MemoryEventSchema.parse({
      schemaVersion: MEMORY_EVENT_VERSION,
      eventId: "direct-cache-delete-event",
      type: "MEMORY_DELETED",
      eventType: "MEMORY_DELETED",
      userId,
      sessionId: "direct-cache-delete-session",
      targetMemoryId: memoryId,
      operation: "DELETE",
      idempotencyKey: "direct-cache-delete-idem",
      producerVersion: "test",
      payload: { memoryId, reason: "privacy erase" },
      createdAt: "2026-08-28T00:00:03.000Z",
    });

    await expect(service.ingestEvent(userId, event)).resolves.toMatchObject({ accepted: false });
    expect((await repository.getRecordVersion?.(userId, memoryId))?.status).toBe("DELETED");
    expect((await service.getBrief(userId)).memories).toHaveLength(0);
  });

  it("retries host invalidation when a tombstone already exists", async () => {
    const repository = new InMemoryMemoryRepository();
    let attempts = 0;
    const notices: Array<{ memoryId: string; sessionIds: readonly string[] }> = [];
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED" },
      onMemoryDeleted: async (notice) => {
        attempts += 1;
        notices.push({ memoryId: notice.memoryId, sessionIds: notice.sessionIds });
        if (attempts === 1) throw new Error("host unavailable");
      },
    });
    const seeded = await service.ingestEvent(userId, makeEvent(makeProposal("delete-retry"), "delete-retry"));
    const memoryId = seeded.record?.memoryId as string;

    await expect(service.delete(userId, memoryId, { reason: "privacy erase" })).resolves.toBeUndefined();
    const retried = await service.delete(userId, memoryId, { reason: "privacy erase" });
    expect(retried?.status).toBe("DELETED");
    expect(attempts).toBe(2);
    expect(notices[1]).toMatchObject({ memoryId });
    expect(notices[1]?.sessionIds).toContain("session-delete-retry");
  });

  it("retries direct MEMORY_DELETED cleanup without replaying a redacted payload", async () => {
    const repository = new InMemoryMemoryRepository();
    let attempts = 0;
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED" },
      onMemoryDeleted: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("host unavailable");
      },
    });
    const seeded = await service.ingestEvent(userId, makeEvent(makeProposal("direct-delete-retry"), "direct-delete-retry"));
    const memoryId = seeded.record?.memoryId as string;
    const event = MemoryEventSchema.parse({
      schemaVersion: MEMORY_EVENT_VERSION,
      eventId: "direct-delete-retry-event",
      type: "MEMORY_DELETED",
      eventType: "MEMORY_DELETED",
      userId,
      sessionId: "direct-delete-retry-session",
      targetMemoryId: memoryId,
      operation: "DELETE",
      idempotencyKey: "direct-delete-retry-idem",
      producerVersion: "test",
      payload: { memoryId, reason: "erase this payload" },
      createdAt: "2026-08-28T00:00:03.000Z",
    });

    const first = await service.ingestEvent(userId, event);
    expect(first.accepted).toBe(false);
    const second = await service.ingestEvent(userId, event);
    expect(second.accepted).toBe(false);
    expect(second.record?.status).toBe("DELETED");
    expect(attempts).toBe(2);
    expect(JSON.stringify(repository.events)).not.toContain("erase this payload");
  });

  it("rejects a late control correction without appending deleted user text", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const original = await service.ingestEvent(userId, makeEvent(makeProposal("late-control")));
    const memoryId = original.record?.memoryId as string;
    await service.delete(userId, memoryId, { reason: "erase" });
    const before = repository.events.length;
    const lateEvent = MemoryEventSchema.parse({
      schemaVersion: MEMORY_EVENT_VERSION,
      eventId: "late-control-event",
      type: "USER_CORRECTED_COACH",
      eventType: "USER_CORRECTED_COACH",
      userId,
      sessionId: "late-control-session",
      targetMemoryId: memoryId,
      operation: "CORRECT",
      idempotencyKey: "late-control-idem",
      producerVersion: "late-test",
      payload: { memoryId, correction: { correctionId: "late-correction", content: "DELETED_SECRET_TEXT", source: "USER" } },
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    const result = await service.ingestEvent(userId, lateEvent);
    expect(result.accepted).toBe(false);
    expect(result.record?.status).toBe("DELETED");
    expect(repository.events).toHaveLength(before);
    expect(JSON.stringify(repository.events)).not.toContain("DELETED_SECRET_TEXT");
  });

  it("merges by logical key and is idempotent", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    const event = makeEvent(makeProposal("1"));
    const first = await service.ingestEvent(userId, event);
    const duplicate = await service.ingestEvent(userId, event);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.decision.reason).toBe("DUPLICATE_IDEMPOTENCY");
    expect(duplicate.record?.revision).toBe(first.record?.revision);
    expect((await repository.listMemories(userId)).filter((record) => record.status !== "DELETED")).toHaveLength(1);
  });

  it("bounds brief to two threads, three memories, and two corrections", () => {
    const refs = (index: number) => [{ namespace: "SESSION" as const, refId: `ref-${index}`, demoContentHash: `demo-${index}`, sessionId: `session-${index}`, cueId: `cue-${index}` }];
    const records: MemoryRecord[] = Array.from({ length: 4 }, (_, index) => ({
      schemaVersion: MEMORY_RECORD_VERSION,
      memoryId: `memory-${index}`,
      userId,
      kind: "LEARNING_THREAD",
      source: "AGENT_INFERRED",
      scope: "CROSS_DEMO",
      logicalKey: `logical-${index}`,
      status: "CONFIRMED",
      active: true,
      revision: 1,
      summary: `summary ${index}`,
      claims: [],
      facts: [],
      inferences: [],
      advice: [],
      evidence: refs(index),
      sourceRefs: refs(index),
      demoContentHashes: [`demo-${index}`],
      corrections: [{ correctionId: `correction-${index}`, memoryId: `memory-${index}`, content: `correction ${index}`, source: "USER", createdAt: `2026-08-28T00:00:0${index}.000Z`, revision: 1, refs: refs(index) }],
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: `2026-08-28T00:00:0${index}.000Z`,
      limitations: [],
      producerVersion: "test",
      lastIdempotencyKey: `idem-${index}`,
      thread: makeThread(`${index}`),
    }));
    const brief = buildUserMemoryBrief({ records, generatedAt: "2026-08-28T00:00:10.000Z" });
    expect(brief.memories).toHaveLength(3);
    expect(brief.activeThreads).toHaveLength(2);
    expect(brief.corrections).toHaveLength(2);
    expect(MemoryBriefSchema.safeParse(brief).success).toBe(true);
    const agentBrief = buildAgentMemoryBrief(brief);
    expect(approximateMemoryBriefTokens(agentBrief)).toBeLessThanOrEqual(800);
    expect(JSON.stringify(agentBrief)).not.toContain("memoryId");
  });

  it("falls back to structured brief when embedding fails", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED" },
      embedding: { embed: async () => { throw new Error("embedding unavailable"); } },
    });
    await service.ingestEvent(userId, makeEvent(makeProposal("1")));
    const brief = await service.getBrief(userId, { semanticText: "trade timing" });
    expect(brief.source).toBe("EMPTY"); // the only record is still a candidate
    expect(brief.limitations.join(" ")).toContain("Semantic");
    expect(repository.calls).toContain("retrieveStructured");
  });

  it("bounds a hanging semantic embedding provider and returns structured fallback", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED" },
      embeddingTimeoutMs: 10,
      embedding: { embed: () => new Promise<readonly number[]>(() => undefined) },
    });
    await service.ingestEvent(userId, makeEvent(makeProposal("embedding-hang")));
    const startedAt = Date.now();
    const brief = await service.getBrief(userId, { semanticText: "trade timing" });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(brief.limitations.join(" ")).toContain("Semantic");
  });

  it("indexes an accepted active memory through the optional embedding seam", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED" },
      embedding: { model: "test-embedding", embed: async () => [0.1, 0.2] },
    });
    await service.ingestEvent(userId, makeEvent(makeProposal("embed-1", "embed-demo-a"), "embed-a"));
    expect(repository.embeddings).toHaveLength(0); // first observation remains a candidate
    const accepted = await service.ingestEvent(userId, makeEvent(makeProposal("embed-2", "embed-demo-b"), "embed-b"));
    expect(accepted.record?.active).toBe(true);
    expect(repository.embeddings).toHaveLength(1);
    expect(repository.embeddings[0]).toMatchObject({ userId, memoryId: accepted.record?.memoryId, model: "test-embedding", sourceRevision: accepted.record?.revision });
  });

  it("does not invoke optional embedding after consent is revoked before confirmation", async () => {
    const repository = new InMemoryMemoryRepository();
    const seed = makeService(repository);
    await seed.ingestEvent(userId, makeEvent(makeProposal("embed-before-a", "embed-before-demo-a"), "embed-before-a"));
    const active = await seed.ingestEvent(userId, makeEvent(makeProposal("embed-before-b", "embed-before-demo-b"), "embed-before-b"));
    const memoryId = active.record?.memoryId as string;
    let providerCalls = 0;
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorizationStore: {
        getAuthorization: async () => ({ userId, memoryEnabled: true, consent: "REVOKED", consentVersion: 2, updatedAt: "2026-08-28T00:00:02.000Z" }),
        setAuthorization: async () => undefined,
      },
      embedding: { embed: async () => { providerCalls += 1; return [0.1, 0.2]; } },
    });
    repository.calls.length = 0;
    await expect(service.confirm(userId, memoryId)).resolves.toBeUndefined();
    expect(providerCalls).toBe(0);
    expect(repository.calls).toEqual([]);
  });

  it("drops an embedding when consent version changes while confirmation embedding is in flight", async () => {
    const repository = new InMemoryMemoryRepository();
    const seed = makeService(repository);
    await seed.ingestEvent(userId, makeEvent(makeProposal("embed-after-a", "embed-after-demo-a"), "embed-after-a"));
    const active = await seed.ingestEvent(userId, makeEvent(makeProposal("embed-after-b", "embed-after-demo-b"), "embed-after-b"));
    const memoryId = active.record?.memoryId as string;
    let authorization: MemoryAuthorization = { userId, memoryEnabled: true, consent: "GRANTED", consentVersion: 1, updatedAt: "2026-08-28T00:00:01.000Z" };
    let providerCalls = 0;
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorizationStore: {
        getAuthorization: async () => authorization,
        setAuthorization: async () => undefined,
      },
      embedding: {
        model: "test-embedding",
        embed: async () => {
          providerCalls += 1;
          authorization = { ...authorization, consent: "REVOKED", consentVersion: 2, updatedAt: "2026-08-28T00:00:02.000Z" };
          return [0.1, 0.2];
        },
      },
    });
    const confirmed = await service.confirm(userId, memoryId);
    expect(confirmed?.status).toBe("CONFIRMED");
    expect(providerCalls).toBe(1);
    expect(repository.embeddings).toHaveLength(0);
  });

  it("checks consent again before a semantic embedding provider call", async () => {
    const repository = new InMemoryMemoryRepository();
    const seed = makeService(repository);
    await seed.ingestEvent(userId, makeEvent(makeProposal("semantic-gate-a", "semantic-gate-demo-a"), "semantic-gate-a"));
    await seed.ingestEvent(userId, makeEvent(makeProposal("semantic-gate-b", "semantic-gate-demo-b"), "semantic-gate-b"));
    let authorization: MemoryAuthorization = { userId, memoryEnabled: true, consent: "GRANTED", consentVersion: 1, updatedAt: "2026-08-28T00:00:01.000Z" };
    let providerCalls = 0;
    const retrieveStructured = repository.retrieveStructured.bind(repository);
    repository.retrieveStructured = async (requestedUserId, query) => {
      const result = await retrieveStructured(requestedUserId, query);
      authorization = { ...authorization, consent: "REVOKED", consentVersion: 2, updatedAt: "2026-08-28T00:00:02.000Z" };
      return result;
    };
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorizationStore: {
        getAuthorization: async () => authorization,
        setAuthorization: async () => undefined,
      },
      embedding: { embed: async () => { providerCalls += 1; return [0.1, 0.2]; } },
    });
    const brief = await service.getBrief(userId, { semanticText: "trade timing" });
    expect(providerCalls).toBe(0);
    expect(brief.source).toBe("EMPTY");
    expect(repository.calls).not.toContain("retrieveSemantic");
  });

  it("does not expose a semantic result when consent is revoked during embedding", async () => {
    const repository = new InMemoryMemoryRepository();
    const seed = makeService(repository);
    await seed.ingestEvent(userId, makeEvent(makeProposal("semantic-race-a", "semantic-race-demo-a"), "semantic-race-a"));
    await seed.ingestEvent(userId, makeEvent(makeProposal("semantic-race-b", "semantic-race-demo-b"), "semantic-race-b"));
    let authorization: MemoryAuthorization = { userId, memoryEnabled: true, consent: "GRANTED", consentVersion: 1, updatedAt: "2026-08-28T00:00:01.000Z" };
    let providerCalls = 0;
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorizationStore: {
        getAuthorization: async () => authorization,
        setAuthorization: async () => undefined,
      },
      embedding: { embed: async () => {
        providerCalls += 1;
        authorization = { ...authorization, consent: "REVOKED", consentVersion: 2, updatedAt: "2026-08-28T00:00:02.000Z" };
        return [0.1, 0.2];
      } },
    });
    const brief = await service.getBrief(userId, { semanticText: "trade timing" });
    expect(providerCalls).toBe(1);
    expect(brief.source).toBe("EMPTY");
    expect(repository.calls).not.toContain("retrieveSemantic");
  });

  it("keeps corrections in the separate brief channel without presenting disputed memory as active", () => {
    const record = MemoryRecordSchema.parse({
        schemaVersion: MEMORY_RECORD_VERSION,
        memoryId: "memory-disputed",
        userId,
        kind: "LEARNING_THREAD",
        source: "USER_CORRECTION",
        scope: "CROSS_DEMO",
        logicalKey: "logical-disputed",
        status: "DISPUTED",
        active: true,
        revision: 2,
        summary: "用户纠正后的表述",
        claims: [],
        facts: [],
        inferences: [],
        advice: [],
        evidence: [],
        sourceRefs: [],
        demoContentHashes: ["demo-disputed"],
        corrections: [{
          correctionId: "correction-disputed",
          memoryId: "memory-disputed",
          content: "这次不是因为补枪距离",
          source: "USER",
          createdAt: "2026-08-28T00:00:02.000Z",
          revision: 2,
          refs: [{ namespace: "USER_CLAIM", refId: "correction-disputed", demoContentHash: "demo-disputed", sessionId: "session-disputed", cueId: "cue-disputed" }],
        }],
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:02.000Z",
        limitations: [],
        producerVersion: "test",
        lastIdempotencyKey: "disputed-idem",
    }) as unknown as MemoryRecord;
    const brief = buildUserMemoryBrief({ records: [record] });
    expect(brief.memories).toHaveLength(0);
    expect(brief.corrections).toHaveLength(1);
    expect(brief.corrections[0]?.content).toContain("不是因为补枪");
    const agentBrief = buildAgentMemoryBrief(brief);
    expect(agentBrief.memories).toEqual([]);
    expect(agentBrief.corrections).toHaveLength(1);
    expect((agentBrief.corrections as Array<{ content: string }>)[0]?.content).toContain("不是因为补枪");
  });

  it("loads corrections from a disputed aggregate through the separate recall channel", async () => {
    const record = MemoryRecordSchema.parse({
      schemaVersion: MEMORY_RECORD_VERSION,
      memoryId: "memory-disputed-service",
      userId,
      kind: "LEARNING_THREAD",
      source: "USER_CORRECTION",
      scope: "CROSS_DEMO",
      logicalKey: "logical-disputed-service",
      status: "DISPUTED",
      active: true,
      revision: 2,
      summary: "用户纠正后的表述",
      claims: [], facts: [], inferences: [], advice: [], evidence: [], sourceRefs: [],
      demoContentHashes: ["demo-disputed-service"],
      corrections: [{
        correctionId: "correction-disputed-service",
        memoryId: "memory-disputed-service",
        content: "用户明确纠正的教学判断",
        source: "USER",
        createdAt: "2026-08-28T00:00:02.000Z",
        revision: 2,
        refs: [{ namespace: "USER_CLAIM", refId: "correction-disputed-service", demoContentHash: "demo-disputed-service", sessionId: "session-disputed-service", cueId: "cue-disputed-service" }],
      }],
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:02.000Z",
      limitations: [], producerVersion: "test", lastIdempotencyKey: "disputed-service-idem",
    }) as unknown as MemoryRecord;
    const repository = new InMemoryMemoryRepository();
    const retrieveStructured = repository.retrieveStructured.bind(repository);
    repository.retrieveStructured = async (requestedUserId, query) => {
      if (query?.status === "DISPUTED") return [record];
      return retrieveStructured(requestedUserId, query);
    };
    const brief = await makeService(repository).getBrief(userId);
    expect(brief.memories).toHaveLength(0);
    expect(brief.corrections).toHaveLength(1);
    expect(brief.corrections[0]?.content).toContain("明确纠正");
  });

  it("does not put terminal projections into the active brief even when marked active", () => {
    const base = MemoryRecordSchema.parse({
      schemaVersion: MEMORY_RECORD_VERSION,
      memoryId: "memory-terminal",
      userId,
      kind: "LEARNING_THREAD",
      source: "AGENT_INFERRED",
      scope: "CROSS_DEMO",
      logicalKey: "logical-terminal",
      status: "RESOLVED",
      active: true,
      revision: 1,
      summary: "已解决",
      claims: [], facts: [], inferences: [], advice: [], evidence: [], sourceRefs: [],
      demoContentHashes: ["demo-terminal"], corrections: [],
      createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z",
      limitations: [], producerVersion: "test", lastIdempotencyKey: "terminal-idem",
    }) as unknown as MemoryRecord;
    expect(buildUserMemoryBrief({ records: [base] }).memories).toHaveLength(0);
  });

  it("keeps explicit preferences in the brief when learning memories fill the recall page", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    for (const suffix of ["brief-a", "brief-b", "brief-c"]) {
      await service.ingestEvent(userId, makeEvent(makeProposal(suffix, `demo-${suffix}`), `event-${suffix}`));
    }
    await service.setPreference(userId, { key: "explanationDepth", value: "DEEP" });
    const brief = await service.getBrief(userId);
    expect(brief.preferences?.explanationDepth).toBe("DEEP");
  });

  it("keeps user claims separate from Demo facts and rejects invalid confidence", async () => {
    const proposal = makeProposal("1");
    const repository = new InMemoryMemoryRepository();
    const result = await makeService(repository).ingestEvent(userId, makeEvent(proposal));
    expect(result.record?.claims).toHaveLength(1);
    expect(result.record?.facts).toHaveLength(0);
    const invalid = structuredClone(proposal) as typeof proposal;
    (invalid.thread!.diagnosis as { confidence: number }).confidence = 2;
    expect(MemoryProposalSchema.safeParse(invalid).success).toBe(false);
    expect(MemorySourceRefSchema.safeParse({ namespace: "SESSION", refId: "bare" }).success).toBe(false);
  });

  it("retains bounded Demo facts, observation claims and professional evidence as typed provenance", async () => {
    const proposal = buildMemoryProposal({
      userId,
      sessionId: "provenance-session",
      demoContentHash: "provenance-demo",
      cueCase: makeCueCase("provenance"),
      learningThread: makeThread("provenance"),
      outcomeGateStatus: "COMPLETE",
      provenanceRefs: [
        { namespace: "DEMO_FACT", refId: "decision-fact-1", label: "decision fact" },
        { namespace: "OBSERVATION_CLAIM", refId: "observation-1", label: "observation claim" },
        { namespace: "PRO_EVIDENCE", refId: "pro-evidence-1", label: "professional evidence" },
      ],
    });
    const repository = new InMemoryMemoryRepository();
    const result = await makeService(repository).ingestEvent(userId, makeEvent(proposal, "provenance-event"));
    expect(result.record?.facts.map((fact) => fact.ref.refId)).toEqual(["decision-fact-1", "observation-1"]);
    expect(result.record?.evidence.map((ref) => ref.refId)).toEqual(["pro-evidence-1"]);
    expect(result.record?.claims[0]?.source).toBe("USER");
  });

  it("does not touch repository when feature flag or consent is off", async () => {
    const disabledRepository = new InMemoryMemoryRepository();
    const disabled = new MemoryService({
      repository: disabledRepository,
      memoryEnabled: false,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED" },
    });
    const event = makeEvent(makeProposal("1"));
    const off = await disabled.ingestEvent(userId, event);
    expect(off.errorCode).toBe("MEMORY_DISABLED");
    expect(disabledRepository.calls).toEqual([]);

    const consentRepository = new InMemoryMemoryRepository();
    const noConsent = new MemoryService({
      repository: consentRepository,
      memoryEnabled: true,
      authorization: { userId, memoryEnabled: true, consent: "REVOKED" },
    });
    await noConsent.ingestEvent(userId, event);
    expect(consentRepository.calls).toEqual([]);
  });

  it("does not persist authorization when the feature flag is off", async () => {
    let writes = 0;
    const service = new MemoryService({
      repository: new InMemoryMemoryRepository(),
      memoryEnabled: false,
      authorizationStore: {
        getAuthorization: async () => undefined,
        setAuthorization: async () => { writes += 1; },
      },
    });
    await expect(service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED" })).resolves.toBeUndefined();
    expect(writes).toBe(0);
  });

  it("fails closed when durable authorization persistence is unavailable", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorizationStore: {
        getAuthorization: async () => undefined,
        setAuthorization: async () => { throw new Error("database unavailable"); },
      },
    });
    await expect(service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED" })).resolves.toBeUndefined();
    const result = await service.ingestEvent(userId, makeEvent(makeProposal("auth-fail")));
    expect(result.errorCode).toBe("MEMORY_DISABLED");
    expect(repository.calls).toEqual([]);
  });

  it("fans out a wildcard invalidation when consent is revoked", async () => {
    const repository = new InMemoryMemoryRepository();
    const notices: Array<{ memoryId: string; sessionIds: readonly string[] }> = [];
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      onMemoryDeleted: async (notice) => {
        notices.push({ memoryId: notice.memoryId, sessionIds: notice.sessionIds });
      },
    });
    await service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED", consentVersion: 1 });
    await service.ingestEvent(userId, makeEvent(makeProposal("revoke-fanout"), "revoke-fanout-event"));
    await service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "REVOKED", consentVersion: 2 });
    expect(notices).toEqual([{ memoryId: "*", sessionIds: ["session-revoke-fanout"] }]);
  });

  it("emits bounded decision and brief diagnostics without memory content", async () => {
    const repository = new InMemoryMemoryRepository();
    const diagnostics: Array<{ type: string; reason?: string; memoryId?: string }> = [];
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED" },
      onDiagnostic: (diagnostic) => diagnostics.push({ type: diagnostic.type, reason: diagnostic.reason, memoryId: diagnostic.memoryId }),
    });
    await service.ingestEvent(userId, makeEvent(makeProposal("diagnostic"), "diagnostic-event"));
    await service.getBrief(userId);
    expect(diagnostics.map((diagnostic) => diagnostic.type)).toContain("MEMORY_WRITE_DECISION");
    expect(diagnostics.map((diagnostic) => diagnostic.type)).toContain("MEMORY_BRIEF_LOADED");
    expect(JSON.stringify(diagnostics)).not.toContain("我想等队友补枪再处理");
  });

  it("provides a no-op cache without retaining values", async () => {
    const cache = new NoopCacheProvider();
    await cache.set("key", { value: 1 });
    expect(await cache.get("key")).toBeUndefined();
    await cache.delete("key");
  });

  it("parses strict event envelopes and aliases eventType", () => {
    const proposal = makeProposal("1");
    const event = makeEvent(proposal);
    const parsed = MemoryEventSchema.parse({ ...event, type: undefined, eventType: "CUE_DIAGNOSED" });
    expect(parsed.eventType).toBe("CUE_DIAGNOSED");
    expect(MemoryEventSchema.safeParse({ ...event, unexpected: true }).success).toBe(false);
    expect(MemoryEventSchema.safeParse({
      ...event,
      payload: { ...proposal, userId: "other-user" },
    }).success).toBe(false);
    expect(MemoryEventSchema.safeParse({
      ...event,
      payload: { ...proposal, rawDemo: "forbidden" },
    }).success).toBe(false);
    expect(MemoryEventSchema.safeParse({
      ...event,
      operation: "UPDATE",
    }).success).toBe(false);
    expect(MemoryEventSchema.safeParse({
      ...event,
      sessionId: "other-session",
    }).success).toBe(false);
  });

  it("filters stale terminal memories and session threads at the Agent projection boundary", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = makeService(repository);
    await service.ingestEvent(userId, makeEvent(makeProposal("projection-a", "projection-demo-a"), "projection-a"));
    const activeResult = await service.ingestEvent(userId, makeEvent(makeProposal("projection-b", "projection-demo-b"), "projection-b"));
    const activeRecord = activeResult.record;
    expect(activeRecord?.thread).toBeDefined();
    if (!activeRecord?.thread) return;
    const staleBrief = {
      schemaVersion: "memory-brief.v1" as const,
      generatedAt: "2026-08-28T00:00:00.000Z",
      preferences: { explanationDepth: "DEEP", email: "user@example.com" },
      activeThreads: [{ ...activeRecord.thread, scope: "SESSION" as const }],
      memories: [{ ...activeRecord, status: "DISPUTED" as const, active: true }],
      corrections: activeRecord.corrections,
      limitations: [],
      source: "STRUCTURED" as const,
      structuredStatus: "AVAILABLE" as const,
      semanticStatus: "OPTIONAL" as const,
    };
    const projected = buildAgentMemoryBrief(staleBrief);
    expect(projected.memories).toEqual([]);
    expect(projected.activeThreads).toEqual([]);
    expect(projected.preferences).toEqual({ explanationDepth: "DEEP" });
  });
});
