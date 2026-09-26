import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchResponse,
  CoachAgentEventSchema,
  CoachAgentIdentitySchema,
  diagnoseTeachingCue,
  reviseTeachingDiagnosis,
  type CoachAgentEvent,
  type CoachAgentResult,
} from "@cs-coach/coach-agent";
import { MemoryService, stableMemoryLogicalKey } from "@cs-coach/memory";
import {
  SqliteDatabaseOwner,
  SqliteMemoryRepository,
} from "@cs-coach/memory-sqlite/server";
import { DesktopReviewLibrary } from "@cs-coach/review-library/server";
import {
  buildLocalAgentMemoryEvents,
  desktopBehaviorOpportunityClaim,
} from "./agent-events";

import { POST } from "../../app/api/coaching/agent/route";
import { startCueEvent } from "../../../../libs/coach-agent/src/test-fixtures";
import { setMemoryRuntimeForTests, resetMemoryRuntimeForTests } from "./server";
import { issueTestMemoryPrincipalCookie } from "./principal";

// This test owns the read/teaching path. Do not start unrelated deferred writes
// from the later reflection while the temporary SQLite owner is being closed.
vi.mock("next/server", () => ({ after: vi.fn() }));

const cleanup: string[] = [];
afterEach(async () => {
  resetMemoryRuntimeForTests();
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const DEMO_BYTES = Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(64, 7)]);
const DEMO_HASH = createHash("sha256").update(DEMO_BYTES).digest("hex");
const identity = CoachAgentIdentitySchema.parse({
  runId: "run-memory-history",
  sessionId: "session-memory-history",
  demoId: "analysis-demo-history",
  demoContentHash: DEMO_HASH,
  selectedPlayerId: "player-history",
  routeId: "route-history",
  routeHash: "route-history-v1",
});

function reflectionEvent(sessionSuffix: string): Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }> {
  const cueId = "cue-memory-history";
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: "SUBMIT_REFLECTION",
    eventId: `reflection-${sessionSuffix}`,
    identity: {
      ...identity,
      runId: `run-${sessionSuffix}`,
      sessionId: `session-${sessionSuffix}`,
    },
    cueId,
    outcomeGateStatus: "COMPLETE",
    input: {
      cueId,
      candidateId: "candidate-stable-history-source",
      cue: { id: cueId, primary_focus_code: "POSITIONING", limitations: [] },
      decisionFacts: [],
      playerActionFacts: [],
      outcomeFacts: [],
      focusCode: "POSITIONING",
      limitations: [],
    },
    reflection: {
      cueId,
      rawText: "我想拿信息",
      selectedGoal: "GET_INFO",
      response: "ANSWERED",
      source: "USER",
      limitations: [],
    },
  }) as Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }>;
}

function resultFor(event: Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }>): CoachAgentResult {
  const diagnosis = diagnoseTeachingCue({
    ...(event.input as Parameters<typeof diagnoseTeachingCue>[0]),
    reflection: event.reflection,
  });
  return {
    identity: event.identity,
    state: {
      cueCases: { [event.cueId]: diagnosis.cueCase },
      learningThreads: [diagnosis.learningThread],
    },
  } as unknown as CoachAgentResult;
}

function playbackEvent(index: number): CoachAgentEvent {
  return {
    version: "coach-agent-event.v2",
    type: "PLAYBACK_CONFIRMED",
    eventId: `history-rewatch-${index}`,
    identity,
    playback: { canonicalTick: 100 + index, playing: false, speed: 1 },
  } as unknown as CoachAgentEvent;
}

