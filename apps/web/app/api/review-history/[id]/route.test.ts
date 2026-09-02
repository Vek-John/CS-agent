import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { installDesktopReviewLibrary, type DesktopReviewLibrary } from "@cs-coach/review-library/server";
import { GET } from "./route";
import { DESKTOP_APP_ORIGIN_HEADER } from "../../../../lib/desktop/request-origin";

const APP_ORIGIN = "http://127.0.0.1:43123";

afterEach(() => {
  installDesktopReviewLibrary(undefined);
  vi.unstubAllEnvs();
});

describe("Review detail route", () => {
  it("keeps control-plane metadata available when an active artifact is corrupt", async () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const loadReview = vi.fn().mockResolvedValue({
      demo: {},
      review: {
        reviewId: "review-a",
        demoId: "demo-a",
        title: "Mirage review",
        status: "READY",
        activeRevisionId: "revision-a",
        selectedPlayerId: "player-a",
        selectedPlayerName: "Player A",
        mapName: "Mirage",
        scoreText: "13:9",
      },
      revisions: [{
        reviewRevisionId: "revision-a",
        status: "READY",
        routeId: "route-a",
        routeHash: "route-hash",
        artifactContractVersion: 2,
      }],
      artifacts: [{
        artifactId: "plan-a",
        reviewRevisionId: "revision-a",
        artifactType: "REVIEW_PLAN",
        artifactKey: "route-a",
        artifactRevision: 1,
        createdAt: "2026-09-02T00:00:00.000Z",
        payload: { id: "route-a" },
      }],
      artifactIssues: [{ kind: "ANALYSIS_BUNDLE", key: "analysis", code: "ARTIFACT_CORRUPT" }],
    });
    installDesktopReviewLibrary({ loadReview } as unknown as DesktopReviewLibrary);
    const response = await GET(
      new Request(`${APP_ORIGIN}/api/review-history/review-a`, {
        headers: { [DESKTOP_APP_ORIGIN_HEADER]: APP_ORIGIN },
      }),
      { params: Promise.resolve({ id: "review-a" }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      review: {
        id: "review-a",
        demoId: "demo-a",
        title: "Mirage review",
        status: "READY",
        selectedPlayerId: "player-a",
        selectedPlayerName: "Player A",
        mapName: "Mirage",
        scoreText: "13:9",
      },
      revision: { id: "revision-a", status: "READY", artifactContractVersion: 2, routeId: "route-a", routeHash: "route-hash" },
      artifacts: [{
        id: "plan-a",
        kind: "REVIEW_PLAN",
        key: "route-a",
        revision: 1,
        createdAt: "2026-09-02T00:00:00.000Z",
        payload: { id: "route-a" },
      }],
      artifactIssues: [{ kind: "ANALYSIS_BUNDLE", key: "analysis", code: "ARTIFACT_CORRUPT" }],
      runtimeHead: null,
    });
    expect(loadReview).toHaveBeenCalledWith("review-a", { materializeExternalArtifacts: true });
  });
});
