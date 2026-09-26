import { afterEach, expect, it, vi } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createCoachingSession } from "@cs-coach/session";
import { createReviewHistoryApi } from "./api";
import { HistoryPersistenceController } from "./history-persistence-controller";
import { activatePreparedCoachingSession, buildInitialCoachingRouteState, settlePreparedCoachingStart } from "../coaching/cs2d-route-integration";

const deadline = 20_000;
const createInput = { demoId: "demo-a", selectedPlayerId: "player-a", selectedPlayerName: "Synthetic", title: "Prepared review" };
const revisionInput = { routeId: "route-a", routeHash: "route-hash", analysisVersion: "fixture", graphVersion: "fixture", promptVersion: "fixture", modelMetadata: {} };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function localStart(durability: Promise<void>, isCurrent = () => true) {
  // Existing compiled-plan fixture contract; no Demo parsing or model run.
  const base = createFixtureReviewPlan(createSyntheticMirageTimeline());
  const plan = { ...base, candidate_set_id: "candidate-set-fixture", candidate_set_version: "fixture/1", candidate_set_hash: "candidate-hash",
    compiler_provenance: { version: "compiler/1", route_fingerprint: "route-fingerprint", status: "SUCCEEDED" as const },
    cues: base.cues.map((cue, index) => ({ ...cue, candidate_id: `candidate-${index + 1}`, primary_focus_code: "SURVIVE_CONTACT" })),
  };
  const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, {
    cueId: cue.id, candidateId: cue.candidate_id, primaryFocusCode: cue.primary_focus_code,
    currentSituation: { text: "Prepared synthetic situation", refs: [] }, playerAction: { text: "Prepared action", refs: [] },
    coreIssue: { text: "Prepared limitation", refs: [] }, betterPlay: { text: "No tactical conclusion", refs: [] }, outcomeImpact: { text: "Prepared result", refs: [] },
  }]));
  const route = buildInitialCoachingRouteState(plan, { narrationByCue });
  expect(route.startable).toBe(true);
  const saved = vi.fn(), unconfirmed = vi.fn(), mount = vi.fn(), persistStart = vi.fn(async () => undefined);
  const activate = vi.fn(() => activatePreparedCoachingSession({ plan, initialSession: createCoachingSession(plan, "startup-session", route),
    isCurrent, latestRouteState: () => route, persistStart, acceptPersistedStart: vi.fn(), mountSession: mount }));
  const pending = settlePreparedCoachingStart({ durability, isCurrent, saved, unconfirmed, activate });
  return { pending, saved, unconfirmed, mount, persistStart, activate, plan };
}

function begin(history: HistoryPersistenceController, target: "create" | "revision") {
  const creation = target === "create" ? history.createForPlayer(createInput) : undefined;
  // Real Host separately observes creation failures; the revision dependency must also settle.
  const creationOutcome = creation?.then(value => ({ value }), error => ({ error }));
  if (target === "revision") history.adopt("review-a", undefined, "demo-a");
  const revision = history.beginRevision(revisionInput);
  const revisionOutcome = revision.then(value => ({ value }), error => ({ error }));
  const durability = revision.then(async () => { await history.stableHead({ recoveryArtifactKey: "prepared-start", recoveryBoundary: "ROUTE_START" }); });
  return { creationOutcome, revisionOutcome, durability };
}

it.each((["create", "revision"] as const).flatMap(target => (["fetch", "body"] as const).map(stage => ({ target, stage }))))("releases local startup when $target $stage stalls", async ({ target, stage }) => {
  vi.useFakeTimers();
  const gate = deferred<unknown>();
  const json = vi.fn(() => gate.promise);
  const fetcher = vi.fn((_url: string, _init?: RequestInit) => stage === "fetch" ? gate.promise as Promise<Response> : Promise.resolve(Object.assign(new Response(), { json })));
  const api = createReviewHistoryApi(fetcher as typeof fetch);
  const head = vi.fn(api.commitRuntimeHead);
  const history = new HistoryPersistenceController({ createReview: api.create, startRevision: api.startRevision, appendArtifact: api.appendArtifact, commitRuntimeHead: head, markFailed: vi.fn() });
  const started = begin(history, target), local = localStart(started.durability);
  await vi.advanceTimersByTimeAsync(deadline - 1);
  expect(local.mount).not.toHaveBeenCalled(); expect(local.unconfirmed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await local.pending).toBe(true);
  expect(local.unconfirmed).toHaveBeenCalledOnce(); expect(local.saved).not.toHaveBeenCalled();
  expect(local.mount).toHaveBeenCalledOnce(); expect(local.persistStart).toHaveBeenCalledOnce();
  expect(local.mount.mock.calls[0][0]).toMatchObject({ review_plan_id: local.plan.id, id: "startup-session" });
  expect(local.mount.mock.calls[0][0].phase).not.toBe("INTRO");
  expect(await started.revisionOutcome).toMatchObject({ error: { code: "HISTORY_REQUEST_TIMEOUT" } });
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  gate.resolve(stage === "fetch" ? Object.assign(new Response(), { json }) : target === "create" ? { reviewId: "late-review" } : { revisionId: "late-revision" });
  await vi.advanceTimersByTimeAsync(0);
  expect(history.reviewId).toBe(target === "create" ? undefined : "review-a"); expect(history.revisionId).toBeUndefined();
  expect(head).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce(); expect(json).toHaveBeenCalledTimes(stage === "body" ? 1 : 0);
  expect(local.mount).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  await started.creationOutcome;
});

