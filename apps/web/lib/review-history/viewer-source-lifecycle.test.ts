import { afterEach, expect, it, vi } from "vitest";
import { createReviewHistoryApi } from "./api";
import { HistoryRestoreController, type ManagedDemoSource, type ReviewHistoryDetail } from "./history-restore-controller";
import { attachHistoryViewerSource } from "./attach-history-viewer-source";

const deadline = 20_000;
const source: ManagedDemoSource = { requestId: "request-fixture", demoId: "demo-fixture", capabilityToken: "synthetic-token", originalFilename: "fixture.dem", byteSize: 4, contentHash: "f".repeat(64) };
function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function detail(id: string): ReviewHistoryDetail {
  const identity = { sessionId: "session", runId: "run", demoContentHash: "f".repeat(64), selectedPlayerId: "player", routeId: "plan", routeHash: "route" };
  return {
    review: { id, demoId: source.demoId, title: id, status: "READY", selectedPlayerId: "player" },
    revision: { id: "revision", status: "READY", artifactContractVersion: 2 },
    runtimeHead: { ...identity, recoveryArtifactId: "recovery-id", recoveryArtifactKey: "recovery", recoveryArtifactRevision: 1, recoveryBoundary: "ROUTE_START", defaultRouteCursor: 0, completedCueCount: 0, totalCueCount: 0 },
    artifacts: [
      { kind: "ANALYSIS_BUNDLE", key: "analysis", payload: { review_plan: { id: "plan" } } },
      { kind: "CANDIDATE_SET", key: "candidates", payload: { id: "candidates" } },
      { kind: "REVIEW_PLAN", key: "plan", payload: { id: "plan" } },
      { kind: "NARRATION_BUNDLE", key: "cue", payload: { cueId: "cue", text: "保存的讲解" } },
      { kind: "SESSION_RECOVERY", id: "recovery-id", key: "recovery", revision: 1, payload: { ...identity, agentCheckpointId: null, frozenReviewPlan: { cues: [] }, cueProgress: { completedCueIds: [] }, boundary: { kind: "ROUTE_START", segmentIndex: 0 } } },
    ],
  };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(["fetch", "body"])("bounds the actual viewer-source %s lifetime", async stage => {
  vi.useFakeTimers(); const headers = deferred<Response>(), body = deferred<unknown>();
  const api = createReviewHistoryApi(async () => stage === "fetch" ? headers.promise : Object.assign(new Response(), { json: () => body.promise }));
  let settled = false, error: unknown;
  const pending = api.viewerSource("review").then(() => { settled = true; }, reason => { settled = true; error = reason; });
  try {
    await vi.advanceTimersByTimeAsync(deadline);
    expect(settled).toBe(true);
    expect(error).toMatchObject({ code: "VIEWER_SOURCE_TIMEOUT" });
  } finally { headers.resolve(Response.json(source)); body.resolve(source); await pending; }
});

it.each(["abort", "late-failure"])("keeps B's UI after A's source ends with %s through the real Controller and Host seam", async kind => {
  const late = deferred<ManagedDemoSource>(); const feedback = vi.fn(), expected = vi.fn(), activated = vi.fn();
  const controller = new HistoryRestoreController({ loadDetail: async id => detail(id), loadManagedDemo: activated,
    requestViewerSource: (_id, signal) => {
      if (kind === "abort") signal!.addEventListener("abort", () => late.reject(new DOMException("cancelled", "AbortError")), { once: true });
      return late.promise;
    },
  });
  let epoch = 1;
  const a = await controller.open("A"); expect(a.missingArtifacts).toEqual([]);
  const old = attachHistoryViewerSource({ controller, restored: a, mode: "RESTORE", isCurrent: () => epoch === 1, expectSource: expected, feedback }).catch(() => undefined);
  epoch++;
  await controller.open("B");
  if (kind === "late-failure") late.reject(new Error("late source failure"));
  await old;
  expect(feedback).not.toHaveBeenCalled(); expect(expected).not.toHaveBeenCalled(); expect(activated).not.toHaveBeenCalled();
});

it("normalizes an obsolete source failure into the Controller's stale-request signal", async () => {
  const late = deferred<ManagedDemoSource>();
  const controller = new HistoryRestoreController({ loadDetail: async id => detail(id), requestViewerSource: () => late.promise, loadManagedDemo: vi.fn() });
  const a = await controller.open("A");
  const old = controller.attachViewerSource(a).catch(error => error);
  await controller.open("B"); late.reject(new DOMException("cancelled", "AbortError"));
  expect(await old).toMatchObject({ code: "STALE_REQUEST" });
});

it("checks Host open ownership on failure even before a new Controller generation is created", async () => {
  const late = deferred<ManagedDemoSource>(), feedback = vi.fn(), expected = vi.fn();
  const controller = new HistoryRestoreController({ loadDetail: async id => detail(id), requestViewerSource: () => late.promise, loadManagedDemo: vi.fn() });
  const restored = await controller.open("A"); let current = true;
  const pending = attachHistoryViewerSource({ controller, restored, mode: "RESTORE", isCurrent: () => current, expectSource: expected, feedback }).catch(() => undefined);
  current = false; late.reject(new Error("late failure after Host invalidation")); await pending;
  expect(feedback).not.toHaveBeenCalled(); expect(expected).not.toHaveBeenCalled();
});

it("does not read late headers and removes its parent listener after timeout", async () => {
  vi.useFakeTimers(); const late = deferred<Response>(), parent = new AbortController();
  const add = vi.spyOn(parent.signal, "addEventListener"), remove = vi.spyOn(parent.signal, "removeEventListener");
  let child: AbortSignal | undefined;
  const json = vi.fn().mockResolvedValue(source);
  const api = createReviewHistoryApi((_url, init) => { child = init?.signal as AbortSignal; return late.promise; });
  const pending = api.viewerSource("A", parent.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(deadline);
  expect(await pending).toMatchObject({ code: "VIEWER_SOURCE_TIMEOUT" }); expect(child?.aborted).toBe(true);
  late.resolve(Object.assign(new Response(), { json })); await vi.advanceTimersByTimeAsync(0);
  expect(json).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
});

it.each([200, 409])("uses one deadline for headers plus body and observes a late body rejection, status=%s", async status => {
  vi.useFakeTimers(); const headers = deferred<Response>(), body = deferred<unknown>();
  const api = createReviewHistoryApi(() => headers.promise);
  const result = api.viewerSource("A").catch(error => error);
  await vi.advanceTimersByTimeAsync(deadline - 1);
  headers.resolve(Object.assign(new Response(undefined, { status }), { json: () => body.promise }));
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ code: "VIEWER_SOURCE_TIMEOUT" });
  body.reject(new Error("late fixture body failure")); await vi.advanceTimersByTimeAsync(0);
  expect(await result).toMatchObject({ code: "VIEWER_SOURCE_TIMEOUT" }); expect(vi.getTimerCount()).toBe(0);
});

