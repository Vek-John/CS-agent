import { describe, expect, it, vi } from "vitest";
import {
  AgentToolRequestSchema,
  type CoachAgentEvent,
  type CoachAgentResult,
} from "@cs-coach/coach-agent/client";
import type { PlaybackCommand, TeachingToolAckEvent } from "@cs-coach/contracts";
import {
  CoachAgentStage3Controller,
  type Stage3ControllerScheduler,
} from "./coach-agent-stage3-controller";
import { stage3StatusView } from "./coach-agent-stage3-status";
import { fixtureIdentity } from "../../../../libs/coach-agent/src/test-fixtures";
import type { CoachAgentStage3HostAdapter, Stage3HostAdapterInput, Stage3IdentityInput } from "./coach-agent-stage3-host-adapter";

function input(): Stage3HostAdapterInput {
  return {
    cue: { id: "cue-1" },
    generation: 1, sessionId: "session-1", runId: "run-1", tickRate: 64,
    outcomeGate: { cueId: "cue-1", outcomeEndTick: 100, status: "COMPLETE" },
  } as unknown as Stage3HostAdapterInput;
}

function result(status: CoachAgentResult["status"], effects: unknown[] = []): CoachAgentResult {
  return {
    status,
    effects,
    checkpoint: { checkpointId: status === "WAITING_TOOL" ? "checkpoint-waiting" : "checkpoint-completed" },
    state: { trace: [{ node: "POLICY", runId: "run-1", cueId: "cue-1", selectedCapabilityId: null }], lastToolResult: null, toolHistory: [], pendingToolCall: null, activeCueId: "cue-1", activeManualVisitId: null, completedCueIds: [], currentSessionPhase: "PAUSED_FOR_COACHING", routeCursor: 0, sessionStatus: "ACTIVE" },
  } as unknown as CoachAgentResult;
}

