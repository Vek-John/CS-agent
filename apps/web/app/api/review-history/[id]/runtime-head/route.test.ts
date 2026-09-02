import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { installDesktopReviewLibrary, type DesktopReviewLibrary } from "@cs-coach/review-library/server";
import { PUT } from "./route";
import { DESKTOP_APP_ORIGIN_HEADER } from "../../../../../lib/desktop/request-origin";

const APP_ORIGIN = "http://127.0.0.1:43123";

afterEach(() => {
  installDesktopReviewLibrary(undefined);
  vi.unstubAllEnvs();
});

describe("Review RuntimeHead route", () => {
  it("does not mark a Revision READY when stored JSON fails the real domain validators", async () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const commitRuntimeHead = vi.fn();
    const loadReview = vi.fn().mockResolvedValue({
      demo: { contentHash: "f".repeat(64) },
      review: { reviewId: "review-a", selectedPlayerId: "player-a" },
      revisions: [{ reviewRevisionId: "revision-a", reviewId: "review-a", routeId: "route-a", routeHash: "route-hash" }],
      artifacts: [
        { reviewRevisionId: "revision-a", artifactType: "ANALYSIS_BUNDLE", artifactKey: "analysis", artifactRevision: 1, schemaVersion: "cs2d-analysis-bundle.v1", createdAt: "2026-09-02T00:00:00.000Z", payload: { merelyJson: true } },
        { reviewRevisionId: "revision-a", artifactType: "CANDIDATE_SET", artifactKey: "candidates", artifactRevision: 1, schemaVersion: "candidate-set.v1", createdAt: "2026-09-02T00:00:00.000Z", payload: {} },
        { reviewRevisionId: "revision-a", artifactType: "REVIEW_PLAN", artifactKey: "route-a", artifactRevision: 1, schemaVersion: "review-plan.v1", createdAt: "2026-09-02T00:00:00.000Z", payload: { id: "route-a" } },
        { reviewRevisionId: "revision-a", artifactType: "SESSION_RECOVERY", artifactKey: "recovery-a", artifactRevision: 1, schemaVersion: "session-recovery-record.v2", createdAt: "2026-09-02T00:00:00.000Z", payload: {} },
      ],
      artifactIssues: [],
    });
    installDesktopReviewLibrary({ loadReview, commitRuntimeHead } as unknown as DesktopReviewLibrary);
    const response = await PUT(new Request(`${APP_ORIGIN}/api/review-history/review-a/runtime-head`, {
      method: "PUT",
      headers: { "content-type": "application/json", [DESKTOP_APP_ORIGIN_HEADER]: APP_ORIGIN },
      body: JSON.stringify({
        reviewRevisionId: "revision-a",
        recoveryArtifactKey: "recovery-a",
        sessionId: "session-a",
        runId: "run-a",
        demoId: "demo-a",
        demoContentHash: "f".repeat(64),
        selectedPlayerId: "player-a",
        routeId: "route-a",
        routeHash: "route-hash",
        recoveryBoundary: "ROUTE_START",
        defaultRouteCursor: 0,
        completedCueCount: 0,
        totalCueCount: 0,
        stableProgress: {},
      }),
    }), { params: Promise.resolve({ id: "review-a" }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "REVISION_ARTIFACTS_INCOMPLETE" });
    expect(commitRuntimeHead).not.toHaveBeenCalled();
  });
});