it.each(["create", "revision"] as const)("keeps successful %s metadata, IDs and startup ordering", async target => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.endsWith("/revisions")
    ? { revisionId: "revision-a" } : url.endsWith("/runtime-head") ? { recoveryArtifactId: "head-a" } : { reviewId: "review-a" }, { status: 201 }));
  const api = createReviewHistoryApi(fetcher as typeof fetch);
  const history = new HistoryPersistenceController({ createReview: api.create, startRevision: api.startRevision, appendArtifact: api.appendArtifact, commitRuntimeHead: api.commitRuntimeHead, markFailed: vi.fn() });
  const started = begin(history, target), local = localStart(started.durability);
  expect(await local.pending).toBe(true); await started.creationOutcome;
  expect(history.reviewId).toBe("review-a"); expect(history.revisionId).toBe("revision-a");
  expect(local.saved).toHaveBeenCalledOnce(); expect(local.unconfirmed).not.toHaveBeenCalled(); expect(local.mount).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    ...(target === "create" ? ["/api/review-history"] : []), "/api/review-history/review-a/revisions", "/api/review-history/review-a/runtime-head",
  ]);
  const revisionRequest = fetcher.mock.calls.find(([url]) => url.endsWith("/revisions"))!;
  expect(JSON.parse(String(revisionRequest[1]?.body))).toEqual({ ...revisionInput, mode: target === "create" ? "SELECT_PLAYER" : "REANALYZE" });
  expect(vi.getTimerCount()).toBe(0);
});

it.each((["create", "revision"] as const).flatMap(target => [true, false].map(validJson => ({ target, validJson }))))("preserves $target HTTP error semantics (valid JSON: $validJson)", async ({ target, validJson }) => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => validJson ? Response.json({ code: "RECORD_REJECTED" }, { status: 400 }) : new Response("not-json", { status: 400 }));
  const api = createReviewHistoryApi(fetcher);
  const head = vi.fn(api.commitRuntimeHead);
  const history = new HistoryPersistenceController({ createReview: api.create, startRevision: api.startRevision, appendArtifact: api.appendArtifact, commitRuntimeHead: head, markFailed: vi.fn() });
  const started = begin(history, target), local = localStart(started.durability);
  expect(await local.pending).toBe(true);
  expect(await started.revisionOutcome).toMatchObject({ error: { code: validJson ? "RECORD_REJECTED" : "REQUEST_FAILED" } });
  await started.creationOutcome;
  expect(local.unconfirmed).toHaveBeenCalledOnce(); expect(local.saved).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledOnce(); expect(head).not.toHaveBeenCalled(); expect(history.revisionId).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not activate a superseded startup after its request deadline", async () => {
  vi.useFakeTimers();
  const gate = deferred<Response>();
  const fetcher = vi.fn(() => gate.promise);
  const api = createReviewHistoryApi(fetcher), head = vi.fn(api.commitRuntimeHead);
  const history = new HistoryPersistenceController({ createReview: api.create, startRevision: api.startRevision, appendArtifact: api.appendArtifact, commitRuntimeHead: head, markFailed: vi.fn() });
  const started = begin(history, "revision"); let current = true;
  const local = localStart(started.durability, () => current);
  await vi.advanceTimersByTimeAsync(1); current = false; history.adopt("other-review", "other-revision", "other-demo");
  await vi.advanceTimersByTimeAsync(deadline);
  expect(await local.pending).toBe(false);
  gate.resolve(Response.json({ revisionId: "late-revision" })); await vi.advanceTimersByTimeAsync(0);
  expect(history.revisionId).toBe("other-revision"); expect(local.mount).not.toHaveBeenCalled();
  expect(local.unconfirmed).not.toHaveBeenCalled(); expect(local.saved).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
