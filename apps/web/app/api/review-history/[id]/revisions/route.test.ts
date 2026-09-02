import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { COACH_AGENT_GRAPH_VERSION } from "@cs-coach/coach-agent/client";
import { CS2D_ADAPTER_VERSION } from "@cs-coach/cs2d-analysis-adapter";
import { installDesktopReviewLibrary, type DesktopReviewLibrary } from "@cs-coach/review-library/server";
import { POST } from "./route";
import { DESKTOP_APP_ORIGIN_HEADER } from "../../../../../lib/desktop/request-origin";

const APP_ORIGIN = "http://127.0.0.1:43123";

afterEach(() => {
  installDesktopReviewLibrary(undefined);
  vi.unstubAllEnvs();
});

function request(graphVersion: string = COACH_AGENT_GRAPH_VERSION): Request {
  return new Request(`${APP_ORIGIN}/api/review-history/review-a/revisions`, {
    method: "POST",
    headers: { "content-type": "application/json", [DESKTOP_APP_ORIGIN_HEADER]: APP_ORIGIN },
    body: JSON.stringify({
      mode: "REANALYZE",
      routeId: "route-a",
      routeHash: "route-hash",
      analysisVersion: CS2D_ADAPTER_VERSION,
      graphVersion,
      promptVersion: "director-prompt/1.0.0",
      modelMetadata: { directorProvider: "DETERMINISTIC" },
    }),
  });
}

describe("Review Revision route", () => {
  it("persists current runtime versions and rejects stale graph provenance", async () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const startRevision = vi.fn().mockResolvedValue({ reviewRevisionId: "revision-a" });
    installDesktopReviewLibrary({ startRevision } as unknown as DesktopReviewLibrary);

    expect((await POST(request("coach-agent-graph.v2"), { params: Promise.resolve({ id: "review-a" }) })).status).toBe(400);
    const response = await POST(request(), { params: Promise.resolve({ id: "review-a" }) });
    expect(response.status).toBe(201);
    expect(startRevision).toHaveBeenCalledWith(expect.objectContaining({
      analysisVersion: CS2D_ADAPTER_VERSION,
      graphVersion: COACH_AGENT_GRAPH_VERSION,
      promptVersion: "director-prompt/1.0.0",
      modelMetadata: { directorProvider: "DETERMINISTIC", mode: "REANALYZE" },
    }));
  });
});
