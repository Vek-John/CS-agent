import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import {
  buildCoachingCueView,
  buildThreeStageCoachingView,
  hasMeaningfulWinRateImpact,
  playerStateAtOrBefore,
  selectPresentableNarration
} from "./cs2d-coaching-view";

const cue = createFixtureReviewPlan(createSyntheticMirageTimeline()).cues[0];
const preparedNarration = {
  cueId: cue.id,
  candidateId: "candidate-fixture",
  primaryFocusCode: "SURVIVE_CONTACT",
  currentSituation: { text: "当前情况", refs: ["fact-r2-4v3"] },
  playerAction: { text: "玩家动作", refs: ["action-r2"] },
  coreIssue: { text: "核心问题", refs: ["fact-r2-4v3", "action-r2"] },
  betterPlay: { text: "更好的处理", refs: ["advice-r2-reset"] },
  outcomeImpact: { text: "结果影响", refs: ["fact-r2-outcome"] }
} as const;

describe("cs2d paused coaching cue view", () => {
  it("keeps outcome facts locked before playback completes", () => {
    const view = buildCoachingCueView(cue, false);

    expect(view.decisionFacts.map((fact) => fact.id)).toEqual([
      "fact-r2-4v3",
      "fact-r2-spacing"
    ]);
    expect(view.outcomeFacts).toEqual([]);
    expect(view.question).toContain("当前是 4 打 3");
  });

  it("reveals only typed outcome facts after the endpoint", () => {
    const view = buildCoachingCueView({
      ...cue,
      facts: [
        ...cue.facts,
        {
          id: "fact-too-early",
          text: "不应显示的过早结果",
          availability: "OUTCOME",
          available_at_tick: cue.reveal_tick - 1,
          source: "DEMO",
          observed_by_player: true
        },
        {
          id: "fact-too-late",
          text: "不应显示的未来结果",
          availability: "OUTCOME",
          available_at_tick: cue.outcome_end_tick + 1,
          source: "DEMO",
          observed_by_player: true
        }
      ]
    }, true);

    expect(view.outcomeFacts.map((fact) => fact.id)).toEqual(["fact-r2-outcome"]);
    expect(view.outcomeFacts[0].availability).toBe("OUTCOME");
    expect(view.advice?.text).toContain("队友可补枪");
  });

  it("keeps the five-field narration body hidden before completion and during replay", () => {
    const gate = { cueId: cue.id, outcomeEndTick: cue.outcome_end_tick, status: "LOCKED" as const };
    expect(selectPresentableNarration(cue, "PAUSED_FOR_COACHING", gate)).toBeUndefined();
    expect(selectPresentableNarration(cue, "REPLAYING", { ...gate, status: "COMPLETE" }, preparedNarration)).toBeUndefined();
    expect(selectPresentableNarration(cue, "PAUSED_FOR_COACHING", { ...gate, status: "COMPLETE" })).toBeUndefined();
    const narration = selectPresentableNarration(cue, "PAUSED_FOR_COACHING", { ...gate, status: "COMPLETE" }, preparedNarration);
    expect(narration).toEqual(preparedNarration);
    expect(buildCoachingCueView(cue, { ...gate, status: "COMPLETE" }, preparedNarration).narration).toEqual(preparedNarration);
  });

  it("projects the five evidence fields into three short player-facing sections", () => {
    const decisionState = {
      player_id: "p-user",
      tick: 900,
      side: "T" as const,
      world_position: { x: 1, y: 2, z: 3 },
      yaw: 0,
      pitch: 0,
      alive: true,
      health: 100,
      armor: 100,
      has_helmet: true,
      money: 400,
      equipment_value: 5500,
      active_item: { item_id: "weapon_c4", item_class: "BOMB" },
      inventory: [],
      carries_c4: true,
      fact_refs: [],
      missing_fields: []
    };
    const view = buildThreeStageCoachingView({
      narration: {
        ...preparedNarration,
        primaryFocusCode: "OBJECTIVE_TIMING",
        playerAction: { text: "你在这段窗口内执行了目标点相关操作。", refs: ["action-r2"] },
        coreIssue: { text: "重点是 OBJECTIVE_TIMING，回到决策时的事实和动作。", refs: ["fact-r2-4v3", "action-r2"] },
        betterPlay: { text: "先让队友架住，再开始下包。", refs: ["advice-r2-reset"] },
        outcomeImpact: { text: "我方胜率从 94% 到 94%，上升 0 个百分点。", refs: ["fact-r2-outcome"] }
      },
      decisionState,
      callout: "A 包点",
      outcomeFacts: [{ id: "fact-r2-outcome", text: "你随后完成下包。", availability: "OUTCOME", available_at_tick: cue.outcome_end_tick, source: "DEMO", observed_by_player: true }],
      outcomeImpact: { cueId: cue.id, beforeProbability: 0.944, afterProbability: 0.9444, delta: 0.0004, percentagePoints: 0, relativeChange: 0.0004, attribution: "ROUND_CONTEXT", confidence: "LOW", text: "我方胜率从 94% 到 94%，上升 0 个百分点。", limitations: [] }
    });

    expect(view.currentState.chips.map((chip) => chip.text)).toEqual(["A 包点", "100 HP", "100 头甲", "C4", "无道具", "$400"]);
    expect(view.problem.text).toContain("队友没到位");
    expect(view.problem.text).not.toContain("OBJECTIVE_TIMING");
    expect(view.problem.consequences).toEqual(["你随后完成下包。"]);
    expect(view.improvement.text).toBe("先让队友架住，再开始下包。");
  });

  it("shows only meaningful win-rate movement and picks the last decision state", () => {
    const baseState = {
      player_id: "p-user", tick: 800, side: "CT" as const, world_position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
      alive: true, health: 80, armor: 50, has_helmet: false, inventory: [], fact_refs: [], missing_fields: []
    };
    expect(playerStateAtOrBefore([{ ...baseState, tick: 700 }, baseState, { ...baseState, tick: 950, health: 10 }], "p-user", 900)?.health).toBe(80);
    expect(hasMeaningfulWinRateImpact({ cueId: cue.id, beforeProbability: 0.7, afterProbability: 0.69, delta: -0.01, percentagePoints: -1, relativeChange: -0.01, attribution: "MODEL_SWING", confidence: "MEDIUM", text: "下降 1 个百分点。", limitations: [] })).toBe(true);
    expect(hasMeaningfulWinRateImpact({ cueId: cue.id, beforeProbability: 0.7, afterProbability: 0.699, delta: -0.001, percentagePoints: 0, relativeChange: -0.001, attribution: "ROUND_CONTEXT", confidence: "LOW", text: "下降 0 个百分点。", limitations: [] })).toBe(false);
  });
});
