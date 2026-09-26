import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../../../../../lib/review-history/artifact-validation", () => ({ validateReadyRevisionArtifacts: vi.fn() }));
import { installDesktopReviewLibrary, type DesktopReviewLibrary } from "@cs-coach/review-library/server";
import { PUT } from "./route";
import { DESKTOP_APP_ORIGIN_HEADER } from "../../../../../lib/desktop/request-origin";

const origin = "http://127.0.0.1:43123";
afterEach(() => { installDesktopReviewLibrary(undefined); vi.unstubAllEnvs(); });
function fixture() {
  vi.stubEnv("DEPLOY_TARGET", "desktop");
  const loadReview = vi.fn().mockResolvedValue({ artifacts: [{ reviewRevisionId: "revision-a", artifactType: "SESSION_RECOVERY",
    artifactKey: "recovery-a", artifactRevision: 1, payload: {} }] });
  const commitRuntimeHead = vi.fn().mockResolvedValue({ recoveryArtifactId: "artifact-confirmed" });
  installDesktopReviewLibrary({ loadReview, commitRuntimeHead } as unknown as DesktopReviewLibrary);
  const send = (extra: Record<string, unknown>) => PUT(new Request(`${origin}/api/review-history/review-a/runtime-head`, {
    method: "PUT", headers: { "content-type": "application/json", [DESKTOP_APP_ORIGIN_HEADER]: origin },
    body: JSON.stringify({ reviewRevisionId: "revision-a", recoveryArtifactKey: "recovery-a", sessionId: "session-a", runId: "run-a",
      demoId: "demo-a", demoContentHash: "f".repeat(64), selectedPlayerId: "player-a", routeId: "route-a", routeHash: "route-hash",
      recoveryBoundary: "ROUTE_START", ...extra }),
  }), { params: Promise.resolve({ id: "review-a" }) });
  return { send, loadReview, commitRuntimeHead };
}
it.each([undefined, "", 1, {}, "x".repeat(241)])("rejects a missing or invalid expected head (%j) before loading artifacts", async expected => {
  const f = fixture();
  const response = await f.send({ expectedRecoveryArtifactId: expected });
  expect(response.status).toBe(400); expect(f.loadReview).not.toHaveBeenCalled(); expect(f.commitRuntimeHead).not.toHaveBeenCalled();
});
it.each([null, "previous-artifact"])("forwards explicit expected head %j and returns the confirmed pointer", async expected => {
  const f = fixture(); const response = await f.send({ expectedRecoveryArtifactId: expected });
  expect(response.status).toBe(200);
  expect(f.commitRuntimeHead).toHaveBeenCalledWith(expect.objectContaining({ expectedRecoveryArtifactId: expected, recoveryArtifactRevision: 1 }));
  expect(await response.json()).toEqual({ recoveryArtifactId: "artifact-confirmed" });
});
it("preserves transaction conflict as HTTP 409", async () => {
  const f = fixture(); f.commitRuntimeHead.mockRejectedValue({ code: "RUNTIME_HEAD_CONFLICT" });
  const response = await f.send({ expectedRecoveryArtifactId: "old-artifact" });
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "RUNTIME_HEAD_CONFLICT" });
});
