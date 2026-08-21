import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const validBody = {
  coachingPackage: {
    cueId: "c1",
    candidateId: "k1",
    primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
    decisionContext: { facts: [{ id: "d1", text: "决策时玩家有 65 HP。" }], claims: [] },
    playerAction: [{ id: "a1", text: "你从掩体拉出。" }],
    inferences: [],
    advice: [{ id: "v1", text: "先预瞄，等队友补枪。", trigger: "进入枪线时", factRefs: ["d1"] }],
    evidence: [{ id: "e1", label: "决策事实", factRefs: ["d1"] }],
    allowedRefs: { decision: ["d1"], action: ["a1"], advice: ["v1"], evidence: ["e1"] },
    limitations: []
  },
  outcomePackage: {
    cueId: "c1",
    candidateId: "k1",
    outcomeFacts: [{ id: "o1", text: "随后你被击杀。", outcomeKind: "DEATH" }],
    deathKillHpRefs: ["o1"],
    winProbabilityImpact: { text: "我方胜率下降。", confidence: "HIGH", limitations: [] },
    measurementRefs: ["m1"],
    confounders: [],
    limitations: []
  }
};

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://coach.test/api/coaching/narrate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/coaching/narrate", () => {
  it("returns safe DISABLED when no server key is configured", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const response = await POST(request(validBody));

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; bundle?: unknown; manifest?: { reason?: string; provider?: string } };
    expect(body.status).toBe("FALLBACK");
    expect(body.manifest).toMatchObject({ reason: "MISSING_API_KEY", provider: "DETERMINISTIC" });
    expect(body.bundle).toBeDefined();
  });

  it("rejects cross-origin requests before reading or forwarding the body", async () => {
    const key = "route-test-secret";
    vi.stubEnv("DEEPSEEK_API_KEY", key);
    const response = await POST(request({ ...validBody, secret: key }, { origin: "https://evil.test" }));
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).not.toContain(key);
    expect(body).toContain("CROSS_ORIGIN");
  });

  it("rejects privileged request fields without invoking a provider", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const response = await POST(request({ ...validBody, player_id: "76561197964020430", path: "/tmp/demo.dem" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "FALLBACK", reason: "INVALID_REQUEST" });
  });

  it("accepts one anonymous CoachingPackage+OutcomePackage and returns a strict bundle", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "route-test-secret");
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              bundle: {
                cueId: "c1",
                candidateId: "k1",
                primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
                currentSituation: { text: "决策时玩家有 65 HP。", refs: ["d1"] },
                playerAction: { text: "你从掩体拉出。", refs: ["a1"] },
                coreIssue: { text: "先活过接触。", refs: ["d1", "a1"] },
                betterPlay: { text: "先预瞄，等队友补枪。", refs: ["v1", "e1"] },
                outcomeImpact: { text: "随后你被击杀。", refs: ["o1", "m1"] }
              }
            })
          }
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request(validBody));
    const body = await response.json() as { status: string; bundle?: { outcomeImpact?: { refs: string[] } } };

    expect(response.status).toBe(200);
    expect(body.status).toBe("SUCCEEDED");
    expect(body.bundle?.outcomeImpact?.refs).toEqual(["o1", "m1"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