function harness(options: {
  bridgeAvailable?: boolean;
  tool?: "REPLAY_CUE_SLOW" | "SHOW_GRENADE_TRACE";
  dispatch?: (event: CoachAgentEvent) => Promise<CoachAgentResult>;
  capabilities?: unknown[];
  command?: PlaybackCommand | undefined;
  callStatus?: "UNKNOWN" | "POSTED" | "RESULTED" | "RESUMED";
  onAgentResult?: (event: CoachAgentEvent, result: CoachAgentResult) => void;
  onToolLedgerTransition?: import("./coach-agent-stage3-controller").Stage3ControllerOptions["onToolLedgerTransition"];
} = {}) {
  const request = AgentToolRequestSchema.parse({
    callId: "call-1",
    runId: "run-1",
    cueId: "cue-1",
    capabilityId: "cap-cue-1-map-focus",
    tool: options.tool ?? "FOCUS_MAP_EVIDENCE",
    evidenceRefs: ["annotation-1"],
  });
  const command: PlaybackCommand = {
    type: "teachingTool",
    schemaVersion: "cs2d-teaching-tool-command.v2",
    tool: options.tool ?? "FOCUS_MAP_EVIDENCE",
    callId: request.callId,
    runId: request.runId,
    generation: 1,
    cueId: request.cueId,
    args: options.tool === "REPLAY_CUE_SLOW"
      ? { tool: "REPLAY_CUE_SLOW", startCanonicalTick: 0, decisionCanonicalTick: 32, outcomeEndCanonicalTick: 128, speed: 0.5 }
      : options.tool === "SHOW_GRENADE_TRACE"
        ? { tool: "SHOW_GRENADE_TRACE", trajectoryRefs: ["trajectory-1"], landingRefs: ["landing-1"] }
        : { tool: "FOCUS_MAP_EVIDENCE", annotationRef: "annotation-1", focusWorld: { x: 1, y: 2 }, label: "证据" },
  };
  const resumeEvent = {} as CoachAgentEvent;
  const adapter = {
    prepareStart: vi.fn(() => ({ event: { type: "START_CUE" } as CoachAgentEvent, capabilities: options.capabilities ?? [{}] })),
    prepareManualStart: vi.fn((_input, visitId: string) => ({ event: { type: "START_MANUAL_CUE_VISIT", visitId } as CoachAgentEvent, capabilities: options.capabilities ?? [{}] })),
    isCurrent: vi.fn(() => true),
    createTeachingToolCommand: vi.fn(() => options.command === undefined && Object.prototype.hasOwnProperty.call(options, "command") ? undefined : command),
    acceptTeachingToolAck: vi.fn(() => ({
      callId: request.callId,
      status: "FAILED",
      observation: { code: "UNAVAILABLE", completed: false },
      limitations: ["bridge test"],
    })),
    createResumeEvent: vi.fn(() => ({ ...resumeEvent, type: "RESUME_TOOL" } as CoachAgentEvent)),
    createTakeoverEvent: vi.fn(() => ({ type: "USER_TAKEOVER" } as CoachAgentEvent)),
    createIdentityTakeoverEvent: vi.fn(() => ({ type: "USER_TAKEOVER" } as CoachAgentEvent)),
    createCompleteSessionEvent: vi.fn(() => ({} as CoachAgentEvent)),
    createObserveSegmentEvent: vi.fn(() => ({ type: "OBSERVE_SEGMENT" } as CoachAgentEvent)),
    createObservePresentedCueEvent: vi.fn((input, cueId, segmentId, segmentIndex, eventId) => ({
      version: "coach-agent-event.v2", type: "OBSERVE_PRESENTED_CUE", eventId,
      identity: { ...fixtureIdentity, runId: input.runId }, cueId, segmentId, segmentIndex, currentSessionPhase: "PLAYING",
    } as CoachAgentEvent)),
    beginLifecycleEvent: vi.fn((eventId: string) => {
      const current = lifecycle.get(eventId);
      if (current === "CONFIRMED") return "CONFIRMED";
      if (current === "PENDING") return "PENDING";
      lifecycle.set(eventId, "PENDING");
      return "START";
    }),
    confirmLifecycleEvent: vi.fn((eventId: string) => lifecycle.set(eventId, "CONFIRMED")),
    releaseLifecycleEvent: vi.fn((eventId: string) => lifecycle.delete(eventId)),
    lifecycleEventStatus: vi.fn((eventId: string) => lifecycle.get(eventId) ?? "NONE"),
    markLifecycleSynced: vi.fn(),
    markLifecycleDegraded: vi.fn(),
    reserveLifecycleCursor: vi.fn(),
    resetLifecycleQueue: vi.fn(),
    lifecycleCursor: -1,
    lifecycleQueueCursor: -1,
    lifecycleDegraded: false,
    callStatus: vi.fn(() => options.callStatus ?? "UNKNOWN"),
    resultForCall: vi.fn(() => undefined),
    commandGenerationFor: vi.fn(() => 1),
    cancel: vi.fn(),
    reset: vi.fn(),
  } as unknown as CoachAgentStage3HostAdapter;
  let now = 0;
  const delays: number[] = [];
  const scheduled: (() => void)[] = [];
  const scheduler: Stage3ControllerScheduler = {
    now: () => now,
    setTimeout: vi.fn((callback, timeoutMs) => {
      delays.push(timeoutMs);
      scheduled.push(callback);
      return callback;
    }),
    clearTimeout: vi.fn(),
  };
  const posted: PlaybackCommand[] = [];
  const dispatched: CoachAgentEvent[] = [];
  const lifecycle = new Map<string, "PENDING" | "CONFIRMED">();
  const dispatch = options.dispatch ?? (async (event: CoachAgentEvent) => {
    dispatched.push(event);
    return dispatched.length === 1 ? result("WAITING_TOOL", [request]) : result("COMPLETED");
  });
  const states: string[] = [];
  const controller = new CoachAgentStage3Controller({
    adapter,
    dispatch,
    post: (value) => posted.push(value),
    bridgeAvailable: () => options.bridgeAvailable ?? true,
    isLive: () => true,
    scheduler,
    onState: (state) => states.push(state.status),
    onAgentResult: options.onAgentResult,
    onToolLedgerTransition: options.onToolLedgerTransition,
  });
  return { controller, adapter, request, scheduled, posted, dispatched, states, delays, advance: (ms: number) => { now += ms; } };
}

