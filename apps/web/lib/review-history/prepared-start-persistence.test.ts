import { expect, it, vi } from "vitest";
import type { NarrationBundle } from "@cs-coach/contracts";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { createCoachingSession } from "@cs-coach/session";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildInitialCoachingRouteState, createReviewPreparationOrchestrator, settlePreparedCoachingStart } from "../coaching/cs2d-route-integration";
import { buildSessionRecoveryRecord, createRecoverySessionIdentity, validateStoredReviewArtifacts } from "../recovery/cs2d-session-recovery";
import { HistoryPersistenceController } from "./history-persistence-controller";
import { persistNarrationAfterStart, persistPreparedReviewStart } from "./prepared-start-persistence";
import { createReviewHistoryApi, TEACHING_SAVE_TIMEOUT_MS } from "./api";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function analysisFixture() {
  // Three synthetic rounds, preserving each real Adapter nomination and compiler path.
  const original = fireReplay("DEATH", []), round = original.rounds[0];
  const rounds = Array.from({ length: 3 }, (_, i) => ({ ...round, number: i + 1, scoreCt: i,
    freezeStartTick: round.freezeStartTick + i * 1000, startTick: round.startTick + i * 1000, decidedTick: round.decidedTick + i * 1000,
    endTick: round.endTick + i * 1000, postEndTick: round.postEndTick! + i * 1000,
    frames: round.frames.map(frame => ({ ...frame, tick: frame.tick + i * 1000, players: frame.players.map(player => ({ ...player, health: player.alive ? 40 : 0, armor: 100, weapon: i === 1 ? "flashbang" : i === 2 ? "c4" : "ak47" })) })),
    events: round.events.map(event => ({ ...event, tick: event.tick + i * 1000 })),
  }));
  const analysis = buildCs2dAnalysisBundle({ replay: { ...original, rounds }, selectedSteamId: self, demoId: "prepared-start", demoContentHash: "a".repeat(64) });
  expect(analysis.review_plan.cues).toHaveLength(3);
  return analysis;
}

it("keeps later narration writes outside the initial durable-start critical path", async () => {
  const analysis = analysisFixture(), plan = analysis.review_plan;
  const revision = deferred<{ revisionId: string }>(), laterWrite = deferred<void>();
  const calls: string[] = [];
  const firstTwo = new Set(plan.cues.slice(0, 2).map(cue => cue.id));
  const append = vi.fn(async (_review: string, input: { artifactType: string; artifactKey: string }) => {
    calls.push(`${input.artifactType}:${input.artifactKey}`);
    if (input.artifactType === "NARRATION_BUNDLE" && !firstTwo.has(input.artifactKey)) await laterWrite.promise;
  });
  const head = vi.fn(async () => { calls.push("HEAD"); return { recoveryArtifactId: "start-artifact" }; });
  const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: () => revision.promise, appendArtifact: append, commitRuntimeHead: head, markFailed: vi.fn() });
  history.adopt("review", undefined, "demo");
  let narrations: Readonly<Record<string, NarrationBundle>> = {}, durability: Promise<void> | undefined, activation: Promise<boolean> | undefined;
  const background: Promise<unknown>[] = [];
  const activate = vi.fn(async () => { calls.push("ACTIVATE"); return true; });
  const raw = vi.fn(() => analysis);
  const orchestrator = createReviewPreparationOrchestrator("generation", plan, {}, {
    prepareRoute: async () => plan,
    prepareNarration: async ({ cue }) => ({ readiness: "FALLBACK", narration: deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set)),
      manifest: { status: "FALLBACK", provider: "DETERMINISTIC", limitations: [] } }),
  });
  await orchestrator.run(event => {
    if (event.type === "NARRATION_UPDATE") {
      narrations = { ...narrations, [event.cueId]: event.result.narration };
      if (durability) background.push(persistNarrationAfterStart({ history, durability, isCurrent: () => true, cueId: event.cueId, narration: event.result.narration }));
    }
    if (event.type === "READY_TO_START") {
      const identity = createRecoverySessionIdentity();
      const record = buildSessionRecoveryRecord({ identity, analysis, plan, routeState: event.routeState,
        session: createCoachingSession(plan, identity.sessionId, event.routeState), narrationByCue: narrations,
        boundaryKind: "ROUTE_START", agentCheckpointId: null, demoContentHash: "a".repeat(64), selectedPlayerId: self });
      expect(Object.values(record.routeReadiness).filter(value => value !== "PENDING")).toHaveLength(2);
      durability = persistPreparedReviewStart({ history, plan, routeState: event.routeState, record, analysis, narrationByCue: narrations, readRawAnalysis: raw, isCurrent: () => true });
      activation = settlePreparedCoachingStart({ durability, isCurrent: () => true, saved() {}, unconfirmed() {}, activate });
    }
  });
  expect(raw).not.toHaveBeenCalled(); expect(Object.keys(narrations)).toHaveLength(3); expect(background).toHaveLength(1);
  revision.resolve({ revisionId: "revision" });
  // Flush the finite promise chain; slow background persistence remains deliberately unresolved.
  for (let i = 0; i < 35; i++) await Promise.resolve();
  const activatedBeforeLaterWrites = activate.mock.calls.length;
  laterWrite.resolve(); await activation; await Promise.all(background);
  console.info(JSON.stringify({ activatedBeforeLaterWrites, narrationWrites: calls.filter(call => call.startsWith("NARRATION_BUNDLE:")).length, calls }));
  expect.soft(activatedBeforeLaterWrites).toBe(1);
  expect(calls.filter(call => call.startsWith("NARRATION_BUNDLE:"))).toHaveLength(3);
  expect(head).toHaveBeenCalledOnce(); expect(raw).toHaveBeenCalledOnce();
  expect(calls.indexOf("HEAD")).toBeLessThan(calls.findIndex(call => call.startsWith("NARRATION_BUNDLE:") && !firstTwo.has(call.slice("NARRATION_BUNDLE:".length))));
});