describe("Review history Memory idempotency", () => {
  it("keeps one SQLite opportunity across five opens, five replays, and five resumed emissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-agent-history-memory-"));
    cleanup.push(root);
    const owner = new SqliteDatabaseOwner({ path: join(root, "cs-agent.sqlite3") });
    const library = new DesktopReviewLibrary({ owner, dataRoot: root });
    await library.initialize();
    const repository = new SqliteMemoryRepository({ owner });
    const service = new MemoryService({
      repository,
      authorizationStore: repository,
      memoryEnabled: true,
    });
    const userId = "principal-history-idempotency";
    await service.setAuthorization(userId, {
      userId,
      memoryEnabled: true,
      consent: "GRANTED",
    });

    const capability = library.issueImportCapability({
      objectId: "history-memory-demo",
      originalFilename: "history.dem",
      expectedByteLength: DEMO_BYTES.byteLength,
    });
    const imported = await library.importDemo({
      authorization: capability.authorization,
      objectId: "history-memory-demo",
      stream: (async function* () { yield DEMO_BYTES; })(),
    });
    expect(imported.demo.contentHash).toBe(DEMO_HASH);
    const readyDemo = await library.finalizeDemoImport({
      authorization: imported.validationCapability!.authorization,
      demoId: imported.demo.demoId,
      valid: true,
      parserVersion: "integration-parser.v1",
    });
    expect(readyDemo.status).toBe("READY");
    const review = await library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: identity.selectedPlayerId,
      selectedPlayerName: "Player",
      title: "History idempotency",
    });

    const firstEvent = reflectionEvent("first");
    const firstMemoryEvent = buildLocalAgentMemoryEvents(firstEvent, resultFor(firstEvent), userId)[0]!;
    const firstClaim = desktopBehaviorOpportunityClaim(
      firstMemoryEvent,
      identity.selectedPlayerId,
      identity.routeHash,
    )!;
    const stableClaim = {
      ...firstClaim,
      sourceReviewId: review.reviewId,
    };
    expect(await library.claimMemoryOpportunity(stableClaim)).toMatchObject({ claimed: true });
    await service.ingestEvent(userId, firstMemoryEvent);

    const counts = () => owner.db.prepare(
      "SELECT (SELECT COUNT(*) FROM memory_opportunity_claims) claims,(SELECT COUNT(*) FROM memory_opportunity_evidence) evidence,(SELECT COUNT(*) FROM memory_events) events,(SELECT COUNT(*) FROM memory_records) records",
    ).get();
    expect(counts()).toEqual({ claims: 1, evidence: 1, events: 1, records: 1 });

    for (let index = 0; index < 5; index += 1) {
      expect((await library.loadReview(review.reviewId)).review.reviewId).toBe(review.reviewId);
      expect(buildLocalAgentMemoryEvents(
        playbackEvent(index),
        { identity, state: {} } as unknown as CoachAgentResult,
        userId,
      )).toEqual([]);
    }
    expect(counts()).toEqual({ claims: 1, evidence: 1, events: 1, records: 1 });

    for (let index = 0; index < 5; index += 1) {
      const resumedEvent = reflectionEvent(`resume-${index}`);
      const memoryEvent = buildLocalAgentMemoryEvents(resumedEvent, resultFor(resumedEvent), userId)[0]!;
      const claim = desktopBehaviorOpportunityClaim(
        memoryEvent,
        identity.selectedPlayerId,
        identity.routeHash,
      )!;
      const claimed = await library.claimMemoryOpportunity({
        ...claim,
        evidenceKey: stableClaim.evidenceKey,
        sourceReviewId: review.reviewId,
      });
      expect(claimed.claimed).toBe(false);
    }
    expect(counts()).toEqual({ claims: 1, evidence: 1, events: 1, records: 1 });
    const record = JSON.parse((owner.db.prepare("SELECT record_json FROM memory_records").get() as { record_json: string }).record_json) as {
      occurrenceCount: number;
      demoContentHashes: string[];
    };
    expect(record.occurrenceCount).toBe(1);
    expect(record.demoContentHashes).toEqual([DEMO_HASH]);
    await owner.close();
  });
});


