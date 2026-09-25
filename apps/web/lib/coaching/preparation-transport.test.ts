import { afterEach, describe, expect, it, vi } from "vitest";
import { PREPARATION_REQUEST_TIMEOUT_MS as deadline, requestPreparationJson } from "./preparation-transport";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("preparation fetch and body lifetime", () => {
  it("shares one deadline across headers and body, releases resources, and ignores a late body", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, "addEventListener");
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const headers = deferred<Response>(); const body = deferred<unknown>();
    let child: AbortSignal | undefined;
    const fetcher = vi.fn((_url, init) => { child = init?.signal as AbortSignal; return headers.promise; });
    const observed = requestPreparationJson(fetcher, "/local", {}, parent.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    headers.resolve({ ok: true, status: 200, json: () => body.promise } as Response);
    await vi.advanceTimersByTimeAsync(1);
    expect(await observed).toMatchObject({ message: "LOCAL_REQUEST_TIMEOUT" });
    expect(child?.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    body.reject(new Error("late body rejection"));
    await vi.advanceTimersByTimeAsync(0); // Vitest also fails on unhandled rejection.
    expect(await observed).toMatchObject({ message: "LOCAL_REQUEST_TIMEOUT" });
  });

  it.each(["fetch", "body"] as const)("parent cancellation exits a non-cooperative %s immediately", async stage => {
    vi.useFakeTimers();
    const parent = new AbortController(); const late = deferred<unknown>();
    const json = vi.fn(() => late.promise);
    let child: AbortSignal | undefined;
    const fetcher = vi.fn((_url, init) => {
      child = init?.signal as AbortSignal;
      return stage === "fetch" ? late.promise as Promise<Response> : Promise.resolve(Object.assign(new Response(), { json }));
    });
    const observed = requestPreparationJson(fetcher, "/local", {}, parent.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    parent.abort(new Error("user switched Demo"));
    expect(await observed).toMatchObject({ name: "AbortError" });
    expect(child?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    if (stage === "fetch") {
      late.resolve({ ok: true, status: 200, json });
      await vi.advanceTimersByTimeAsync(0);
      expect(json).not.toHaveBeenCalled();
    } else {
      late.resolve({ ignored: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(await observed).toMatchObject({ name: "AbortError" });
    }
  });

  it("starts no transport for an already cancelled parent", async () => {
    const parent = new AbortController(); parent.abort(); const fetcher = vi.fn();
    await expect(requestPreparationJson(fetcher, "/local", {}, parent.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["success", "http", "bad-body"] as const)("cleans deadline/listener on %s without changing response semantics", async mode => {
    vi.useFakeTimers();
    const parent = new AbortController(); const remove = vi.spyOn(parent.signal, "removeEventListener");
    const response = mode === "http" ? new Response("unread", { status: 503 }) : mode === "bad-body" ? new Response("{bad") : Response.json({ value: 1 });
    const json = vi.spyOn(response, "json");
    const result = await requestPreparationJson(async () => response, "/local", {}, parent.signal).catch(error => error);
    if (mode === "success") expect(result).toEqual({ ok: true, status: 200, payload: { value: 1 } });
    if (mode === "http") { expect(result).toEqual({ ok: false, status: 503 }); expect(json).not.toHaveBeenCalled(); }
    if (mode === "bad-body") expect(result).toBeInstanceOf(SyntaxError);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("keeps timeout distinct when abort-aware transport immediately rejects AbortError", async () => {
    vi.useFakeTimers();
    const pending = requestPreparationJson((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }), "/local", {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(deadline);
    expect(await pending).toMatchObject({ message: "LOCAL_REQUEST_TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
