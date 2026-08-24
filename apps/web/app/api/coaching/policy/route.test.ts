import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import type { PolicyInput } from "../../../../../../libs/coach-agent/src/types";

function policyInput(): PolicyInput {
  return {
    cueId: "cue-17",
    focus: "POSITIONING",
    narrationSummary: {
      primaryFocusCode: "POSITIONING",
      readiness: "READY",
      limitationCount: 0,
      fields: {
        currentSituation: { text: "位置与队友间距摘要", refs: [], limitations: [] },
        playerAction: { text: "实际动作摘要", refs: ["action-1"], limitations: [] },
        coreIssue: { text: "核心问题摘要", refs: ["action-1"], limitations: [] },
        betterPlay: { text: "已有建议摘要", refs: ["action-1"], limitations: [] },
        outcomeImpact: { text: "结果影响摘要", refs: [], limitations: ["仅由结果包提供"] },
      },
    },
    allowedEvidenceSummary: [{ namespace: "ACTION", refs: ["action-1"] }],
    phase: "PAUSED_FOR_COACHING",
    outcomeGateStatus: "COMPLETE",
    capabilities: [{ capabilityId: "cap-cue17-slow-replay", tool: "REPLAY_CUE_SLOW", evidenceRefs: ["action-1"], estimatedDurationMs: 12_000 }],
    toolObservations: [],
    themes: [],
    limitations: [],
    budget: { policyCalls: 0, maxPolicyCalls: 1, alternativeAttempts: 0, maxAlternativeAttempts: 1 },
    maxMoves: 1,
  };
}

function completion(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("/api/coaching/policy", () => {
  it("returns deterministic fallback without a key", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const response = await POST(new Request("http://localhost/api/coaching/policy", { method: "POST", body: JSON.stringify(policyInput()) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "FALLBACK", manifest: { provider: "DETERMINISTIC", reason: "MISSING_API_KEY" } });
  });

  it("rejects extra request fields at the same-origin route", async () => {
    const response = await POST(new Request("http://localhost/api/coaching/policy", { method: "POST", body: JSON.stringify({ ...policyInput(), tick: 1 }) }));
    expect(response.status).toBe(400);
  });

  it("keeps provider output and manifest status aligned", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "route-secret");
    vi.stubGlobal("fetch", vi.fn(async () => completion({
      action: "SELECT_CAPABILITY",
      capabilityId: "cap-cue17-slow-replay",
      evidenceRefs: ["action-1"],
      rationaleCode: "TIMING_NEEDS_SLOW_REPLAY",
      confidence: 0.7,
    })));
    const response = await POST(new Request("http://localhost/api/coaching/policy", { method: "POST", body: JSON.stringify(policyInput()) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "SUCCEEDED", manifest: { status: "SUCCEEDED", provider: "DEEPSEEK" } });
  });
});
