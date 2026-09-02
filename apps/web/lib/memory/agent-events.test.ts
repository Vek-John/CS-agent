import { describe, expect, it } from "vitest";
import {
  CoachAgentEventSchema,
  CoachAgentIdentitySchema,
  diagnoseTeachingCue,
  type CoachAgentEvent,
  type CoachAgentResult,
} from "@cs-coach/coach-agent";
import {
  buildLocalAgentMemoryEvents,
  desktopBehaviorOpportunityClaim,
  stableBehaviorEvidenceKey,
} from "./agent-events";

const identity = CoachAgentIdentitySchema.parse({
  runId: "run-local-memory",
  sessionId: "session-local-memory",
  demoId: "demo-local-memory",
  demoContentHash: "demo-local-hash",
  selectedPlayerId: "player-local",
  routeId: "route-local",
  routeHash: "route-local-hash",
});

function reflectionEvent(options: {
  cueId?: string;
  candidateId?: string;
  identityOverride?: typeof identity;
} = {}): Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }> {
  const cueId = options.cueId ?? "cue-local-memory";
  const candidateId = options.candidateId ?? "candidate-r1-death-source-a";
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: "SUBMIT_REFLECTION",
    eventId: "local-memory-reflection",
    identity: options.identityOverride ?? identity,
    cueId,
    outcomeGateStatus: "COMPLETE",
    input: {
      cueId,
      candidateId,
      cue: { id: cueId, primary_focus_code: "POSITIONING", limitations: [] },
      // This adapter test is intentionally not a parser/replay fixture. A
      // synthetic timestamp must never be presented as a canonical Demo tick;
      // provenance behavior is covered with stable IDs only.
      decisionFacts: [],
      playerActionFacts: [],
      outcomeFacts: [],
      focusCode: "POSITIONING",
      limitations: [],
    },
    reflection: { cueId, rawText: "我想拿信息", selectedGoal: "GET_INFO", response: "ANSWERED", source: "USER", limitations: [] },
  }) as Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }>;
}

