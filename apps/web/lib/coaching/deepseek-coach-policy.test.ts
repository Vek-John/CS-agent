import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeepSeekCoachPolicyAdapter,
  directCoachPolicy,
  requestCoachPolicy,
} from "./deepseek-coach-policy";
import type { PolicyInput } from "../../../../libs/coach-agent/src/types";
import { createCoachAgentRuntime } from "../../../../libs/coach-agent/src/runtime";
import { mapFocusCapability, slowReplayCapability, startCueEvent } from "../../../../libs/coach-agent/src/test-fixtures";

function policyInput(): PolicyInput {
  return {
    cueId: "cue-17",
    focus: "POSITIONING",
    narrationSummary: {
      primaryFocusCode: "POSITIONING",
      readiness: "READY",
      limitationCount: 0,
      fields: {
        currentSituation: { text: "位置与队友间距摘要", refs: ["annotation-1"], limitations: [] },
        playerAction: { text: "实际动作摘要", refs: ["action-1"], limitations: [] },
        coreIssue: { text: "核心问题摘要", refs: ["action-1"], limitations: [] },
        betterPlay: { text: "已有建议摘要", refs: ["action-1"], limitations: [] },
        outcomeImpact: { text: "结果影响摘要", refs: [], limitations: ["仅由结果包提供"] },
      },
    },
    allowedEvidenceSummary: [
      { namespace: "ACTION", refs: ["action-1"] },
      { namespace: "EVIDENCE", refs: ["annotation-1"] },
    ],
    phase: "PAUSED_FOR_COACHING",
    outcomeGateStatus: "COMPLETE",
    capabilities: [
      { capabilityId: "cap-cue17-slow-replay", tool: "REPLAY_CUE_SLOW", evidenceRefs: ["action-1"], estimatedDurationMs: 12_000 },
      { capabilityId: "cap-cue17-map-focus", tool: "FOCUS_MAP_EVIDENCE", evidenceRefs: ["annotation-1"], estimatedDurationMs: 8_000 },
    ],
    toolObservations: [],
    themes: [],
    limitations: [],
    budget: { policyCalls: 0, maxPolicyCalls: 1, alternativeAttempts: 0, maxAlternativeAttempts: 1 },
    maxMoves: 1,
  };
}