it.each(["before", "fetch", "body"])("honors parent cancellation at %s without cooperative transport", async stage => {
  vi.useFakeTimers(); const parent = new AbortController(), headers = deferred<Response>(), body = deferred<unknown>();
  if (stage === "before") parent.abort();
  let child: AbortSignal | undefined;
  const fetcher = vi.fn((_url, init) => { child = init?.signal as AbortSignal;
    return stage === "body" ? Promise.resolve(Object.assign(new Response(), { json: () => body.promise })) : headers.promise;
  });
  const remove = vi.spyOn(parent.signal, "removeEventListener");
  const result = createReviewHistoryApi(fetcher).viewerSource("A", parent.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(0); parent.abort();
  expect(await result).toMatchObject({ name: "AbortError" });
  if (stage === "before") expect(fetcher).not.toHaveBeenCalled();
  else { expect(child?.aborted).toBe(true); expect(remove).toHaveBeenCalledOnce(); }
  headers.resolve(Response.json(source)); body.resolve(source); await vi.advanceTimersByTimeAsync(0);
  expect(await result).toMatchObject({ name: "AbortError" }); expect(vi.getTimerCount()).toBe(0);
});

it.each(["success", "bad-success-json", "coded-http", "bad-error-json"])("preserves viewer-source response semantics for %s", async kind => {
  vi.useFakeTimers();
  const response = kind === "success" ? Response.json(source) : kind === "coded-http" ? Response.json({ code: "SOURCE_UNAVAILABLE" }, { status: 409 }) : new Response("{bad", { status: kind === "bad-error-json" ? 500 : 200 });
  const value = await createReviewHistoryApi(async () => response).viewerSource("A").catch(error => error);
  if (kind === "success") expect(value).toEqual(source);
  if (kind === "bad-success-json") expect(value).toBeUndefined();
  if (kind === "coded-http") expect(value).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  if (kind === "bad-error-json") expect(value).toMatchObject({ code: "REQUEST_FAILED" });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["RESTORE", "timeout"], ["REANALYZE", "timeout"], ["SELECT_PLAYER", "timeout"],
  ["RESTORE", "http"], ["REANALYZE", "http"], ["SELECT_PLAYER", "http"],
] as const)("keeps current %s source %s visible through the actual API/Controller/Host entry", async (mode, kind) => {
  vi.useFakeTimers(); const fetcher = vi.fn(() => kind === "http" ? Promise.resolve(Response.json({ code: "SOURCE_UNAVAILABLE" }, { status: 409 })) : new Promise<Response>(() => {}));
  const api = createReviewHistoryApi(fetcher), feedback = vi.fn(), activated = vi.fn(), expected = vi.fn();
  const controller = new HistoryRestoreController({ loadDetail: async id => detail(id), requestViewerSource: api.viewerSource, loadManagedDemo: activated });
  const restored = await controller.open("A", mode), before = structuredClone(restored);
  const done = attachHistoryViewerSource({ controller, restored, mode, isCurrent: () => true, expectSource: expected, feedback });
  await vi.advanceTimersByTimeAsync(deadline); await done;
  expect(feedback).toHaveBeenCalledOnce();
  expect(feedback.mock.calls[0][0].preparation.phase).toBe(mode === "RESTORE" ? "READY" : "ERROR");
  expect(feedback.mock.calls[0][0].message).toContain(kind === "timeout" ? "超时" : "暂时不可用");
  expect(feedback.mock.calls[0][0].message).not.toContain("校验");
  if (mode === "RESTORE") expect(feedback.mock.calls[0][0].message).toContain("讲解与进度仍保留");
  else expect(feedback.mock.calls[0][0].message).toContain("未启动，原有复盘未改变");
  expect(restored).toEqual(before); expect(expected).not.toHaveBeenCalled(); expect(activated).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["RESTORE", "success"], ["REANALYZE", "success"], ["SELECT_PLAYER", "success"],
  ["RESTORE", "failure"], ["REANALYZE", "failure"], ["SELECT_PLAYER", "failure"],
] as const)("preserves B and isolates A's late %s/%s", async (mode, kind) => {
  const late = deferred<ManagedDemoSource>(), activated = vi.fn(), oldFeedback = vi.fn(), oldExpected = vi.fn();
  const controller = new HistoryRestoreController({ loadDetail: async id => detail(id), loadManagedDemo: activated,
    requestViewerSource: async id => id === "A" ? late.promise : { ...source, requestId: "B" },
  });
  let epoch = 1;
  const a = await controller.open("A", mode);
  const old = attachHistoryViewerSource({ controller, restored: a, mode, isCurrent: () => epoch === 1, expectSource: oldExpected, feedback: oldFeedback });
  epoch = 2; const b = await controller.open("B", mode), expectedB = vi.fn(), feedbackB = vi.fn();
  await attachHistoryViewerSource({ controller, restored: b, mode, isCurrent: () => epoch === 2, expectSource: expectedB, feedback: feedbackB });
  if (kind === "success") late.resolve({ ...source, requestId: "A" });
  else late.reject(new Error("late failure"));
  await old;
  expect(activated).toHaveBeenCalledOnce(); expect(activated).toHaveBeenCalledWith(expect.objectContaining({ requestId: "B" }), mode);
  expect(expectedB).toHaveBeenCalledOnce(); expect(feedbackB).not.toHaveBeenCalled(); expect(oldFeedback).not.toHaveBeenCalled(); expect(oldExpected).not.toHaveBeenCalled();
});

it("leaves the large detail request outside the viewer-source deadline", async () => {
  vi.useFakeTimers(); const late = deferred<Response>(); let settled = false;
  const pending = createReviewHistoryApi(() => late.promise).detail("A").then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(deadline * 2); expect(settled).toBe(false); expect(vi.getTimerCount()).toBe(0);
  late.resolve(Response.json(detail("A"))); await pending;
});
