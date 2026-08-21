import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/coaching/narrate/route";
import { parseNarrationRequest } from "./deepseek-narrator";

const anonymousRequest = {
  coachingPackage: {
    cueId: "c1",
    candidateId: "k1",
    primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
    decisionContext: { facts: [{ id: "d1", text: "决策时在 B小，手持步枪。" }], claims: [] },
    playerAction: [{ id: "a1", text: "你从掩体拉出。" }],
    inferences: [],
    advice: [{ id: "v1", text: "先预瞄，等队友补枪再拉。", trigger: "进入下一条枪线时", factRefs: ["d1"] }],
    evidence: [{ id: "e1", label: "决策事实", factRefs: ["d1"] }],
    allowedRefs: { decision: ["d1"], action: ["a1"], advice: ["v1"], evidence: ["e1"] },
    limitations: []
  },
  outcomePackage: {
    cueId: "c1",
    candidateId: "k1",
    outcomeFacts: [{ id: "o1", text: "结果窗口内你被击杀。", outcomeKind: "DEATH" }],
    deathKillHpRefs: ["o1"],
    winProbabilityImpact: { text: "我方胜率下降。", confidence: "HIGH", limitations: [] },
    measurementRefs: ["m1"],
    confounders: [],
    limitations: []
  }
};

function request(body: unknown): Request {
  return new Request("http://localhost/api/coaching/narrate", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body)
  });
}

describe("single-cue narration contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("accepts the strict anonymous CoachingPackage+OutcomePackage request", () => {
    expect(() => parseNarrationRequest(anonymousRequest)).not.toThrow();
  });

  it("passes the single-cue request through the API route with deterministic fallback when no key exists", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const response = await POST(request(anonymousRequest));
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; bundle: Record<string, unknown>; manifest: Record<string, unknown> };
    expect(body.status).toBe("FALLBACK");
    expect(body.manifest).toMatchObject({ status: "FALLBACK", provider: "DETERMINISTIC", reason: "MISSING_API_KEY" });
    expect(Object.keys(body.bundle).sort()).toEqual(["betterPlay", "candidateId", "coreIssue", "cueId", "currentSituation", "outcomeImpact", "playerAction", "primaryFocusCode"].sort());
  });
});
