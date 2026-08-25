import { describe, expect, it } from "vitest";
import { DeterministicPolicyAdapter } from "./adapters";
import { createCoachAgentRuntime } from "./runtime";
import { fixtureIdentity, resumeEvent, slowReplayCapability, startCueEvent } from "./test-fixtures";
import {
  CoachAgentEventSchema,
  StartManualCueVisitEventSchema,
  TeachingCapabilitySchema,
  type CoachAgentEvent,
} from "./types";

function takeover(eventId: string): CoachAgentEvent {
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: "USER_TAKEOVER",
    eventId,
    identity: fixtureIdentity,
    reason: "MANUAL_CUE_NAVIGATION",
  });
}

function capability(cueId: string) {
  return TeachingCapabilitySchema.parse({
    ...slowReplayCapability,
    capabilityId: `cap-${cueId}-slow-replay`,
    boundArgs: { ...slowReplayCapability.boundArgs, cueId },
  });
}

function manualVisit(options: {
  cueId: string;
  segmentId: string;
  targetSegmentIndex: number;
  visitId?: string;
  eventId?: string;
  capabilities?: ReturnType<typeof capability>[];
  outcomeGateStatus?: "LOCKED" | "COMPLETE";
  narrationReadiness?: "PENDING" | "READY";
}): Extract<CoachAgentEvent, { type: "START_MANUAL_CUE_VISIT" }> {
  const base = startCueEvent({
    cueId: options.cueId,
    segmentId: options.segmentId,
    capabilities: options.capabilities ?? [],
    outcomeGateStatus: options.outcomeGateStatus ?? "COMPLETE",
    narrationReadiness: options.narrationReadiness ?? "READY",
  });
  const { type: _type, routeSegmentIndex: _routeSegmentIndex, resumeFromTakeover: _resume, ...payload } = base;
  return StartManualCueVisitEventSchema.parse({
    ...payload,
    version: "coach-agent-event.v2",
    type: "START_MANUAL_CUE_VISIT",
    eventId: options.eventId ?? `manual-start-${options.cueId}`,
    visitId: options.visitId ?? `visit-${options.cueId}`,
    targetSegmentIndex: options.targetSegmentIndex,
  });
}

async function runtimeAtTakeover() {
  const policy = new DeterministicPolicyAdapter();
  const runtime = createCoachAgentRuntime({ policy });
  await runtime.dispatch(startCueEvent({
    eventId: "default-cue-1",
    cueId: "cue-1",
    segmentId: "segment-1",
    routeSegmentIndex: 0,
    capabilities: [],
  }));
  const takenOver = await runtime.dispatch(takeover("takeover-after-cue-1"));
  return { runtime, policy, takenOver };
}

