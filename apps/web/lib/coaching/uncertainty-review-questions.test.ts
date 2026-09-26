import { expect, it } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle, assertValidNarrationBundle } from "@cs-coach/review-planner";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { uncertaintyReviewQuestions } from "./decision-presentation";
import { buildThreeStageCoachingView } from "./cs2d-coaching-view";
import type { DecisionCheck } from "@cs-coach/contracts";
function scenario(grenades: string[] = []) {
  // Synthetic fixture coordinates are not parsed Demo ticks.
  const source = fireReplay("DEATH");
  const analysis = buildCs2dAnalysisBundle({ replay: { ...source, rounds: source.rounds.map(round => ({ ...round,
    frames: round.frames.map(frame => ({ ...frame, players: frame.players.map(player => ({ ...player, grenades, grenadeInventoryVersion: 1 as const })) })),
  })) }, selectedSteamId: self, demoId: "uncertainty-questions" });
  const cue = analysis.review_plan.cues[0]; expect(cue.assessment?.kind).toBe("INSUFFICIENT_EVIDENCE");
  const material = analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const coaching = buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence);
  const outcome = buildOutcomePackage(cue, analysis.candidate_set, analysis.outcome_impacts.find(item => item.cueId === cue.id));
  const narration = deterministicNarrationBundle(coaching, outcome);
  const semantics = { ...material, ...cue };
  return { cue, coaching, outcome, narration, semantics };
}
it("projects concrete review questions from the actual uncertain Adapter route without approving advice", () => {
  const f = scenario(); const before = JSON.stringify(f);
  const view = buildThreeStageCoachingView({ narration: f.narration, semantics: f.semantics, decisionTick: f.cue.decision_tick, outcomeFacts: [] });
  expect(view.improvement.reviewQuestions.length).toBeGreaterThan(0);
  expect(view.improvement.reviewQuestions.length).toBeLessThanOrEqual(3);
  expect(view.improvement.reviewQuestions.join(" ")).toContain("当时的回合时间");
  expect(view.improvement.reviewQuestions.join(" ")).not.toMatch(/手里的闪光|携带情况/); // Known empty inventory, not missing inventory.
  expect(view.improvement.text).toBe(f.narration.betterPlay.text);
  expect(f.cue.advice).toEqual([]); expect(f.cue.assessment?.hasEvaluableDecision).toBe(false);
  expect(() => assertValidNarrationBundle(f.narration, f.coaching, f.outcome)).not.toThrow();
  expect(JSON.stringify(f)).toBe(before);
  expect(uncertaintyReviewQuestions(JSON.parse(JSON.stringify(f.semantics)), f.cue.decision_tick)).toEqual(view.improvement.reviewQuestions);
});
it("uses only recognized unresolved conditions, never raw reasons or outcome-only checks", () => {
  const f = scenario();
  const check = (code: string, status: DecisionCheck["status"], boundary: DecisionCheck["boundary"] = "OBSERVABLE"): DecisionCheck => ({ code, status, boundary, reason: "hidden identity secret marker", missingFields: ["raw_unknown_key"], evidenceRefs: [] });
  const semantics = { ...f.semantics, decisionSnapshot: { ...f.semantics.decisionSnapshot!, supportChecks: [check("tradeWindow", "UNVERIFIABLE"), check("teammateAlive", "INAPPLICABLE"), check("flashAvailable", "INAPPLICABLE")],
    pressureChecks: [check("objectiveAllowsDelay", "UNVERIFIABLE", "OUTCOME")], spatialChecks: [check("providerInventedCondition", "UNVERIFIABLE")] } };
  const questions = uncertaintyReviewQuestions(semantics, f.cue.decision_tick);
  expect(questions).toEqual(["你当时想完成什么，依据的是哪些已知信息？"]);
  expect(questions.join(" ")).not.toMatch(/队友|hidden|raw_unknown|providerInvented/);
});
it("does not reopen a resolved or contradictory condition as an unknown question", () => {
  const f = scenario(), snapshot = f.semantics.decisionSnapshot!;
  const unresolved = snapshot.pressureChecks.find(item => item.code === "objectiveAllowsDelay")!;
  const semantics = { ...f.semantics, decisionSnapshot: { ...snapshot, pressureChecks: [unresolved, { ...unresolved, status: "APPLICABLE" as const }] } };
  expect(uncertaintyReviewQuestions(semantics, f.cue.decision_tick).join(" ")).not.toContain("回合时间");
});
it("does not show questions for a different decision, missing snapshot or an evaluable judgement", () => {
  const f = scenario();
  expect(uncertaintyReviewQuestions(f.semantics, f.cue.decision_tick + 1)).toEqual([]);
  expect(uncertaintyReviewQuestions({ ...f.semantics, decisionSnapshot: undefined }, f.cue.decision_tick)).toEqual([]);
  expect(uncertaintyReviewQuestions({ ...f.semantics, assessment: { ...f.cue.assessment!, kind: "POSITIVE_PROCESS", hasEvaluableDecision: true } }, f.cue.decision_tick)).toEqual([]);
  expect(uncertaintyReviewQuestions({ ...f.semantics, decisionSnapshot: { ...f.semantics.decisionSnapshot!, sampledAtTick: f.cue.decision_tick + 1 } }, f.cue.decision_tick)).toEqual([]);
});

it("asks about flash purpose only when the current observable inventory confirms a flash", () => {
  const f = scenario(["Flash"]);
  const questions = uncertaintyReviewQuestions(f.semantics, f.cue.decision_tick);
  expect(questions.join(" ")).toContain("如果考虑手里的闪光");
  const snapshot = f.semantics.decisionSnapshot!;
  const hiddenInventory = { ...f.semantics, decisionSnapshot: { ...snapshot, selectedPlayer: { ...snapshot.selectedPlayer, boundary: "APPLICABILITY_ONLY" as const } } };
  expect(uncertaintyReviewQuestions(hiddenInventory, f.cue.decision_tick).join(" ")).not.toContain("手里的闪光");
});
