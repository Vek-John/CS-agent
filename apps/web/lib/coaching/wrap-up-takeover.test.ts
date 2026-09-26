import { afterEach, expect, it, vi } from "vitest";
import type { CoachAgentResult, SessionWrapUpBuildInput } from "@cs-coach/coach-agent/client";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { createCoachingSession } from "@cs-coach/session";
import type { PlaybackCommand } from "@cs-coach/contracts";
import { completeStage3SessionWrapUp, createSessionWrapUpGuard } from "./session-wrap-up-completion";
import { CoachAgentStage3Controller } from "./coach-agent-stage3-controller";
import { buildStage3Identity, type Stage3IdentityInput } from "./coach-agent-stage3-host-adapter";
import { buildInitialCoachingRouteState } from "./cs2d-route-integration";
import { HistoryPersistenceController } from "../review-history/history-persistence-controller";
import { HostPlaybackControl, issueHostUserCommand } from "../playback/cs2d-playback-host";
import * as summaries from "./deepseek-wrap-up";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const projection: SessionWrapUpBuildInput = { summary: { schemaVersion: "coach-agent-session-summary.v1", themes: [], completedCues: [], limitations: [] }, presentableCues: {} };
afterEach(() => vi.restoreAllMocks());
let sequence = 0;
function setup() {
  sequence++;
  const analysis = buildCs2dAnalysisBundle({ replay: fireReplay("DEATH"), selectedSteamId: self, demoId: "wrap-up-fixture", demoContentHash: "a".repeat(64) });
  const plan = analysis.review_plan;
  const identity: Stage3IdentityInput = { plan, routeState: buildInitialCoachingRouteState(plan),
    analysis: { demo_id: plan.demo_id, selected_steam_id: plan.player_id }, demoContentHash: "a".repeat(64),
    selectedPlayerId: plan.player_id, sessionId: `finished-session-${sequence}`, runId: `finished-run-${sequence}` };
  buildStage3Identity(identity);
  const graph = deferred<CoachAgentResult>(), dispatched = deferred<void>();
  const dispatch = vi.fn(async () => { dispatched.resolve(); return graph.promise; });
  const controller = new CoachAgentStage3Controller({ dispatch, post: vi.fn(), bridgeAvailable: () => true, isLive: () => false });
  const persistence = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(), appendArtifact: vi.fn(), commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
  persistence.adopt("review", "revision", "demo");
  const artifact = vi.spyOn(persistence, "artifact").mockResolvedValue(undefined);
  const live = { generation: 1, historyEpoch: 1, takenOver: false, session: { ...createCoachingSession(plan, identity.sessionId), phase: "WRAP_UP" as "WRAP_UP" | "COMPLETED" | "PLAYING" }, runId: identity.runId as string | undefined, persistence };
  // Return a fresh snapshot like Host refs; owner values themselves remain live.
  const isCurrent = createSessionWrapUpGuard(identity, 1, () => ({ ...live }));
  expect(isCurrent()).toBe(true);
  let claimed = false;
  const onResult = vi.fn(), onStart = vi.fn(), onSaveError = vi.fn();
  const finish = () => completeStage3SessionWrapUp({ controller, identity, isCurrent, persistence,
    buildInput: () => projection, claim: () => { if (claimed) return false; claimed = true; return true; }, onStart, onResult, onSaveError, onRequest: vi.fn() });
  const resolveGraph = () => graph.resolve({ identity: buildStage3Identity(identity), status: "COMPLETED", effects: [], state: { sessionStatus: "COMPLETED" } } as unknown as CoachAgentResult);
  return { live, controller, dispatch, dispatched, resolveGraph, finish, artifact, onResult, onStart, onSaveError, persistence };
}

