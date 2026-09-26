import { describe, expect, it, vi } from "vitest";
import { HistoryPersistenceController } from "./history-persistence-controller";
const revisionInput = {
  routeId: "route-1",
  routeHash: "hash-1",
  analysisVersion: "cs2d-analysis-adapter/1.4.0",
  graphVersion: "coach-agent-graph.v3",
  promptVersion: "prompt.v1",
  modelMetadata: {},
};
describe("HistoryPersistenceController", () => {
  it("uses one revision-scoped idempotency key and only commits stable heads", async () => {
    const deps = { createReview: vi.fn().mockResolvedValue({ reviewId: "review-1" }), startRevision: vi.fn().mockResolvedValue({ revisionId: "revision-1" }), appendArtifact: vi.fn().mockResolvedValue(undefined), commitRuntimeHead: vi.fn().mockResolvedValue({ recoveryArtifactId: "artifact-1" }), markFailed: vi.fn().mockResolvedValue(undefined) };
    const controller = new HistoryPersistenceController(deps);
    await controller.createForPlayer({ demoId: "demo-1", selectedPlayerId: "p1", selectedPlayerName: "P1", title: "Mirage" }); await controller.beginRevision(revisionInput);
    await controller.artifact("REVIEW_PLAN", "route-1", { plan: 1 }, "review-plan.v1");
    await controller.stableHead({ recoveryArtifactKey: "recovery-a", recoveryBoundary: "ROUTE_START", sessionId: "s", runId: "r", demoId: "analysis-artifact-id" });
    expect(deps.appendArtifact).toHaveBeenCalledWith("review-1", expect.objectContaining({ revisionId: "revision-1", artifactRevision: 1, idempotencyKey: "revision-1:REVIEW_PLAN:route-1:v1" }));
    expect(deps.startRevision).toHaveBeenCalledWith("review-1", expect.objectContaining({ mode: "SELECT_PLAYER" }));
    expect(deps.commitRuntimeHead).toHaveBeenCalledWith("review-1", expect.objectContaining({ reviewRevisionId: "revision-1", recoveryBoundary: "ROUTE_START", demoId: "demo-1" }));
  });
  it("does not allow an old async create to become the current review", async () => {
    let resolve!: (value: { reviewId: string }) => void; const created = new Promise<{ reviewId: string }>((done) => { resolve = done; });
    const deps = { createReview: vi.fn().mockReturnValue(created), startRevision: vi.fn().mockResolvedValue({ revisionId: "revision" }), appendArtifact: vi.fn(), commitRuntimeHead: vi.fn(), markFailed: vi.fn() };
    const controller = new HistoryPersistenceController(deps); const pending = controller.createForPlayer({ demoId: "d", selectedPlayerId: "p", selectedPlayerName: "p", title: "t" }); controller.reset(); resolve({ reviewId: "old" });
    await expect(pending).rejects.toThrow("STALE_HISTORY_GENERATION"); expect(controller.reviewId).toBeUndefined(); expect(deps.startRevision).not.toHaveBeenCalled();
  });
  it("does not send an artifact after reset while its revision promise is pending", async () => {
    let resolveRevision!: (value: { revisionId: string }) => void;
    const revision = new Promise<{ revisionId: string }>((done) => { resolveRevision = done; });
    const deps = { createReview: vi.fn().mockResolvedValue({ reviewId: "review-old" }), startRevision: vi.fn().mockReturnValue(revision), appendArtifact: vi.fn().mockResolvedValue(undefined), commitRuntimeHead: vi.fn(), markFailed: vi.fn() };
    const controller = new HistoryPersistenceController(deps);
    await controller.createForPlayer({ demoId: "d", selectedPlayerId: "p", selectedPlayerName: "p", title: "t" });
    const begin = controller.beginRevision({ ...revisionInput, routeId: "route", routeHash: "hash" });
    const write = controller.artifact("REVIEW_PLAN", "route", {}, "review-plan.v1");
    controller.reset(); resolveRevision({ revisionId: "revision-old" });
    await expect(begin).rejects.toThrow("STALE_HISTORY_GENERATION");
    await expect(write).rejects.toThrow("STALE_HISTORY_GENERATION");
    expect(deps.appendArtifact).not.toHaveBeenCalled();
  });
  it("shares a revision promise with durability artifacts while Review creation is delayed", async () => {
    let resolveReview!: (value: { reviewId: string }) => void;
    const review = new Promise<{ reviewId: string }>((done) => { resolveReview = done; });
    const deps = { createReview: vi.fn().mockReturnValue(review), startRevision: vi.fn().mockResolvedValue({ revisionId: "revision-1" }), appendArtifact: vi.fn().mockResolvedValue(undefined), commitRuntimeHead: vi.fn(), markFailed: vi.fn() };
    const controller = new HistoryPersistenceController(deps);
    void controller.createForPlayer({ demoId: "d", selectedPlayerId: "p", selectedPlayerName: "p", title: "t" });
    const begin = controller.beginRevision({ ...revisionInput, routeId: "route", routeHash: "hash" });
    const artifact = controller.artifact("REVIEW_PLAN", "route", { route: true }, "review-plan.v1");
    resolveReview({ reviewId: "review-1" });
    await begin; await artifact;
    expect(deps.startRevision).toHaveBeenCalledTimes(1);
    expect(deps.appendArtifact).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function headFixture() {
  const deps = { createReview: vi.fn(), startRevision: vi.fn(), appendArtifact: vi.fn(), markFailed: vi.fn(),
    commitRuntimeHead: vi.fn<(review: string, input: Record<string, unknown>) => Promise<{ recoveryArtifactId: string }>>() };
  const controller = new HistoryPersistenceController(deps);
  controller.adopt("review-a", "revision-a", "demo-a", "REANALYZE", { recoveryArtifactId: "head-0" });
  return { deps, controller };
}

it("serializes head commits using the preceding confirmed ID and captures queued payloads", async () => {
  const { deps, controller } = headFixture();
  const firstAck = deferred<{ recoveryArtifactId: string }>();
  deps.commitRuntimeHead.mockReturnValueOnce(firstAck.promise).mockResolvedValueOnce({ recoveryArtifactId: "head-2" });
  const first = controller.stableHead({ checkpointId: "c1", expectedRecoveryArtifactId: "caller-cannot-override" });
  const input = { checkpointId: "c2", stableProgress: { consumed: ["cue-a"] } };
  const second = controller.stableHead(input);
  input.stableProgress.consumed.push("mutated-after-queue");
  await Promise.resolve();
  expect(deps.commitRuntimeHead).toHaveBeenCalledOnce();
  expect(deps.commitRuntimeHead.mock.calls[0][1].expectedRecoveryArtifactId).toBe("head-0");
  firstAck.resolve({ recoveryArtifactId: "head-1" });
  await first; await second;
  expect(deps.commitRuntimeHead.mock.calls[1][1]).toMatchObject({ expectedRecoveryArtifactId: "head-1", checkpointId: "c2", stableProgress: { consumed: ["cue-a"] } });
});

it.each([new Error("CHECKPOINT_SAVE_TIMEOUT"), new Error("RUNTIME_HEAD_CONFLICT")])("keeps the observed token after failure without retry or rebasing: %s", async error => {
  const { deps, controller } = headFixture();
  deps.commitRuntimeHead.mockRejectedValueOnce(error).mockResolvedValueOnce({ recoveryArtifactId: "head-2" });
  await expect(controller.stableHead({ checkpointId: "c1" })).rejects.toBe(error);
  expect(deps.commitRuntimeHead).toHaveBeenCalledOnce();
  await controller.stableHead({ checkpointId: "c2" });
  expect(deps.commitRuntimeHead.mock.calls.map(([, input]) => input.expectedRecoveryArtifactId)).toEqual(["head-0", "head-0"]);
});

it("invalidates queued old writes and ignores their acknowledgements after adoption", async () => {
  const { deps, controller } = headFixture();
  const gate = deferred<{ recoveryArtifactId: string }>();
  deps.commitRuntimeHead.mockReturnValueOnce(gate.promise).mockResolvedValue({ recoveryArtifactId: "head-b-new" });
  const first = controller.stableHead({ checkpointId: "c1" }).catch(error => error.message);
  const queued = controller.stableHead({ checkpointId: "c2" }).catch(error => error.message);
  await Promise.resolve();
  controller.adopt("review-b", "revision-b", "demo-b", "REANALYZE", { recoveryArtifactId: "head-b" });
  await controller.stableHead({ checkpointId: "b-new" });
  gate.resolve({ recoveryArtifactId: "late-head-a" });
  expect(await first).toBe("STALE_HISTORY_GENERATION");
  expect(await queued).toBe("STALE_HISTORY_GENERATION");
  await controller.stableHead({ checkpointId: "b-next" });
  expect(deps.commitRuntimeHead.mock.calls.map(([review, input]) => [review, input.expectedRecoveryArtifactId]))
    .toEqual([["review-a", "head-0"], ["review-b", "head-b"], ["review-b", "head-b-new"]]);
});

it("carries the observed old head into a new analysis Revision and rejects malformed stored heads", async () => {
  const { deps, controller } = headFixture();
  controller.adopt("review-a", undefined, "demo-a", "REANALYZE", { recoveryArtifactId: "head-previous-revision" });
  deps.startRevision.mockResolvedValue({ revisionId: "revision-new" });
  deps.commitRuntimeHead.mockResolvedValue({ recoveryArtifactId: "head-new" });
  await controller.beginRevision(revisionInput);
  await controller.stableHead({ checkpointId: "new" });
  expect(deps.commitRuntimeHead).toHaveBeenCalledWith("review-a", expect.objectContaining({
    reviewRevisionId: "revision-new", expectedRecoveryArtifactId: "head-previous-revision",
  }));
  expect(() => controller.adopt("review-b", "revision-b", "demo-b", "REANALYZE", {})).toThrow("INVALID_RUNTIME_HEAD_ACK");
  expect(controller.reviewId).toBe("review-a");
});

it("permits a legacy stored head without an artifact binding to start reanalysis, but never accepts it as a new acknowledgement", async () => {
  const { deps, controller } = headFixture();
  const legacy = { reviewId: "review-a", reviewRevisionId: "revision-old", demoId: "demo-a", sessionId: "session-old", runId: "run-old" };
  controller.adopt("review-a", undefined, "demo-a", "REANALYZE", legacy);
  deps.startRevision.mockResolvedValue({ revisionId: "revision-new" });
  deps.commitRuntimeHead.mockResolvedValueOnce(legacy as never).mockResolvedValueOnce({ recoveryArtifactId: "head-new" });
  await controller.beginRevision(revisionInput);
  await expect(controller.stableHead({ checkpointId: "new" })).rejects.toThrow("INVALID_RUNTIME_HEAD_ACK");
  await controller.stableHead({ checkpointId: "new" });
  expect(deps.commitRuntimeHead.mock.calls.map(([, input]) => input.expectedRecoveryArtifactId)).toEqual([null, null]);
  expect(() => controller.adopt("review-b", undefined, "demo-a", "REANALYZE", legacy)).toThrow("INVALID_RUNTIME_HEAD_ACK");
});
