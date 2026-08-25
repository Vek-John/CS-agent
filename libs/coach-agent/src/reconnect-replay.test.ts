import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import {
  CoachAgentEventSchema,
  COACH_AGENT_EVENT_VERSION,
  COACH_AGENT_GRAPH_VERSION,
  COACH_AGENT_STATE_VERSION,
  type CoachAgentEvent,
} from "./types";
import { FakePolicyAdapter } from "./adapters";
import { createCoachAgentRuntime } from "./runtime";
import { fixtureIdentity, resumeEvent, startCueEvent } from "./test-fixtures";

function reconnectEvent(overrides: Record<string, unknown> = {}): CoachAgentEvent {
  return {
    version: COACH_AGENT_EVENT_VERSION,
    type: "RECONNECT_REPLAY",
    eventId: "event-reconnect-1",
    identity: fixtureIdentity,
    replayAvailability: "READY",
    expectedCheckpointId: "checkpoint-placeholder",
    versions: {
      graph: COACH_AGENT_GRAPH_VERSION,
      state: COACH_AGENT_STATE_VERSION,
      session: "coaching-session.v2",
      recovery: "session-recovery-record.v2",
    },
    boundary: {
      kind: "CUE_PAUSED",
      boundaryId: "boundary-1",
      segmentId: "segment-1",
      segmentIndex: 0,
      cueId: "cue-17",
      sessionPhase: "PAUSED_FOR_COACHING",
      outcomeGateStatus: "COMPLETE",
    },
    pendingToolDisposition: {
      status: "POSTED",
      callId: "pending-placeholder",
    },
    ...overrides,
  } as CoachAgentEvent;
}

function reconnectWithCheckpoint(
  checkpointId: string,
  disposition: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): CoachAgentEvent {
  return reconnectEvent({
    expectedCheckpointId: checkpointId,
    pendingToolDisposition: disposition,
    ...overrides,
  });
}

function checkpointId(result: { checkpoint: { checkpointId: string | null } }): string {
  if (!result.checkpoint.checkpointId) throw new Error("runtime did not expose a saver checkpoint id");
  return result.checkpoint.checkpointId;
}

function observeSegment(eventId: string, segmentId: string, segmentIndex: number): CoachAgentEvent {
  return {
    version: COACH_AGENT_EVENT_VERSION,
    type: "OBSERVE_SEGMENT",
    eventId,
    identity: fixtureIdentity,
    segmentId,
    segmentIndex,
    mode: "BRIEF",
    currentSessionPhase: "PLAYING",
  };
}

function takeoverEvent(eventId: string): CoachAgentEvent {
  return {
    version: COACH_AGENT_EVENT_VERSION,
    type: "USER_TAKEOVER",
    eventId,
    identity: fixtureIdentity,
    cueId: "cue-17",
    reason: "USER_PAUSED_MANUAL_CONTROL",
  };
}