const ack: TeachingToolAckEvent = {
  type: "TEACHING_TOOL_ACK",
  schemaVersion: "cs2d-teaching-tool-ack.v1",
  tool: "FOCUS_MAP_EVIDENCE",
  callId: "call-1",
  runId: "run-1",
  generation: 1,
  cueId: "cue-1",
  annotationRef: "annotation-1",
  status: "FAILED",
  observationCode: "UNAVAILABLE",
  completed: false,
  limitations: [],
};

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("CoachAgentStage3Controller", () => {
  it("dispatches zero-capability START_CUE so the Graph can finish the cue deterministically", async () => {
    const h = harness({ capabilities: [], dispatch: async (event) => {
      h.dispatched.push(event);
      return result("COMPLETED");
    } });
    h.controller.start(input());
    await flush();
    expect(h.dispatched).toHaveLength(1);
    expect(h.controller.currentState.status).toBe("COMPLETED");
  });

  it("starts a manual cue directly without default-route observer catch-up", async () => {
    const h = harness({ capabilities: [], dispatch: async (event) => {
      h.dispatched.push(event);
      return result("COMPLETED");
    } });
    h.controller.startManualCueVisit(input(), "visit-cue-4");
    await flush();
    expect(h.dispatched.map((event) => event.type)).toEqual(["START_MANUAL_CUE_VISIT"]);
    expect(h.adapter.createObserveSegmentEvent).not.toHaveBeenCalled();
    expect(h.adapter.markLifecycleDegraded).not.toHaveBeenCalled();
    expect(h.controller.hasStartedCue("cue-1")).toBe(false);
    expect(h.controller.currentState).toMatchObject({ status: "COMPLETED", source: "MANUAL", visitId: "visit-cue-4" });
  });

  it("arms exactly one resumed start after takeover checkpointing instead of starting early", async () => {
    let releaseTakeover: ((value: CoachAgentResult) => void) | undefined;
    const h = harness({ dispatch: (event) => {
      h.dispatched.push(event);
      if (event.type === "USER_TAKEOVER") return new Promise<CoachAgentResult>((resolve) => { releaseTakeover = resolve; });
      return Promise.resolve(result("COMPLETED"));
    } });
    const current = input();
    void h.controller.takeover(current, "用户接管回放。", 1);
    const armed = h.controller.resumeAfterTakeover(current);
    await flush();
    expect(h.dispatched.map((event) => event.type)).toEqual(["USER_TAKEOVER"]);

    releaseTakeover?.(result("USER_TAKEOVER"));
    await expect(armed).resolves.toBe(true);
    expect(h.dispatched.map((event) => event.type)).toEqual(["USER_TAKEOVER"]);
    const restored = h.controller.resumeInputFor(current);
    expect(restored.resumeFromTakeover).toBe(true);
    h.controller.start(restored);
    h.controller.start(h.controller.resumeInputFor(current));
    await flush();
    expect(h.dispatched.map((event) => event.type)).toEqual(["USER_TAKEOVER", "START_CUE"]);
  });

  it("persists identity-only takeover before the first cue input exists", async () => {
    const h = harness({ dispatch: async (event) => {
      h.dispatched.push(event);
      return result("USER_TAKEOVER");
    } });
    await expect(h.controller.takeoverIdentity({ runId: "run-1" } as Stage3IdentityInput, "先手动复查。", 1)).resolves.toBe(true);
    expect(h.dispatched.map((event) => event.type)).toEqual(["USER_TAKEOVER"]);
    expect(h.adapter.createIdentityTakeoverEvent).toHaveBeenCalledTimes(1);
  });

  it("accepts USER_TAKEOVER as a manual terminal only when that visit completed its cue", async () => {
    const completedManual = {
      ...result("USER_TAKEOVER"),
      state: {
        ...result("USER_TAKEOVER").state,
        activeManualVisitId: null,
        completedCueIds: ["cue-1"],
      },
    } as CoachAgentResult;
    const h = harness({ capabilities: [], dispatch: async (event) => {
      h.dispatched.push(event);
      return completedManual;
    } });
    h.controller.startManualCueVisit(input(), "visit-cue-4");
    await flush();
    expect(h.controller.currentState).toMatchObject({ status: "COMPLETED", source: "MANUAL", visitId: "visit-cue-4" });

    const ordinary = harness({ capabilities: [], dispatch: async () => result("USER_TAKEOVER") });
    ordinary.controller.startManualCueVisit(input(), "visit-not-complete");
    await flush();
    expect(ordinary.controller.currentState.status).toBe("FAILED");
  });

  it("observes a presented default cue without Policy or a teaching command", async () => {
    const h = harness({ dispatch: async (event) => {
      h.dispatched.push(event);
      if (event.type !== "OBSERVE_PRESENTED_CUE") throw new Error("unexpected event");
      const completed = result("COMPLETED");
      return { ...completed, identity: event.identity, state: { ...completed.state,
        routeCursor: event.segmentIndex, processedEventIds: [event.eventId],
        presentedCueBindings: [{ cueId: event.cueId, segmentId: event.segmentId, segmentIndex: event.segmentIndex }],
      } };
    } });
    h.controller.observePresentedCue({ runId: "run-1" } as unknown as Stage3IdentityInput, "cue-4", "segment-4", 4);
    await flush();
    await flush();
    expect(h.dispatched.map((event) => event.type)).toEqual(["OBSERVE_PRESENTED_CUE"]);
    expect(h.adapter.createTeachingToolCommand).not.toHaveBeenCalled();
    expect(h.adapter.reserveLifecycleCursor).toHaveBeenCalledWith(4);
    expect(h.adapter.markLifecycleSynced).toHaveBeenCalledWith(4);
  });

  it("degrades presented-cue bookkeeping only on a real dispatch failure", async () => {
    const network = harness({ dispatch: async () => { throw new Error("network down"); } });
    network.controller.observePresentedCue({ runId: "run-1" } as unknown as Stage3IdentityInput, "cue-4", "segment-4", 4);
    await flush();
    expect(network.adapter.releaseLifecycleEvent).toHaveBeenCalled();
    expect(network.adapter.resetLifecycleQueue).toHaveBeenCalled();
    expect(network.adapter.markLifecycleDegraded).toHaveBeenCalledTimes(1);

    const dormant = harness({ dispatch: async (event) => {
      dormant.dispatched.push(event);
      return result("DORMANT");
    } });
    dormant.controller.observePresentedCue({ runId: "run-1" } as unknown as Stage3IdentityInput, "cue-4", "segment-4", 4);
    await flush();
    expect(dormant.adapter.resetLifecycleQueue).toHaveBeenCalled();
    expect(dormant.adapter.markLifecycleDegraded).not.toHaveBeenCalled();
  });

  it("marks manual tool persistence as current-tab only", async () => {
    const transitions: import("./coach-agent-stage3-controller").Stage3ToolLedgerTransition[] = [];
    const h = harness({ onToolLedgerTransition: (transition) => { transitions.push(transition); } });
    h.controller.startManualCueVisit(input(), "visit-tool");
    await flush();
    expect(h.posted).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ status: "POSTED", source: "MANUAL", manualVisitId: "visit-tool" });
  });

  it("cancels an old manual effect before a second visit without RECOVERY_REQUIRED or duplicate post", async () => {
    let starts = 0;
    let h!: ReturnType<typeof harness>;
    h = harness({ dispatch: async (event) => {
      h.dispatched.push(event);
      if (event.type === "USER_TAKEOVER") return result("USER_TAKEOVER");
      if (event.type === "START_MANUAL_CUE_VISIT" && starts++ === 0) return result("WAITING_TOOL", [h.request]);
      return {
        ...result("USER_TAKEOVER"),
        state: { ...result("USER_TAKEOVER").state, activeManualVisitId: null, completedCueIds: ["cue-3"] },
      } as CoachAgentResult;
    } });
    const cue1 = input();
    h.controller.startManualCueVisit(cue1, "visit-1");
    await flush();
    expect(h.posted).toHaveLength(1);
    await h.controller.takeover(cue1, "用户继续跳转。", 1);
    const cue3 = { ...cue1, cue: { id: "cue-3" }, outcomeGate: { ...cue1.outcomeGate, cueId: "cue-3" }, generation: 2 } as Stage3HostAdapterInput;
    h.controller.startManualCueVisit(cue3, "visit-3");
    await flush();
    expect(h.posted).toHaveLength(1);
    expect(h.states).not.toContain("RECOVERY_REQUIRED");
    expect(h.controller.currentState).toMatchObject({ status: "COMPLETED", cueId: "cue-3", visitId: "visit-3" });
  });

  it("resumes the Graph with FAILED when an ACK explicitly fails, instead of leaving WAITING_TOOL", async () => {
    const h = harness();
    h.controller.start(input());
    await flush();
    expect(h.posted).toHaveLength(1);
    h.controller.acceptAck(ack);
    await flush();
    expect(h.adapter.createResumeEvent).toHaveBeenCalledTimes(1);
    expect(h.dispatched).toHaveLength(2);
    expect(h.controller.currentState.status).toBe("COMPLETED");
  });

  it("pairs POSTED/RESULTED with the waiting checkpoint and RESUMED with the completed checkpoint", async () => {
    const persisted: string[] = [];
    const h = harness({
      onAgentResult: (event, agent) => persisted.push(`agent:${event.type}:${agent.checkpoint.checkpointId}`),
      onToolLedgerTransition: (transition) => { persisted.push(`tool:${transition.status}:${transition.agentCheckpointId}`); },
    });

    h.controller.start(input());
    await flush();
    h.controller.acceptAck(ack);
    await flush();

    expect(persisted).toEqual([
      "agent:START_CUE:checkpoint-waiting",
      "tool:POSTED:checkpoint-waiting",
      "tool:RESULTED:checkpoint-waiting",
      "agent:RESUME_TOOL:checkpoint-completed",
      "tool:RESUMED:checkpoint-completed",
    ]);
  });

  it("does not post an external tool when POSTED persistence rejects", async () => {
    const h = harness({
      onToolLedgerTransition: async (transition) => {
        if (transition.status === "POSTED") throw new Error("recovery store unavailable");
      },
    });

    h.controller.start(input());
    await flush();

    expect(h.posted).toEqual([]);
    expect(h.controller.currentState.status).toBe("FAILED");
  });

  it("synthesizes one FAILED resume on timeout while the bridge is reachable", async () => {
    const h = harness({ bridgeAvailable: true });
    h.controller.start(input());
    await flush();
    const timeout = h.scheduled[0];
    if (!timeout) throw new Error("timeout not armed");
    timeout();
    await flush();
    await flush();
    expect(h.adapter.createResumeEvent).toHaveBeenCalledTimes(1);
    expect(h.dispatched).toHaveLength(2);
    expect(h.controller.currentState.status).toBe("COMPLETED");
  });

  it("does not resume or advance when the iframe is actually unavailable at timeout", async () => {
    const h = harness({ bridgeAvailable: false });
    h.controller.start(input());
    await flush();
    const timeout = h.scheduled[0];
    if (!timeout) throw new Error("timeout not armed");
    timeout();
    await flush();
    expect(h.adapter.createResumeEvent).not.toHaveBeenCalled();
    expect(h.dispatched).toHaveLength(1);
    expect(h.adapter.cancel).toHaveBeenCalled();
    expect(h.controller.currentState.status).toBe("RECOVERY_REQUIRED");
  });

  it("closes a posted-but-unknown rebuilt call with one constrained FAILED resume", async () => {
    const h = harness({ command: undefined, callStatus: "POSTED", bridgeAvailable: true });
    h.controller.start(input());
    await flush();
    await flush();
    expect(h.adapter.createResumeEvent).toHaveBeenCalledTimes(1);
    expect(h.dispatched).toHaveLength(2);
    expect(h.controller.currentState.status).toBe("COMPLETED");
  });

  it("orders WAITING_TOOL takeover before same-cue restore and ignores the old ACK", async () => {
    const h = harness();
    const current = input();
    h.controller.start(current);
    await flush();
    expect(h.posted).toHaveLength(1);
    await h.controller.takeover(current, "用户接管回放。", 1);
    h.controller.acceptAck(ack);
    await h.controller.resumeAfterTakeover(current);
    h.controller.start(h.controller.resumeInputFor(current));
    await flush();
    expect(h.adapter.createTakeoverEvent).toHaveBeenCalledTimes(1);
    expect(h.adapter.createTeachingToolCommand).toHaveBeenCalledTimes(1);
    expect(h.dispatched).toHaveLength(3);
    expect(h.controller.currentState.status).toBe("COMPLETED");
  });

  it("closes a pending takeover as RESUMED with the takeover checkpoint before returning", async () => {
    const persisted: string[] = [];
    const h = harness({
      onAgentResult: (event, agent) => { persisted.push(`agent:${event.type}:${agent.checkpoint.checkpointId}`); },
      onToolLedgerTransition: (transition) => { persisted.push(`tool:${transition.status}:${transition.result?.status ?? "NONE"}:${transition.agentCheckpointId}`); },
    });
    const current = input();
    h.controller.start(current);
    await flush();

    await h.controller.takeover(current, "用户接管回放。", 1);

    expect(persisted).toEqual([
      "agent:START_CUE:checkpoint-waiting",
      "tool:POSTED:NONE:checkpoint-waiting",
      "tool:RESUMED:CANCELLED:checkpoint-completed",
    ]);
  });

  it("re-enters an in-flight cue after takeover and closes its posted-unknown old call once", async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({
      dispatch: async (event) => {
        h.dispatched.push(event);
        if (event.type === "USER_TAKEOVER") return result("USER_TAKEOVER");
        if (event.type === "RESUME_TOOL") return result("COMPLETED");
        return result("WAITING_TOOL", [h.request]);
      }
    });
    const current = input();
    h.controller.start(current);
    await flush();
    expect(h.posted).toHaveLength(1);

    await h.controller.takeover(current, "用户接管回放。", 1);
    h.controller.acceptAck(ack);
    expect(h.adapter.acceptTeachingToolAck).not.toHaveBeenCalled();

    vi.mocked(h.adapter.createTeachingToolCommand).mockReturnValue(undefined);
    vi.mocked(h.adapter.callStatus).mockReturnValue("POSTED");
    h.controller.start(current);
    await flush();
    await flush();

    expect(h.adapter.createTeachingToolCommand).toHaveBeenCalledTimes(2);
    expect(h.adapter.createResumeEvent).toHaveBeenCalledTimes(1);
    expect(h.dispatched.filter((event) => event.type === "RESUME_TOOL")).toHaveLength(1);
    expect(h.controller.currentState.status).toBe("COMPLETED");
  });

  it("can leave a completed cue without issuing a TeachingMove on takeover restore", async () => {
    const current = input();
    const h = harness({ dispatch: async (event) => {
      h.dispatched.push(event);
      return result("COMPLETED");
    } });
    h.controller.start(current);
    await flush();
    expect(h.controller.currentState.status).toBe("COMPLETED");
    await h.controller.takeover(current, "用户接管回放。", 1);
    await h.controller.resumeAfterTakeover(current);
    h.controller.start(h.controller.resumeInputFor(current));
    await flush();
    expect(h.adapter.createTeachingToolCommand).not.toHaveBeenCalled();
    expect(h.dispatched).toHaveLength(3);
    expect(h.controller.currentState.status).toBe("COMPLETED");
  });

  it("returns COMPLETE_SESSION result once and dedupes the lifecycle event", async () => {
    const summaryResult = {
      status: "COMPLETED",
      identity: { sessionId: "session-1", runId: "run-1", routeId: "route-1", routeHash: "route-hash", selectedPlayerId: "player-1" },
      state: { sessionStatus: "COMPLETED", sessionSummaryInput: { themes: [], completedCues: [], limitations: [] } },
      effects: [],
    } as unknown as CoachAgentResult;
    const h = harness({ dispatch: async (event) => {
      h.dispatched.push(event);
      return summaryResult;
    } });
    const lifecycleInput = {
      plan: { id: "route-1" },
      routeState: { routeFingerprint: "route-hash" },
      analysis: { demo_id: "demo-1", selected_steam_id: "player-1" },
      demoContentHash: "a".repeat(64),
      selectedPlayerId: "player-1",
      sessionId: "session-1",
      runId: "run-1",
    } as unknown as Stage3IdentityInput;
    vi.mocked(h.adapter.createCompleteSessionEvent).mockReturnValue({ identity: summaryResult.identity } as CoachAgentEvent & { type: "COMPLETE_SESSION" });
    const first = h.controller.completeSession(lifecycleInput);
    const second = h.controller.completeSession(lifecycleInput);
    await flush();
    expect(await first).toEqual({ status: "SUCCEEDED", result: summaryResult });
    expect(await second).toBeUndefined();
    expect(h.dispatched).toHaveLength(1);
  });
});