it("finishes and saves once when a timeline seek takes over during Graph completion", async () => {
  const f = setup();
  try {
    const pending = f.finish(); await f.dispatched.promise;
    const commands: PlaybackCommand[] = [];
    issueHostUserCommand({ type: "seekCanonicalTick", canonicalTick: 64 }, { session: f.live.session, userTookOver: false,
      control: new HostPlaybackControl(), takeover: () => { f.live.takenOver = true; }, send: command => commands.push(command) });
    f.resolveGraph(); await pending; await f.finish();
    expect(commands).toEqual([{ type: "pause" }, { type: "seekCanonicalTick", canonicalTick: 64 }]);
    expect(f.onResult).toHaveBeenCalledOnce(); expect(f.artifact).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.live.session.phase).toBe("WRAP_UP"); expect(f.live.takenOver).toBe(true);
  } finally { f.controller.dispose(); }
});

it.each(["generation", "session", "run", "phase", "history", "persistence", "review", "revision"])("rejects a delayed completion after %s ownership changes", async kind => {
  const f = setup();
  try {
    const pending = f.finish(); await f.dispatched.promise;
    if (kind === "generation") f.live.generation++;
    if (kind === "session") f.live.session = { ...f.live.session, id: "other" };
    if (kind === "run") f.live.runId = "other";
    if (kind === "phase") f.live.session = { ...f.live.session, phase: "PLAYING" };
    if (kind === "history") f.live.historyEpoch++;
    if (kind === "persistence") f.live.persistence = Object.create(f.persistence);
    if (kind === "review") f.persistence.adopt("other", "revision", "demo");
    if (kind === "revision") f.persistence.adopt("review", "other", "demo");
    f.resolveGraph(); await pending;
    expect(f.onResult).not.toHaveBeenCalled(); expect(f.artifact).not.toHaveBeenCalled();
  } finally { f.controller.dispose(); }
});

it("keeps same-owner summary publication after completion releases its transient run", async () => {
  const f = setup(), result = await summaries.requestSessionWrapUp(projection), summary = deferred<typeof result>(), requested = deferred<void>();
  vi.spyOn(summaries, "requestSessionWrapUp").mockImplementation(async () => { requested.resolve(); return summary.promise; });
  try {
    const pending = f.finish(); await f.dispatched.promise; f.resolveGraph(); await requested.promise;
    f.live.takenOver = true; f.live.session.phase = "COMPLETED"; f.live.runId = undefined;
    summary.resolve(result); await pending;
    expect(f.onResult).toHaveBeenCalledWith(result); expect(f.artifact).toHaveBeenCalledOnce();
  } finally { f.controller.dispose(); }
});

it.each([false, true])("reports delayed save failure only for its summary owner during free playback (switch=%s)", async switchOwner => {
  const f = setup(), saving = deferred<void>();
  let reject!: (reason: Error) => void;
  f.artifact.mockImplementation(() => { saving.resolve(); return new Promise((_, fail) => { reject = fail; }); });
  try {
    const pending = f.finish(); await f.dispatched.promise; f.resolveGraph(); await saving.promise;
    f.live.takenOver = true;
    if (switchOwner) f.live.historyEpoch++;
    reject(new Error("test save failure")); await pending;
    expect(f.artifact).toHaveBeenCalledOnce(); expect(f.onResult).toHaveBeenCalledOnce();
    expect(f.onSaveError).toHaveBeenCalledTimes(switchOwner ? 0 : 1);
  } finally { f.controller.dispose(); }
});

it("rejects a summary response after another history opens, even if the prior Graph already completed", async () => {
  const f = setup(), result = await summaries.requestSessionWrapUp(projection), summary = deferred<typeof result>(), requested = deferred<void>();
  vi.spyOn(summaries, "requestSessionWrapUp").mockImplementation(async () => { requested.resolve(); return summary.promise; });
  try {
    const pending = f.finish(); await f.dispatched.promise; f.resolveGraph(); await requested.promise;
    f.live.historyEpoch++; summary.resolve(result); await pending;
    expect(f.onResult).not.toHaveBeenCalled(); expect(f.artifact).not.toHaveBeenCalled();
  } finally { f.controller.dispose(); }
});
