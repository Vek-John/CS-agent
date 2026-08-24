import { MemorySaver } from "@langchain/langgraph";
import { IDBFactory as FakeIndexedDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  CoachAgentResultSchema,
  StartCueEventSchema,
  assertJsonSerializable,
  TeachingCapabilitySchema,
  type CoachAgentEvent,
} from "./types";
import { DeterministicPolicyAdapter, FakePlaybackTool, FakePolicyAdapter, type PolicyAdapter } from "./adapters";
import { createCoachAgentRuntime } from "./runtime";
import { stableInputHash } from "./identity";
import { buildSessionWrapUpRequest, deterministicSessionWrapUpResult } from "./session-wrap-up";
import { fixtureIdentity, mapFocusCapability, resumeEvent, slowReplayCapability, startCueEvent } from "./test-fixtures";

function stage3Event(value: unknown): CoachAgentEvent {
  return value as CoachAgentEvent;
}

function capabilityForCue(cueId: string) {
  return TeachingCapabilitySchema.parse({
    ...slowReplayCapability,
    capabilityId: `cap-${cueId}-slow-replay`,
    boundArgs: { ...slowReplayCapability.boundArgs, cueId },
  });
}

function observeSegmentEvent(
  eventId: string,
  segmentId: string,
  segmentIndex: number,
  mode: "SKIP" | "FREEZE" | "BRIEF" | "OBSERVE" = "BRIEF",
): CoachAgentEvent {
  return stage3Event({
    version: "coach-agent-event.v2",
    type: "OBSERVE_SEGMENT",
    eventId,
    identity: fixtureIdentity,
    segmentId,
    segmentIndex,
    mode,
    currentSessionPhase: "PLAYING",
  });
}

function takeoverEvent(eventId = "event-takeover"): CoachAgentEvent {
  return stage3Event({
    version: "coach-agent-event.v2",
    type: "USER_TAKEOVER",
    eventId,
    identity: fixtureIdentity,
    cueId: "cue-17",
    reason: "USER_PAUSED_MANUAL_CONTROL",
  });
}

function cancelRunEvent(eventId = "event-cancel"): CoachAgentEvent {
  return stage3Event({
    version: "coach-agent-event.v2",
    type: "CANCEL_RUN",
    eventId,
    identity: fixtureIdentity,
    reason: "USER_CANCELLED",
  });
}

function completeSessionEvent(eventId = "event-session-complete"): CoachAgentEvent {
  return stage3Event({
    version: "coach-agent-event.v2",
    type: "COMPLETE_SESSION",
    eventId,
    identity: fixtureIdentity,
  });
}

function completedThemeCue(options: {
  eventId: string;
  cueId: string;
  focus: string;
  roundId: string;
  adviceRef: string;
}): Extract<CoachAgentEvent, { type: "START_CUE" }> {
  const base = startCueEvent({ eventId: options.eventId, cueId: options.cueId, capabilities: [] });
  if (!base.presentableSummary) throw new Error("theme fixture requires a presentable summary");
  return StartCueEventSchema.parse({
    ...base,
    focus: options.focus,
    allowedEvidenceSummary: [
      ...base.allowedEvidenceSummary,
      { namespace: "ADVICE", refs: [options.adviceRef] },
    ],
    presentableSummary: {
      ...base.presentableSummary,
      cueId: options.cueId,
      roundId: options.roundId,
      focus: options.focus,
      evidenceRefs: [...base.presentableSummary.evidenceRefs, options.adviceRef],
      adviceRefs: [options.adviceRef],
    },
  });
}

function longSameFocusCue(index: number): Extract<CoachAgentEvent, { type: "START_CUE" }> {
  const cueId = `cue-long-${index}`;
  const roundId = `round-long-${index}`;
  const evidenceRefs = Array.from({ length: 16 }, (_, refIndex) => `evidence-${index}-${refIndex}`);
  const adviceRef = `advice-long-${index}`;
  const base = startCueEvent({
    eventId: `event-long-start-${index}`,
    cueId,
    segmentId: `segment-long-${index}`,
    capabilities: [capabilityForCue(cueId)],
  });
  if (!base.presentableSummary) throw new Error("long cue fixture requires a presentable summary");
  return StartCueEventSchema.parse({
    ...base,
    focus: "SURVIVE_CONTACT",
    allowedEvidenceSummary: [
      { namespace: "DECISION", refs: ["decision-long"] },
      { namespace: "ACTION", refs: ["action-a1"] },
      { namespace: "ADVICE", refs: [adviceRef] },
      { namespace: "EVIDENCE", refs: evidenceRefs },
    ],
    presentableSummary: {
      ...base.presentableSummary,
      cueId,
      roundId,
      focus: "SURVIVE_CONTACT",
      evidenceRefs,
      adviceRefs: [adviceRef],
    },
  });
}