describe("Coach Agent replay reconnect", () => {
  it("exposes the actual latest checkpoint id from the saver tuple", async () => {
    const runtime = createCoachAgentRuntime({ checkpointer: new MemorySaver() });
    const started = await runtime.dispatch(startCueEvent({ routeSegmentIndex: 0 } as never));

    expect(started.checkpoint.checkpointId).toEqual(expect.any(String));
  });

  it("resumes a persisted SUCCEEDED tool exactly once without Policy or a new effect", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("Policy must not run during reconnect") });
    const runtime = createCoachAgentRuntime({ policy, checkpointer: new MemorySaver() });
    const started = await runtime.dispatch(startCueEvent({ routeSegmentIndex: 0 } as never));
    const request = started.effects[0];
    const result = resumeEvent(request, { eventId: "event-reconnect-source" }).result;
    const reconnect = reconnectWithCheckpoint(
      checkpointId(started),
      { status: "SUCCEEDED", callId: request.callId, result },
    );

    const completed = await runtime.dispatch(reconnect);
    const duplicate = await runtime.dispatch(reconnect);

    expect(completed.effects).toEqual([]);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.state.runStatus).toBe("CUE_COMPLETED");
    expect(completed.state.toolHistory).toHaveLength(1);
    expect(completed.state.toolHistory[0]?.status).toBe("SUCCEEDED");
    expect(completed.state.routeCursor).toBe(started.state.routeCursor);
    expect(completed.state.activeFocus).toBe(started.state.activeFocus);
    expect(completed.state.currentSessionPhase).toBe(started.state.currentSessionPhase);
    expect(completed.state.outcomeGateStatus).toBe(started.state.outcomeGateStatus);
    expect(checkpointId(completed)).not.toBe(checkpointId(started));
    expect(duplicate.effects).toEqual([]);
    expect(duplicate.state.toolHistory).toHaveLength(1);
    expect(checkpointId(duplicate)).toBe(checkpointId(completed));
    expect(policy.calls).toHaveLength(0);
  });

  it("converges POSTED and failed dispositions to CANCELLED without an alternative", async () => {
    for (const status of ["POSTED", "FAILED", "REJECTED"] as const) {
      const policy = new FakePolicyAdapter({ failure: new Error("Policy must not run during reconnect") });
      const runtime = createCoachAgentRuntime({ policy, checkpointer: new MemorySaver() });
      const started = await runtime.dispatch(startCueEvent({ routeSegmentIndex: 0 } as never));
      const request = started.effects[0];
      const reconnect = reconnectWithCheckpoint(checkpointId(started), {
        status,
        callId: request.callId,
      });

      const cancelled = await runtime.dispatch(reconnect);
      const duplicate = await runtime.dispatch(reconnect);

      expect(cancelled.effects).toEqual([]);
      expect(cancelled.status).toBe("COMPLETED");
      expect(cancelled.state.runStatus).toBe("CUE_COMPLETED");
      expect(cancelled.state.pendingToolCall).toBeNull();
      expect(cancelled.state.toolHistory[0]?.status).toBe("CANCELLED");
      expect(cancelled.state.completedCueIds).toEqual(["cue-17"]);
      expect(cancelled.state.completedCueSummaries).toHaveLength(1);
      expect(cancelled.state.sessionThemes[0]).toMatchObject({ occurrence: 1, repeated: false });
      expect(cancelled.state.policyBudget.alternativeAttempts).toBe(0);
      expect(duplicate.effects).toEqual([]);
      expect(duplicate.state.toolHistory).toHaveLength(1);
      expect(duplicate.state.completedCueIds).toEqual(["cue-17"]);
      expect(duplicate.state.completedCueSummaries).toHaveLength(1);
      expect(duplicate.state.sessionThemes[0]).toMatchObject({ occurrence: 1, repeated: false });
      expect(policy.calls).toHaveLength(0);
    }
  });

  it("returns DORMANT mismatches without deleting the valid old checkpoint", async () => {
    const runtime = createCoachAgentRuntime({ checkpointer: new MemorySaver() });
    const started = await runtime.dispatch(startCueEvent({ routeSegmentIndex: 0 } as never));
    const request = started.effects[0];
    const valid = {
      status: "POSTED" as const,
      callId: request.callId,
    };

    const wrongCheckpoint = await runtime.dispatch(reconnectWithCheckpoint("wrong-checkpoint", valid));
    expect(wrongCheckpoint.status).toBe("DORMANT");
    expect(wrongCheckpoint.state.fallbackReasons).toContain("RECOVERY_CHECKPOINT_MISMATCH");

    const wrongBoundary = await runtime.dispatch(reconnectWithCheckpoint(
      checkpointId(started),
      valid,
      { boundary: { ...((reconnectEvent() as any).boundary), segmentIndex: 1 } },
    ));
    expect(wrongBoundary.status).toBe("DORMANT");
    expect(wrongBoundary.state.fallbackReasons).toContain("RECOVERY_BOUNDARY_MISMATCH");

    const validReconnect = await runtime.dispatch(reconnectWithCheckpoint(
      checkpointId(started),
      valid,
    ));
    expect(validReconnect.status).toBe("COMPLETED");
    expect(validReconnect.state.toolHistory[0]?.status).toBe("CANCELLED");
  });

  it("rejects identity/version mismatches and non-ready reconnects before runtime work", async () => {
    const runtime = createCoachAgentRuntime({ checkpointer: new MemorySaver() });
    const started = await runtime.dispatch(startCueEvent({ routeSegmentIndex: 0 } as never));
    const request = started.effects[0];
    const disposition = { status: "POSTED" as const, callId: request.callId };

    const identityMismatch = await runtime.dispatch(reconnectWithCheckpoint(
      checkpointId(started),
      disposition,
      { identity: { ...fixtureIdentity, routeHash: "different-route" } },
    ));
    expect(identityMismatch.status).toBe("DORMANT");
    expect(identityMismatch.state.fallbackReasons).toContain("ROUTE_HASH_MISMATCH");

    const versionMismatch = await runtime.dispatch(reconnectWithCheckpoint(
      checkpointId(started),
      disposition,
      { versions: { graph: "coach-agent-graph.v999", state: COACH_AGENT_STATE_VERSION, session: "coaching-session.v2", recovery: "session-recovery-record.v2" } },
    ));
    expect(versionMismatch.status).toBe("DORMANT");
    expect(versionMismatch.state.fallbackReasons).toContain("RECOVERY_VERSION_MISMATCH");

    const notReady = { ...reconnectEvent(), replayAvailability: "LOADING" };
    expect(() => CoachAgentEventSchema.parse(notReady)).toThrow();
  });

  it("reconnects from the exact retained stable checkpoint after latest advances", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("Policy must not run during reconnect") });
    const checkpointer = new MemorySaver();
    const runtime = createCoachAgentRuntime({ policy, checkpointer });
    const stable = await runtime.dispatch(startCueEvent({ capabilities: [], routeSegmentIndex: 0 }));
    const stableId = checkpointId(stable);
    const advanced = await runtime.dispatch(observeSegment("event-after-stable", "segment-after-stable", 1));

    expect(checkpointId(advanced)).not.toBe(stableId);
    expect(advanced.state.currentSessionPhase).toBe("PLAYING");
    const recovered = await runtime.dispatch(reconnectWithCheckpoint(
      stableId,
      { status: "NONE" },
      { eventId: "event-historical-reconnect" },
    ));

    expect(recovered.status).toBe("COMPLETED");
    expect(recovered.effects).toEqual([]);
    expect(recovered.state.activeCueId).toBe("cue-17");
    expect(recovered.state.activeSegmentId).toBe("segment-1");
    expect(recovered.state.routeCursor).toBe(0);
    expect(recovered.state.currentSessionPhase).toBe("PAUSED_FOR_COACHING");
    expect(recovered.state.outcomeGateStatus).toBe("COMPLETE");
    expect(policy.calls).toHaveLength(0);

    const missing = await runtime.dispatch(reconnectWithCheckpoint(
      "checkpoint-does-not-exist",
      { status: "NONE" },
      { eventId: "event-missing-historical-reconnect" },
    ));
    expect(missing.status).toBe("DORMANT");
    expect(missing.state.fallbackReasons).toContain("RECOVERY_CHECKPOINT_MISMATCH");
  });

  it("converges a takeover checkpoint to one completed presentable cue without Policy or effects", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("Policy must not run during reconnect") });
    const checkpointer = new MemorySaver();
    const runtime = createCoachAgentRuntime({ policy, checkpointer });
    const started = await runtime.dispatch(startCueEvent({ routeSegmentIndex: 0 }));
    const takeover = await runtime.dispatch(takeoverEvent("event-reconnect-takeover"));
    const reconnect = reconnectWithCheckpoint(
      checkpointId(takeover),
      { status: "NONE" },
      { eventId: "event-takeover-reconnect" },
    );

    const recovered = await runtime.dispatch(reconnect);
    const duplicate = await runtime.dispatch(reconnect);

    expect(started.status).toBe("WAITING_TOOL");
    expect(takeover.status).toBe("USER_TAKEOVER");
    expect(recovered.status).toBe("COMPLETED");
    expect(recovered.effects).toEqual([]);
    expect(recovered.state.runStatus).toBe("CUE_COMPLETED");
    expect(recovered.state.sessionStatus).toBe("ACTIVE");
    expect(recovered.state.completedCueIds).toEqual(["cue-17"]);
    expect(recovered.state.completedCueSummaries).toHaveLength(1);
    expect(recovered.state.sessionThemes[0]).toMatchObject({ occurrence: 1, repeated: false });
    expect(recovered.state.routeCursor).toBe(takeover.state.routeCursor);
    expect(recovered.state.activeFocus).toBe(takeover.state.activeFocus);
    expect(recovered.state.currentSessionPhase).toBe(takeover.state.currentSessionPhase);
    expect(recovered.state.outcomeGateStatus).toBe(takeover.state.outcomeGateStatus);
    expect(duplicate.effects).toEqual([]);
    expect(duplicate.state.completedCueIds).toEqual(["cue-17"]);
    expect(duplicate.state.completedCueSummaries).toHaveLength(1);
    expect(policy.calls).toHaveLength(0);
  });

  it("reconnects a completed session only at WRAP_UP and rejects a running checkpoint posing as WRAP_UP", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("Policy must not run during completed reconnect") });
    const checkpointer = new MemorySaver();
    const runtime = createCoachAgentRuntime({ policy, checkpointer });
    const started = await runtime.dispatch(startCueEvent({ capabilities: [], routeSegmentIndex: 0 }));
    const completedCue = await runtime.dispatch(
      reconnectWithCheckpoint(checkpointId(started), { status: "NONE" }, { eventId: "event-complete-cue" }),
    );
    const completedSession = await runtime.dispatch({
      version: COACH_AGENT_EVENT_VERSION,
      type: "COMPLETE_SESSION",
      eventId: "event-complete-session",
      identity: fixtureIdentity,
    });
    const wrapUpReconnect = await runtime.dispatch(reconnectWithCheckpoint(
      checkpointId(completedSession),
      { status: "NONE" },
      {
        eventId: "event-wrap-up-reconnect",
        boundary: { kind: "WRAP_UP", boundaryId: "boundary-wrap-up", segmentIndex: completedSession.state.routeCursor },
      },
    ));
    const duplicate = await runtime.dispatch({
      ...reconnectWithCheckpoint(
        checkpointId(completedSession),
        { status: "NONE" },
        {
          eventId: "event-wrap-up-reconnect",
          boundary: { kind: "WRAP_UP", boundaryId: "boundary-wrap-up", segmentIndex: completedSession.state.routeCursor },
        },
      ),
    });

    expect(completedCue.status).toBe("COMPLETED");
    expect(completedSession.state.sessionStatus).toBe("COMPLETED");
    expect(completedSession.state.runStatus).toBe("COMPLETED");
    expect(wrapUpReconnect.status).toBe("COMPLETED");
    expect(wrapUpReconnect.effects).toEqual([]);
    expect(wrapUpReconnect.state.sessionStatus).toBe("COMPLETED");
    expect(wrapUpReconnect.state.runStatus).toBe("COMPLETED");
    expect(duplicate.effects).toEqual([]);
    expect(policy.calls).toHaveLength(0);

    const runningWrapUp = await runtime.dispatch(reconnectWithCheckpoint(
      checkpointId(started),
      { status: "NONE" },
      {
        eventId: "event-running-poses-wrap-up",
        boundary: { kind: "WRAP_UP", boundaryId: "boundary-wrap-up-running", segmentIndex: started.state.routeCursor },
      },
    ));
    expect(runningWrapUp.status).toBe("DORMANT");
    expect(runningWrapUp.state.fallbackReasons).toContain("RECOVERY_BOUNDARY_MISMATCH");
  });
});
