import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewHistoryApi, HISTORY_DETAIL_TIMEOUT_MS, ReviewHistoryDetailReadError } from "./api";
import { HistoryRestoreController, HistoryRestoreError, type ReviewHistoryDetail } from "./history-restore-controller";
import { historyOpenFailureFeedback } from "./history-open-feedback";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function detail(id = "review"): ReviewHistoryDetail {
  return { review: { id, demoId: "synthetic-demo", title: "Saved", status: "READY", selectedPlayerId: "synthetic-player" }, revision: null, artifacts: [], runtimeHead: null };
}
// Execute the small actual Host catch body with state setters, not a second ownership implementation.
// This verifies its real feedback wiring without claiming React mounting or GUI coverage.
const host = readFileSync(new URL("../../components/playback/cs2d-playback-host.tsx", import.meta.url), "utf8");
const openSection = host.slice(host.indexOf("const openHistoryReview ="), host.indexOf("const reanalyzeHistoryReview ="));
const catchStart = openSection.lastIndexOf("} catch (error) {") + "} catch (error) {".length;
const catchEnd = openSection.lastIndexOf("\n    }");
const actualHostCatch = new Function("error", "historyOpenEpochRef", "openEpoch", "setReviewPreparationStatus", "setHistoryError", "HistoryRestoreError", "historyOpenFailureFeedback", openSection.slice(catchStart, catchEnd));
function publish(error: unknown, current = 1, captured = 1) {
  const preparation = vi.fn(), message = vi.fn();
  actualHostCatch(error, { current }, captured, preparation, message, HistoryRestoreError, historyOpenFailureFeedback);
  return { preparation, message };
}
function controller(api: ReturnType<typeof createReviewHistoryApi>) {
  const viewer = vi.fn();
  return { value: new HistoryRestoreController({ loadDetail: api.detail, requestViewerSource: vi.fn(async () => { throw Error("NO_VIEWER_SOURCE_EXPECTED"); }), loadManagedDemo: viewer }), viewer };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(["headers", "body"])("settles detail %s waits within its conservative budget and exposes retry reading through actual Host catch", async phase => {
  vi.useFakeTimers(); const headers = deferred<Response>(), body = deferred<unknown>();
  const fetcher = vi.fn(async () => phase === "headers" ? headers.promise : Object.assign(new Response(), { json: () => body.promise }));
  const c = controller(createReviewHistoryApi(fetcher)); let settled = false;
  const pending = c.value.open("review").catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(HISTORY_DETAIL_TIMEOUT_MS - 1); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1); const error = await pending;
  expect(error).toBeInstanceOf(ReviewHistoryDetailReadError); expect(error.code).toBe("HISTORY_DETAIL_TIMEOUT");
  const feedback = publish(error);
  expect(feedback.preparation).toHaveBeenCalledWith({ phase: "ERROR", detail: "读取已保存的复盘超时。" });
  expect(feedback.message.mock.calls[0][0]).toContain("重试读取"); expect(feedback.message.mock.calls[0][0]).not.toContain("重新分析");
  expect(fetcher).toHaveBeenCalledOnce(); expect(c.viewer).not.toHaveBeenCalled();
  headers.resolve(Response.json(detail())); body.resolve(detail()); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0); c.value.cancel();
});
it("uses one total deadline, skips late header body reading and removes the parent listener", async () => {
  vi.useFakeTimers(); const headers = deferred<Response>(), parent = new AbortController();
  const add = vi.spyOn(parent.signal, "addEventListener"), remove = vi.spyOn(parent.signal, "removeEventListener");
  let signal: AbortSignal | undefined;
  const pending = createReviewHistoryApi((_url, init) => { signal = init?.signal as AbortSignal; return headers.promise; }).detail("review", parent.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(HISTORY_DETAIL_TIMEOUT_MS);
  expect((await pending).code).toBe("HISTORY_DETAIL_TIMEOUT"); expect(signal?.aborted).toBe(true);
  const json = vi.fn().mockResolvedValue(detail()); headers.resolve(Object.assign(new Response(), { json }));
  await vi.advanceTimersByTimeAsync(0); expect(json).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]); expect(vi.getTimerCount()).toBe(0);
});
it("does not restart the budget for body or publish a late body rejection", async () => {
  vi.useFakeTimers(); const headers = deferred<Response>(), body = deferred<unknown>();
  const pending = createReviewHistoryApi(() => headers.promise).detail("review").catch(error => error);
  await vi.advanceTimersByTimeAsync(HISTORY_DETAIL_TIMEOUT_MS - 5);
  headers.resolve(Object.assign(new Response(), { json: () => body.promise }));
  await vi.advanceTimersByTimeAsync(5); expect((await pending).code).toBe("HISTORY_DETAIL_TIMEOUT");
  body.reject(Error("late body")); await vi.advanceTimersByTimeAsync(0);
  expect((await pending).code).toBe("HISTORY_DETAIL_TIMEOUT"); expect(vi.getTimerCount()).toBe(0);
});
it.each(["before", "headers", "body"])("settles owned parent cancellation at %s without transport cooperation", async phase => {
  vi.useFakeTimers(); const headers = deferred<Response>(), body = deferred<unknown>(), parent = new AbortController();
  if (phase === "before") parent.abort();
  const fetcher = vi.fn(async () => phase === "body" ? Object.assign(new Response(), { json: () => body.promise }) : headers.promise);
  const pending = createReviewHistoryApi(fetcher).detail("review", parent.signal).catch(error => error);
  await vi.advanceTimersByTimeAsync(0); parent.abort(); expect(await pending).toMatchObject({ name: "AbortError" });
  if (phase === "before") expect(fetcher).not.toHaveBeenCalled();
  headers.resolve(Response.json(detail())); body.resolve(detail()); await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
});
it.each(["network", "transport-abort", "http", "invalid-json"])("reports %s as reading failure, not invalid saved artifacts", async kind => {
  vi.useFakeTimers(); const fetcher = vi.fn(async () => {
    if (kind === "network") throw new TypeError("fetch failed");
    if (kind === "transport-abort") throw new DOMException("transport stopped", "AbortError");
    return kind === "http" ? Response.json({ code: "REVIEW_TEMPORARILY_UNAVAILABLE" }, { status: 503 }) : new Response("{broken");
  });
  const c = controller(createReviewHistoryApi(fetcher)); const error = await c.value.open("review").catch(error => error);
  expect(error).toBeInstanceOf(ReviewHistoryDetailReadError);
  expect(error.code).toBe(kind === "http" ? "REVIEW_TEMPORARILY_UNAVAILABLE" : kind === "invalid-json" ? "HISTORY_DETAIL_INVALID_JSON" : "HISTORY_DETAIL_READ_FAILED");
  const feedback = publish(error); expect(feedback.preparation.mock.calls[0][0].detail).toContain("读取");
  expect(feedback.message.mock.calls[0][0]).not.toMatch(/校验|重新分析/); expect(fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0); c.value.cancel();
});
it("preserves a large successful detail and supports explicit reopening after a failed read", async () => {
  vi.useFakeTimers(); const saved = { ...detail(), artifacts: [{ kind: "NARRATION_BUNDLE" as const, key: "cue", payload: { cueId: "cue", text: "合成".repeat(400_000) } }] };
  let attempt = 0; const fetcher = vi.fn(async () => { if (++attempt === 1) throw Error("read unavailable"); return Response.json(saved); });
  const c = controller(createReviewHistoryApi(fetcher)); expect(await c.value.open("review").catch(error => error)).toBeInstanceOf(ReviewHistoryDetailReadError);
  const result = await c.value.open("review"); expect(result.detail).toEqual(saved); expect(fetcher).toHaveBeenCalledTimes(2);
  expect(c.viewer).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); c.value.cancel();
});
it.each([null, [], 7, { artifacts: [] }])("rejects invalid detail %j without claiming its artifacts failed validation", async payload => {
  const c = controller(createReviewHistoryApi(async () => Response.json(payload)));
  const error = await c.value.open("review").catch(error => error);
  expect(error).toBeInstanceOf(HistoryRestoreError); expect(error.code).toBe("INVALID_DETAIL");
  const feedback = publish(error);
  expect(feedback.preparation.mock.calls[0][0].detail).toContain("详情格式无效");
  expect(feedback.message.mock.calls[0][0]).not.toContain("重新分析");
  const artifactFeedback = publish(Error("artifact identity mismatch"));
  expect(artifactFeedback.preparation.mock.calls[0][0].detail).toContain("身份或版本校验");
  expect(artifactFeedback.message.mock.calls[0][0]).toContain("重新分析");
  c.value.cancel();
});
it.each(["headers", "body"])("cancels old %s when B opens and prevents its late result from touching B", async phase => {
  vi.useFakeTimers(); const headers = deferred<Response>(), body = deferred<unknown>();
  const api = createReviewHistoryApi(async url => String(url).endsWith("/A") ? phase === "headers" ? headers.promise : Object.assign(new Response(), { json: () => body.promise }) : Response.json(detail("B")));
  const c = controller(api); const old = c.value.open("A").catch(error => error);
  await vi.advanceTimersByTimeAsync(0); const current = await c.value.open("B"); expect(current.detail.review.id).toBe("B");
  const error = await old; expect(error).toMatchObject({ code: "STALE_REQUEST" });
  expect(publish(error, 2, 1).message).not.toHaveBeenCalled();
  headers.resolve(Response.json(detail("A"))); body.resolve(detail("A")); await vi.advanceTimersByTimeAsync(HISTORY_DETAIL_TIMEOUT_MS);
  expect(current.detail.review.id).toBe("B"); expect(vi.getTimerCount()).toBe(0); c.value.cancel();
});
it("normalizes a noncooperating late Controller failure and keeps Host-only epoch invalidation quiet", async () => {
  const late = deferred<ReviewHistoryDetail>();
  const c = new HistoryRestoreController({ loadDetail: () => late.promise, requestViewerSource: vi.fn(), loadManagedDemo: vi.fn() });
  const pending = c.open("A").catch(error => error); c.cancel(); late.reject(Error("late transport failure"));
  const stale = await pending; expect(stale).toMatchObject({ code: "STALE_REQUEST" });
  expect(publish(stale).message).not.toHaveBeenCalled();
  expect(publish(new ReviewHistoryDetailReadError("HISTORY_DETAIL_READ_FAILED"), 2, 1).message).not.toHaveBeenCalled();
});