describe("ManualCueVisit and DefaultRouteCursor", () => {
  it("allows a first identity-only takeover to establish the manual visit state", async () => {
    const runtime = createCoachAgentRuntime({ policy: new DeterministicPolicyAdapter() });
    const takenOver = await runtime.dispatch(takeover("identity-only-takeover"));
    expect(takenOver.status).toBe("USER_TAKEOVER");
    expect(takenOver.state.runStatus).toBe("USER_TAKEOVER");

    const manual = await runtime.dispatch(manualVisit({
      cueId: "cue-4",
      segmentId: "segment-4",
      targetSegmentIndex: 3,
      capabilities: [],
    }));
    expect(manual.status).toBe("USER_TAKEOVER");
    expect(manual.state.completedCueIds).toContain("cue-4");
  });

  it("runs a manual cue with a tool, presents it once, and preserves the default cursor", async () => {
    const { runtime, policy, takenOver } = await runtimeAtTakeover();
    const event = manualVisit({
      cueId: "cue-4",
      segmentId: "segment-4",
      targetSegmentIndex: 3,
      capabilities: [capability("cue-4")],
    });

    const waiting = await runtime.dispatch(event);
    expect(waiting.status).toBe("WAITING_TOOL");
    expect(waiting.state.routeCursor).toBe(takenOver.state.routeCursor);
    expect(waiting.state.activeCueSource).toBe("MANUAL");
    expect(waiting.state.activeManualVisitId).toBe("visit-cue-4");

    const completed = await runtime.dispatch(resumeEvent(waiting.effects[0]!, { eventId: "manual-cue-4-result" }));
    expect(completed.status).toBe("USER_TAKEOVER");
    expect(completed.state.sessionStatus).toBe("TAKEN_OVER");
    expect(completed.state.routeCursor).toBe(0);
    expect(completed.state.completedCueIds.filter((cueId) => cueId === "cue-4")).toHaveLength(1);
    expect(completed.state.completedCueSummaries.filter((summary) => summary.cueId === "cue-4")).toHaveLength(1);
    expect(completed.state.sessionThemes.flatMap((theme) => theme.cueRefs).filter((cueId) => cueId === "cue-4")).toHaveLength(1);
    expect(completed.state.presentedCueBindings).toContainEqual({ cueId: "cue-4", segmentId: "segment-4", segmentIndex: 3 });
    expect(policy.calls).toHaveLength(0);

    const duplicate = await runtime.dispatch({ ...event, eventId: "manual-cue-4-again", visitId: "visit-cue-4-again" });
    expect(duplicate.status).toBe("USER_TAKEOVER");
    expect(duplicate.effects).toEqual([]);
    expect(duplicate.state.completedCueSummaries.filter((summary) => summary.cueId === "cue-4")).toHaveLength(1);
  });

  it("rejects a pending manual cue before Runtime or Policy", () => {
    const base = startCueEvent({
      cueId: "cue-4",
      segmentId: "segment-4",
      capabilities: [capability("cue-4")],
      outcomeGateStatus: "LOCKED",
      narrationReadiness: "PENDING",
    });
    const { type: _type, routeSegmentIndex: _routeSegmentIndex, resumeFromTakeover: _resume, ...payload } = base;
    expect(StartManualCueVisitEventSchema.safeParse({
      ...payload,
      version: "coach-agent-event.v2",
      type: "START_MANUAL_CUE_VISIT",
      visitId: "visit-cue-4-pending",
      targetSegmentIndex: 3,
    }).success).toBe(false);
  });

  it("advances only the next default segment when its cue was already presented", async () => {
    const { runtime, policy } = await runtimeAtTakeover();
    const manual = await runtime.dispatch(manualVisit({
      cueId: "cue-2",
      segmentId: "segment-2",
      targetSegmentIndex: 1,
      capabilities: [],
    }));
    expect(manual.state.routeCursor).toBe(0);

    const observed = await runtime.dispatch(CoachAgentEventSchema.parse({
      version: "coach-agent-event.v2",
      type: "OBSERVE_PRESENTED_CUE",
      eventId: "observe-presented-cue-2",
      identity: fixtureIdentity,
      segmentId: "segment-2",
      segmentIndex: 1,
      cueId: "cue-2",
      currentSessionPhase: "PLAYING",
    }));
    expect(observed.state.routeCursor).toBe(1);
    expect(observed.effects).toEqual([]);
    expect(policy.calls).toHaveLength(0);

    for (const invalid of [
      { eventId: "unknown", cueId: "cue-3", segmentId: "segment-3", segmentIndex: 2 },
      { eventId: "not-next", cueId: "cue-2", segmentId: "segment-2", segmentIndex: 3 },
      { eventId: "wrong-binding", cueId: "cue-2", segmentId: "segment-x", segmentIndex: 2 },
    ]) {
      const rejected = await runtime.dispatch(CoachAgentEventSchema.parse({
        version: "coach-agent-event.v2",
        type: "OBSERVE_PRESENTED_CUE",
        identity: fixtureIdentity,
        currentSessionPhase: "PLAYING",
        ...invalid,
      }));
      expect(rejected.state.routeCursor).toBe(1);
      expect(rejected.effects).toEqual([]);
    }
  });

  it("keeps an old manual result inert after the next manual visit starts", async () => {
    const { runtime } = await runtimeAtTakeover();
    const cue4 = await runtime.dispatch(manualVisit({
      cueId: "cue-4",
      segmentId: "segment-4",
      targetSegmentIndex: 3,
      capabilities: [capability("cue-4")],
    }));
    const cue4Request = cue4.effects[0]!;
    await runtime.dispatch(resumeEvent(cue4Request, { eventId: "complete-manual-cue-4" }));

    const cue3 = await runtime.dispatch(manualVisit({
      cueId: "cue-3",
      segmentId: "segment-3",
      targetSegmentIndex: 2,
      capabilities: [capability("cue-3")],
    }));
    const cue3CallId = cue3.state.pendingToolCall?.callId;
    const stale = await runtime.dispatch(resumeEvent(cue4Request, { eventId: "stale-manual-cue-4-result" }));

    expect(stale.status).toBe("WAITING_TOOL");
    expect(stale.state.activeCueId).toBe("cue-3");
    expect(stale.state.pendingToolCall?.callId).toBe(cue3CallId);
    expect(stale.effects).toEqual([]);
    expect(stale.state.toolHistory.filter((item) => item.cueId === "cue-4")).toHaveLength(1);
    expect(stale.state.routeCursor).toBe(0);
  });
});
