import { afterEach, expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "./cs2d-coaching-view";
import { CurrentCueResourceCache } from "./current-cue-resource-source";
import { answerGroundedCueQuestion, buildCurrentCueQuestionContext, updateCurrentCueQuestions } from "./current-cue-questions";
import { buildTeachingDiagnosisInput } from "./teaching-diagnosis-host";

const question = "我当时多少血？";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  // Synthetic events and samples, not measured Demo ticks.
  const analysis = buildCs2dAnalysisBundle({ replay: fireReplay("DEATH"), selectedSteamId: self, demoId: "synthetic-baseline-health" });
  const plan = analysis.review_plan, cue = plan.cues[0];
  const material = analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const coaching = buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence);
  const narration = deterministicNarrationBundle(coaching, buildOutcomePackage(cue, analysis.candidate_set));
  const state = playerStateAtOrBefore(analysis.match_timeline.player_state_tracks ?? [], self, cue.decision_tick)!;
  const viewInput = { narration, decisionState: state, semantics: { ...material, ...cue }, decisionTick: cue.decision_tick,
    decisionFacts: buildCoachingCueView(cue, false).decisionFacts, outcomeFacts: [] };
  const view = buildThreeStageCoachingView(viewInput);
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  for (let i = 0; i < 30 && session.phase !== "PAUSED_FOR_COACHING"; i++) {
    const active = getCurrentCue(plan, session);
    session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" }
      : active ? { type: "TICK", tick: active.outcome_end_tick } : { type: "ADVANCE_SEGMENT" });
  }
  expect(session.current_cue_id).toBe(cue.id); expect(session.outcome_completion?.status).toBe("COMPLETE");
  const cache = new CurrentCueResourceCache(), origin = { plan, cue, material, timeline: analysis.match_timeline, selectedPlayerId: self };
  const input = { plan, session, generation: 1, diagnosticsEnabled: false, presentableNarration: narration, busy: false, takenOver: false,
    displayedHealthText: view.currentState.chips.find(chip => chip.kind === "health")?.text, resourceSource: cache.read(origin) };
  return { analysis, origin, cache, input, state, viewInput };
}
it("repeats the actual displayed baseline health only after the complete outcome gate", () => {
  const fetch = vi.fn(() => { throw Error("NETWORK_NOT_EXPECTED"); }); vi.stubGlobal("fetch", fetch);
  const f = fixture(), before = JSON.stringify(f.analysis);
  expect(f.input.displayedHealthText).toBe("40 HP");
  const answer = answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question);
  expect(answer.items).toEqual([{ text: "40 HP", refs: f.origin.material.decisionSnapshot!.selectedPlayer.evidenceRefs }]);
  expect(answer.source).toContain("当前状态"); expect(answer.source).not.toContain("诊断");
  expect(JSON.stringify(f.analysis)).toBe(before); expect(fetch).not.toHaveBeenCalled();
});

it.each([undefined, "39 HP", "40", "0 HP"])("does not infer health from an absent or different current chip: %s", displayedHealthText => {
  const f = fixture();
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, displayedHealthText })!, question).items).toEqual([]);
});

it.each(["unknown", "stale", "dead", "wrong-player", "value-conflict", "raw-ref", "unobserved", "cue-fact-time"])("requires trustworthy current health despite a visible number: %s", mode => {
  const f = fixture(), snapshot = structuredClone(f.origin.material.decisionSnapshot!);
  const canonicalRefs = snapshot.selectedPlayer.evidenceRefs;
  if (mode === "unknown") snapshot.selectedPlayer.value!.health = null;
  if (mode === "stale") snapshot.sampledAtTick = f.origin.cue.decision_tick - 64;
  if (mode === "dead") snapshot.selectedPlayer.value!.alive = false;
  if (mode === "wrong-player") snapshot.selectedPlayerId = "other";
  if (mode === "value-conflict") snapshot.selectedPlayer.value!.health = 39;
  if (mode === "raw-ref") snapshot.selectedPlayer.evidenceRefs = f.state.fact_refs;
  if (mode === "cue-fact-time") f.origin.cue.facts = f.origin.cue.facts.map(fact => canonicalRefs.includes(fact.id) ? { ...fact, available_at_tick: fact.available_at_tick - 1 } : fact);
  const material = { ...f.origin.material, decisionSnapshot: snapshot,
    decisionFacts: f.origin.material.decisionFacts.map(fact => mode === "unobserved" && canonicalRefs.includes(fact.id) ? { ...fact, observed_by_player: false } : fact) };
  f.input.resourceSource = f.cache.read({ ...f.origin, material });
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
});

it("does not let a valid baseline chip replace a missing diagnostic measurement", () => {
  const f = fixture();
  const diagnosis = diagnoseTeachingCue(buildTeachingDiagnosisInput(f.origin, { cueId: f.origin.cue.id, selectedGoal: "DELAY", response: "ANSWERED", source: "USER", limitations: [] }));
  const cueCase = structuredClone(diagnosis.cueCase);
  cueCase.diagnosticResult!.measurements = cueCase.diagnosticResult!.measurements.filter(m => m.id !== `measurement-${f.origin.cue.id}-health`);
  const diagnosticContext = buildCurrentCueQuestionContext({ ...f.input, diagnosticsEnabled: true, cueCase });
  expect(diagnosticContext).toBeDefined();
  expect(answerGroundedCueQuestion(diagnosticContext!, question).items).toEqual([]);
});

it("invalidates old sources and callbacks on source or display changes without accepting a forged token", () => {
  const f = fixture(), source = f.input.resourceSource!, context = buildCurrentCueQuestionContext(f.input)!;
  const state = updateCurrentCueQuestions(undefined, context.key, context, { type: "ASK", question });
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, resourceSource: { revision: source.revision } })!, question).items).toEqual([]);
  const other = fixture();
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, resourceSource: other.input.resourceSource })!, question).items).toEqual([]);
  const changedDisplay = buildCurrentCueQuestionContext({ ...f.input, displayedHealthText: "39 HP" })!;
  expect(changedDisplay.key).not.toBe(context.key);
  expect(updateCurrentCueQuestions(state, context.key, changedDisplay, { type: "ASK", question })).toBe(state);
  f.input.resourceSource = f.cache.read({ ...f.origin, timeline: { ...f.origin.timeline } });
  const changedSource = buildCurrentCueQuestionContext(f.input)!;
  expect(changedSource.key).not.toBe(context.key);
  expect(updateCurrentCueQuestions(state, context.key, changedSource, { type: "ASK", question })).toBe(state);
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, resourceSource: source })!, question).items).toEqual([]);
  f.cache.read(undefined);
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
});

it("retains the result, takeover and busy gates and rejects hypothetical health advice", () => {
  const f = fixture();
  const session = reduceCoachingSession(f.input.plan, f.input.session, { type: "REPLAY_OUTCOME" });
  expect(buildCurrentCueQuestionContext({ ...f.input, session })).toBeUndefined();
  expect(buildCurrentCueQuestionContext({ ...f.input, busy: true })).toBeUndefined();
  expect(buildCurrentCueQuestionContext({ ...f.input, takenOver: true })).toBeUndefined();
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, "如果当时40血应该怎么打？").items).toEqual([]);
});
