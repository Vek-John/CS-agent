import { IDBFactory } from "fake-indexeddb";
import { captureRecoveryBoundaryOwner, dispatchHostRecoveryBoundary } from "./host-recovery-boundary";
import { expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { consumeGuidedRoute, type GuidedRouteArtifacts } from "../../../../tools/validate-guided-lifecycle";
import { buildSessionRecoveryRecord, buildCheckpointedRecoveryRecord, createRecoverySessionIdentity } from "./cs2d-session-recovery";
import { createSessionRecoveryRuntime } from "./session-recovery-runtime";
import { hasConfirmedTerminalRecovery, mirrorAgentCheckpoint, type AgentMirrorOwner } from "./agent-checkpoint-mirror";
import { HistoryPersistenceController } from "../review-history/history-persistence-controller";
const hash = "a".repeat(64);
async function fixture() {
  const analysis = buildCs2dAnalysisBundle({ replay: fireReplay("DEATH"), selectedSteamId: self, demoId: "terminal-fixture", demoContentHash: hash });
  const captured: { value?: GuidedRouteArtifacts } = {};
  await consumeGuidedRoute(analysis, hash, "ALL_SKIP", { capture: value => { captured.value = value; } });
  const { routeState, session: wrap, narrationByCue, completedGraph } = captured.value!;
  const plan = analysis.review_plan;
  const identity = { ...createRecoverySessionIdentity(), sessionId: wrap.id, runId: completedGraph.identity.runId };
  const base = { identity, analysis, plan, routeState, narrationByCue, demoContentHash: hash, selectedPlayerId: self };
  const record = buildSessionRecoveryRecord({ ...base, session: createCoachingSession(plan, identity.sessionId, routeState), boundaryKind: "ROUTE_START", agentCheckpointId: null });
  const runtime = createSessionRecoveryRuntime({ indexedDB: new IDBFactory() });
  await runtime.dispatch({ type: "SESSION_STARTED", eventId: "terminal-start", record });
  const append = vi.fn().mockResolvedValue(undefined), head = vi.fn().mockResolvedValue({ recoveryArtifactId: "terminal-artifact" });
  const history = new HistoryPersistenceController({ appendArtifact: append, commitRuntimeHead: head, createReview: vi.fn(), startRevision: vi.fn(), markFailed: vi.fn() });
  history.adopt("review", "revision", "demo");
  const finished = reduceCoachingSession(plan, wrap, { type: "COMPLETE_SESSION" });
  const live: AgentMirrorOwner = { generation: 1, historyEpoch: 1, transportEpoch: 1, sessionId: wrap.id, sessionPhase: "COMPLETED",
    identity: { ...base, sessionId: identity.sessionId, runId: identity.runId }, recoveryIdentity: identity, runtime, record, history, takenOver: false, recovering: false };
  const accept = vi.fn(), failure = vi.fn();
  const input = { event: { version: "coach-agent-event.v2" as const, type: "COMPLETE_SESSION" as const, eventId: "terminal-complete", identity: completedGraph.identity },
    result: completedGraph, read: () => live, checkpoint: vi.fn(), accept, failure, eventId: () => "terminal-mirror",
    stable: (checkpoint: import("./cs2d-session-recovery").RecoveryAgentCheckpointMeta) => buildCheckpointedRecoveryRecord({ ...base, session: finished, boundaryKind: "WRAP_UP", agentCheckpointId: null }, checkpoint) };
  return { base, wrap, finished, live, input, append, head, accept, failure };
}
it("captures the actual completed Session as the same plan-derived terminal boundary", async () => {
  const f = await fixture();
  const result = f.input.stable({ checkpointId: f.input.result.checkpoint.checkpointId, activeCueId: f.input.result.state.activeCueId,
    currentSessionPhase: f.input.result.state.currentSessionPhase, routeCursor: f.input.result.state.routeCursor, sessionStatus: f.input.result.state.sessionStatus });
  expect(result?.boundary.kind).toBe("WRAP_UP"); expect(result?.cueProgress.consumedCueIds).toEqual(f.finished.consumed_cue_ids);
  expect(() => buildSessionRecoveryRecord({ ...f.base, session: { ...f.finished, current_tick: f.finished.current_tick - 1 }, boundaryKind: "WRAP_UP", agentCheckpointId: null })).toThrow();
});
it("commits the completed head while free playback has control", async () => {
  const f = await fixture(); f.live.takenOver = true;
  await mirrorAgentCheckpoint(f.input);
  expect(f.append).toHaveBeenCalledOnce(); expect(f.head).toHaveBeenCalledOnce();
  expect(f.head.mock.calls[0][1]).toMatchObject({ recoveryBoundary: "WRAP_UP", reviewStatus: "COMPLETED", completedCueCount: f.base.plan.cues.length });
  expect(f.accept).toHaveBeenCalledOnce(); expect(f.failure).not.toHaveBeenCalled();
});

it("keeps a failed terminal head retry valid after summary saving and further free seeks", async () => {
  const f = await fixture();
  f.head.mockRejectedValueOnce(new TypeError("network interrupted"));
  f.input.checkpoint.mockImplementation(meta => { f.live.checkpointId = meta.checkpointId; });
  await mirrorAgentCheckpoint(f.input);
  const retry = f.failure.mock.calls[0]?.[0] as import("../review-history/history-persistence-controller").RuntimeHeadRetry;
  expect(retry?.isCurrent()).toBe(true);
  f.live.takenOver = true; f.live.transportEpoch = 2;
  await f.live.history!.artifact("SESSION_SUMMARY", "session-summary", {}, "session-wrap-up.v1");
  expect(retry.isCurrent()).toBe(true);
  expect(await retry.retry()).toBe(true);
  expect(f.head).toHaveBeenCalledTimes(2); expect(f.accept).toHaveBeenCalledOnce();
});


it("does not release recovery based on local persistence before the terminal head acknowledgement", async () => {
  const f = await fixture();
  let release!: () => void, called!: () => void;
  const started = new Promise<void>(done => { called = done; });
  f.head.mockImplementationOnce(() => { called(); return new Promise(done => { release = () => done({ recoveryArtifactId: "terminal-artifact" }); }); });
  const pending = mirrorAgentCheckpoint(f.input); await started;
  expect(f.accept).not.toHaveBeenCalled();
  const local = (await f.live.runtime!.dispatch({ type: "BOOT", eventId: "inspect-local" })).record!;
  expect(local.boundary.kind).toBe("WRAP_UP");
  expect(hasConfirmedTerminalRecovery(local, undefined)).toBe(false);
  release(); await pending;
  const saved = f.accept.mock.calls[0][0].record!;
  expect(hasConfirmedTerminalRecovery(saved, { recoveryId: saved.recoveryId, checkpointId: saved.agentCheckpointId! })).toBe(true);
  expect(hasConfirmedTerminalRecovery(saved, { recoveryId: "other", checkpointId: saved.agentCheckpointId! })).toBe(false);
});

it.each(["phase", "event", "owner"])("does not promote a taken-over terminal result after %s changes", async kind => {
  const f = await fixture(); f.live.takenOver = true;
  if (kind === "phase") f.live.sessionPhase = "PLAYING";
  if (kind === "owner") f.live.sessionId = "other";
  const event = kind === "event" ? { ...f.input.event, type: "OBSERVE_SEGMENT" } as unknown as typeof f.input.event : f.input.event;
  await mirrorAgentCheckpoint({ ...f.input, event });
  expect(f.append).not.toHaveBeenCalled(); expect(f.head).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
});

it("still invalidates a terminal retry when recovery content is replaced", async () => {
  const f = await fixture(); f.head.mockRejectedValueOnce(new TypeError("network interrupted"));
  f.input.checkpoint.mockImplementation(meta => { f.live.checkpointId = meta.checkpointId; });
  await mirrorAgentCheckpoint(f.input);
  const retry = f.failure.mock.calls[0][0] as import("../review-history/history-persistence-controller").RuntimeHeadRetry;
  await f.live.history!.artifact("SESSION_RECOVERY", "replacement", {}, "session-recovery-record.v2");
  expect(retry.isCurrent()).toBe(false); expect(await retry.retry()).toBe(false);
});


it("cleans the confirmed terminal recovery while playback remains taken over", async () => {
  const f = await fixture(); f.live.takenOver = true;
  await mirrorAgentCheckpoint(f.input);
  const saved = f.accept.mock.calls[0][0].record!;
  const ack = { recoveryId: saved.recoveryId, checkpointId: saved.agentCheckpointId! };
  const owner = { generation: 1, historyEpoch: 1, operationEpoch: 1, runtime: f.live.runtime,
    sessionId: f.finished.id, sessionPhase: "COMPLETED", record: saved, takenOver: true, recovering: false,
    completedHeadConfirmed: hasConfirmedTerminalRecovery(saved, ack) };
  const isCurrent = captureRecoveryBoundaryOwner(() => owner, true);
  expect(isCurrent()).toBe(true);
  expect(captureRecoveryBoundaryOwner(() => owner)()).toBe(false); // Ordinary boundaries still respect takeover.
  owner.completedHeadConfirmed = false; expect(isCurrent()).toBe(false); owner.completedHeadConfirmed = true;
  const onCompleted = vi.fn(), accept = vi.fn(), failure = vi.fn();
  await dispatchHostRecoveryBoundary({ runtime: f.live.runtime!, record: saved, isCurrent,
    event: { type: "SESSION_COMPLETED", eventId: "terminal-cleanup", recoveryId: saved.recoveryId }, onCompleted, accept, onFailure: failure });
  expect(onCompleted).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
  expect((await f.live.runtime!.dispatch({ type: "BOOT", eventId: "reopen-cleanup" })).record).toBeNull();
});