function prepared() {
  const analysis = analysisFixture(), plan = analysis.review_plan;
  const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set))]));
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue });
  const identity = createRecoverySessionIdentity();
  const record = buildSessionRecoveryRecord({ identity, analysis, plan, routeState, session: createCoachingSession(plan, identity.sessionId, routeState),
    narrationByCue, boundaryKind: "ROUTE_START", agentCheckpointId: null, demoContentHash: "a".repeat(64), selectedPlayerId: self });
  const append = vi.fn(async () => {}), head = vi.fn(async () => ({ recoveryArtifactId: "start" }));
  const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(async () => ({ revisionId: "revision" })), appendArtifact: append, commitRuntimeHead: head, markFailed: vi.fn() });
  history.adopt("review", undefined, "demo");
  return { analysis, plan, routeState, record, narrationByCue, history, append, head, readRawAnalysis: vi.fn(() => analysis), isCurrent: () => true };
}

it.each(["fetch", "body"])("settles the prepared start when its first narration %s hangs", async stage => {
  vi.useFakeTimers();
  const f = prepared(), gate = deferred<unknown>();
  const lateJson = vi.fn(async () => ({ saved: true }));
  const calls: string[] = [];
  let blocked = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/revisions")) return Response.json({ revisionId: "revision" });
    if (url.endsWith("/runtime-head")) { calls.push("HEAD"); return Response.json({ recoveryArtifactId: "head" }); }
    const body = JSON.parse(String(init?.body));
    calls.push(body.artifactType);
    if (body.artifactType === "NARRATION_BUNDLE" && !blocked) {
      blocked = true;
      return stage === "fetch" ? await gate.promise as Response : Object.assign(new Response(), { json: () => gate.promise });
    }
    return Response.json({ saved: true });
  });
  const api = createReviewHistoryApi(fetcher as typeof fetch);
  const history = new HistoryPersistenceController({ createReview: api.create, startRevision: api.startRevision,
    appendArtifact: api.appendArtifact, commitRuntimeHead: api.commitRuntimeHead, markFailed: api.markFailed });
  history.adopt("review", undefined, "demo");
  let failure: unknown, settled = false;
  const save = persistPreparedReviewStart({ ...f, history }).catch(error => { failure = error; throw error; });
  const activate = vi.fn(async () => true), saved = vi.fn(), unconfirmed = vi.fn();
  const start = settlePreparedCoachingStart({ durability: save, isCurrent: () => true, saved, unconfirmed, activate })
    .then(result => { settled = true; return result; });
  const release = () => gate.resolve(stage === "fetch" ? Object.assign(new Response(), { json: lateJson }) : { saved: true });
  try {
    await vi.advanceTimersByTimeAsync(TEACHING_SAVE_TIMEOUT_MS - 1);
    expect(blocked).toBe(true); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(failure).toMatchObject({ code: "TEACHING_SAVE_TIMEOUT" });
    expect(await start).toBe(true); expect(activate).toHaveBeenCalledOnce();
    expect(unconfirmed).toHaveBeenCalledOnce(); expect(saved).not.toHaveBeenCalled();
    const before = [...calls]; release(); await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(before);
    expect(calls).toEqual(["ANALYSIS_BUNDLE", "CANDIDATE_SET", "REVIEW_PLAN", "NARRATION_BUNDLE"]);
    expect(lateJson).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  } finally {
    release(); await start; vi.clearAllTimers(); vi.useRealTimers();
  }
});

