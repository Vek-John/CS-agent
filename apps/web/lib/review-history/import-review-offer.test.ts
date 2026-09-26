import { expect, it, vi } from "vitest";
import { offerImportedReview } from "./import-review-offer";

const impact = { reviewCount: 1, reviews: [{ id: "existing", title: "旧复盘" }] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  let epoch = 0; let current = true;
  const input = { recovering: false, deduplicated: true, isCurrent: () => current,
    readSelectionEpoch: () => epoch, refresh: vi.fn(async (_isCurrent: () => boolean) => {}),
    loadExisting: vi.fn(async () => impact), confirmExisting: vi.fn(() => true),
    openReview: vi.fn(async (_id: string) => {}), onError: vi.fn() };
  return { input, select: () => { epoch++; }, replaceImport: () => { current = false; } };
}

it("does not look up or offer an old review after selection during list refresh", async () => {
  const h = setup(); const refresh = deferred<void>();
  h.input.refresh.mockImplementation(() => refresh.promise);
  const pending = offerImportedReview(h.input);
  h.select(); refresh.resolve(); await pending;
  expect(h.input.loadExisting).not.toHaveBeenCalled();
  expect(h.input.confirmExisting).not.toHaveBeenCalled();
  expect(h.input.openReview).not.toHaveBeenCalled();
  expect(h.input.refresh.mock.calls[0][0]()).toBe(false);
});

it.each(["success", "failure"])("ignores late lookup %s after the user selects a player", async result => {
  const h = setup(); const lookup = deferred<typeof impact>();
  h.input.loadExisting.mockImplementation(() => lookup.promise);
  const pending = offerImportedReview(h.input); await Promise.resolve();
  expect(h.input.loadExisting).toHaveBeenCalledOnce(); h.select();
  if (result === "success") lookup.resolve(impact); else lookup.reject(new Error("late failure"));
  await pending;
  expect(h.input.confirmExisting).not.toHaveBeenCalled();
  expect(h.input.openReview).not.toHaveBeenCalled(); expect(h.input.onError).not.toHaveBeenCalled();
});

it.each([true, false])("preserves the unselected user's explicit choice (%s)", async accept => {
  const h = setup(); h.input.confirmExisting.mockReturnValue(accept);
  await offerImportedReview(h.input);
  expect(h.input.confirmExisting).toHaveBeenCalledWith(impact);
  expect(h.input.openReview.mock.calls).toEqual(accept ? [["existing"]] : []);
});

it.each(["recovery", "new-demo", "empty"])("does not offer existing review for %s", async reason => {
  const h = setup();
  h.input.recovering = reason === "recovery"; h.input.deduplicated = reason !== "new-demo";
  if (reason === "empty") h.input.loadExisting.mockResolvedValue({ reviewCount: 0, reviews: [] });
  await offerImportedReview(h.input);
  expect(h.input.confirmExisting).not.toHaveBeenCalled(); expect(h.input.openReview).not.toHaveBeenCalled();
  expect(h.input.loadExisting).toHaveBeenCalledTimes(reason === "empty" ? 1 : 0);
});

it("reports current failure but suppresses failure belonging to a replaced import", async () => {
  const h = setup(); h.input.loadExisting.mockRejectedValue(new Error("current failure"));
  await offerImportedReview(h.input); expect(h.input.onError).toHaveBeenCalledOnce();
  const lookup = deferred<typeof impact>(); h.input.loadExisting.mockImplementation(() => lookup.promise);
  const pending = offerImportedReview(h.input); await Promise.resolve(); h.replaceImport();
  lookup.reject(new Error("old failure")); await pending;
  expect(h.input.onError).toHaveBeenCalledOnce();
});

it("checks ownership again after confirmation before opening", async () => {
  const h = setup(); h.input.confirmExisting.mockImplementation(() => { h.select(); return true; });
  await offerImportedReview(h.input); expect(h.input.openReview).not.toHaveBeenCalled();
});