describe("same-demonstration playback controls", () => {
  it.each(["REPLAY_CUE_SLOW", "SHOW_GRENADE_TRACE"] as const)("pauses %s beyond the wall-clock limit without another call or Graph resume", async tool => {
    const h = harness({ tool });
    h.controller.start(input()); await flush();
    const current = h.controller.currentState.playback!;
    expect(current).toMatchObject({ sessionId: "session-1", runId: "run-1", callId: "call-1", cueId: "cue-1", generation: 1, paused: false });
    h.advance(4_000);
    expect(h.controller.setPlaybackPaused(current, true)).toBe(true);
    h.advance(30_000);
    h.scheduled[0]!(); // Cleared but queued old expiry must be inert.
    h.scheduled.at(-1)!(); // Pause monitor: available bridge, no failure.
    await flush();
    expect(h.controller.currentState.playback?.paused).toBe(true);
    expect(h.dispatched).toHaveLength(1);
    expect(h.adapter.createResumeEvent).not.toHaveBeenCalled();
    expect(h.controller.setPlaybackPaused(current, false)).toBe(true);
    expect(h.delays.at(-1)).toBe(6_000);
    expect(h.posted.filter(c => c.type === "teachingTool")).toHaveLength(1);
    expect(h.posted.filter(c => c.type === "teachingPlayback")).toEqual([
      { type: "teachingPlayback", action: "pause", callId: "call-1", runId: "run-1", cueId: "cue-1", generation: 1 },
      { type: "teachingPlayback", action: "resume", callId: "call-1", runId: "run-1", cueId: "cue-1", generation: 1 },
    ]);
    vi.mocked(h.adapter.acceptTeachingToolAck).mockReturnValue({ callId: "call-1", status: "SUCCEEDED",
      observation: { code: tool === "REPLAY_CUE_SLOW" ? "CUE_PLAYED" : "EVIDENCE_SHOWN", completed: true }, limitations: [] });
    h.controller.acceptAck({ ...ack, tool, status: "SUCCEEDED", completed: true }); await flush();
    expect(h.controller.currentState.status).toBe("COMPLETED");
    expect(h.controller.currentState.playback).toBeUndefined();
    expect(h.controller.setPlaybackPaused(current, false)).toBe(false);
    expect(h.adapter.createResumeEvent).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });

  it("rejects mismatched identities and stops a paused tool on explicit takeover", async () => {
    const h = harness({ tool: "REPLAY_CUE_SLOW" });
    h.controller.start(input()); await flush();
    const current = h.controller.currentState.playback!;
    for (const mismatch of [{ sessionId: "old" }, { runId: "old" }, { cueId: "old" }, { callId: "old" }, { generation: 0 }]) {
      expect(h.controller.setPlaybackPaused({ ...current, ...mismatch }, true)).toBe(false);
    }
    expect(h.posted).toHaveLength(1);
    h.controller.setPlaybackPaused(current, true);
    await h.controller.takeover(input());
    expect(h.posted.at(-1)).toMatchObject({ type: "teachingPlayback", action: "cancel", callId: current.callId });
    expect(h.controller.setPlaybackPaused(current, false)).toBe(false);
    h.controller.acceptAck({ ...ack, tool: "REPLAY_CUE_SLOW" });
    h.scheduled[0]!(); await flush();
    expect(h.adapter.createResumeEvent).not.toHaveBeenCalled();
  });

  it("uses only remaining active time after repeated pauses and cancels on real timeout", async () => {
    const h = harness({ tool: "SHOW_GRENADE_TRACE" });
    h.controller.start(input()); await flush();
    const current = h.controller.currentState.playback!;
    h.advance(4_000); h.controller.setPlaybackPaused(current, true);
    h.advance(100_000); h.controller.setPlaybackPaused(current, false);
    h.advance(2_000); h.controller.setPlaybackPaused(current, true);
    h.advance(100_000); h.controller.setPlaybackPaused(current, false);
    expect(h.delays.at(-1)).toBe(4_000);
    h.scheduled.at(-1)!(); await flush(); await flush();
    expect(h.posted.at(-1)).toMatchObject({ type: "teachingPlayback", action: "cancel" });
    expect(h.adapter.createResumeEvent).toHaveBeenCalledTimes(1);
  });

  it("does not expose controls before the durable POSTED barrier and invalidates them on reconnect", async () => {
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ tool: "REPLAY_CUE_SLOW", onToolLedgerTransition: t => t.status === "POSTED" ? persisted : undefined });
    h.controller.start(input()); await flush();
    expect(h.controller.currentState.playback).toBeUndefined();
    expect(h.posted).toEqual([]);
    release(); await flush();
    const current = h.controller.currentState.playback!;
    expect(current).toBeDefined();
    h.controller.setPlaybackPaused(current, true);
    await h.controller.reconnect({ type: "RECONNECT_REPLAY" } as Extract<CoachAgentEvent, { type: "RECONNECT_REPLAY" }>);
    expect(h.posted.at(-1)).toMatchObject({ type: "teachingPlayback", action: "cancel" });
    expect(h.controller.setPlaybackPaused(current, false)).toBe(false);
    expect(h.controller.currentState.status).toBe("RECOVERY_REQUIRED");
  });

  it("treats a lost bridge while paused as recovery, not a fabricated tool result", async () => {
    const options = { tool: "REPLAY_CUE_SLOW" as const, bridgeAvailable: true };
    const h = harness(options); h.controller.start(input()); await flush();
    h.controller.setPlaybackPaused(h.controller.currentState.playback!, true);
    options.bridgeAvailable = false;
    h.scheduled.at(-1)!(); await flush();
    expect(h.controller.currentState.status).toBe("RECOVERY_REQUIRED");
    expect(h.adapter.createResumeEvent).not.toHaveBeenCalled();
  });
  it.each(["cancel", "reconnect", "bridgeLost"] as const)("ignores a RESULTED write completing after %s", async (boundary) => {
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ tool: "REPLAY_CUE_SLOW", onToolLedgerTransition: t => t.status === "RESULTED" ? persisted : undefined });
    h.controller.start(input()); await flush();
    h.controller.acceptAck({ ...ack, tool: "REPLAY_CUE_SLOW" }); await flush();
    if (boundary === "cancel") h.controller.cancel(1);
    else if (boundary === "bridgeLost") h.controller.bridgeLost();
    else await h.controller.reconnect({ type: "RECONNECT_REPLAY" } as Extract<CoachAgentEvent, { type: "RECONNECT_REPLAY" }>);
    release(); await flush(); await flush();
    expect(h.dispatched.filter(event => event.type === "RESUME_TOOL")).toHaveLength(0);
    expect(h.controller.currentState.status).toBe(boundary === "cancel" ? "CANCELLED" : "RECOVERY_REQUIRED");
  });

  it("invalidates paused playback on an iframe lifecycle boundary even while contentWindow exists", async () => {
    const h = harness({ tool: "REPLAY_CUE_SLOW", bridgeAvailable: true });
    h.controller.start(input()); await flush();
    const playback = h.controller.currentState.playback!;
    h.controller.setPlaybackPaused(playback, true);
    h.controller.bridgeLost();
    expect(h.controller.currentState.status).toBe("RECOVERY_REQUIRED");
    expect(h.controller.setPlaybackPaused(playback, false)).toBe(false);
    h.scheduled.at(-1)!(); await flush();
    expect(h.adapter.createResumeEvent).not.toHaveBeenCalled();
  });

  it("does not present failed execution as success when Graph still completes the cue", async () => {
    const h = harness(); h.controller.start(input()); await flush();
    h.controller.acceptAck(ack); await flush(); await flush();
    expect(h.controller.currentState.status).toBe("COMPLETED");
    expect(stage3StatusView(h.controller.currentState, { ...input(), cueId: "cue-1" })).toMatchObject({ title: "额外演示未完成", showPresentation: false });
    expect(h.controller.currentState.presentation).toBeUndefined();
  });

  it("binds a no-tool finish to this manual visit and does not borrow old cue history", async () => {
    const h = harness({ dispatch: async () => result("COMPLETED") });
    h.controller.startManualCueVisit(input(), "visit-1"); await flush();
    const scope = { ...input(), cueId: "cue-1", visitId: "visit-1" };
    expect(stage3StatusView(h.controller.currentState, scope).title).toBe("无需额外演示");
    expect(stage3StatusView(h.controller.currentState, { ...scope, visitId: "visit-2" }).title).toBe("本段讲解已就绪");
    const prior = result("COMPLETED");
    prior.state.toolHistory = [{ cueId: "cue-1", status: "SUCCEEDED", tool: "REPLAY_CUE_SLOW" }] as typeof prior.state.toolHistory;
    const recovered = harness({ dispatch: async () => prior });
    recovered.controller.start(input()); await flush();
    expect(stage3StatusView(recovered.controller.currentState, scope)).toMatchObject({ title: "本段讲解已就绪", showPresentation: false });
    const unknown = result("COMPLETED");
    unknown.state.trace = [];
    const missing = harness({ dispatch: async () => unknown });
    missing.controller.start(input()); await flush();
    expect(stage3StatusView(missing.controller.currentState, { ...input(), cueId: "cue-1" }).title).toBe("本段讲解已就绪");
  });

});
