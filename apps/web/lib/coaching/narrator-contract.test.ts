import { describe, expect, it, vi } from "vitest";
import type { CoachingPackage, OutcomePackage } from "@cs-coach/contracts";
import { buildNarratorRequestContext, requestNarrationBundle } from "./narrator-contract";

function context() {
  const coaching: CoachingPackage = {
    cueId: "cue-final",
    candidateId: "candidate-final",
    decisionContext: { facts: [{ id: "decision-1", text: "决策时在 B小。", availability: "DECISION", available_at_tick: 100, source: "DEMO", observed_by_player: true }], claims: [] },
    playerAction: [{ id: "action-1", text: "你从掩体拉出。", actorPlayerId: "p-user", availableAtTick: 100, source: "DEMO", evidenceRefs: ["evidence-1"], limitations: [] }],
    inferences: [],
    advice: [{ id: "advice-1", text: "先预瞄，等队友补枪。", trigger: "进入枪线时", fact_refs: ["decision-1"] }],
    evidence: [{ id: "evidence-1", source: "RULE", label: "决策证据", fact_refs: ["decision-1"] }],
    primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
    allowedRefs: { decision: ["decision-1"], action: ["action-1"], advice: ["advice-1"], evidence: ["evidence-1"] },
    limitations: []
  };
  const outcome: OutcomePackage = {
    cueId: "cue-final",
    candidateId: "candidate-final",
    outcomeFacts: [{ id: "outcome-1", text: "结果窗口内你被击杀。", availableAtTick: 120, source: "DEMO", outcomeKind: "DEATH", evidenceRefs: ["outcome-1"], limitations: [] }],
    deathKillHpRefs: ["outcome-1"],
    winProbabilityImpact: { cueId: "cue-final", beforeProbability: 0.7, afterProbability: 0.4, delta: -0.3, percentagePoints: -30, relativeChange: -0.42, attribution: "SELECTED_PLAYER_DEATH", confidence: "HIGH", text: "我方胜率下降。", limitations: [] },
    measurementRefs: ["measurement-cue-final"],
    confounders: [],
    limitations: []
  };
  return buildNarratorRequestContext(coaching, outcome);
}

function providerResponse() {
  return {
    status: "SUCCEEDED",
    bundle: context().request.approvedNarration,
    manifest: { status: "SUCCEEDED", provider: "DEEPSEEK", model: "deepseek-v4-flash", promptVersion: "provider/1", limitations: [] }
  };
}

describe("client narrator alias seam", () => {
  it("maps anonymous refs back to the final real package and validates all five fields", async () => {
    const prepared = context();
    const result = await requestNarrationBundle(prepared, { fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify(providerResponse()))) });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.bundle.cueId).toBe("cue-final");
    expect(result.bundle.candidateId).toBe("candidate-final");
    expect(result.bundle.currentSituation.refs).toEqual(["decision-1"]);
    expect(result.bundle.playerAction.refs).toEqual(["action-1"]);
    expect(result.bundle.betterPlay.refs).toEqual(context().request.approvedNarration?.betterPlay.refs.map((ref) => ref === "v1" ? "advice-1" : ref === "e1" ? "evidence-1" : "decision-1"));
    expect(result.bundle.outcomeImpact.refs).toEqual(["outcome-1", "measurement-cue-final"]);
  });

  it("passes AbortSignal through and lets superseded work terminate without fallback", async () => {
    const prepared = context();
    const controller = new AbortController();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      throw abort;
    });
    await expect(requestNarrationBundle(prepared, { fetcher, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("falls back when top-level and manifest status or manifest keys disagree", async () => {
    const prepared = context();
    const bad = { ...providerResponse(), status: "FALLBACK", manifest: { ...providerResponse().manifest, status: "SUCCEEDED", unexpected: true } };
    const result = await requestNarrationBundle(prepared, { fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify(bad))) });
    expect(result.status).toBe("FALLBACK");
    expect(result.manifest.reason).toBe("CLIENT_SCHEMA");
    expect(result.bundle.outcomeImpact.text).toContain("我方胜率下降。");
  });
});


describe("bounded preparation transport regression", () => {
  it.each(["fetch", "body"] as const)("settles a hung %s at the client deadline even if abort is ignored", async stage => {
    vi.useFakeTimers();
    try {
      const never = new Promise<Response>(() => {});
      const fetcher = vi.fn(() => stage === "fetch" ? never : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response));
      let settled = false;
      const pending = requestNarrationBundle(context(), { fetcher }).then(value => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(true);
      expect((await pending).manifest).toMatchObject({ status: "FALLBACK", reason: "LOCAL_REQUEST_TIMEOUT" });
    } finally { vi.useRealTimers(); }
  });
});


it("does not request or return fallback when the client parent is already cancelled", async () => {
  const parent = new AbortController(); parent.abort(); const fetcher = vi.fn();
  await expect(requestNarrationBundle(context(), { fetcher, signal: parent.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("exits the client on parent cancellation even when fetch ignores abort", async () => {
  vi.useFakeTimers();
  try {
    const parent = new AbortController();
    const pending = requestNarrationBundle(context(), { fetcher: () => new Promise(() => {}), signal: parent.signal }).catch(error => error);
    parent.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});


it.each(["http", "bad-body"] as const)("retains the client fallback reason for %s", async mode => {
  const fetcher = async () => mode === "http" ? new Response(null, { status: 503 })
    : Object.assign(new Response(), { json: async () => { throw new SyntaxError("bad-body"); } });
  const result = await requestNarrationBundle(context(), { fetcher });
  expect(result.manifest).toMatchObject({ status: "FALLBACK", reason: mode === "http" ? "HTTP_503" : "CLIENT_SCHEMA" });
});
