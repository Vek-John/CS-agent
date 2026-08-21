import { describe, expect, it, vi } from "vitest";
import {
  narrateWithDeepSeek,
  parseNarrationRequest
} from "./deepseek-narrator";
import type { AnonymousNarrationRequest } from "./narrator-contract";

const SECRET = "test-only-deepseek-secret";
const FOCUS = "SURVIVE_THE_NEXT_CONTACT";

function sampleRequest(withImpact = true): AnonymousNarrationRequest {
  return {
    coachingPackage: {
      cueId: "c1",
      candidateId: "k1",
      primaryFocusCode: FOCUS,
      decisionContext: {
        facts: [{ id: "d1", text: "决策时你在 B小，手持步枪。" }],
        claims: []
      },
      playerAction: [{ id: "a1", text: "你先从掩体拉出。" }],
      inferences: [],
      advice: [{ id: "v1", text: "先预瞄，等队友补枪再拉。", trigger: "进入下一条枪线时", factRefs: ["d1"] }],
      evidence: [{ id: "e1", label: "决策时结构化事实", factRefs: ["d1"] }],
      allowedRefs: { decision: ["d1"], action: ["a1"], advice: ["v1"], evidence: ["e1"] },
      limitations: []
    },
    outcomePackage: {
      cueId: "c1",
      candidateId: "k1",
      outcomeFacts: [{ id: "o1", text: "这次接触后你被击杀。", outcomeKind: "DEATH" }],
      deathKillHpRefs: ["o1"],
      ...(withImpact ? { winProbabilityImpact: { text: "我方胜率下降 31 个百分点。", confidence: "HIGH", limitations: [] } } : {}),
      measurementRefs: withImpact ? ["m1"] : [],
      confounders: [],
      limitations: []
    }
  };
}

function completion(content: string, finishReason = "stop", status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function successContent() {
  return JSON.stringify({
    bundle: {
      cueId: "c1",
      candidateId: "k1",
      primaryFocusCode: FOCUS,
      currentSituation: { text: "你在 B小，手持步枪。", refs: ["d1"] },
      playerAction: { text: "你先从掩体拉出。", refs: ["a1"] },
      coreIssue: { text: "重点是先活过这次接触。", refs: ["d1", "a1"] },
      betterPlay: { text: "先预瞄，等队友补枪再拉。", refs: ["v1", "e1"] },
      outcomeImpact: { text: "这次接触后你被击杀，我方胜率下降。", refs: ["o1", "m1"] }
    }
  });
}

describe("DeepSeek five-field narrator provider", () => {
  it("accepts a single anonymous CoachingPackage+OutcomePackage and returns strict five fields", async () => {
    let seenInit: RequestInit | undefined;
    const result = await narrateWithDeepSeek(sampleRequest(), { DEEPSEEK_API_KEY: SECRET }, async (_input, init) => {
      seenInit = init;
      return completion(successContent());
    });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.bundle).toMatchObject({ cueId: "c1", candidateId: "k1", primaryFocusCode: FOCUS });
    expect(Object.keys(result.bundle).sort()).toEqual(["betterPlay", "candidateId", "coreIssue", "cueId", "currentSituation", "outcomeImpact", "playerAction", "primaryFocusCode"].sort());
    expect(result.bundle.outcomeImpact.refs).toEqual(["o1", "m1"]);
    const body = JSON.parse(String(seenInit?.body)) as { messages: Array<{ content: string }>; thinking: { type: string }; response_format: { type: string } };
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain("架枪、预瞄、小身位 peek、补枪、eco、强起");
    expect(body.messages[0].content).toContain("Never print primaryFocusCode");
    expect(body.messages[0].content).toContain("never return a narration field as a bare string");
    expect(body.messages[0].content).toContain("currentSituation={text:'...',refs:['d1']}");
    expect(body.messages[1].content).not.toMatch(/tick|frame|segment|route|order/i);
  });

  it("allows an OutcomePackage without WinProbabilityImpact and keeps measurement refs empty", async () => {
    const request = sampleRequest(false);
    expect(() => parseNarrationRequest(request)).not.toThrow();
    const result = await narrateWithDeepSeek(request, {}, vi.fn());
    expect(result.status).toBe("FALLBACK");
    expect(result.manifest.reason).toBe("MISSING_API_KEY");
    expect(result.bundle.coreIssue.text).not.toContain(FOCUS);
    expect(result.bundle.outcomeImpact.refs).toEqual(["o1"]);
    expect(result.bundle.outcomeImpact.text).toContain("这次接触后你被击杀");
  });

  it("combines outcome fact and WinProbabilityImpact text in deterministic fallback", async () => {
    const result = await narrateWithDeepSeek(sampleRequest(true), {}, vi.fn());
    expect(result.bundle.outcomeImpact.refs).toEqual(["o1", "m1"]);
    expect(result.bundle.outcomeImpact.text).toContain("这次接触后你被击杀");
    expect(result.bundle.outcomeImpact.text).toContain("我方胜率下降 31 个百分点");
  });

  it("returns traceable deterministic fallback for missing key, timeout, and schema failures", async () => {
    const request = sampleRequest();
    await expect(narrateWithDeepSeek(request, {}, vi.fn())).resolves.toMatchObject({ status: "FALLBACK", manifest: { reason: "MISSING_API_KEY", provider: "DETERMINISTIC" } });
    const timeout = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(narrateWithDeepSeek(request, { DEEPSEEK_API_KEY: SECRET }, vi.fn().mockRejectedValue(timeout))).resolves.toMatchObject({ status: "FALLBACK", manifest: { reason: "TIMEOUT" } });
    await expect(narrateWithDeepSeek(request, { DEEPSEEK_API_KEY: SECRET }, async () => completion(JSON.stringify({ bundle: {}, route: "forbidden" })))).resolves.toMatchObject({ status: "FALLBACK", manifest: { reason: "UPSTREAM_SCHEMA" } });
  });

  it.each([
    ["provider extra top-level field", { ...JSON.parse(successContent()), tick: 12 }],
    ["focus changed", { bundle: { ...JSON.parse(successContent()).bundle, primaryFocusCode: "INVENTED_FOCUS" } }],
    ["outcome ref in currentSituation", { bundle: { ...JSON.parse(successContent()).bundle, currentSituation: { text: "结果", refs: ["o1"] } } }],
    ["betterPlay lacks advice", { bundle: { ...JSON.parse(successContent()).bundle, betterPlay: { text: "证据", refs: ["e1"] } } }]
  ])("rejects %s and keeps the fallback bundle valid", async (_label, content) => {
    const result = await narrateWithDeepSeek(sampleRequest(), { DEEPSEEK_API_KEY: SECRET }, async () => completion(JSON.stringify(content)));
    expect(result.status).toBe("FALLBACK");
    expect(result.manifest.reason).toBe("UPSTREAM_SCHEMA");
    expect(() => parseNarrationRequest(sampleRequest())).not.toThrow();
  });
});
