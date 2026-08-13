import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const validBody = {
  cues: [{
    cue_id: "c1",
    cue_type: "DECISION",
    facts: [{ id: "f1", text: "决策时玩家有 65 HP。", availability: "DECISION", observed_by_player: true }],
    inferences: [],
    advice: [],
    limitations: []
  }]
};

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://coach.test/api/coaching/narrate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function multiCueBody(count: number) {
  return {
    cues: Array.from({ length: count }, (_, index) => ({
      cue_id: `c${index + 1}`,
      cue_type: "DECISION",
      facts: [{ id: "f1", text: "决策时玩家有 65 HP。", availability: "DECISION", observed_by_player: true }],
      inferences: [],
      advice: [],
      limitations: []
    }))
  };
}

function multiCueCompletion(count: number) {
  return {
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify({
          items: Array.from({ length: count }, (_, index) => ({
            cue_id: `c${index + 1}`,
            title: `第 ${index + 1} 个决策点`,
            explanation: "基于当前决策事实，保留退路。"
          }))
        })
      }
    }]
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/coaching/narrate", () => {
  it("returns safe DISABLED when no server key is configured", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const response = await POST(request(validBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "DISABLED", items: [], reason: "MISSING_API_KEY" });
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
    expect(await response.json()).toEqual({ status: "FALLBACK", items: [], reason: "INVALID_REQUEST" });
  });

  it("accepts a 15-cue request and returns every narration item", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "route-test-secret");
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(multiCueCompletion(15)), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request(multiCueBody(15)));
    const body = await response.json() as { status: string; items?: Array<{ cue_id: string }> };

    expect(response.status).toBe(200);
    expect(body.status).toBe("SUCCEEDED");
    expect(body.items).toHaveLength(15);
    expect(body.items?.map((item) => item.cue_id)).toEqual(
      Array.from({ length: 15 }, (_, index) => `c${index + 1}`)
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
