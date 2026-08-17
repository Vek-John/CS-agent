import { describe, expect, it, vi } from "vitest";
import {
  narrateWithDeepSeek,
  parseNarrationRequest,
  type NarrationRequest
} from "./deepseek-narration";

const SECRET = "test-only-deepseek-secret";

function sampleRequest(): NarrationRequest {
  return {
    cues: [
      {
        cue_id: "c1",
        cue_type: "DECISION",
        facts: [
          {
            id: "f1",
            text: "决策时你在 B小，有 65 HP 和 80 甲，手持步枪。",
            availability: "DECISION",
            observed_by_player: true
          }
        ],
        inferences: [
          {
            id: "i1",
            text: "B小这次先架住首接触位，队友能跟上再拉。",
            confidence: 0.8,
            fact_refs: ["f1"]
          }
        ],
        advice: [
          {
            id: "a1",
            text: "先预瞄，等队友能补枪再拉出去。",
            trigger: "B小准备进入下一条枪线时",
            fact_refs: ["f1"],
            rule_id: "r1"
          }
        ],
        limitations: ["没有把未确认的敌方位置当作事实。"]
      }
    ]
  };
}

function completion(content: string, finishReason = "stop", status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content } }]
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

function successContent() {
  return JSON.stringify({
    items: [{
      cue_id: "c1",
      title: "B小先架枪",
      explanation: "你现在先预瞄首接触位，队友能补枪再拉出去。"
    }]
  });
}

function multiCueRequest(count: number): NarrationRequest {
  const cue = sampleRequest().cues[0];
  return {
    cues: Array.from({ length: count }, (_, index) => ({
      ...cue,
      cue_id: `c${index + 1}`
    }))
  };
}

function multiCueSuccessContent(request: NarrationRequest): string {
  return JSON.stringify({
    items: request.cues.map((cue, index) => ({
      cue_id: cue.cue_id,
      title: `第 ${index + 1} 个决策点`,
      explanation: "基于当前决策事实，保留退路。"
    }))
  });
}

