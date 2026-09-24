import { afterEach, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { decisionAssessmentEvalCases } from "../../../../../../libs/review-planner/src/decision-assessment-fixtures";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const request = (body: unknown, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/coaching/assess-decision", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
it("defaults to baseline, never exposing credentials or calling models", async () => {
  vi.stubEnv("CS_DECISION_ASSESSMENT_MODE", "RULE_BASELINE"); vi.stubEnv("JEV_API_KEY", "private-test-key"); const remote = vi.fn(); vi.stubGlobal("fetch", remote);
  expect(await (await GET(new Request("http://localhost:3000/api/coaching/assess-decision"))).json()).toEqual({ mode: "RULE_BASELINE", acceptance: "DISABLED" });
  expect(await (await POST(request(decisionAssessmentEvalCases[0]!.packet))).json()).toMatchObject({ reason: "DISABLED" }); expect(remote).not.toHaveBeenCalled();
});
it("rejects cross-origin, oversized streams and outcome injection before model access", async () => {
  vi.stubEnv("CS_DECISION_ASSESSMENT_MODE", "JEV_SHADOW"); const remote = vi.fn(); vi.stubGlobal("fetch", remote);
  expect((await POST(request({}, "https://evil.example"))).status).toBe(403);
  expect((await POST(request({ padding: "x".repeat(17000) }))).status).toBe(413);
  expect((await POST(request({ ...decisionAssessmentEvalCases[0]!.packet, outcome: "win" }))).status).toBe(400); expect(remote).not.toHaveBeenCalled();
});
it("missing key does not block the review and is observable", async () => {
  vi.stubEnv("CS_DECISION_ASSESSMENT_MODE", "JEV_SHADOW"); vi.stubEnv("JEV_API_KEY", "");
  expect(await (await POST(request(decisionAssessmentEvalCases[0]!.packet))).json()).toMatchObject({ status: "FALLBACK", reason: "MISSING_API_KEY" });
});
