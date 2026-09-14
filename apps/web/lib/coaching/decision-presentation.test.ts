import { describe, expect, it } from "vitest";
import { decisionSnapshotFixture } from "../../../../libs/review-planner/src/teaching-gate-fixtures";
import { observableSituation, playerFacingLimitation } from "./decision-presentation";
import { buildThreeStageCoachingView } from "./cs2d-coaching-view";

const narration = {
  cueId: "c", candidateId: "k", primaryFocusCode: "REVIEW_UNCERTAINTY",
  currentSituation: { text: "当前只有你存活。", refs: ["d"] },
  playerAction: { text: "当前记录不足以确认具体行动意图。", refs: [] },
  coreIssue: { text: "结果本身不能证明选择有错。", refs: ["d"] },
  betterPlay: { text: "还缺少确认替代方案所需的条件。", refs: ["d"] },
  outcomeImpact: { text: "这段结果后我方胜率上升。", refs: ["o"] },
};

describe("bounded coaching situation presentation", () => {
  it("never projects hidden players, identities, timing coordinates, or unobservable objective state", () => {
    const snapshot = decisionSnapshotFixture();
    snapshot.players = [{ playerId: "secret-player", side: "CT", alive: true, health: 100, boundary: "APPLICABILITY_ONLY" }];
    snapshot.bomb = { ...snapshot.bomb, boundary: "GROUND_TRUTH", value: { state: "PLANTED", carriedBySelectedPlayer: false, remainingSeconds: 7 } };
    snapshot.clock = { ...snapshot.clock, boundary: "OUTCOME" };
    const projected = observableSituation({ decisionSnapshot: snapshot });
    expect(projected).toMatchObject({ allies: 1, enemies: 3, health: 2, objective: null, remainingSeconds: null });
    expect(JSON.stringify(projected)).not.toMatch(/secret-player|playerId|Tick|PLANTED|position/);
  });

  it("shows neutral assessment, public alive counts, clock and objective with rising outcome evidence", () => {
    const view = buildThreeStageCoachingView({ narration, outcomeFacts: [], semantics: {
      decisionSnapshot: decisionSnapshotFixture(),
      assessment: { kind: "INSUFFICIENT_EVIDENCE", confidence: 0.35, explanation: narration.coreIssue.text, supportingEvidenceRefs: ["d"], counterEvidenceRefs: ["o"], missingFields: [], limitations: ["缺少双方视线和交火时机。"], hasEvaluableDecision: false },
    } });
    expect(view.problem.title).toBe("暂时无法确定");
    expect(view.problem.confidence).toBe(0.35);
    expect(view.currentState.chips.map((chip) => chip.text)).toEqual(expect.arrayContaining(["我方 1 人 · 对方 3 人存活", "回合剩余 65 秒", "C4 已携带"]));
    expect(view.problem.consequences).toContain("这段结果后我方胜率上升。");
    expect(view.currentState.limitations).toContain("缺少双方视线和交火时机。");
  });

  it.each(["ObservationState", "renderer", "Worker", "Director", "PlanCompiler", "Viewer", "tick", "lossless", "TRADE", "refId", "schema", "focus", "pipeline", "fallback", "candidate"])("translates the internal limitation %s into normal language", (term) => {
    expect(playerFacingLimitation(term)).not.toContain(term);
  });
});
