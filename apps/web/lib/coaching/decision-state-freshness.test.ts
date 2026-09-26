import { describe, expect, it } from "vitest";
import type { WinProbabilityTimelineV1 } from "@cs-coach/contracts";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "./cs2d-coaching-view";

// All integer times below are synthetic fixtures, not measured Demo ticks.
type Kind = "DEATH" | "HP_CHANGE" | "WIN_RATE_DROP";
type StateMode = "stale" | "missing" | "fresh";
function buildScenario(kind: Kind, stateMode: StateMode) {
  const source = fireReplay(kind === "DEATH" ? "DEATH" : "HP_CHANGE", []);
  const original = source.rounds[0];
  const oldTick = stateMode === "stale" ? 1008 : stateMode === "missing" ? 1056 : 1064;
  const oldPlayer = { ...original.frames[0].players[0], health: 40, armor: 75, money: 1234, lastPlaceName: "Connector" };
  const frames = [
    { tick: oldTick, t: 0, players: [oldPlayer] },
    ...(stateMode === "missing" ? [{ tick: 1064, t: 0, players: [] }] : []),
    { tick: 1408, t: 0, players: [{ ...oldPlayer, health: kind === "DEATH" ? 0 : kind === "HP_CHANGE" ? 10 : 40, alive: kind !== "DEATH" }] },
  ];
  const probability: WinProbabilityTimelineV1 = {
    version: "win-probability-timeline.v1", status: "AVAILABLE", tickRate: 64,
    model: { provider: "CS_NET", revision: "synthetic", assetUrl: "/synthetic.onnx", assetSha256: "a".repeat(64), assetBytes: 1, quantization: "INT8", temperature: 1, sourceCommit: "synthetic", featureVersion: "synthetic" },
    rounds: [{ roundNumber: 1, startTick: 1000, endTick: 1800, winner: "CT", economy: { ct: "FULL", t: "FULL", ctValue: 20000, tValue: 20000 }, samples: [
      { tick: 1064, probability: 0.3, roundNumber: 1, side: "CT", source: "CS_NET" },
      { tick: 1408, probability: 0.6, roundNumber: 1, side: "CT", source: "CS_NET" },
    ] }],
    swings: [{ id: "synthetic-drop", tick: 1408, before: 0.3, after: 0.6, delta: 0.3, direction: "UP", cause: "PLAYER_DEATH", selectedPlayerDeath: false, victimSide: "T", economy: "FULL" }], limitations: [],
  };
  const bundle = buildCs2dAnalysisBundle({ replay: { ...source, rounds: [{ ...original, frames }] }, selectedSteamId: self, demoId: `synthetic-freshness-${kind}-${stateMode}`,
    ...(kind === "WIN_RATE_DROP" ? { winProbabilityTimeline: probability } : {}) });
  return { bundle, oldTick };
}

function scenario(kind: Kind, stateMode: StateMode) {
  const { bundle, oldTick } = buildScenario(kind, stateMode);
  const cue = bundle.review_plan.cues[0];
  expect(cue).toBeDefined();
  const material = bundle.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const coaching = buildCoachingPackage(cue, bundle.candidate_set, bundle.observation_evidence);
  const narration = deterministicNarrationBundle(coaching, buildOutcomePackage(cue, bundle.candidate_set, bundle.outcome_impacts.find(impact => impact.cueId === cue.id)));
  const decisionState = playerStateAtOrBefore(bundle.match_timeline.player_state_tracks ?? [], self, cue.decision_tick);
  const view = buildThreeStageCoachingView({ narration, decisionState, decisionTick: cue.decision_tick,
    decisionFacts: buildCoachingCueView(cue, false).decisionFacts, semantics: { ...material, ...cue }, callout: material.callout, outcomeFacts: [] });
  return { bundle, cue, material, coaching, narration, decisionState, view, oldTick };
}

describe("current coaching state freshness through the real adapter", () => {
  for (const kind of ["WIN_RATE_DROP"] as const) {
    for (const mode of ["stale", "missing"] as const) {
      it(`${kind}: ${mode} selected-player frame does not become current resource chips`, () => {
        const { cue, material, decisionState, view, oldTick } = scenario(kind, mode);
        expect(cue.decision_tick).toBe(1064);
        expect(decisionState?.tick).toBe(oldTick);
        expect(material.decisionSnapshot?.selectedPlayer.value).toBeNull();
        expect(view.currentState.limitations).toContain("无法确认该决策点的当前玩家状态，暂不展示生命、护甲等资源。");
        expect(JSON.stringify(view.currentState)).not.toMatch(/40 HP|75 头甲|1,234/);
        expect(view.currentState.chips.filter(chip => ["health", "armor", "money", "weapon", "utility", "location"].includes(chip.kind))).toEqual([]);
      });

      it(`${kind}: ${mode} selected-player frame is already excluded from facts and narration`, () => {
        const { cue, material, coaching, narration } = scenario(kind, mode);
        expect(material.decisionSnapshot?.selectedPlayer.value).toBeNull();
        expect(material.callout).toBeUndefined();
        const decisionText = [
          ...coaching.decisionContext.facts.map(fact => fact.text),
          ...buildCoachingCueView(cue, false).decisionFacts.map(fact => fact.text),
          narration.currentSituation.text,
        ].join(" ");
        expect(decisionText).not.toMatch(/40 HP|75 甲|1234|拱门|连接/);
        expect(material.decisionSnapshot?.selectedPlayer.evidenceRefs).toEqual([]);
      });
    }
  }

  it.each(["DEATH", "HP_CHANGE"] as const)("does not invent a teachable %s cue when both player state and independent context are absent", kind => {
    for (const mode of ["stale", "missing"] as const) {
      const { bundle } = buildScenario(kind, mode);
      expect(bundle.review_plan.cues).toEqual([]);
      expect(bundle.candidate_set.materials.length).toBeGreaterThan(0);
      expect(bundle.candidate_set.materials.every(material => material.decisionSnapshot?.selectedPlayer.value === null)).toBe(true);
      expect(bundle.candidate_set.materials.flatMap(material => material.decisionFacts).map(fact => fact.text).join(" ")).not.toMatch(/40 HP|75 甲|1234/);
    }
  });

  it("retains resources when the decision is legitimately bound to the same pre-outcome sample", () => {
    const { cue, material, decisionState, view, narration } = scenario("DEATH", "fresh");
    expect(cue.decision_tick).toBe(1064);
    expect(decisionState?.tick).toBe(1064);
    expect(material.decisionSnapshot?.selectedPlayer.value?.health).toBe(40);
    expect(view.currentState.chips.map(chip => chip.text)).toContain("40 HP");
    expect(view.currentState.chips.map(chip => chip.text)).toContain("75 头甲");
    expect(view.currentState.chips.map(chip => chip.text)).toContain("$1,234");
    expect(narration.currentSituation.text).toContain("40 HP");
  });
});