function completion(content: unknown, finishReason = "stop", usage?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(content) } }],
    ...(usage ? { usage } : {}),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DeepSeek Coach Policy adapter", () => {
  it("uses deterministic selection with a traceable reason when the key is unavailable", async () => {
    const fetcher = vi.fn();
    const result = await directCoachPolicy(policyInput(), {}, fetcher);

    expect(result.status).toBe("FALLBACK");
    expect(result.manifest).toMatchObject({ provider: "DETERMINISTIC", reason: "MISSING_API_KEY" });
    expect(result.output).toMatchObject({ action: "SELECT_CAPABILITY", capabilityId: "cap-cue17-map-focus" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends only PolicyInput and accepts an exact allowlisted provider output", async () => {
    let body = "";
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = String(init?.body);
      return completion({
        action: "SELECT_CAPABILITY",
        capabilityId: "cap-cue17-map-focus",
        evidenceRefs: ["annotation-1"],
        rationaleCode: "POSITION_NEEDS_MAP_FOCUS",
        confidence: 0.87,
      }, "stop", { total_tokens: 37 });
    });
    const result = await directCoachPolicy(policyInput(), { DEEPSEEK_API_KEY: "server-secret" }, fetcher);

    expect(result.status).toBe("SUCCEEDED");
    expect(result.manifest.provider).toBe("DEEPSEEK");
    expect(result.manifest.tokenCount).toBe(37);
    expect(result.output).toMatchObject({ action: "SELECT_CAPABILITY", capabilityId: "cap-cue17-map-focus" });
    expect(JSON.parse(body).messages[1].content).toEqual(JSON.stringify(policyInput()));
    expect(body).not.toContain("server-secret");
  });

  it("supports a keyless loopback OpenAI-compatible endpoint without an authorization header", async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return completion({
        action: "FINISH_CUE",
        evidenceRefs: [],
        rationaleCode: "NO_EXTRA_VISUAL_VALUE",
        confidence: 0.8,
      });
    });
    const result = await directCoachPolicy(policyInput(), {
      DEEPSEEK_MODEL: "local-model",
      DEEPSEEK_URL: "http://127.0.0.1:11434/v1/chat/completions",
      DEEPSEEK_ALLOW_EMPTY_KEY: true,
    }, fetcher);
    expect(result.status).toBe("SUCCEEDED");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["unknown capability", { action: "SELECT_CAPABILITY", capabilityId: "cap-not-available", evidenceRefs: [], rationaleCode: "POSITION_NEEDS_MAP_FOCUS", confidence: 0.8 }],
    ["illegal ref", { action: "SELECT_CAPABILITY", capabilityId: "cap-cue17-map-focus", evidenceRefs: ["action-1"], rationaleCode: "POSITION_NEEDS_MAP_FOCUS", confidence: 0.8 }],
    ["extra field", { action: "SELECT_CAPABILITY", capabilityId: "cap-cue17-map-focus", evidenceRefs: [], rationaleCode: "POSITION_NEEDS_MAP_FOCUS", confidence: 0.8, boundArgs: {} }],
  ])("falls back when the provider returns %s", async (_label, output) => {
    const result = await directCoachPolicy(
      policyInput(),
      { DEEPSEEK_API_KEY: "server-secret" },
      async () => completion(output),
    );
    expect(result.status).toBe("FALLBACK");
    expect(result.manifest.reason).toBe("UPSTREAM_SCHEMA");
    expect(result.output).toMatchObject({ action: "SELECT_CAPABILITY", capabilityId: "cap-cue17-map-focus" });
  });

  it("keeps HTTP/network failures deterministic and passes client AbortSignal", async () => {
    await expect(directCoachPolicy(policyInput(), { DEEPSEEK_API_KEY: "secret" }, async () => new Response("", { status: 503 }))).resolves.toMatchObject({ status: "FALLBACK", manifest: { reason: "UPSTREAM_HTTP" } });
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("aborted", "AbortError");
    });
    controller.abort();
    await expect(requestCoachPolicy(policyInput(), { fetcher, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("exposes provider-neutral trace metadata through the PolicyAdapter seam", async () => {
    const adapter = createDeepSeekCoachPolicyAdapter({
      fetcher: async () => new Response(JSON.stringify({
        status: "SUCCEEDED",
        output: {
          action: "SELECT_CAPABILITY",
          capabilityId: "cap-cue17-map-focus",
          evidenceRefs: ["annotation-1"],
          rationaleCode: "POSITION_NEEDS_MAP_FOCUS",
          confidence: 0.87,
        },
        manifest: {
          status: "SUCCEEDED",
          provider: "DEEPSEEK",
          model: "deepseek-v4-flash",
          tokenCount: 41,
          limitations: [],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await adapter.selectCapability(policyInput());
    expect(adapter.consumeLastTraceMeta?.()).toMatchObject({
      provider: "DEEPSEEK",
      model: "deepseek-v4-flash",
      tokenCount: 41,
    });
    expect(adapter.consumeLastTraceMeta?.()).toBeNull();
  });

  it("keeps fallback manifest metadata when the result bridge callback throws", async () => {
    const adapter = createDeepSeekCoachPolicyAdapter({
      fetcher: async () => new Response(JSON.stringify({
        status: "FALLBACK",
        output: {
          action: "SELECT_CAPABILITY",
          capabilityId: "cap-cue17-map-focus",
          evidenceRefs: ["annotation-1"],
          rationaleCode: "POSITION_NEEDS_MAP_FOCUS",
          confidence: 0.87,
        },
        manifest: {
          status: "FALLBACK",
          provider: "DETERMINISTIC",
          reason: "DO_RESULT_BRIDGE_FAILED",
          limitations: ["bridge failed after provider result"],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      onResult: () => {
        throw new Error("DO_RESULT_BRIDGE_FAILED");
      },
    });

    await expect(adapter.selectCapability(policyInput())).rejects.toThrow("DO_RESULT_BRIDGE_FAILED");
    expect(adapter.consumeLastTraceMeta?.()).toMatchObject({
      provider: "DETERMINISTIC",
      model: null,
      tokenCount: null,
      latencyMs: expect.any(Number),
    });
  });

  it("carries DeepSeek stub metadata into the Graph POLICY trace", async () => {
    const adapter = createDeepSeekCoachPolicyAdapter({
      fetcher: async () => new Response(JSON.stringify({
        status: "SUCCEEDED",
        output: {
          action: "SELECT_CAPABILITY",
          capabilityId: "cap-cue17-map-focus",
          evidenceRefs: ["annotation-a1"],
          rationaleCode: "POSITION_NEEDS_MAP_FOCUS",
          confidence: 0.87,
        },
        manifest: {
          status: "SUCCEEDED",
          provider: "DEEPSEEK",
          model: "deepseek-v4-flash",
          tokenCount: 41,
          limitations: [],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const runtime = createCoachAgentRuntime({ policy: adapter });
    const result = await runtime.dispatch(startCueEvent({ capabilities: [slowReplayCapability, mapFocusCapability] }));
    const policyTrace = [...result.state.trace].reverse().find((entry) => entry.node === "POLICY");

    expect(policyTrace).toMatchObject({
      provider: "DEEPSEEK",
      model: "deepseek-v4-flash",
      tokenCount: 41,
    });
    expect(policyTrace?.latencyMs).toEqual(expect.any(Number));
  });
});
