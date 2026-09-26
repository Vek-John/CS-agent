import { afterEach, expect, it, vi } from "vitest";
import { createReviewHistoryApi, HISTORY_REQUEST_TIMEOUT_MS as deadline } from "./api";

const input = { requestId: "import-a", originalFilename: "synthetic.dem", byteSize: 1024 };
const capability = { requestId: input.requestId, capabilityToken: "a".repeat(43) };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each(["fetch", "body"])("ends import authorization waiting when %s hangs, without releasing a late token", async stage => {
  vi.useFakeTimers();
  const gate = deferred<unknown>(), lateJson = vi.fn(async () => capability);
  let signal: AbortSignal | undefined, settled = false;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    return stage === "fetch" ? await gate.promise as Response : Object.assign(new Response(), { json: () => gate.promise });
  });
  const success = vi.fn(), failure = vi.fn();
  const pending = createReviewHistoryApi(fetcher as typeof fetch).importCapability(input)
    .then(value => { success(value); }, error => { failure(error); }).then(() => { settled = true; });
  const release = () => gate.resolve(stage === "fetch" ? Object.assign(new Response(), { json: lateJson }) : capability);
  try {
    await vi.advanceTimersByTimeAsync(deadline - 1); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: "HISTORY_REQUEST_TIMEOUT" }));
    expect(signal?.aborted).toBe(true); expect(success).not.toHaveBeenCalled();
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(success).not.toHaveBeenCalled(); expect(lateJson).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  } finally { release(); await pending; }
});

it("keeps a later import request alive when the previous request reaches its deadline", async () => {
  vi.useFakeTimers();
  const a = deferred<Response>(), b = deferred<Response>(), signals: AbortSignal[] = [];
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    signals.push(init?.signal as AbortSignal);
    return signals.length === 1 ? a.promise : b.promise;
  });
  const api = createReviewHistoryApi(fetcher as typeof fetch);
  const first = api.importCapability(input).catch(error => error);
  await vi.advanceTimersByTimeAsync(1000);
  const nextInput = { ...input, requestId: "import-b" };
  const second = api.importCapability(nextInput);
  try {
    await vi.advanceTimersByTimeAsync(deadline - 1000);
    expect(signals[0]?.aborted).toBe(true); expect(signals[1]?.aborted).toBe(false);
    expect(await first).toMatchObject({ code: "HISTORY_REQUEST_TIMEOUT" });
    b.resolve(Response.json({ ...capability, requestId: nextInput.requestId }));
    expect(await second).toEqual({ ...capability, requestId: nextInput.requestId });
    a.resolve(Response.json(capability)); await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  } finally { a.resolve(Response.json(capability)); b.resolve(Response.json(capability)); await first; await second; }
});

it.each([200, 400, 500])("preserves metadata transport and HTTP %s response semantics", async status => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(status === 200 ? capability : { code: "CAPABILITY_FAILED" }, { status }));
  const result = createReviewHistoryApi(fetcher).importCapability(input);
  if (status === 200) await expect(result).resolves.toEqual(capability);
  else await expect(result).rejects.toMatchObject({ code: "CAPABILITY_FAILED" });
  expect(fetcher).toHaveBeenCalledWith("/api/review-history/import-capability", expect.objectContaining({
    method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
  expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