it.each([false, true])("corrects the original SQLite judgment after a changed hinge without touching a new-key record (%s)", async seedNewKey => {
  const root = await mkdtemp(join(tmpdir(), "cs-agent-revised-memory-"));
  cleanup.push(root);
  const owner = new SqliteDatabaseOwner({ path: join(root, "cs-agent.sqlite3") });
  try {
    const library = new DesktopReviewLibrary({ owner, dataRoot: root });
    await library.initialize();
    const repository = new SqliteMemoryRepository({ owner });
    const service = new MemoryService({ repository, authorizationStore: repository, memoryEnabled: true });
    const userId = "principal-revised-memory";
    await service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED" });
    const base = reflectionEvent("changed-hinge");
    const event = CoachAgentEventSchema.parse({ ...base,
      input: { ...base.input, decisionFacts: [{ id: "fact-no-visible-enemy", text: "决策时没有看到敌人。", availability: "DECISION", available_at_tick: 64, source: "DEMO", observed_by_player: true }] },
      reflection: { ...base.reflection, selectedGoal: undefined, rawText: "我看到敌人在前面，想拿信息。" },
    }) as Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }>;
    const diagnosisInput = { ...event.input, reflection: event.reflection } as Parameters<typeof diagnoseTeachingCue>[0];
    const original = diagnoseTeachingCue(diagnosisInput);
    expect(original.cueCase.verdict?.type).toBe("INCONCLUSIVE");
    expect(original.cueCase.hinge?.kind).toBe("INFORMATION");
    const correctionText = "我当时以为队友语音叫我先拉出去执行固定战术。" + "这是对当时记忆的补充说明。".repeat(20) + "但我后来想清楚了：其实没有语音，也不是固定战术。";
    expect(correctionText.length).toBeGreaterThan(220);
    expect(correctionText.length).toBeLessThanOrEqual(500);
    const disagreement = CoachAgentEventSchema.parse({ ...event, type: "SUBMIT_DISAGREEMENT", eventId: "changed-hinge-disagreement",
      reflection: { ...event.reflection, reflectionId: "stable-hinge-correction", rawText: correctionText },
    }) as Extract<CoachAgentEvent, { type: "SUBMIT_DISAGREEMENT" }>;
    const revised = reviseTeachingDiagnosis({ previous: original, input: diagnosisInput, disagreement: disagreement.reflection });
    expect(revised.cueCase.verdict).toMatchObject({ type: "INCONCLUSIVE", revision: 1 });
    expect(revised.learningThread.hingeCode).not.toBe(original.learningThread.hingeCode);
    expect(stableMemoryLogicalKey(revised.learningThread)).not.toBe(stableMemoryLogicalKey(original.learningThread));
    const result = (output: typeof original) => ({ identity: event.identity, state: {
      cueCases: { [event.cueId]: output.cueCase }, learningThreads: [output.learningThread],
    } }) as unknown as CoachAgentResult;
    const originalEvent = buildLocalAgentMemoryEvents(event, result(original), userId)[0]!;
    const originalClaim = desktopBehaviorOpportunityClaim(originalEvent, identity.selectedPlayerId, identity.routeHash)!;
    expect(await library.claimMemoryOpportunity(originalClaim)).toMatchObject({ claimed: true });
    const initial = await service.ingestEvent(userId, originalEvent);
    expect(initial.accepted).toBe(true); expect(initial.record).toBeDefined();
    const originalRecord = initial.record!;
    let independentRecord: typeof originalRecord | undefined;
    if (seedNewKey) {
      // Synthetic independent aggregate: seed the revised semantic key through a
      // normal observation event, solely to prove the correction cannot target it.
      const independentOutput = { ...revised, learningThread: { ...revised.learningThread, threadId: "independent-new-key-thread" } };
      const independentEvent = buildLocalAgentMemoryEvents(event, result(independentOutput), userId)[0]!;
      const independent = await service.ingestEvent(userId, independentEvent);
      expect(independent.accepted, JSON.stringify({ error: independent.errorCode, reason: independent.decision.reason })).toBe(true); independentRecord = independent.record!;
      expect(independentRecord.memoryId).not.toBe(originalRecord.memoryId);
      expect(independentRecord.logicalKey).toBe(stableMemoryLogicalKey(revised.learningThread));
    }
    const opportunityCounts = () => owner.db.prepare("SELECT (SELECT COUNT(*) FROM memory_opportunity_claims) claims,(SELECT COUNT(*) FROM memory_opportunity_evidence) evidence").get();
    const beforeOpportunities = opportunityCounts();
    const correction = buildLocalAgentMemoryEvents(disagreement, result(revised), userId)[0]!;
    expect(correction).toBeDefined();
    expect(desktopBehaviorOpportunityClaim(correction, identity.selectedPlayerId, identity.routeHash)).toBeUndefined();
    const corrected = await service.ingestEvent(userId, correction);
    // Source target, not revised hinge/key, chooses the original aggregate.
    expect(corrected.accepted).toBe(true);
    expect(corrected.record).toMatchObject({ memoryId: originalRecord.memoryId, logicalKey: originalRecord.logicalKey,
      revision: originalRecord.revision + 1, status: "DISPUTED", content: disagreement.reflection.rawText,
      occurrenceCount: originalRecord.occurrenceCount,
      successfulApplicationCount: originalRecord.successfulApplicationCount,
      conflictingApplicationCount: originalRecord.conflictingApplicationCount });
    const repeated = await service.ingestEvent(userId, correction);
    expect(repeated.record).toEqual(corrected.record);
    expect(repeated.record?.corrections).toHaveLength(1);
    expect(opportunityCounts()).toEqual(beforeOpportunities);
    expect(opportunityCounts()).toEqual({ claims: 1, evidence: 1 });
    expect(await repository.getRecordVersion(userId, originalRecord.memoryId, originalRecord.revision)).toEqual(originalRecord);
    if (independentRecord) expect(await repository.getRecordVersion(userId, independentRecord.memoryId)).toEqual(independentRecord);
    if (!seedNewKey) {
      vi.stubEnv("NODE_ENV", "test");
      const memoryRuntime = setMemoryRuntimeForTests({ repository, authorizationStore: repository,
        memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
      const brief = await memoryRuntime.service.getBrief(userId);
      expect(brief.corrections).toContainEqual(expect.objectContaining({
        content: disagreement.reflection.rawText, memoryId: originalRecord.memoryId,
      }));
      expect(brief.memories.some(record => record.memoryId === originalRecord.memoryId)).toBe(false);
      const cookie = (await issueTestMemoryPrincipalCookie(userId, { consent: "GRANTED", consentVersion: 1 })).split(";")[0];
      const nextIdentity = { ...event.identity, sessionId: "session-correction-recall", runId: "run-correction-recall" };
      const dispatch = async (event: CoachAgentEvent) => {
        const response = await POST(new Request("http://localhost/api/coaching/agent", {
          method: "POST", headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(createRemoteCoachAgentDispatchEnvelope(event)),
        }));
        expect(response.status).toBe(200);
        return parseRemoteCoachAgentDispatchResponse(await response.json());
      };
      const started = await dispatch(startCueEvent({ identity: nextIdentity, cueId: "cue-recalled",
        eventId: "recalled-start", capabilities: [], routeSegmentIndex: 0 }));
      expect(started.state.memoryBrief?.corrections).toEqual([{
        content: disagreement.reflection.rawText, source: "USER", revision: corrected.record!.revision,
      }]);
      expect(JSON.stringify(started.state.memoryBrief)).not.toContain(originalRecord.memoryId);
      expect(JSON.stringify(started.state.memoryBrief)).not.toContain(userId);
      const nextReflection = (cueId: string) => CoachAgentEventSchema.parse({ ...event,
        identity: nextIdentity, eventId: `reflect-${cueId}`, cueId,
        reflection: { ...event.reflection, cueId, rawText: "", selectedGoal: "OTHER" },
        input: { ...event.input, cueId, cue: { ...event.input.cue, id: cueId }, decisionFacts: [],
          decisionResources: { health: 100, armor: 100, hasHelmet: true, utilityCount: 1, evidenceRefs: [] },
        },
      });
      const reflection = nextReflection("cue-recalled");
      if (reflection.type !== "SUBMIT_REFLECTION") throw new Error("reflection fixture required");
      const baseline = diagnoseTeachingCue({ ...(reflection.input as Parameters<typeof diagnoseTeachingCue>[0]), reflection: reflection.reflection });
      const taught = await dispatch(reflection);
      expect(taught.state.cueCases["cue-recalled"].pedagogyMode).toBe("REINFORCE");
      expect(taught.state.cueCases["cue-recalled"].verdict).toEqual(baseline.cueCase.verdict);
      expect(taught.state.cueCases["cue-recalled"].claims).toEqual(baseline.cueCase.claims);
      await memoryRuntime.service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "REVOKED", consentVersion: 2 });
      const revokedStart = await dispatch(startCueEvent({ identity: nextIdentity, cueId: "cue-after-revoke",
        eventId: "revoked-start", segmentId: "segment-after-revoke", capabilities: [], routeSegmentIndex: 1 }));
      expect(revokedStart.state.activeCueId).toBe("cue-after-revoke");
      expect(revokedStart.state.routeCursor).toBe(1);
      expect(revokedStart.state.memoryBrief).toBeUndefined();
      const afterRevoke = await dispatch(nextReflection("cue-after-revoke"));
      expect(afterRevoke.state.cueCases["cue-after-revoke"].pedagogyMode).not.toBe("REINFORCE");
      expect((await memoryRuntime.service.getBrief(userId)).corrections).toEqual([]);
    }
  } finally { await owner.close(); }
});