function resultFor(
  event: Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }>,
): CoachAgentResult {
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

describe("local Agent memory event adapter", () => {
  it("uses a review-stable behavior evidence identity rather than a Host session id", () => {
    const first = stableBehaviorEvidenceKey({
      userId: "principal-local-memory",
      demoContentHash: identity.demoContentHash,
      selectedPlayerId: identity.selectedPlayerId,
      stableCueSourceId: "behavior-opportunity-source-a",
      taxonomyCode: "POSITIONING",
      analysisEvidenceRevision: identity.routeHash,
      effect: "DIAGNOSIS",
    });
    const sameReviewAfterSessionReplacement = stableBehaviorEvidenceKey({
      userId: "principal-local-memory",
      demoContentHash: identity.demoContentHash,
      selectedPlayerId: identity.selectedPlayerId,
      stableCueSourceId: "behavior-opportunity-source-a",
      taxonomyCode: "POSITIONING",
      analysisEvidenceRevision: identity.routeHash,
      effect: "DIAGNOSIS",
    });
    const explicitNewEvidenceRevision = stableBehaviorEvidenceKey({
      userId: "principal-local-memory",
      demoContentHash: identity.demoContentHash,
      selectedPlayerId: identity.selectedPlayerId,
      stableCueSourceId: "behavior-opportunity-source-a",
      taxonomyCode: "POSITIONING",
      analysisEvidenceRevision: "route-current-analyzer-v2",
      effect: "DIAGNOSIS",
    });
    expect(sameReviewAfterSessionReplacement).toBe(first);
    expect(explicitNewEvidenceRevision).not.toBe(first);
  });

  it("emits bounded events with typed fact/evidence provenance after a completed cue", () => {
    const event = reflectionEvent();
    const diagnosis = diagnoseTeachingCue({
      ...(event.input as Parameters<typeof diagnoseTeachingCue>[0]),
      reflection: event.reflection,
    });
    const result = {
      identity,
      state: { cueCases: { [event.cueId]: diagnosis.cueCase }, learningThreads: [diagnosis.learningThread] },
    } as unknown as CoachAgentResult;
    const events = buildLocalAgentMemoryEvents(event, result, "principal-local-memory");
    expect(events[0]?.type).toBe("CUE_DIAGNOSED");
    const proposal = events[0]?.payload as { origin?: { typedSourceRefs?: readonly { namespace: string; refId: string }[] } };
    expect(proposal.origin?.typedSourceRefs ?? []).not.toContainEqual(expect.objectContaining({ namespace: "DEMO_FACT" }));
    expect(proposal.origin?.typedSourceRefs ?? []).toContainEqual(expect.objectContaining({
      namespace: "SESSION",
      refId: expect.stringMatching(/^behavior-opportunity-source-/),
    }));
    expect(JSON.stringify(events)).not.toContain("available_at_tick");

    const retried = buildLocalAgentMemoryEvents({ ...event, eventId: "local-memory-reflection-retry" }, result, "principal-local-memory");
    expect(retried[0]?.idempotencyKey).toBe(events[0]?.idempotencyKey);
    expect(retried[0]?.proposalId).toBe(events[0]?.proposalId);

    const replacementSession = {
      ...identity,
      runId: "run-local-memory-reopened",
      sessionId: "session-local-memory-reopened",
    };
    const reopenedEvent = { ...event, identity: replacementSession };
    const reopenedResult = { ...result, identity: replacementSession } as unknown as CoachAgentResult;
    const reopened = buildLocalAgentMemoryEvents(reopenedEvent, reopenedResult, "principal-local-memory");
    expect(reopened[0]?.idempotencyKey).toBe(events[0]?.idempotencyKey);
    expect(reopened[0]?.proposalId).toBe(events[0]?.proposalId);
  });

  it("keeps a resumed Graph emission idempotent", () => {
    const event = reflectionEvent({ cueId: "c1", candidateId: "candidate-r7-death-source-a" });
    const first = buildLocalAgentMemoryEvents(event, resultFor(event), "principal-local-memory");
    const resumed = buildLocalAgentMemoryEvents(
      { ...event, eventId: "local-memory-reflection-after-checkpoint-resume" },
      structuredClone(resultFor(event)),
      "principal-local-memory",
    );

    expect(resumed[0]?.eventId).toBe(first[0]?.eventId);
    expect(resumed[0]?.proposalId).toBe(first[0]?.proposalId);
    expect(resumed[0]?.idempotencyKey).toBe(first[0]?.idempotencyKey);
  });

  it("does not create behavior events for playback-only history actions", () => {
    const result = { identity, state: {} } as unknown as CoachAgentResult;
    for (const event of [
      { version: "coach-agent-event.v2", type: "RECONNECT_REPLAY", eventId: "review-opened", identity, replayAvailability: "READY" },
      { version: "coach-agent-event.v2", type: "PLAYBACK_CONFIRMED", eventId: "cue-rewatched", identity, playback: { canonicalTick: 1, playing: false, speed: 1 } },
    ] as unknown as CoachAgentEvent[]) {
      expect(buildLocalAgentMemoryEvents(event, result, "principal-local-memory")).toEqual([]);
    }
  });

  it("keeps the desktop opportunity stable while versioning reanalysis evidence", () => {
    const firstEvent = reflectionEvent({ cueId: "c1", candidateId: "candidate-r7-death-source-a" });
    const revisedIdentity = {
      ...identity,
      runId: "run-local-memory-reanalysis",
      sessionId: "session-local-memory-reanalysis",
      routeHash: "route-current-analyzer-v2",
    };
    const reorderedEvent = reflectionEvent({
      cueId: "c2",
      candidateId: "candidate-r7-death-source-a",
      identityOverride: revisedIdentity,
    });
    const firstMemoryEvent = buildLocalAgentMemoryEvents(
      firstEvent,
      resultFor(firstEvent),
      "principal-local-memory",
    )[0]!;
    const reorderedMemoryEvent = buildLocalAgentMemoryEvents(
      reorderedEvent,
      resultFor(reorderedEvent),
      "principal-local-memory",
    )[0]!;
    const first = desktopBehaviorOpportunityClaim(firstMemoryEvent, identity.selectedPlayerId, identity.routeHash)!;
    const revised = desktopBehaviorOpportunityClaim(reorderedMemoryEvent, identity.selectedPlayerId, revisedIdentity.routeHash)!;

    expect(revised.stableCueSourceId).toBe(first.stableCueSourceId);
    expect(revised.taxonomyCode).toBe(first.taxonomyCode);
    expect(revised.analysisEvidenceRevision).not.toBe(first.analysisEvidenceRevision);
    expect(revised.evidenceKey).not.toBe(first.evidenceKey);
  });

  it("keeps different candidate sources distinct even when both analyses assign c1", () => {
    const firstEvent = reflectionEvent({ cueId: "c1", candidateId: "candidate-r7-death-source-a" });
    const otherEvent = reflectionEvent({ cueId: "c1", candidateId: "candidate-r8-death-source-b" });
    const firstMemoryEvent = buildLocalAgentMemoryEvents(firstEvent, resultFor(firstEvent), "principal-local-memory")[0]!;
    const otherMemoryEvent = buildLocalAgentMemoryEvents(otherEvent, resultFor(otherEvent), "principal-local-memory")[0]!;
    const first = desktopBehaviorOpportunityClaim(firstMemoryEvent, identity.selectedPlayerId, identity.routeHash)!;
    const other = desktopBehaviorOpportunityClaim(otherMemoryEvent, identity.selectedPlayerId, identity.routeHash)!;

    expect(other.stableCueSourceId).not.toBe(first.stableCueSourceId);
    expect(other.evidenceKey).not.toBe(first.evidenceKey);
  });
});
