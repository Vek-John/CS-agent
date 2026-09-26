import { afterEach, expect, it, vi } from "vitest";
import { createReviewHistoryApi } from "./api";
import { refreshHistoryPage } from "./refresh-history-page";
import { settlePreparedCoachingStart } from "../coaching/cs2d-route-integration";

const deadline = 20_000;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each(["list", "status"])("bounds %s fetch and body even when transport ignores abort", async kind => {
  for (const stage of ["fetch", "body"]) {
    vi.useFakeTimers(); const gate = deferred<unknown>();
    const json = vi.fn(() => gate.promise);
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => stage === "fetch" ? gate.promise as Promise<Response>
      : Promise.resolve(Object.assign(new Response(), { json })));
    const api = createReviewHistoryApi(fetcher as typeof fetch);
    let outcome = "pending";
    const pending = (kind === "list" ? api.list() : api.markFailed("review-a"))
      .then(() => { outcome = "success"; }, error => { outcome = error.code; });
    await vi.advanceTimersByTimeAsync(deadline - 1); expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1); expect(outcome).toBe("HISTORY_REQUEST_TIMEOUT"); await pending;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    gate.resolve(stage === "fetch" ? Object.assign(new Response(), { json }) : { items: [], nextCursor: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("HISTORY_REQUEST_TIMEOUT"); expect(fetcher).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledTimes(stage === "fetch" ? 0 : 1); expect(vi.getTimerCount()).toBe(0);
  }
});

it("finishes background status and refresh waiting without blocking activation or erasing the save warning", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => undefined));
  const api = createReviewHistoryApi(fetcher as typeof fetch);
  let warning: string | undefined = "复盘保存未确认"; let loading = false;
  const accept = vi.fn(); const activate = vi.fn(async () => true); const refreshDone = vi.fn();
  expect(await settlePreparedCoachingStart({ durability: Promise.reject(new Error("save unknown")), isCurrent: () => true,
    saved: vi.fn(), unconfirmed: vi.fn(), activate, markFailed: () => api.markFailed("review-a"),
    refreshHistory: () => refreshHistoryPage({ load: () => api.list(), accept, isCurrent: () => true, ownsRequest: () => true,
      clearError: false, setLoading: value => { loading = value; }, setError: update => { warning = update(warning); },
    }).then(refreshDone),
  })).toBe(true);
  expect(activate).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(deadline);
  expect(fetcher).toHaveBeenCalledTimes(2); expect(loading).toBe(true);
  await vi.advanceTimersByTimeAsync(deadline);
  expect(loading).toBe(false); expect(refreshDone).toHaveBeenCalledOnce(); expect(warning).toBe("复盘保存未确认");
  expect(accept).not.toHaveBeenCalled(); expect(activate).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["PATCH", "GET"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves query parameters and the existing summary projection", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ items: [{
    reviewId: "review-a", demoId: "demo-a", title: "Mirage", selectedPlayerName: "Player", originalFilename: "match.dem",
    lastOpenedAt: "now", createdAt: "earlier", status: "IN_PROGRESS", totalCueCount: 4, completedCueCount: 2, demoStatus: "READY",
  }], nextCursor: "next" }));
  const page = await createReviewHistoryApi(fetcher as typeof fetch).list("mirage 中文", "cursor+1");
  const url = new URL(fetcher.mock.calls[0][0], "http://localhost");
  expect(url.searchParams.get("search")).toBe("mirage 中文"); expect(url.searchParams.get("cursor")).toBe("cursor+1");
  expect(page).toMatchObject({ items: [{ id: "review-a", playerName: "Player", progress: 50, completedCueCount: 2, totalCueCount: 4 }], nextCursor: "next" });
  expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it.each(["list", "status"])("preserves %s server error codes without retry", async kind => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json({ code: "DESKTOP_ONLY" }, { status: 403 }));
  const api = createReviewHistoryApi(fetcher);
  await expect(kind === "list" ? api.list() : api.markFailed("review-a")).rejects.toMatchObject({ code: "DESKTOP_ONLY" });
  expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("keeps the status mutation's void acknowledgement and exact request", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{bad"));
  await expect(createReviewHistoryApi(fetcher as typeof fetch).markFailed("review-a")).resolves.toBeUndefined();
  expect(fetcher.mock.calls[0][0]).toBe("/api/review-history/review-a");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "PATCH", body: '{"status":"FAILED"}', cache: "no-store" });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not apply the summary deadline to full history detail", async () => {
  vi.useFakeTimers(); const gate = deferred<Response>();
  const fetcher = vi.fn((_url: string, _init?: RequestInit) => gate.promise);
  let finished = false;
  const pending = createReviewHistoryApi(fetcher as typeof fetch).detail("review-a").then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(deadline * 2);
  expect(finished).toBe(false); expect(fetcher.mock.calls[0][1]?.signal).toBeUndefined();
  gate.resolve(Response.json({})); await pending; expect(finished).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