describe("DeepSeek narration provider", () => {
  it("sends only bounded anonymous decision material with required request controls", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const result = await narrateWithDeepSeek(
      sampleRequest(),
      { DEEPSEEK_API_KEY: SECRET },
      async (input, init) => {
        seenUrl = String(input);
        seenInit = init;
        return completion(successContent());
      }
    );

    expect(result).toEqual({
      status: "SUCCEEDED",
      items: [{
        cue_id: "c1",
        title: "B小先架枪",
        explanation: "你现在先预瞄首接触位，队友能补枪再拉出去。"
      }],
      model: "deepseek-v4-flash",
      manifest: { model: "deepseek-v4-flash", prompt_version: "deepseek-cue-narration/1.2.0" }
    });
    expect(seenUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${SECRET}` }));

    const body = JSON.parse(String(seenInit?.body)) as {
      model: string;
      temperature: number;
      max_tokens: number;
      thinking: { type: string };
      response_format: { type: string };
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(2400);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain('top-level object must contain exactly one key named items');
    expect(body.messages[0].content).toContain('{"items":');
    expect(body.messages[0].content).toContain("experienced CS2 player or streamer");
    expect(body.messages[0].content).toContain("short, concrete and conversational");
    expect(body.messages[0].content).toContain("B小、警家、中路");
    expect(body.messages[0].content).toContain("架枪、预瞄、拉出去、补枪、头甲、eco、磕枪、换位");
    expect(body.messages[0].content).toContain("空间控制、资源关系、风险暴露");
    const userPayload = body.messages[1].content;
    expect(userPayload).toContain('"cue_id":"c1"');
    expect(userPayload).toContain('"id":"f1"');
    expect(userPayload).not.toMatch(/player_id|observer_player_id|steam_id|display_name|demo_id|path|outcome|tick|decision_tick|world_position/i);
    expect(userPayload).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("does not call upstream when the server secret is missing", async () => {
    const fetcher = vi.fn();
    const result = await narrateWithDeepSeek(sampleRequest(), {}, fetcher);

    expect(result).toEqual({ status: "DISABLED", items: [], reason: "MISSING_API_KEY" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses only the allowlisted model names", async () => {
    const fetcher = vi.fn();
    const result = await narrateWithDeepSeek(sampleRequest(), {
      DEEPSEEK_API_KEY: SECRET,
      DEEPSEEK_MODEL: "deepseek-v4-secret-experimental"
    }, fetcher);

    expect(result).toEqual({ status: "FALLBACK", items: [], reason: "MODEL_NOT_ALLOWED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts and maps a 15-cue request as one bounded provider call", async () => {
    const request = multiCueRequest(15);
    const result = await narrateWithDeepSeek(
      request,
      { DEEPSEEK_API_KEY: SECRET },
      async () => completion(multiCueSuccessContent(request))
    );

    expect(result.status).toBe("SUCCEEDED");
    expect(result.items).toHaveLength(15);
    expect(result.items.map((item) => item.cue_id)).toEqual(
      Array.from({ length: 15 }, (_, index) => `c${index + 1}`)
    );
    expect(result.manifest).toEqual({
      model: "deepseek-v4-flash",
      prompt_version: "deepseek-cue-narration/1.2.0"
    });
  });

  it("accepts supported C4 and A1 terms in concise player-style output", async () => {
    const request = sampleRequest();
    request.cues[0].facts[0].text = "决策时你在 A1，携带 C4，队友可以补枪。";
    const content = JSON.stringify({
      items: [{
        cue_id: "c1",
        title: "A1先架枪再带包走",
        explanation: "你现在先在 A1 架住，队友能补枪再带 C4 往前走。"
      }]
    });
    const result = await narrateWithDeepSeek(
      request,
      { DEEPSEEK_API_KEY: SECRET },
      async () => completion(content)
    );

    expect(result.status).toBe("SUCCEEDED");
    expect(result.items[0]).toEqual({
      cue_id: "c1",
      title: "A1先架枪再带包走",
      explanation: "你现在先在 A1 架住，队友能补枪再带 C4 往前走。"
    });
  });

  it("keeps deterministic fallback for timeout, HTTP, invalid JSON, and non-stop completion", async () => {
    const timeoutError = Object.assign(new Error("request aborted"), { name: "AbortError" });
    await expect(narrateWithDeepSeek(sampleRequest(), { DEEPSEEK_API_KEY: SECRET }, vi.fn().mockRejectedValue(timeoutError)))
      .resolves.toEqual({ status: "FALLBACK", items: [], model: "deepseek-v4-flash", reason: "TIMEOUT" });
    await expect(narrateWithDeepSeek(sampleRequest(), { DEEPSEEK_API_KEY: SECRET }, async () => new Response("upstream secret", { status: 502 })))
      .resolves.toEqual({ status: "FALLBACK", items: [], model: "deepseek-v4-flash", reason: "UPSTREAM_HTTP" });
    await expect(narrateWithDeepSeek(sampleRequest(), { DEEPSEEK_API_KEY: SECRET }, async () => completion("not-json")))
      .resolves.toEqual({ status: "FALLBACK", items: [], model: "deepseek-v4-flash", reason: "UPSTREAM_JSON" });
    await expect(narrateWithDeepSeek(sampleRequest(), { DEEPSEEK_API_KEY: SECRET }, async () => completion(successContent(), "length")))
      .resolves.toEqual({ status: "FALLBACK", items: [], model: "deepseek-v4-flash", reason: "UPSTREAM_FINISH" });
  });

  it.each([
    ["extra response field", JSON.stringify({ items: [{ cue_id: "c1", title: "t", explanation: "e", extra: "no" }] })],
    ["wrong cue alias", JSON.stringify({ items: [{ cue_id: "c2", title: "t", explanation: "e" }] })],
    ["duplicate response alias", JSON.stringify({ items: [{ cue_id: "c1", title: "t", explanation: "e" }, { cue_id: "c1", title: "t2", explanation: "e2" }] })],
    ["future outcome wording", JSON.stringify({ items: [{ cue_id: "c1", title: "t", explanation: "随后被击杀，结果是失败。" }] })],
    ["future tick", JSON.stringify({ items: [{ cue_id: "c1", title: "t", explanation: "tick 123 之后再看。" }] })],
    ["coordinate leak", JSON.stringify({ items: [{ cue_id: "c1", title: "t", explanation: "坐标 (120.5, -30) 显示在这里。" }] })],
    ["path leak", JSON.stringify({ items: [{ cue_id: "c1", title: "t", explanation: "详见 /tmp/private.dem。" }] })],
    ["URL leak", JSON.stringify({ items: [{ cue_id: "c1", title: "t", explanation: "参考 https://example.test。" }] })],
    ["unknown stable alias", JSON.stringify({ items: [{ cue_id: "c1", title: "t", explanation: "请查看 player_76561197964020430。" }] })],
    ["unknown anonymous alias", JSON.stringify({ items: [{ cue_id: "c1", title: "t", explanation: "请结合 f2 再判断。" }] })],
    ["question prompt", JSON.stringify({ items: [{ cue_id: "c1", title: "t", explanation: "你会怎么做？" }] })]
  ])("rejects %s without returning upstream details", async (_label, content) => {
    const result = await narrateWithDeepSeek(sampleRequest(), { DEEPSEEK_API_KEY: SECRET }, async () => completion(content));

    expect(result).toEqual({ status: "FALLBACK", items: [], model: "deepseek-v4-flash", reason: "UPSTREAM_SCHEMA" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("upstream");
  });

  it("rejects stable IDs, privilege fields, escaped references, and explicit tick text at the boundary", () => {
    const base = sampleRequest();
    expect(() => parseNarrationRequest({ ...base, player_id: "76561197964020430" })).toThrow();
    expect(() => parseNarrationRequest({ cues: [{ ...base.cues[0], decision_tick: 123 }] })).toThrow();
    expect(() => parseNarrationRequest({ cues: [{ ...base.cues[0], facts: [{ ...base.cues[0].facts[0], world_position: { x: 1, y: 2, z: 3 } }] }] })).toThrow();
    expect(() => parseNarrationRequest({ cues: [{ ...base.cues[0], cue_id: "c-76561197964020430" }] })).toThrow();
    expect(() => parseNarrationRequest({ cues: [{ ...base.cues[0], cue_id: "c12345678901234567890" }] })).toThrow();
    expect(() => parseNarrationRequest({ cues: [{ ...base.cues[0], inferences: [{ ...base.cues[0].inferences[0], fact_refs: ["f2"] }] }] })).toThrow();
    expect(() => parseNarrationRequest({ cues: [{ ...base.cues[0], facts: [{ ...base.cues[0].facts[0], text: "当前 tick 123 的位置" }] }] })).toThrow();
    expect(() => parseNarrationRequest({ cues: [{ ...base.cues[0], advice: [{ ...base.cues[0].advice[0], trigger: "tick=123 后" }] }] })).toThrow();
    for (const text of [
      "参考 https://example.test/demo.dem",
      "详见 /tmp/private.dem",
      "player_76561197964020430",
      "随后被击杀，结果是失败"
    ]) {
      expect(() => parseNarrationRequest({ cues: [{ ...base.cues[0], facts: [{ ...base.cues[0].facts[0], text }] }] })).toThrow();
    }
    expect(() => parseNarrationRequest({
      cues: [{
        ...base.cues[0],
        advice: [{ ...base.cues[0].advice[0], text: "下一次如果信息不足，就先保留撤退路线。" }]
      }]
    })).not.toThrow();
  });

  it("rejects more than thirty-two cues and oversized serialized input", () => {
    const base = sampleRequest().cues[0];
    const cues = Array.from({ length: 33 }, (_, index) => ({ ...base, cue_id: `c${index + 1}` }));
    expect(() => parseNarrationRequest({ cues })).toThrow(/1 to 32 cues/);
    expect(() => parseNarrationRequest({ cues: [{ ...base, cue_id: "c33" }] })).toThrow();
    expect(() => parseNarrationRequest(sampleRequest(), 64 * 1024 + 1)).toThrow();
  });
});
