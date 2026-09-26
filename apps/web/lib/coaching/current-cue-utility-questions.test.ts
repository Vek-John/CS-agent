import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "./cs2d-coaching-view";
import { CurrentCueResourceCache } from "./current-cue-resource-source";
import { answerGroundedCueQuestion, buildCurrentCueQuestionContext, updateCurrentCueQuestions } from "./current-cue-questions";
import { buildTeachingDiagnosisInput } from "./teaching-diagnosis-host";
import { CoachingStatusList } from "../../components/playback/coaching-status-list";
import { CurrentCueQuestionsPanel } from "../../components/playback/current-cue-questions-panel";
import * as stateProjection from "./diagnosis-decision-state";

function fixture(kinds: string[] | null = ["Flash", "Smoke"], version: 1 | null = 1, restored = false) {
  // Synthetic Replay coordinates exercise the real Adapter; no parsed Demo claim.
  const source = fireReplay("DEATH", []);
  const replay = { ...source, rounds: source.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame,
    players: frame.players.map(player => ({ ...player, grenades: kinds ?? undefined, grenadeInventoryVersion: version ?? undefined })),
  })) })) };
  const built = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "utility-questions" });
  const analysis: typeof built = restored ? JSON.parse(JSON.stringify(built)) : built;
  const plan = analysis.review_plan, cue = plan.cues[0];
  const material = analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const narration = deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence),
    buildOutcomePackage(cue, analysis.candidate_set, analysis.outcome_impacts.find(item => item.cueId === cue.id)));
  const sourceContext = { plan, cue, material, timeline: analysis.match_timeline, selectedPlayerId: self };
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
  const cache = new CurrentCueResourceCache();
  const input = { plan, session, generation: 1, diagnosticsEnabled: false, presentableNarration: narration, busy: false, takenOver: false,
    displayedUtilityText: view.currentState.chips.find(chip => chip.kind === "utility")?.text, resourceSource: cache.read(sourceContext) };
  return { analysis, cue, material, sourceContext, state, viewInput, view, cache, input };
}
const question = "当时有什么道具？";
it.each([false, true])("repeats the actual baseline chip with kinds but no inferred count (JSON restore: %s)", restored => {
  const f = fixture(["Flash", "Smoke"], 1, restored);
  expect(f.input.displayedUtilityText).toBe("闪光弹、烟雾弹（数量未知）");
  const statusHtml = renderToStaticMarkup(createElement(CoachingStatusList, { chips: f.view.currentState.chips }));
  expect(statusHtml).toContain(f.input.displayedUtilityText!);
  const context = buildCurrentCueQuestionContext(f.input)!;
  const before = JSON.stringify(f.analysis);
  const answer = answerGroundedCueQuestion(context, question);
  expect(answer.items).toEqual([{ text: "闪光弹、烟雾弹（数量未知）", refs: expect.arrayContaining([expect.any(String)]) }]);
  expect(answer.text).toContain("种类"); expect(answer.text).toContain("颗数");
  expect(answer.items[0].text).not.toMatch(/\d+颗/);
  const state = updateCurrentCueQuestions(undefined, context.key, context, { type: "ASK", question })!;
  expect(renderToStaticMarkup(createElement(CurrentCueQuestionsPanel, { state, onDraft() {}, onAsk() {} }))).toContain("闪光弹、烟雾弹（数量未知）");
  expect(JSON.stringify(f.analysis)).toBe(before);
});

it.each([
  { kinds: [] as string[], version: 1 as const, shown: "无道具" },
  { kinds: null, version: 1 as const, shown: undefined },
  { kinds: ["unverified"], version: 1 as const, shown: undefined },
  { kinds: ["Flash"], version: null, shown: undefined },
])("distinguishes actual shown empty inventory from unknown/unverified data: $kinds / $version", ({ kinds, version, shown }) => {
  const f = fixture(kinds, version);
  expect(f.input.displayedUtilityText).toBe(shown);
  const answer = answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question);
  expect(answer.items.map(item => item.text)).toEqual(shown ? [shown] : []);
  if (!shown) expect(answer.text).toContain("不能把未知当成无道具");
});

it("refuses hidden baseline kinds while the full diagnostic branch is displayed", () => {
  const f = fixture();
  const output = diagnoseTeachingCue(buildTeachingDiagnosisInput(f.sourceContext, { cueId: f.cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] }));
  expect(f.input.displayedUtilityText).toContain("闪光弹");
  const context = buildCurrentCueQuestionContext({ ...f.input, diagnosticsEnabled: true, cueCase: output.cueCase })!;
  expect(context).toBeDefined();
  expect(answerGroundedCueQuestion(context, question).items).toEqual([]);
});

