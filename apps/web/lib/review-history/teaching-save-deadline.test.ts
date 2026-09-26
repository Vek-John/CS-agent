import { afterEach, expect, it, vi } from "vitest";
import { createReviewHistoryApi } from "./api";
import { HistoryPersistenceController } from "./history-persistence-controller";
import { persistTeachingBeforeRuntimeHead } from "../playback/cs2d-playback-host";

const types = ["USER_INTERACTION", "CUE_CASE", "DIAGNOSTIC_RESULT", "TRANSFER_RULE", "LEARNING_THREAD"] as const;
const deadline = 20_000;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each(types)("bounds %s fetch and JSON waiting without trusting late success", async artifactType => {
  for (const stage of ["fetch", "body"] as const) {
    vi.useFakeTimers();
    const gate = deferred<unknown>();
    const json = vi.fn(() => gate.promise);
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => stage === "fetch"
      ? gate.promise as Promise<Response>
      : Promise.resolve(Object.assign(new Response(), { json })));
    const api = createReviewHistoryApi(fetcher as typeof fetch);
    let outcome = "pending";
    const pending = api.appendArtifact("review-a", { revisionId: "revision-a", artifactType,
      artifactKey: "cue-a", schemaVersion: "fixture", payload: { retained: true }, idempotencyKey: "fixed" })
      .then(() => { outcome = "saved"; }, error => { outcome = error.code; });
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("TEACHING_SAVE_TIMEOUT");
    await pending;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    gate.resolve(stage === "fetch" ? Object.assign(new Response(), { json }) : { saved: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("TEACHING_SAVE_TIMEOUT");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledTimes(stage === "fetch" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  }
});

it("releases a partial teaching save without promoting its head or continuing after late success", async () => {
  vi.useFakeTimers();
  const body = deferred<unknown>();
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body));
    return input.artifactType === "DIAGNOSTIC_RESULT"
      ? Object.assign(new Response(), { json: () => body.promise }) : Response.json({ saved: true, recoveryArtifactId: "confirmed-artifact" });
  });
  const api = createReviewHistoryApi(fetcher as typeof fetch);
  const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(),
    appendArtifact: api.appendArtifact, commitRuntimeHead: api.commitRuntimeHead, markFailed: vi.fn() });
  history.adopt("review-a", "revision-a", "demo-a");
  const mirror = vi.fn();
  let busy = true;
  const pending = persistTeachingBeforeRuntimeHead({ interactionDurable: true, mirror,
    persistDiagnosis: async () => {
      try {
        for (const type of types.slice(1)) await history.artifact(type, "cue-a", { retained: true }, "fixture");
        return true;
      } catch { return false; } // Same failure contract as Host applyTeachingDiagnosis.
    },
  }).finally(() => { busy = false; });
  await vi.advanceTimersByTimeAsync(deadline);
  expect(busy).toBe(false);
  expect(await pending).toBe("ARTIFACTS_INCOMPLETE");
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).artifactType))
    .toEqual(["CUE_CASE", "DIAGNOSTIC_RESULT"]);
  expect(mirror).not.toHaveBeenCalled();
  body.resolve({ saved: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(mirror).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves successful teaching payloads, idempotency and artifact-before-head ordering", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ saved: true, recoveryArtifactId: "confirmed-artifact" }));
  const api = createReviewHistoryApi(fetcher as typeof fetch);
  const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(),
    appendArtifact: api.appendArtifact, commitRuntimeHead: api.commitRuntimeHead, markFailed: vi.fn() });
  history.adopt("review-a", "revision-a", "demo-a");
  const payload = { retained: "用户原文", revision: 1 };
  await history.artifact("USER_INTERACTION", "reflection-a", payload, "fixture");
  await expect(persistTeachingBeforeRuntimeHead({ interactionDurable: true,
    persistDiagnosis: async () => {
      for (const type of types.slice(1)) await history.artifact(type, "cue-a", payload, "fixture", 2);
      return true;
    }, mirror: () => history.stableHead({ checkpointId: "checkpoint-new" }),
  })).resolves.toBe("COMMITTED");
  expect(fetcher.mock.calls.slice(0, 5).map(([, init]) => JSON.parse(String(init?.body)).artifactType)).toEqual(types);
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({
    revisionId: "revision-a", artifactType: "CUE_CASE", artifactKey: "cue-a", artifactRevision: 2,
    payload, idempotencyKey: "revision-a:CUE_CASE:cue-a:v2",
  });
  expect(fetcher.mock.calls[5][0]).toBe("/api/review-history/review-a/runtime-head");
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves server errors and clears the teaching timer", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json({ code: "ARTIFACT_INVALID" }, { status: 400 }));
  await expect(createReviewHistoryApi(fetcher).appendArtifact("review-a", {
    revisionId: "revision-a", artifactType: "CUE_CASE", artifactKey: "cue-a", schemaVersion: "fixture",
    payload: {}, idempotencyKey: "fixed",
  })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not apply the per-cue deadline to large analysis artifacts", async () => {
  vi.useFakeTimers();
  const gate = deferred<Response>();
  const fetcher = vi.fn((_url: string, _init?: RequestInit) => gate.promise);
  let saved = false;
  const pending = createReviewHistoryApi(fetcher as typeof fetch).appendArtifact("review-a", {
    revisionId: "revision-a", artifactType: "ANALYSIS_BUNDLE", artifactKey: "analysis", schemaVersion: "fixture",
    payload: {}, idempotencyKey: "fixed",
  }).then(() => { saved = true; });
  await vi.advanceTimersByTimeAsync(deadline * 2);
  expect(saved).toBe(false);
  expect(fetcher.mock.calls[0][1]?.signal).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  gate.resolve(Response.json({ saved: true, recoveryArtifactId: "confirmed-artifact" }));
  await pending;
  expect(saved).toBe(true);
});
