import { describe, expect, it, vi } from "vitest";
import { HistoryRestoreController, restoreHistoryControlPlane, type ManagedDemoSource, type ReviewHistoryDetail } from "./history-restore-controller";

const detail: ReviewHistoryDetail = {
  review: { id: "review-1", demoId: "demo-1", title: "Mirage", status: "READY", selectedPlayerId: "p1" },
  revision: { id: "revision-1", status: "READY", artifactContractVersion: 2, routeId: "route-1", routeHash: "hash-1" },
  runtimeHead: {
    recoveryArtifactId: "artifact-recovery",
    recoveryArtifactKey: "recovery",
    recoveryArtifactRevision: 1,
    sessionId: "session-1",
    runId: "run-1",
    demoContentHash: "f".repeat(64),
    selectedPlayerId: "p1",
    routeId: "route-1",
    routeHash: "hash-1",
    recoveryBoundary: "ROUTE_START",
    defaultRouteCursor: 0,
    completedCueCount: 0,
    totalCueCount: 0,
  },
  artifacts: [
    { kind: "ANALYSIS_BUNDLE", key: "analysis", payload: { demo_id: "analysis-demo", review_plan: { id: "route-1" } } },
    { kind: "CANDIDATE_SET", key: "candidates", payload: { id: "candidate-set-1" } },
    { kind: "REVIEW_PLAN", key: "plan", payload: { id: "route-1" } },
    { kind: "NARRATION_BUNDLE", key: "cue-1", payload: { cueId: "cue-1", text: "already written" } },
    { kind: "CUE_CASE", key: "cue-1", payload: { cueId: "cue-1" } },
    { kind: "TOOL_RESULT", key: "call-1", payload: { callId: "call-1", status: "SUCCEEDED" } },
    { kind: "LEARNING_THREAD", key: "thread-1", payload: { threadId: "thread-1" } },
    { kind: "SESSION_SUMMARY", key: "summary", payload: { title: "summary" } },
    { id: "artifact-recovery", kind: "SESSION_RECOVERY", key: "recovery", revision: 1, payload: {
      sessionId: "session-1",
      runId: "run-1",
      demoContentHash: "f".repeat(64),
      selectedPlayerId: "p1",
      routeId: "route-1",
      routeHash: "hash-1",
      agentCheckpointId: null,
      frozenReviewPlan: { cues: [] },
      cueProgress: { completedCueIds: [] },
      boundary: { kind: "ROUTE_START", segmentIndex: 0 },
    } },
  ],
};

