import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { installDesktopReviewLibrary, type DesktopReviewLibrary } from "@cs-coach/review-library/server";
import { POST } from "./route";
import { DESKTOP_APP_ORIGIN_HEADER } from "../../../../../lib/desktop/request-origin";

const APP_ORIGIN = "http://127.0.0.1:43123";

afterEach(() => {
  installDesktopReviewLibrary(undefined);
  vi.unstubAllEnvs();
});

describe("Review artifact route", () => {
  it("rejects a checksum-storable but semantically invalid AnalysisBundle", async () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const appendArtifact = vi.fn();
    const loadReview = vi.fn().mockResolvedValue({
      demo: { contentHash: "f".repeat(64) },
      review: { reviewId: "review-a", selectedPlayerId: "player-a" },
      revisions: [{ reviewRevisionId: "revision-a", reviewId: "review-a", routeHash: "route-hash" }],
      artifacts: [],
      artifactIssues: [],
    });
    installDesktopReviewLibrary({ loadReview, appendArtifact } as unknown as DesktopReviewLibrary);
    const response = await POST(new Request(`${APP_ORIGIN}/api/review-history/review-a/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json", [DESKTOP_APP_ORIGIN_HEADER]: APP_ORIGIN },
      body: JSON.stringify({
        revisionId: "revision-a",
        artifactType: "ANALYSIS_BUNDLE",
        artifactKey: "analysis-a",
        artifactRevision: 1,
        schemaVersion: "cs2d-analysis-bundle.v1",
        payload: { merelyJson: true },
        idempotencyKey: "analysis-a",
      }),
    }), { params: Promise.resolve({ id: "review-a" }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "ARTIFACT_INVALID" });
    expect(loadReview).toHaveBeenCalledWith("review-a", {
      materializeExternalArtifacts: true,
      reviewRevisionId: "revision-a",
    });
    expect(appendArtifact).not.toHaveBeenCalled();
  });

  it("rejects a dependent artifact before AnalysisBundle and ReviewPlan exist", async () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const appendArtifact = vi.fn();
    const loadReview = vi.fn().mockResolvedValue({
      demo: { contentHash: "f".repeat(64) },
      review: { reviewId: "review-a", selectedPlayerId: "player-a" },
      revisions: [{ reviewRevisionId: "revision-a", reviewId: "review-a", routeHash: "route-hash" }],
      artifacts: [],
      artifactIssues: [],
    });
    installDesktopReviewLibrary({ loadReview, appendArtifact } as unknown as DesktopReviewLibrary);
    const response = await POST(new Request(`${APP_ORIGIN}/api/review-history/review-a/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json", [DESKTOP_APP_ORIGIN_HEADER]: APP_ORIGIN },
      body: JSON.stringify({
        revisionId: "revision-a",
        artifactType: "TOOL_RESULT",
        artifactKey: "tool-invalid",
        artifactRevision: 1,
        schemaVersion: "agent-tool-result.v1",
        payload: { notAToolResult: true },
        idempotencyKey: "tool-invalid",
      }),
    }), { params: Promise.resolve({ id: "review-a" }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "ARTIFACT_INVALID" });
    expect(appendArtifact).not.toHaveBeenCalled();
  });
});
