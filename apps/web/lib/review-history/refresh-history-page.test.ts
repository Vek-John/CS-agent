import { expect, it, vi } from "vitest";
import { refreshHistoryPage } from "./refresh-history-page";

it.each([true, false])("preserves a save warning during background history refresh (success: %s)", async success => {
  let warning: string | undefined = "复盘保存未确认";
  const accept = vi.fn(); const loading = vi.fn();
  await refreshHistoryPage({ load: async () => { if (!success) throw new Error("list failed"); return { items: [] }; },
    accept, isCurrent: () => true, ownsRequest: () => true, clearError: false, setLoading: loading,
    setError: update => { warning = update(warning); },
  });
  expect(warning).toBe("复盘保存未确认"); expect(accept).toHaveBeenCalledTimes(success ? 1 : 0);
  expect(loading.mock.calls).toEqual([[true], [false]]);
});

it.each(["route", "request"])("does not publish late success or failure after its %s changes", async change => {
  for (const success of [true, false]) {
    let resolve!: (page: { items: [] }) => void; let reject!: (error: Error) => void;
    const load = new Promise<{ items: [] }>((yes, no) => { resolve = yes; reject = no; });
    let current = true; let owned = true;
    const accept = vi.fn(); const setError = vi.fn(); const setLoading = vi.fn();
    const pending = refreshHistoryPage({ load: () => load, accept, setError, setLoading,
      isCurrent: () => current, ownsRequest: () => owned, clearError: true });
    if (change === "route") current = false; else owned = false;
    if (success) resolve({ items: [] }); else reject(new Error("late failure"));
    await pending;
    expect(accept).not.toHaveBeenCalled(); expect(setError).not.toHaveBeenCalled();
    expect(setLoading.mock.calls).toEqual(change === "route" ? [[true], [false]] : [[true]]);
  }
});

it("keeps normal user-requested refresh error and success feedback", async () => {
  let error: string | undefined;
  const input = { accept: vi.fn(), isCurrent: () => true, ownsRequest: () => true, clearError: true,
    setLoading: vi.fn(), setError: (update: (previous: string | undefined) => string | undefined) => { error = update(error); } };
  await refreshHistoryPage({ ...input, load: async () => { throw new Error("failure"); } });
  expect(error).toBe("无法读取本地复盘历史。");
  await refreshHistoryPage({ ...input, load: async () => ({ items: [] }) });
  expect(error).toBeUndefined(); expect(input.accept).toHaveBeenCalledOnce();
});