it("persists every narration already ready at capture, including more than the first two", async () => {
  const f = prepared();
  await persistPreparedReviewStart(f);
  const artifacts = f.append.mock.calls as unknown as [string, { artifactType: string; artifactKey: string; payload: unknown }][];
  expect(artifacts.map(([, input]) => input.artifactType)).toEqual(["ANALYSIS_BUNDLE", "CANDIDATE_SET", "REVIEW_PLAN", "NARRATION_BUNDLE", "NARRATION_BUNDLE", "NARRATION_BUNDLE", "SESSION_RECOVERY"]);
  const savedNarration = Object.fromEntries(artifacts.filter(([, input]) => input.artifactType === "NARRATION_BUNDLE").map(([, input]) => [input.artifactKey, input.payload]));
  const validated = validateStoredReviewArtifacts({ analysis: f.analysis, candidateSet: f.analysis.candidate_set, plan: f.plan, narrationByCue: savedNarration,
    cueCases: {}, learningThreads: [], summary: null, selectedPlayerId: self, demoContentHash: "a".repeat(64), routeId: f.plan.id, routeHash: f.routeState.routeFingerprint });
  expect(Object.keys(validated.narrationByCue)).toHaveLength(3);
  expect(Object.entries(f.record.routeReadiness).filter(([, state]) => state !== "PENDING").every(([cue]) => cue in validated.narrationByCue)).toBe(true);
  expect(f.head).toHaveBeenCalledOnce();
});

it("does not publish a head after an initial narration write fails", async () => {
  const f = prepared();
  f.append.mockImplementation(async (...args) => {
    const input = (args as unknown as [string, { artifactType: string }])[1];
    if (input.artifactType === "NARRATION_BUNDLE") throw new Error("initial narration failed");
  });
  await expect(persistPreparedReviewStart(f)).rejects.toThrow("initial narration failed");
  expect(f.head).not.toHaveBeenCalled(); expect(f.append).toHaveBeenCalledTimes(4);
});

it("refuses to omit a narration required by the captured recovery readiness", async () => {
  const f = prepared();
  await expect(persistPreparedReviewStart({ ...f, narrationByCue: {} })).rejects.toThrow("START_NARRATION_MISSING");
  expect(f.append).not.toHaveBeenCalled(); expect(f.head).not.toHaveBeenCalled(); expect(f.readRawAnalysis).not.toHaveBeenCalled();
});

it("stops the old startup before its next artifact when the Controller is adopted during a write", async () => {
  const f = prepared(), gate = deferred<void>();
  f.append.mockImplementationOnce(() => gate.promise);
  const pending = persistPreparedReviewStart(f);
  const outcome = pending.then(() => "saved", error => error.message);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(f.append).toHaveBeenCalledOnce();
  f.history.adopt("other-review", "other-revision", "other-demo");
  gate.resolve();
  expect(await outcome).toMatch(/STALE/);
  expect(f.append).toHaveBeenCalledOnce(); expect(f.head).not.toHaveBeenCalled();
});

it.each(["same-owner-adopt", "other-owner", "generation"])("does not send queued narration after %s", async change => {
  const f = prepared(), durability = deferred<void>(); let current = true;
  const pending = persistNarrationAfterStart({ history: f.history, durability: durability.promise, isCurrent: () => current,
    cueId: f.plan.cues[2].id, narration: f.narrationByCue[f.plan.cues[2].id] });
  if (change === "generation") current = false;
  else f.history.adopt(change === "other-owner" ? "other-review" : "review", undefined, "demo");
  durability.resolve(); await pending;
  expect(f.append).not.toHaveBeenCalled(); expect(f.head).not.toHaveBeenCalled();
});
