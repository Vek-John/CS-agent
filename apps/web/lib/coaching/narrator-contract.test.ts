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
    bundle: {
      cueId: "c1",
      candidateId: "k1",
      primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
      currentSituation: { text: "你在 B小。", refs: ["d1"] },
      playerAction: { text: "你从掩体拉出。", refs: ["a1"] },
      coreIssue: { text: "先活过接触。", refs: ["d1", "a1"] },
      betterPlay: { text: "先预瞄，等队友补枪。", refs: ["v1"] },
      outcomeImpact: { text: "你被击杀，我方胜率下降。", refs: ["o1", "m1"] }
    },
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
    expect(result.bundle.betterPlay.refs).toEqual(["advice-1"]);
    expect(result.bundle.outcomeImpact.refs).toEqual(["outcome-1", "measurement-cue-final"]);
  });

  it("passes AbortSignal through and lets superseded work terminate without fallback", async () => {
    const prepared = context();
    const controller = new AbortController();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
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
