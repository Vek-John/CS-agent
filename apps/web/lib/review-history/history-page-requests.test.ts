import { expect, it, vi } from "vitest";
import type { ReviewHistoryItem } from "../../components/history/review-history-sidebar";
import { HistoryPageRequests, type HistoryPageRequest } from "./history-page-requests";
import { refreshHistoryPage } from "./refresh-history-page";

type Page = { items: ReviewHistoryItem[]; nextCursor?: string };
function page(id: string, nextCursor?: string): Page {
  return { items: [{ id, demoId: "demo", title: id, playerName: "Player", originalFilename: "fixture.dem", updatedAt: "now", createdAt: "then",
    status: "IN_PROGRESS", progress: 0, demoStatus: "READY", completedCueCount: 0, totalCueCount: 1 }], nextCursor };
}
function deferred() { let resolve!: (page: Page) => void; let reject!: (error: Error) => void;
  const promise = new Promise<Page>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function fixture() {
  const owner = new HistoryPageRequests(); let items: string[] = []; let cursor: string | undefined; let loading = false; let error: string | undefined;
  const accepted = vi.fn();
  const run = (request: HistoryPageRequest, source: Promise<Page>, append = false) => refreshHistoryPage({
    load: () => source, isCurrent: () => true, ownsRequest: request.owns, clearError: !append,
    failureMessage: append ? "无法加载更多复盘。" : undefined,
    accept: value => { accepted(value); request.acceptCursor(value.nextCursor); cursor = value.nextCursor;
      items = append ? [...items, ...value.items.map(item => item.id)] : value.items.map(item => item.id); },
    setLoading: value => { if (!value) request.finish(); loading = value; },
    setError: update => { error = update(error); },
  });
  return { owner, run, accepted, state: () => ({ items, cursor, loading, error }) };
}

it.each([true, false])("drops old pagination success/error while the new query is loading (success: %s)", async success => {
  const f = fixture(); await f.run(f.owner.refresh("")!, Promise.resolve(page("old-first", "old-cursor")));
  const old = deferred(); const pending = f.run(f.owner.more("", "old-cursor")!, old.promise, true);
  expect(f.owner.changeSearch("mirage")).toBe(true);
  // The search callback invalidates ownership before React's new-query effect runs.
  expect(f.owner.refresh("")).toBeUndefined(); expect(f.owner.more("mirage", "old-cursor")).toBeUndefined();
  const next = deferred(); const current = f.run(f.owner.refresh("mirage")!, next.promise);
  if (success) old.resolve(page("wrong-query-row", "wrong-cursor")); else old.reject(new Error("old failure"));
  await pending;
  expect(f.state()).toMatchObject({ items: ["old-first"], loading: true, error: undefined });
  next.resolve(page("new-first", "new-cursor")); await current;
  expect(f.state()).toEqual({ items: ["new-first"], cursor: "new-cursor", loading: false, error: undefined });
  expect(f.accepted).toHaveBeenCalledTimes(2);
});

it("prevents a stale page from appending after a newer same-query refresh has completed", async () => {
  const f = fixture(); await f.run(f.owner.refresh("")!, Promise.resolve(page("before", "cursor-a")));
  const old = deferred(); const pending = f.run(f.owner.more("", "cursor-a")!, old.promise, true);
  await f.run(f.owner.refresh("")!, Promise.resolve(page("refreshed", "cursor-b")));
  old.resolve(page("stale-append", "cursor-stale")); await pending;
  expect(f.state()).toEqual({ items: ["refreshed"], cursor: "cursor-b", loading: false, error: undefined });
  expect(f.owner.more("", "cursor-a")).toBeUndefined();
});

it("blocks same-render double clicks and consumed cursors while allowing the next current page", async () => {
  const f = fixture(); await f.run(f.owner.refresh("")!, Promise.resolve(page("one", "cursor-1")));
  const request = f.owner.more("", "cursor-1")!;
  expect(f.owner.more("", "cursor-1")).toBeUndefined();
  await f.run(request, Promise.resolve(page("two", "cursor-2")), true);
  expect(f.owner.more("", "cursor-1")).toBeUndefined();
  await f.run(f.owner.more("", "cursor-2")!, Promise.resolve(page("three")), true);
  expect(f.state().items).toEqual(["one", "two", "three"]);
  expect(f.owner.more("", undefined)).toBeUndefined(); expect(f.owner.more("", "cursor-2")).toBeUndefined();
});

it("releases a current failed page for an explicit retry without losing its cursor", async () => {
  const f = fixture(); await f.run(f.owner.refresh("")!, Promise.resolve(page("one", "cursor-1")));
  await f.run(f.owner.more("", "cursor-1")!, Promise.reject(new Error("timeout")), true);
  expect(f.state()).toEqual({ items: ["one"], cursor: "cursor-1", loading: false, error: "无法加载更多复盘。" });
  expect(f.owner.changeSearch("")).toBe(false);
  expect(f.owner.more("", "cursor-1")).toBeDefined();
});
