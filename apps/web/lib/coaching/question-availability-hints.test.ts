import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "./cs2d-coaching-view";
import { CurrentCueResourceCache } from "./current-cue-resource-source";
import { buildTeachingDiagnosisInput } from "./teaching-diagnosis-host";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CurrentCueQuestionsPanel } from "../../components/playback/current-cue-questions-panel";
import { availableCurrentCueResourceQuestions, answerGroundedCueQuestion, buildCurrentCueQuestionContext, CURRENT_CUE_QUESTIONS } from "./current-cue-questions";

it("does not advertise unavailable resources when no current resource questions are supplied", () => {
  const html = renderToStaticMarkup(createElement(CurrentCueQuestionsPanel, { state: { key: "empty", draft: "", turns: [] }, onDraft() {}, onAsk() {} }));
  expect(html).not.toContain("血量、护甲、道具数量和决策前弹匣记录");
  expect(html).not.toContain("也可问");
  for (const question of CURRENT_CUE_QUESTIONS) expect(html).toContain(question);
});



function fixture(withKinds = false) {
  // Synthetic samples, never parsed Demo measurements.
  const source = fireReplay("DEATH");
  const replay = { ...source, rounds: source.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame,
    players: frame.players.map(player => ({ ...player, ...(withKinds ? { grenadeInventoryVersion: 1 as const, grenades: ["Flash"] } : {}) })),
    clock: { source: "SOURCE2_GAMERULES" as const, sampledAtTick: frame.tick, serverTick: frame.tick, tickInterval: 1 / 64,
      roundStartTimeSeconds: round.startTick / 64, roundDurationSeconds: 115, roundsPlayed: 0, freeze: false, warmup: false,
      bombPlanted: false, roundWinStatus: 0, paused: false, totalPausedTicks: 0, pauseObserved: false, clockContinuous: true },
  })) })) };
  const analysis = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-question-hints" });
  const plan = analysis.review_plan, cue = plan.cues[0], material = analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const narration = deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set));
  const view = buildThreeStageCoachingView({ narration, decisionState: playerStateAtOrBefore(analysis.match_timeline.player_state_tracks ?? [], self, cue.decision_tick),
    semantics: { ...material, ...cue }, decisionTick: cue.decision_tick, decisionFacts: buildCoachingCueView(cue, false).decisionFacts, outcomeFacts: [] });
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  for (let i = 0; i < 30 && session.phase !== "PAUSED_FOR_COACHING"; i++) {
    const current = getCurrentCue(plan, session);
    session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" }
      : current ? { type: "TICK", tick: current.outcome_end_tick } : { type: "ADVANCE_SEGMENT" });
  }
  expect(session.outcome_completion?.status).toBe("COMPLETE");
  const cache = new CurrentCueResourceCache(), origin = { plan, cue, material, timeline: analysis.match_timeline, selectedPlayerId: self };
  const input = { plan, session, generation: 1, diagnosticsEnabled: false, presentableNarration: narration, busy: false, takenOver: false,
    displayedHealthText: view.currentState.chips.find(chip => chip.kind === "health")?.text,
    displayedUtilityText: view.currentState.chips.find(chip => chip.kind === "utility")?.text, resourceSource: cache.read(origin) };
  return { input, cache, origin };
}
function panel(context: ReturnType<typeof buildCurrentCueQuestionContext>, canRepeatAdvice = false) {
  return renderToStaticMarkup(createElement(CurrentCueQuestionsPanel, { state: { key: context?.key ?? "empty", draft: "", turns: [] },
    resourceQuestions: availableCurrentCueResourceQuestions(context), canRepeatAdvice, onDraft() {}, onAsk() {} }));
}

it("advertises only actual baseline health/clock and routes every hint to a sourced answer", () => {
  const f = fixture(), context = buildCurrentCueQuestionContext(f.input)!;
  const hints = availableCurrentCueResourceQuestions(context);
  expect(hints).toEqual(["我当时多少血？", "当时回合还剩多久？"]);
  const html = panel(context);
  for (const hint of hints) { expect(html).toContain(hint); expect(answerGroundedCueQuestion(context, hint).items.length).toBeGreaterThan(0); }
  for (const unavailable of ["当时有多少护甲？", "当时有几颗道具？", "弹匣当时还有几发？", "当时有什么道具？"]) expect(html).not.toContain(unavailable);
});

it("lists known kinds without advertising an unknown physical count", () => {
  const f = fixture(true), context = buildCurrentCueQuestionContext(f.input)!;
  const hints = availableCurrentCueResourceQuestions(context);
  expect(hints).toEqual(["我当时多少血？", "当时回合还剩多久？", "当时有什么道具？"]);
  for (const hint of hints) expect(answerGroundedCueQuestion(context, hint).items.length).toBeGreaterThan(0);
  expect(panel(context)).not.toContain("当时有几颗道具？");
});

it("uses the same canonical wordings for actual diagnostic resources and preserves the advice entry", () => {
  const f = fixture();
  const output = diagnoseTeachingCue(buildTeachingDiagnosisInput(f.origin, { cueId: f.origin.cue.id, selectedGoal: "DELAY", response: "ANSWERED", source: "USER", limitations: [] }));
  const context = buildCurrentCueQuestionContext({ ...f.input, diagnosticsEnabled: true, cueCase: output.cueCase })!;
  expect(context).toBeDefined();
  const hints = availableCurrentCueResourceQuestions(context);
  // The actual DELAY diagnostic displays only its clock measurement, even though the baseline has health.
  expect(hints).toEqual(["当时回合还剩多久？"]); expect(hints.length).toBeLessThanOrEqual(6);
  for (const hint of hints) expect(answerGroundedCueQuestion(context, hint).items.length).toBeGreaterThan(0);
  const html = panel(context, true);
  expect(html).toContain("下次记住什么？");
  for (const question of CURRENT_CUE_QUESTIONS) expect(html).toContain(question);
});

it("removes hints when provenance expires, the source belongs elsewhere, or the context gate closes", () => {
  const f = fixture();
  expect(availableCurrentCueResourceQuestions(buildCurrentCueQuestionContext(f.input))).toHaveLength(2);
  const elsewhere = fixture(true);
  expect(availableCurrentCueResourceQuestions(buildCurrentCueQuestionContext({ ...f.input, resourceSource: elsewhere.input.resourceSource }))).toEqual([]);
  f.cache.read(undefined);
  const expired = buildCurrentCueQuestionContext(f.input);
  expect(availableCurrentCueResourceQuestions(expired)).toEqual([]); expect(panel(expired)).not.toContain("也可问");
  expect(availableCurrentCueResourceQuestions(buildCurrentCueQuestionContext({ ...f.input, busy: true }))).toEqual([]);
  expect(availableCurrentCueResourceQuestions(undefined)).toEqual([]);
});