it.each(["stale", "future", "player", "missing-self", "invalid-kind", "bad-ref", "hidden", "missing-snapshot"])("rejects saved display text when the current source is %s", kind => {
  const f = fixture(), snapshot = structuredClone(f.viewInput.semantics.decisionSnapshot!);
  if (kind === "stale") snapshot.sampledAtTick = f.cue.decision_tick - f.sourceContext.timeline.tick_rate;
  if (kind === "future") snapshot.sampledAtTick = f.cue.decision_tick + 1;
  if (kind === "player") snapshot.selectedPlayerId = "other";
  if (kind === "missing-self") snapshot.selectedPlayer.value = null;
  if (kind === "invalid-kind") snapshot.selectedPlayer.value!.grenades = ["unverified"];
  if (kind === "bad-ref") snapshot.selectedPlayer.evidenceRefs = ["unrelated"];
  if (kind === "hidden") snapshot.selectedPlayer.boundary = "GROUND_TRUTH";
  const decisionSnapshot = kind === "missing-snapshot" ? undefined : snapshot;
  const cue = { ...f.cue, decisionSnapshot };
  const plan = { ...f.input.plan, cues: f.input.plan.cues.map(item => item.id === cue.id ? cue : item) };
  const sourceContext = { ...f.sourceContext, plan, cue, material: { ...f.material, decisionSnapshot } };
  const context = buildCurrentCueQuestionContext({ ...f.input, plan, resourceSource: f.cache.read(sourceContext) })!;
  expect(context).toBeDefined();
  expect(answerGroundedCueQuestion(context, question).items).toEqual([]);
});

it("requires the actual displayed text and invalidates old answers when the chip changes", () => {
  const f = fixture(), original = buildCurrentCueQuestionContext(f.input)!;
  const state = updateCurrentCueQuestions(undefined, original.key, original, { type: "ASK", question });
  for (const displayedUtilityText of [undefined, "闪光弹", "2 颗道具", "无道具"]) {
    const next = buildCurrentCueQuestionContext({ ...f.input, displayedUtilityText })!;
    expect(next.key).not.toBe(original.key);
    expect(answerGroundedCueQuestion(next, question).items).toEqual([]);
    expect(updateCurrentCueQuestions(state, original.key, next, { type: "ASK", question })).toBe(state);
  }
});

it("preserves the result gate, legal manual visit and numeric resource boundaries", () => {
  const f = fixture();
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, "当时有几颗道具？").items).toEqual([]);
  const replay = reduceCoachingSession(f.input.plan, f.input.session, { type: "REPLAY_OUTCOME" });
  expect(buildCurrentCueQuestionContext({ ...f.input, session: replay })).toBeUndefined();
  expect(buildCurrentCueQuestionContext({ ...f.input, takenOver: true })).toBeUndefined();
  expect(buildCurrentCueQuestionContext({ ...f.input, presentableNarration: undefined })).toBeUndefined();
  let manual = reduceCoachingSession(f.input.plan, f.input.session, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: f.cue.id, visitId: "utility-visit" });
  expect(buildCurrentCueQuestionContext({ ...f.input, session: manual, takenOver: true })).toBeUndefined();
  manual = reduceCoachingSession(f.input.plan, manual, { type: "TICK", tick: f.cue.outcome_end_tick });
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, session: manual, takenOver: true })!, question).items).toHaveLength(1);
});

it.each(["如果有闪光应该怎么用？", "当时有什么道具，所以应该扔烟吗？", "下个点有什么道具？", "队友说当时有什么道具？"])("does not turn a hypothetical or unrelated question into inventory facts: %s", q => {
  const f = fixture();
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, q).items).toEqual([]);
});

it("projects once per source, rejects forged/expired tokens, and does not scan while typing", () => {
  const f = fixture(), source = f.input.resourceSource, context = buildCurrentCueQuestionContext(f.input)!;
  const spy = vi.spyOn(stateProjection, "currentDiagnosisSnapshot");
  try {
    let state = updateCurrentCueQuestions(undefined, context.key, context, { type: "ASK", question });
    for (let i = 0; i < 8; i++) {
      f.input.resourceSource = f.cache.read({ ...f.sourceContext });
      state = updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(f.input), { type: "DRAFT", text: `问题${i}` });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, resourceSource: { revision: source!.revision } })!, question).items).toEqual([]);
    f.input.resourceSource = f.cache.read({ ...f.sourceContext, timeline: { ...f.sourceContext.timeline } });
    const changed = buildCurrentCueQuestionContext(f.input)!;
    expect(changed.key).not.toBe(context.key);
    expect(updateCurrentCueQuestions(state, context.key, changed, { type: "ASK", question })).toBe(state);
    expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, resourceSource: source })!, question).items).toEqual([]);
    f.cache.read(undefined);
    expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
  } finally { spy.mockRestore(); }
});
