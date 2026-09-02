import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { installDesktopReviewLibrary, type DesktopReviewLibrary } from "@cs-coach/review-library/server";
import { DELETE, GET } from "./route";
import { DESKTOP_APP_ORIGIN_HEADER } from "../../../../../lib/desktop/request-origin";

const APP_ORIGIN = "http://127.0.0.1:43123";
const context = { params: Promise.resolve({ id: "demo-a" }) };

function request(method: "GET" | "DELETE", body?: unknown): Request {
  return new Request(`${APP_ORIGIN}/api/review-history/demos/demo-a`, {
    method,
    headers: {
      [DESKTOP_APP_ORIGIN_HEADER]: APP_ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

afterEach(() => {
  installDesktopReviewLibrary(undefined);
  vi.unstubAllEnvs();
});

describe("Demo deletion impact route", () => {
  it("returns the bounded newest-first impact DTO expected by the Host", async () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const previewDemoDeletion = vi.fn().mockResolvedValue({
      schemaVersion: "review-library-demo-deletion-impact.v1",
      demoId: "demo-a",
      originalFilename: "match.dem",
      affectedReviewCount: 2,
      affectedReviews: [
        { reviewId: "review-new", title: "Newest", selectedPlayerName: "B", status: "READY" },
        { reviewId: "review-old", title: "Older", selectedPlayerName: "A", status: "COMPLETED" },
      ],
      truncated: false,
      impactToken: "a".repeat(64),
    });
    installDesktopReviewLibrary({ previewDemoDeletion } as unknown as DesktopReviewLibrary);
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      demoId: "demo-a",
      originalFilename: "match.dem",
      reviews: [
        { id: "review-new", title: "Newest", selectedPlayerName: "B", status: "READY" },
        { id: "review-old", title: "Older", selectedPlayerName: "A", status: "COMPLETED" },
      ],
      reviewCount: 2,
      truncated: false,
      impactToken: "a".repeat(64),
    });
  });

  it("requires an exact impact-token DTO and preserves stale-impact errors", async () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const deleteDemo = vi.fn().mockRejectedValue({ code: "DELETION_IMPACT_CHANGED" });
    installDesktopReviewLibrary({ deleteDemo } as unknown as DesktopReviewLibrary);
    expect((await DELETE(request("DELETE"), context)).status).toBe(400);
    expect((await DELETE(request("DELETE", { impactToken: "a".repeat(64), force: true }), context)).status).toBe(400);
    expect(deleteDemo).not.toHaveBeenCalled();
    const response = await DELETE(request("DELETE", { impactToken: "a".repeat(64) }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "DELETION_IMPACT_CHANGED" });
    expect(deleteDemo).toHaveBeenCalledWith("demo-a", { impactToken: "a".repeat(64) });
  });
});