describe("CoachAgentRuntime one-cue graph", () => {
  it("finishes directly when no capability is available and remains JSON serializable", async () => {
    const runtime = createCoachAgentRuntime();
    const result = await runtime.dispatch(startCueEvent({ capabilities: [] }));

    expect(result.status).toBe("COMPLETED");
    expect(result.effects).toEqual([]);
    expect(result.state.policyBudget.policyCalls).toBe(0);
    expect(result.state.completedCueIds).toEqual(["cue-17"]);
    expect(result.state.traceSummary.entryCount).toBeGreaterThan(0);
    expect(CoachAgentResultSchema.parse(assertJsonSerializable(result))).toEqual(result);
  });

  it("uses a rule capability without policy, interrupts before playback, and resumes idempotently", async () => {
    const runtime = createCoachAgentRuntime();
    const playback = new FakePlaybackTool();
    const started = await runtime.dispatch(startCueEvent());

    expect(Object.keys(runtime)).toEqual(["dispatch"]);
    expect(started.status).toBe("WAITING_TOOL");
    expect(started.state.policyBudget.policyCalls).toBe(0);
    expect(started.effects).toHaveLength(1);
    expect(playback.requests).toHaveLength(0);

    const request = started.effects[0];
    (started.state.availableCapabilities[0]!.boundArgs as { cueId: string }).cueId = "mutated-outside-checkpoint";
    const restoredSnapshot = await runtime.dispatch(startCueEvent());
    expect(restoredSnapshot.state.availableCapabilities[0]?.boundArgs.cueId).toBe("cue-17");
    const resume = {
      ...resumeEvent(request, { eventId: "event-resume-1" }),
      result: playback.resultFor(request),
    };
    const result = await runtime.dispatch(resume);
    expect(result.status).toBe("COMPLETED");
    expect(result.effects).toEqual([]);
    expect(result.state.completedCueIds).toContain("cue-17");
    expect(result.state.toolHistory[0]?.status).toBe("SUCCEEDED");

    const duplicate = await runtime.dispatch(resume);
    expect(duplicate.state.toolHistory).toHaveLength(1);
    expect(duplicate.state.completedCueIds).toEqual(result.state.completedCueIds);
  });

  it("passes a compact policy packet for multiple capabilities and binds the selected tool locally", async () => {
    const policy = new FakePolicyAdapter({
      response: {
        action: "SELECT_CAPABILITY",
        capabilityId: mapFocusCapability.capabilityId,
        evidenceRefs: [],
        rationaleCode: "POSITION_NEEDS_MAP_FOCUS",
        confidence: 0.91,
      },
    });
    const runtime = createCoachAgentRuntime({ policy });
    const result = await runtime.dispatch(
      startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] }),
    );

    expect(policy.calls).toHaveLength(1);
    expect(policy.calls[0]).toMatchObject({
      cueId: "cue-17",
      focus: "primary-positioning",
      phase: "PAUSED_FOR_COACHING",
      outcomeGateStatus: "COMPLETE",
      maxMoves: 1,
    });
    expect(policy.calls[0]).not.toHaveProperty("selectedPlayerId");
    expect(policy.calls[0]?.capabilities[1]).not.toHaveProperty("boundArgs");
    expect(result.state.selectedTeachingMove?.capabilityId).toBe(mapFocusCapability.capabilityId);
    expect(result.state.selectedTeachingMove?.source).toBe("MODEL");
    expect(result.effects[0]?.tool).toBe("FOCUS_MAP_EVIDENCE");
  });

  it("uses deterministic Policy by default for multiple capabilities without a fake invalid-output fallback", async () => {
    const runtime = createCoachAgentRuntime();
    const result = await runtime.dispatch(
      startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] }),
    );

    expect(result.status).toBe("WAITING_TOOL");
    expect(result.state.selectedTeachingMove?.capabilityId).toBe(mapFocusCapability.capabilityId);
    expect(result.state.selectedTeachingMove?.source).toBe("MODEL");
    expect(result.state.fallbackReasons).not.toContain("POLICY_INVALID_OUTPUT");
    expect(result.state.policyBudget).toMatchObject({ policyCalls: 1, alternativeAttempts: 0 });
  });

  it("records deterministic Policy provider, elapsed latency, and the actual compact node input hash", async () => {
    const policy = new DeterministicPolicyAdapter();
    const runtime = createCoachAgentRuntime({ policy });
    const result = await runtime.dispatch(
      startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] }),
    );
    const policyTrace = [...result.state.trace].reverse().find((entry) => entry.node === "POLICY");

    expect(policyTrace).toMatchObject({
      provider: "DETERMINISTIC",
      model: null,
      tokenCount: null,
    });
    expect(policyTrace?.latencyMs).toEqual(expect.any(Number));
    expect(policyTrace?.inputHash).toBe(stableInputHash(policy.calls[0]));
  });

  it("uses one deterministic alternative for model failure or invalid output", async () => {
    const policy = new FakePolicyAdapter({ response: { action: "SELECT_CAPABILITY", capabilityId: "cap-not-available" } });
    const runtime = createCoachAgentRuntime({ policy });
    const result = await runtime.dispatch(
      startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] }),
    );

    expect(result.status).toBe("WAITING_TOOL");
    expect(result.state.selectedTeachingMove?.source).toBe("FALLBACK");
    expect(result.state.fallbackReasons).toContain("POLICY_INVALID_OUTPUT");
    expect(result.state.policyBudget).toMatchObject({ policyCalls: 1, alternativeAttempts: 0 });

    const failingPolicy = new FakePolicyAdapter({ failure: new Error("provider unavailable") });
    const failingRuntime = createCoachAgentRuntime({ policy: failingPolicy });
    const providerFailed = await failingRuntime.dispatch(
      startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] }),
    );
    expect(providerFailed.state.fallbackReasons).toContain("POLICY_FAILED");
    expect(providerFailed.state.selectedTeachingMove?.source).toBe("FALLBACK");
  });

  it("does not create a tool request before outcome and narration are presentable", async () => {
    const policy = new FakePolicyAdapter({ capabilityId: slowReplayCapability.capabilityId });
    const runtime = createCoachAgentRuntime({ policy });
    const result = await runtime.dispatch(
      startCueEvent({
        outcomeGateStatus: "LOCKED",
        narrationReadiness: "PENDING",
        capabilities: [slowReplayCapability, mapFocusCapability],
      }),
    );

    expect(result.status).toBe("COMPLETED");
    expect(result.effects).toEqual([]);
    expect(result.state.selectedTeachingMove).toBeNull();
    expect(policy.calls).toHaveLength(0);
  });

  it("accepts deterministic narration fallback as presentable and routes the cue", async () => {
    const runtime = createCoachAgentRuntime();
    const result = await runtime.dispatch(
      startCueEvent({ narrationReadiness: "FALLBACK" }),
    );
    expect(result.status).toBe("WAITING_TOOL");
    expect(result.effects).toHaveLength(1);
  });

  it("uses FINISH_CUE without a tool and still completes the cue", async () => {
    const policy = new FakePolicyAdapter({
      response: {
        action: "FINISH_CUE",
        evidenceRefs: [],
        rationaleCode: "NO_EXTRA_VISUAL_VALUE",
        confidence: 0.9,
      },
    });
    const runtime = createCoachAgentRuntime({ policy });
    const result = await runtime.dispatch(
      startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] }),
    );
    expect(result.status).toBe("COMPLETED");
    expect(result.effects).toEqual([]);
    expect(result.state.completedCueIds).toEqual(["cue-17"]);
  });

  it("chooses one deterministic tool-2 after the first tool failure without calling Policy again", async () => {
    const policy = new FakePolicyAdapter({ capabilityId: mapFocusCapability.capabilityId });
    const runtime = createCoachAgentRuntime({ policy });
    const started = await runtime.dispatch(
      startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] }),
    );
    const firstRequest = started.effects[0];
    const failed = await runtime.dispatch(
      resumeEvent(firstRequest, { eventId: "event-tool-1-failed", status: "FAILED" }),
    );

    expect(failed.status).toBe("WAITING_TOOL");
    expect(failed.effects).toHaveLength(1);
    expect(failed.effects[0]?.callId).not.toBe(firstRequest.callId);
    expect(failed.effects[0]?.capabilityId).toBe(slowReplayCapability.capabilityId);
    expect(failed.state.policyBudget).toMatchObject({ policyCalls: 1, alternativeAttempts: 1 });
    expect(policy.calls).toHaveLength(1);

    const completed = await runtime.dispatch(
      resumeEvent(failed.effects[0], { eventId: "event-tool-2-succeeded" }),
    );
    expect(completed.status).toBe("COMPLETED");
    expect(completed.state.toolHistory.map((item) => item.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(completed.state.completedCueIds).toEqual(["cue-17"]);
  });

  it("ends after tool-2 failure and never loops or creates a third request", async () => {
    const runtime = createCoachAgentRuntime({ policy: new FakePolicyAdapter({ capabilityId: mapFocusCapability.capabilityId }) });
    const started = await runtime.dispatch(startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] }));
    const retry = await runtime.dispatch(
      resumeEvent(started.effects[0], { eventId: "event-tool-1-failed-again", status: "REJECTED" }),
    );
    const completed = await runtime.dispatch(
      resumeEvent(retry.effects[0], { eventId: "event-tool-2-failed", status: "FAILED" }),
    );
    expect(completed.status).toBe("COMPLETED");
    expect(completed.effects).toEqual([]);
    expect(completed.state.toolHistory.map((item) => item.status)).toEqual(["REJECTED", "FAILED"]);
    expect(completed.state.completedCueIds).toEqual(["cue-17"]);
  });

  it("ends after tool cancellation without an alternative attempt", async () => {
    const runtime = createCoachAgentRuntime({ policy: new FakePolicyAdapter({ capabilityId: mapFocusCapability.capabilityId }) });
    const started = await runtime.dispatch(startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] }));
    const completed = await runtime.dispatch(
      resumeEvent(started.effects[0], { eventId: "event-tool-cancelled", status: "CANCELLED" }),
    );
    expect(completed.status).toBe("COMPLETED");
    expect(completed.effects).toEqual([]);
    expect(completed.state.toolHistory.map((item) => item.status)).toEqual(["CANCELLED"]);
    expect(completed.state.policyBudget.alternativeAttempts).toBe(0);
    expect(completed.state.completedCueIds).toEqual(["cue-17"]);
  });

  it("serializes concurrent dispatches so the browser context has one graph owner", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const policy: PolicyAdapter = {
      selectCapability: async (input) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return {
          action: "SELECT_CAPABILITY",
          capabilityId: input.capabilities[0]!.capabilityId,
          evidenceRefs: [],
          rationaleCode: "TIMING_NEEDS_SLOW_REPLAY",
          confidence: 0.5,
        };
      },
    };
    const runtime = createCoachAgentRuntime({ policy });
    const secondIdentity = { ...fixtureIdentity, runId: "run-demo-2", sessionId: "session-2" };
    const [first, second] = await Promise.all([
      runtime.dispatch(startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] })),
      runtime.dispatch(startCueEvent({ identity: secondIdentity, eventId: "event-start-2", capabilities: [slowReplayCapability, mapFocusCapability] })),
    ]);
    expect(first.status).toBe("WAITING_TOOL");
    expect(second.status).toBe("WAITING_TOOL");
    expect(maxInFlight).toBe(1);
  });

  it("rejects a resume from a different route while a same-session run is waiting", async () => {
    const checkpointer = new MemorySaver();
    const runtime = createCoachAgentRuntime({ checkpointer });
    const first = await runtime.dispatch(startCueEvent());
    const changedIdentity = { ...fixtureIdentity, routeHash: "sha256-route-2", routeId: "route-2" };
    const second = await runtime.dispatch(startCueEvent({ identity: changedIdentity, eventId: "event-start-2" }));
    expect(second.status).toBe("WAITING_TOOL");
    expect(second.state.routeHash).toBe(changedIdentity.routeHash);

    const stale = await runtime.dispatch(
      resumeEvent(first.effects[0], { identity: fixtureIdentity, eventId: "event-resume-stale" }),
    );
    expect(stale.status).toBe("DORMANT");
    expect(stale.restored).toBe("DORMANT_IDENTITY_MISMATCH");
    expect(stale.state.fallbackReasons).toContain("ROUTE_HASH_MISMATCH");
  });

  it("does not manufacture a run when resuming without a checkpoint", async () => {
    const runtime = createCoachAgentRuntime();
    const request = {
      callId: "playback-missing",
      runId: fixtureIdentity.runId,
      cueId: "cue-17",
      capabilityId: slowReplayCapability.capabilityId,
      tool: slowReplayCapability.tool,
      evidenceRefs: slowReplayCapability.evidenceRefs,
    };
    const result = await runtime.dispatch(resumeEvent(request, { eventId: "resume-missing" }));
    expect(result.status).toBe("DORMANT");
    expect(result.restored).toBe("DORMANT_MISSING");
    expect(result.state.fallbackReasons).toContain("STALE_RESUME");
    expect(result.state.lastToolResult).toBeNull();
  });

  it("rebuilds a second runtime over IndexedDB and resumes the same interrupted cue", async () => {
    const indexedDB = new FakeIndexedDBFactory() as unknown as IDBFactory;
    const runtimeA = createCoachAgentRuntime({
      checkpoint: "indexeddb",
      indexedDB,
      databaseName: "coach-agent-runtime-cross-instance-1",
    });
    const started = await runtimeA.dispatch(startCueEvent());
    expect(started.status).toBe("WAITING_TOOL");

    const runtimeB = createCoachAgentRuntime({
      checkpoint: "indexeddb",
      indexedDB,
      databaseName: "coach-agent-runtime-cross-instance-1",
    });
    const resumed = await runtimeB.dispatch(
      resumeEvent(started.effects[0], { eventId: "event-resume-cross-instance" }),
    );

    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.state.activeCueId).toBe("cue-17");
    expect(resumed.state.currentSessionPhase).toBe("PAUSED_FOR_COACHING");
    expect(resumed.effects).toEqual([]);
    expect(resumed.state.toolHistory).toHaveLength(1);
    expect(resumed.state.completedCueIds).toEqual(["cue-17"]);
  });

  it("continues a same-route run with a new cue after the previous cue completes", async () => {
    const runtime = createCoachAgentRuntime();
    const first = await runtime.dispatch(startCueEvent());
    const firstCompleted = await runtime.dispatch(resumeEvent(first.effects[0], { eventId: "event-cue-17-done" }));
    const second = await runtime.dispatch(startCueEvent({
      eventId: "event-cue-18-start",
      cueId: "cue-18",
      segmentId: "segment-2",
      capabilities: [capabilityForCue("cue-18")],
    }));

    expect(firstCompleted.state.completedCueIds).toEqual(["cue-17"]);
    expect(second.status).toBe("WAITING_TOOL");
    expect(second.state.activeCueId).toBe("cue-18");
    expect(second.state.completedCueIds).toEqual(["cue-17"]);
    expect(second.state.policyBudget).toMatchObject({ policyCalls: 0, alternativeAttempts: 0 });
    expect(second.effects[0]?.cueId).toBe("cue-18");
  });

  it("does not create a new move when a completed cue is delivered again", async () => {
    const runtime = createCoachAgentRuntime();
    const first = await runtime.dispatch(startCueEvent());
    await runtime.dispatch(resumeEvent(first.effects[0], { eventId: "event-cue-17-repeat-base" }));
    const duplicate = await runtime.dispatch(startCueEvent({ eventId: "event-cue-17-repeat" }));

    expect(duplicate.status).toBe("COMPLETED");
    expect(duplicate.effects).toEqual([]);
    expect(duplicate.state.completedCueIds).toEqual(["cue-17"]);
  });

  it("observes ordinary route segments without calling Policy and rejects out-of-order observations", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("Policy must not be called for route observation") });
    const runtime = createCoachAgentRuntime({ policy });
    const first = await runtime.dispatch(observeSegmentEvent("event-segment-0", "segment-0", 0, "FREEZE"));
    const second = await runtime.dispatch(observeSegmentEvent("event-segment-1", "segment-1", 1, "BRIEF"));
    const skipped = await runtime.dispatch(observeSegmentEvent("event-segment-3", "segment-3", 3, "SKIP"));

    expect(first.effects).toEqual([]);
    expect(second.effects).toEqual([]);
    expect((second.state as any).routeCursor).toBe(1);
    expect((second.state as any).currentSegmentMode).toBe("BRIEF");
    expect(skipped.effects).toEqual([]);
    expect((skipped.state as any).routeCursor).toBe(1);
    expect(skipped.state.fallbackReasons).toContain("ROUTE_ORDER_MISMATCH");
    expect(policy.calls).toHaveLength(0);
  });

  it("pauses on USER_TAKEOVER, blocks old results, and resumes only from a new host cue", async () => {
    const runtime = createCoachAgentRuntime();
    const started = await runtime.dispatch(startCueEvent());
    const takeover = await runtime.dispatch(takeoverEvent());
    const staleResult = await runtime.dispatch(resumeEvent(started.effects[0], { eventId: "event-stale-after-takeover" }));
    const staleReady = await runtime.dispatch(startCueEvent({ eventId: "event-ready-after-takeover" }));
    const sameEventIdResume = await runtime.dispatch(stage3Event({
      ...startCueEvent(),
      version: "coach-agent-event.v2",
      resumeFromTakeover: true,
    }));
    const resumed = await runtime.dispatch(stage3Event({
      ...startCueEvent({
        eventId: "event-host-resume-after-takeover",
      }),
      version: "coach-agent-event.v2",
      resumeFromTakeover: true,
    }));

    expect(takeover.status).toBe("USER_TAKEOVER");
    expect(takeover.effects).toEqual([]);
    expect(staleResult.status).toBe("USER_TAKEOVER");
    expect(staleResult.effects).toEqual([]);
    expect(staleReady.status).toBe("USER_TAKEOVER");
    expect(sameEventIdResume.status).toBe("USER_TAKEOVER");
    expect(resumed.status).toBe("WAITING_TOOL");
    expect(resumed.state.activeCueId).toBe("cue-17");
  });

  it("restores a completed cue after takeover without creating a move or invoking Policy", async () => {
    const policy = new FakePolicyAdapter({ capabilityId: mapFocusCapability.capabilityId });
    const checkpointer = new MemorySaver();
    const runtime = createCoachAgentRuntime({ policy, checkpointer });
    const started = await runtime.dispatch(startCueEvent());
    const completed = await runtime.dispatch(
      resumeEvent(started.effects[0], { eventId: "event-completed-before-takeover" }),
    );
    const takeover = await runtime.dispatch(takeoverEvent("event-completed-takeover"));
    const resumed = await runtime.dispatch(stage3Event({
      ...startCueEvent({
        eventId: "event-completed-cue-resume",
        capabilities: [slowReplayCapability, mapFocusCapability],
      }),
      version: "coach-agent-event.v2",
      resumeFromTakeover: true,
    }));

    expect(completed.state.runStatus).toBe("CUE_COMPLETED");
    expect(takeover.status).toBe("USER_TAKEOVER");
    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.state.sessionStatus).toBe("ACTIVE");
    expect(resumed.state.runStatus).toBe("CUE_COMPLETED");
    expect(resumed.state.activeCueId).toBe("cue-17");
    expect(resumed.state.currentSessionPhase).toBe("PAUSED_FOR_COACHING");
    expect(resumed.effects).toEqual([]);
    expect(resumed.state.selectedTeachingMove).toBeNull();
    expect(resumed.state.pendingToolCall).toBeNull();
    expect(policy.calls).toHaveLength(0);

    const observed = await runtime.dispatch(
      observeSegmentEvent("event-completed-cue-observed", "segment-after-takeover", 0),
    );
    expect(observed.state.sessionStatus).toBe("ACTIVE");
    expect(observed.state.runStatus).toBe("CUE_COMPLETED");
    expect(observed.state.routeCursor).toBe(0);

    const rebuilt = createCoachAgentRuntime({ checkpointer, policy });
    const afterRebuild = await rebuilt.dispatch(
      observeSegmentEvent("event-completed-cue-observed-after-rebuild", "segment-after-rebuild", 1),
    );
    expect(afterRebuild.state.sessionStatus).toBe("ACTIVE");
    expect(afterRebuild.state.runStatus).toBe("CUE_COMPLETED");
    expect(afterRebuild.state.routeCursor).toBe(1);
    const sessionCompleted = await rebuilt.dispatch(completeSessionEvent("event-completed-cue-session-complete"));
    expect(sessionCompleted.state.sessionStatus).toBe("COMPLETED");
  });

  it("cancels the CoachRun and ignores an expired tool result", async () => {
    const runtime = createCoachAgentRuntime();
    const started = await runtime.dispatch(startCueEvent());
    const cancelled = await runtime.dispatch(cancelRunEvent());
    const stale = await runtime.dispatch(resumeEvent(started.effects[0], { eventId: "event-expired-after-cancel" }));

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.effects).toEqual([]);
    expect(stale.status).toBe("CANCELLED");
    expect(stale.effects).toEqual([]);
  });

  it("aggregates presentable completed cues and emits at most three wrap-up themes", async () => {
    const runtime = createCoachAgentRuntime();
    const first = await runtime.dispatch(startCueEvent());
    await runtime.dispatch(resumeEvent(first.effects[0], { eventId: "event-theme-cue-17-done" }));
    const second = await runtime.dispatch(startCueEvent({
      eventId: "event-theme-cue-18-start",
      cueId: "cue-18",
      segmentId: "segment-2",
      capabilities: [capabilityForCue("cue-18")],
    }));
    const secondCompleted = await runtime.dispatch(resumeEvent(second.effects[0], { eventId: "event-theme-cue-18-done" }));
    const sessionCompleted = await runtime.dispatch(completeSessionEvent());

    expect((secondCompleted.state as any).completedCueSummaries).toHaveLength(2);
    expect(secondCompleted.state.sessionThemes[0]).toMatchObject({ occurrence: 2, repeated: true });
    expect(sessionCompleted.status).toBe("COMPLETED");
    expect((sessionCompleted.state as any).sessionStatus).toBe("COMPLETED");
    expect((sessionCompleted.state as any).summaryThemes.length).toBeLessThanOrEqual(3);
    expect((sessionCompleted.state as any).summaryThemes[0].cueRefs).toEqual(["cue-17", "cue-18"]);
    expect((sessionCompleted.state as any).sessionSummaryInput.themes[0].adviceRefs).toContain("advice-a1");
  });

  it("does not package a singleton cue as a habit in the session summary", async () => {
    const runtime = createCoachAgentRuntime();
    const started = await runtime.dispatch(startCueEvent());
    await runtime.dispatch(resumeEvent(started.effects[0], { eventId: "event-singleton-done" }));
    const completed = await runtime.dispatch(completeSessionEvent("event-singleton-session-complete"));

    expect((completed.state as any).summaryThemes).toEqual([]);
    expect((completed.state as any).sessionSummaryInput.themes).toEqual([]);
    expect((completed.state as any).sessionSummaryFallback).toBe("无反复主题。");
  });

  it("selects one advised representative per repeated theme instead of a global first-three slice", async () => {
    const runtime = createCoachAgentRuntime();
    const cues = [
      completedThemeCue({ eventId: "event-theme-a-1", cueId: "cue-theme-a-1", focus: "THEME_A", roundId: "round-a-1", adviceRef: "advice-a-1" }),
      completedThemeCue({ eventId: "event-theme-a-2", cueId: "cue-theme-a-2", focus: "THEME_A", roundId: "round-a-2", adviceRef: "advice-a-2" }),
      completedThemeCue({ eventId: "event-theme-a-3", cueId: "cue-theme-a-3", focus: "THEME_A", roundId: "round-a-3", adviceRef: "advice-a-3" }),
      completedThemeCue({ eventId: "event-theme-b-1", cueId: "cue-theme-b-1", focus: "THEME_B", roundId: "round-b-1", adviceRef: "advice-b-1" }),
      completedThemeCue({ eventId: "event-theme-b-2", cueId: "cue-theme-b-2", focus: "THEME_B", roundId: "round-b-2", adviceRef: "advice-b-2" }),
      completedThemeCue({ eventId: "event-theme-c-1", cueId: "cue-theme-c-1", focus: "THEME_C", roundId: "round-c-1", adviceRef: "advice-c-1" }),
      completedThemeCue({ eventId: "event-theme-c-2", cueId: "cue-theme-c-2", focus: "THEME_C", roundId: "round-c-2", adviceRef: "advice-c-2" }),
    ];
    for (const cue of cues) await runtime.dispatch(cue);

    const completed = await runtime.dispatch(completeSessionEvent("event-three-theme-session-complete"));
    const summaryInput = completed.state.sessionSummaryInput;

    expect(completed.state.summaryThemes).toHaveLength(3);
    expect(summaryInput?.completedCues).toHaveLength(3);
    expect(summaryInput?.completedCues.map((cue) => cue.focus)).toEqual(["THEME_A", "THEME_B", "THEME_C"]);
    expect(summaryInput?.themes.every((theme) => theme.adviceRefs.length > 0)).toBe(true);
    expect(summaryInput?.themes.map((theme) => theme.adviceRefs[0])).toEqual([
      "advice-a-1",
      "advice-b-1",
      "advice-c-1",
    ]);
  });

  it("completes twenty same-focus cues with bounded theme refs and a successful session close", async () => {
    const runtime = createCoachAgentRuntime();
    let last: Awaited<ReturnType<typeof runtime.dispatch>> | undefined;
    for (let index = 1; index <= 20; index += 1) {
      const started = await runtime.dispatch(longSameFocusCue(index));
      expect(started.status).toBe("WAITING_TOOL");
      last = await runtime.dispatch(
        resumeEvent(started.effects[0]!, { eventId: `event-long-resume-${index}` }),
      );
      expect(last.status).toBe("COMPLETED");
      expect(last.state.runStatus).toBe("CUE_COMPLETED");
      expect(last.effects).toEqual([]);
    }

    expect(last?.state.completedCueIds).toHaveLength(20);
    expect(last?.state.sessionThemes[0]).toMatchObject({
      focus: "SURVIVE_CONTACT",
      occurrence: 20,
      repeated: true,
    });
    expect(last?.state.sessionThemes[0]?.cueRefs).toHaveLength(16);
    expect(last?.state.sessionThemes[0]?.roundRefs).toHaveLength(16);
    expect(last?.state.sessionThemes[0]?.evidenceRefs).toHaveLength(16);

    const completed = await runtime.dispatch(completeSessionEvent("event-long-session-complete"));
    expect(completed.status).toBe("COMPLETED");
    expect(completed.state.sessionStatus).toBe("COMPLETED");
    expect(completed.state.sessionSummaryInput?.themes).toHaveLength(1);
    expect(completed.state.sessionSummaryInput?.completedCues).toHaveLength(1);

    const summary = completed.state.sessionSummaryInput;
    if (!summary) throw new Error("twenty-cue fixture should produce SessionSummaryInput");
    const representative = summary.completedCues[0];
    if (!representative) throw new Error("twenty-cue fixture should select a representative cue");
    const representativeAdvice = representative.adviceRefs[0];
    const representativeEvidence = representative.evidenceRefs[0];
    if (!representativeAdvice || !representativeEvidence) throw new Error("representative cue should retain advice/evidence refs");
    const wrapRequest = buildSessionWrapUpRequest({
      summary,
      presentableCues: {
        [representative.cueId]: {
          cueId: representative.cueId,
          focus: representative.focus,
          coreIssue: { text: "已验证的接触问题。", refs: [representativeEvidence], limitations: [] },
          betterPlay: { text: "已有的接触改法。", refs: [representativeAdvice], limitations: [] },
          advice: [{ id: representativeAdvice, text: "保留已有退路并等待补枪。", refs: [representativeEvidence] }],
        },
      },
    });
    const wrapResult = deterministicSessionWrapUpResult(wrapRequest, "TEST");
    expect(wrapResult.bundle.themes[0]?.summary.refs).toEqual([representative.cueId]);
    expect(wrapResult.bundle.themes[0]?.trainingAdvice.refs).toEqual([representativeAdvice]);
  });
});