describe("HistoryRestoreController", () => {
  it("restores the persisted control plane before activating Viewer and exposes no generation dependency", async () => {
    const loadDetail = vi.fn().mockResolvedValue(detail);
    const requestViewerSource = vi.fn().mockResolvedValue({ requestId: "request-1", demoId: "demo-1", capabilityToken: "a".repeat(43), originalFilename: "match.dem", byteSize: 4, contentHash: "f".repeat(64) });
    const loadManagedDemo = vi.fn();
    const controller = new HistoryRestoreController({ loadDetail, requestViewerSource, loadManagedDemo });

    const restored = await controller.open("review-1");

    expect(restored.plan).toEqual({ id: "route-1" });
    expect(restored.analysis).toEqual({ demo_id: "analysis-demo", review_plan: { id: "route-1" } });
    expect(restored.candidateSet).toEqual({ id: "candidate-set-1" });
    expect(restored.narrationByCue).toEqual({ "cue-1": { cueId: "cue-1", text: "already written" } });
    expect(restored.cueCases).toEqual({ "cue-1": { cueId: "cue-1" } });
    expect(restored.toolResultsByCall).toEqual({ "call-1": { callId: "call-1", status: "SUCCEEDED" } });
    expect(restored.learningThreads).toEqual([{ threadId: "thread-1" }]);
    expect(restored.summary).toEqual({ title: "summary" });
    expect(loadDetail).toHaveBeenCalledOnce();
    expect(requestViewerSource).not.toHaveBeenCalled();
    expect(loadManagedDemo).not.toHaveBeenCalled();
    const withViewer = await controller.attachViewerSource(restored, "RESTORE");
    expect(loadDetail).toHaveBeenCalledBefore(requestViewerSource);
    controller.activate(withViewer, "RESTORE");
    expect(loadManagedDemo).toHaveBeenCalledWith(expect.objectContaining({ demoId: "demo-1" }), "RESTORE");
    expect(withViewer.managedSource).toEqual(expect.objectContaining({ demoId: "demo-1" }));
  });

  it("marks an incomplete revision for explicit reanalysis and never auto-generates narration", async () => {
    const incomplete = { ...detail, artifacts: [] };
    const source = vi.fn();
    const controller = new HistoryRestoreController({
      loadDetail: vi.fn().mockResolvedValue(incomplete),
      requestViewerSource: source,
      loadManagedDemo: vi.fn(),
    });
    const restored = await controller.open("review-1");
    expect(restored.missingArtifacts).toEqual(["ANALYSIS_BUNDLE", "CANDIDATE_SET", "REVIEW_PLAN", "SESSION_RECOVERY"]);
    await controller.attachViewerSource(restored);
    expect(source).not.toHaveBeenCalled();
  });

  it("returns the SQLite control plane before a slow Viewer source resolves", async () => {
    let release!: (value: { requestId: string; demoId: string; capabilityToken: string; originalFilename: string; byteSize: number; contentHash: string }) => void;
    const source = new Promise<ManagedDemoSource>((resolve) => { release = resolve; });
    const controller = new HistoryRestoreController({
      loadDetail: vi.fn().mockResolvedValue(detail),
      requestViewerSource: vi.fn().mockReturnValue(source),
      loadManagedDemo: vi.fn(),
    });

    const controlPlane = await controller.open("review-1");
    expect(controlPlane.plan).toEqual({ id: "route-1" });
    expect(controlPlane.managedSource).toBeUndefined();
    const pendingViewer = controller.attachViewerSource(controlPlane);
    expect(controlPlane.cueCases).toEqual({ "cue-1": { cueId: "cue-1" } });
    release({ requestId: "slow", demoId: "demo-1", capabilityToken: "a".repeat(43), originalFilename: "match.dem", byteSize: 4, contentHash: "f".repeat(64) });
    await expect(pendingViewer).resolves.toMatchObject({ managedSource: { requestId: "slow" } });
  });

  it("treats a missing independent CandidateSet as an incomplete RESTORE revision", async () => {
    const withoutCandidate = {
      ...detail,
      artifacts: detail.artifacts.filter((artifact) => artifact.kind !== "CANDIDATE_SET"),
    };
    const source = vi.fn();
    const controller = new HistoryRestoreController({
      loadDetail: vi.fn().mockResolvedValue(withoutCandidate),
      requestViewerSource: source,
      loadManagedDemo: vi.fn(),
    });
    const restored = await controller.open("review-1");
    expect(restored.missingArtifacts).toContain("CANDIDATE_SET");
    await controller.attachViewerSource(restored);
    expect(source).not.toHaveBeenCalled();
  });

  it("restores a v1 Revision from the CandidateSet embedded in its checksummed AnalysisBundle", () => {
    const legacy = restoreHistoryControlPlane({
      ...detail,
      revision: { ...detail.revision!, artifactContractVersion: 1 },
      artifacts: detail.artifacts
        .filter((artifact) => artifact.kind !== "CANDIDATE_SET")
        .map((artifact) => artifact.kind === "ANALYSIS_BUNDLE"
          ? { ...artifact, payload: { ...(artifact.payload as Record<string, unknown>), candidate_set: { id: "legacy-candidates" } } }
          : artifact),
    });

    expect(legacy.candidateSet).toEqual({ id: "legacy-candidates" });
    expect(legacy.missingArtifacts).not.toContain("CANDIDATE_SET");
  });

  it("does not use the v1 embedded compatibility path for an unfinished Revision", () => {
    const unfinished = restoreHistoryControlPlane({
      ...detail,
      revision: { ...detail.revision!, status: "PREPARING", artifactContractVersion: 1 },
      artifacts: detail.artifacts
        .filter((artifact) => artifact.kind !== "CANDIDATE_SET")
        .map((artifact) => artifact.kind === "ANALYSIS_BUNDLE"
          ? { ...artifact, payload: { ...(artifact.payload as Record<string, unknown>), candidate_set: { id: "not-durable" } } }
          : artifact),
    });

    expect(unfinished.candidateSet).toBeNull();
    expect(unfinished.missingArtifacts).toContain("CANDIDATE_SET");
  });

  it("allows an explicit reanalysis to load the managed Demo even when old artifacts are incomplete", async () => {
    const source = vi.fn().mockResolvedValue({ requestId: "reanalyze", demoId: "demo-1", capabilityToken: "a".repeat(43), originalFilename: "match.dem", byteSize: 4, contentHash: "f".repeat(64) });
    const loadManagedDemo = vi.fn();
    const controller = new HistoryRestoreController({
      loadDetail: vi.fn().mockResolvedValue({ ...detail, artifacts: [] }),
      requestViewerSource: source,
      loadManagedDemo,
    });
    const restored = await controller.open("review-1", "REANALYZE");
    expect(restored.missingArtifacts).toEqual(["ANALYSIS_BUNDLE", "CANDIDATE_SET", "REVIEW_PLAN", "SESSION_RECOVERY"]);
    const withViewer = await controller.attachViewerSource(restored, "REANALYZE");
    expect(source).toHaveBeenCalledOnce();
    controller.activate(withViewer, "REANALYZE");
    expect(loadManagedDemo).toHaveBeenCalledWith(expect.objectContaining({ demoId: "demo-1" }), "REANALYZE");
  });

  it("keeps only the newest open request eligible to load the Viewer", async () => {
    let finishFirst!: (value: ReviewHistoryDetail) => void;
    const first = new Promise<ReviewHistoryDetail>((resolve) => { finishFirst = resolve; });
    const loaded = vi.fn();
    const controller = new HistoryRestoreController({
      loadDetail: vi.fn().mockImplementation((id: string) => id === "first" ? first : Promise.resolve({ ...detail, review: { ...detail.review, id: "second" } })),
      requestViewerSource: vi.fn().mockResolvedValue({ requestId: "r", demoId: "demo-1", capabilityToken: "a".repeat(43), originalFilename: "match.dem", byteSize: 4, contentHash: "f".repeat(64) }),
      loadManagedDemo: loaded,
    });
    const old = controller.open("first");
    const second = await controller.open("second");
    const secondWithViewer = await controller.attachViewerSource(second);
    controller.activate(secondWithViewer);
    finishFirst(detail);
    await expect(old).rejects.toMatchObject({ code: "STALE_REQUEST" });
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it("rejects activation of a source that became stale after its HTTP load completed", async () => {
    const loaded = vi.fn();
    const controller = new HistoryRestoreController({
      loadDetail: vi.fn().mockImplementation((id: string) => Promise.resolve({
        ...detail,
        review: { ...detail.review, id },
      })),
      requestViewerSource: vi.fn().mockImplementation((id: string) => Promise.resolve({
        requestId: `request-${id}`,
        demoId: "demo-1",
        capabilityToken: "a".repeat(43),
        originalFilename: "match.dem",
        byteSize: 4,
        contentHash: "f".repeat(64),
      })),
      loadManagedDemo: loaded,
    });
    const first = await controller.open("first");
    const firstWithViewer = await controller.attachViewerSource(first);
    const second = await controller.open("second");
    const secondWithViewer = await controller.attachViewerSource(second);

    expect(() => controller.activate(firstWithViewer)).toThrow(expect.objectContaining({ code: "STALE_REQUEST" }));
    controller.activate(secondWithViewer);
    expect(loaded).toHaveBeenCalledOnce();
    expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-second" }), "RESTORE");
  });

  it("uses an analysis bundle plan only when an explicit ReviewPlan artifact is absent", () => {
    const restored = restoreHistoryControlPlane({ ...detail, artifacts: [{ kind: "ANALYSIS_BUNDLE", key: "bundle", payload: { review_plan: { id: "frozen" } } }] });
    expect(restored.plan).toEqual({ id: "frozen" });
  });

  it("selects newest mutable projections but binds recovery to the committed RuntimeHead", () => {
    const restored = restoreHistoryControlPlane({
      ...detail,
      artifacts: [
        ...detail.artifacts,
        { kind: "CUE_CASE", key: "cue-1", revision: 2, payload: { cueId: "cue-1", status: "COMPLETED" } },
        { kind: "LEARNING_THREAD", key: "thread-1", revision: 2, payload: { threadId: "thread-1", status: "TAUGHT" } },
        { kind: "SESSION_RECOVERY", key: "boundary-1", revision: 1, createdAt: "2026-09-01T00:00:00.000Z", payload: { boundary: 1 } },
        { kind: "SESSION_RECOVERY", key: "boundary-2", revision: 1, createdAt: "2026-09-02T00:00:00.000Z", payload: { boundary: 2 } },
      ],
    });
    expect(restored.cueCases["cue-1"]).toEqual({ cueId: "cue-1", status: "COMPLETED" });
    expect(restored.learningThreads).toEqual([{ threadId: "thread-1", status: "TAUGHT" }]);
    expect(restored.recoverySnapshot).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      boundary: { kind: "ROUTE_START", segmentIndex: 0 },
    });
  });

  it("selects only the exact Recovery artifact committed by RuntimeHead", () => {
    const committed = detail.artifacts.find((artifact) => artifact.id === "artifact-recovery")!;
    const restored = restoreHistoryControlPlane({
      ...detail,
      artifacts: [
        ...detail.artifacts,
        {
          id: "artifact-uncommitted",
          kind: "SESSION_RECOVERY",
          key: "newer-uncommitted",
          revision: 1,
          createdAt: "2026-09-03T00:00:00.000Z",
          payload: {
            ...(committed.payload as Record<string, unknown>),
            marker: "uncommitted",
            cueProgress: { completedCueIds: [] },
            frozenReviewPlan: { cues: [] },
          },
        },
      ],
    });

    expect(restored.recoverySnapshot).toBe(committed.payload);
    expect(restored.missingArtifacts).not.toContain("SESSION_RECOVERY");
  });

  it("fails closed when a legacy RuntimeHead has no exact Recovery identity", () => {
    const legacyHead = { ...(detail.runtimeHead as Record<string, unknown>) };
    delete legacyHead.recoveryArtifactId;
    delete legacyHead.recoveryArtifactKey;
    delete legacyHead.recoveryArtifactRevision;
    const restored = restoreHistoryControlPlane({ ...detail, runtimeHead: legacyHead });
    expect(restored.recoverySnapshot).toBeNull();
    expect(restored.missingArtifacts).toContain("SESSION_RECOVERY");
  });
});
