import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const validBody = {
  schemaVersion: "coach-agent-session-wrap-up.v1",
  themes: [
    { focus: "f1", cueRefs: ["c1"], evidenceRefs: ["e1"], occurrence: 2, economyContext: "FULL", repeated: true, conflictEvidence: false, adviceRefs: ["v1"], limitations: [] },
    { focus: "f2", cueRefs: ["c2"], evidenceRefs: ["e2"], occurrence: 2, economyContext: "ECO", repeated: true, conflictEvidence: false, adviceRefs: ["v2"], limitations: [] },
    { focus: "f3", cueRefs: ["c3"], evidenceRefs: ["e3"], occurrence: 2, economyContext: "FORCE", repeated: true, conflictEvidence: false, adviceRefs: ["v3"], limitations: [] },
  ],
  completedCues: [
    { cueId: "c1", focus: "f1", coreIssue: { text: "问题一", refs: ["r1"], limitations: [] }, betterPlay: { text: "改法一", refs: ["r2"], limitations: [] }, advice: [{ id: "v1", text: "建议一", refs: ["r3"] }] },
    { cueId: "c2", focus: "f2", coreIssue: { text: "问题二", refs: ["r4"], limitations: [] }, betterPlay: { text: "改法二", refs: ["r5"], limitations: [] }, advice: [{ id: "v2", text: "建议二", refs: ["r6"] }] },
    { cueId: "c3", focus: "f3", coreIssue: { text: "问题三", refs: ["r7"], limitations: [] }, betterPlay: { text: "改法三", refs: ["r8"], limitations: [] }, advice: [{ id: "v3", text: "建议三", refs: ["r9"] }] },
  ],
  limitations: [],
};

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://coach.test/api/coaching/wrap-up", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function completion(bundle: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ bundle }) } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function successBundle() {
  return {
    schemaVersion: "coach-agent-session-wrap-up.v1",
    themes: [
      { focus: "f1", summary: { text: "主题一", refs: ["c1"] }, trainingAdvice: { text: "建议一", refs: ["v1"] } },
      { focus: "f2", summary: { text: "主题二", refs: ["e2"] }, trainingAdvice: { text: "建议二", refs: ["v2"] } },
      { focus: "f3", summary: { text: "主题三", refs: ["c3", "e3"] }, trainingAdvice: { text: "建议三", refs: ["v3"] } },
    ],
    limitations: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/coaching/wrap-up", () => {
  it("returns deterministic fallback without a server key", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; bundle?: unknown; manifest?: { reason?: string; provider?: string } };
    expect(body.status).toBe("FALLBACK");
    expect(body.manifest).toMatchObject({ reason: "MISSING_API_KEY", provider: "DETERMINISTIC" });
    expect(body.bundle).toBeDefined();
  });

  it("rejects singleton/extra control fields and cross-origin requests", async () => {
    const singleton = { ...validBody, themes: [{ ...validBody.themes[0], repeated: false }] };
    expect((await POST(request(singleton))).status).toBe(400);
    expect((await POST(request({ ...validBody, tick: 42 }))).status).toBe(400);
    expect((await POST(request(validBody, { origin: "https://evil.test" }))).status).toBe(403);
  });

  it("passes strict anonymous input to DeepSeek and returns a legal strict bundle", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "route-secret");
    const fetcher = vi.fn().mockResolvedValue(completion(successBundle()));
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; bundle: unknown; manifest: { provider: string } };
    expect(body.status).toBe("SUCCEEDED");
    expect(body.manifest.provider).toBe("DEEPSEEK");
    const upstreamBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { messages: Array<{ content: string }> };
    expect(upstreamBody.messages[1]?.content).not.toMatch(/tick|route|playerId|rawReplay|frames|prompt|cot/i);
  });

  it("returns deterministic fallback for invalid provider JSON/schema", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "route-secret");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "FALLBACK", manifest: { provider: "DETERMINISTIC", reason: "UPSTREAM_JSON" } });
  });
});
