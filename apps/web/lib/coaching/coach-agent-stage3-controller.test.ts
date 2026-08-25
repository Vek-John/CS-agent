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
import type { CoachAgentStage3HostAdapter, Stage3HostAdapterInput, Stage3IdentityInput } from "./coach-agent-stage3-host-adapter";

function input(): Stage3HostAdapterInput {
  return {
    cue: { id: "cue-1" },
    generation: 1,
    outcomeGate: { cueId: "cue-1", outcomeEndTick: 100, status: "COMPLETE" },
  } as unknown as Stage3HostAdapterInput;
}

function result(status: CoachAgentResult["status"], effects: unknown[] = []): CoachAgentResult {
  return {
    status,
    effects,
    checkpoint: { checkpointId: status === "WAITING_TOOL" ? "checkpoint-waiting" : "checkpoint-completed" },
    state: { activeCueId: "cue-1", currentSessionPhase: "PAUSED_FOR_COACHING", routeCursor: 0 },
  } as unknown as CoachAgentResult;
}

function harness(options: {
  bridgeAvailable?: boolean;
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
    tool: "FOCUS_MAP_EVIDENCE",
    evidenceRefs: ["annotation-1"],
  });
  const command: PlaybackCommand = {
    type: "teachingTool",
    schemaVersion: "cs2d-teaching-tool-command.v2",
    tool: "FOCUS_MAP_EVIDENCE",
    callId: request.callId,
    runId: request.runId,
    generation: 1,
    cueId: request.cueId,
    args: { tool: "FOCUS_MAP_EVIDENCE", annotationRef: "annotation-1", focusWorld: { x: 1, y: 2 }, label: "证据" },
  };
  const resumeEvent = {} as CoachAgentEvent;
  const adapter = {
    prepareStart: vi.fn(() => ({ event: { type: "START_CUE" } as CoachAgentEvent, capabilities: options.capabilities ?? [{}] })),
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
    createCompleteSessionEvent: vi.fn(() => ({} as CoachAgentEvent)),
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
    lifecycleCursor: -1,
    lifecycleQueueCursor: -1,
    lifecycleDegraded: false,
    callStatus: vi.fn(() => options.callStatus ?? "UNKNOWN"),
    resultForCall: vi.fn(() => undefined),
    commandGenerationFor: vi.fn(() => 1),
    cancel: vi.fn(),
    reset: vi.fn(),
  } as unknown as CoachAgentStage3HostAdapter;
  const scheduled: (() => void)[] = [];
  const scheduler: Stage3ControllerScheduler = {
    setTimeout: vi.fn((callback) => {
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
  return { controller, adapter, request, scheduled, posted, dispatched, states };
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
    await flush();
    expect(h.adapter.createTeachingToolCommand).not.toHaveBeenCalled();
    expect(h.dispatched).toHaveLength(3);
    expect(h.controller.currentState.status).toBe("COMPLETED");
  });

  it("returns COMPLETE_SESSION result once and dedupes the lifecycle event", async () => {
    const summaryResult = {
      status: "COMPLETED",
      identity: { runId: "run-1", routeId: "route-1", routeHash: "route-hash", selectedPlayerId: "player-1" },
      state: { sessionSummaryInput: { themes: [], completedCues: [], limitations: [] } },
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
    const first = h.controller.completeSession(lifecycleInput);
    const second = h.controller.completeSession(lifecycleInput);
    await flush();
    expect(await first).toBe(summaryResult);
    expect(await second).toBe(summaryResult);
    expect(h.dispatched).toHaveLength(1);
  });
});
