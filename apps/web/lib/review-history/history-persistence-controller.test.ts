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
    const deps = { createReview: vi.fn().mockResolvedValue({ reviewId: "review-1" }), startRevision: vi.fn().mockResolvedValue({ revisionId: "revision-1" }), appendArtifact: vi.fn().mockResolvedValue(undefined), commitRuntimeHead: vi.fn().mockResolvedValue(undefined), markFailed: vi.fn().mockResolvedValue(undefined) };
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
