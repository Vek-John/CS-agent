import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { WinProbabilityTimelineV1 } from "@cs-coach/contracts";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildTeachingDiagnosisInput } from "./teaching-diagnosis-host";
import { TeachingDiagnosisPanel } from "../../components/playback/teaching-diagnosis-panel";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import { CurrentCueResourceCache } from "./current-cue-resource-source";
import { answerGroundedCueQuestion, buildCurrentCueQuestionContext, updateCurrentCueQuestions } from "./current-cue-questions";
import { CurrentCueQuestionsPanel } from "../../components/playback/current-cue-questions-panel";
import * as projection from "./diagnosis-decision-state";
function fixture(known = true, missingPlayer = false) {
  // Synthetic clock samples in a synthetic Replay, never measured Demo ticks.
  const original = fireReplay(missingPlayer ? "HP_CHANGE" : "DEATH", missingPlayer ? [] : undefined);
  const player = original.rounds[0].frames[0].players[0];
  const source = missingPlayer ? { ...original, rounds: original.rounds.map(round => ({ ...round, frames: [
    { tick: 1056, t: 0, players: [player] },
    { tick: 1064, t: 0, players: [] },
    { tick: 1408, t: 0, players: [player] },
  ] })) } : original;
  const replay = { ...source, rounds: source.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame,
    ...(known ? { clock: { source: "SOURCE2_GAMERULES" as const, sampledAtTick: frame.tick, serverTick: frame.tick, tickInterval: 1 / 64,
      roundStartTimeSeconds: round.startTick / 64, roundDurationSeconds: 115, roundsPlayed: 0, freeze: false, warmup: false,
      bombPlanted: false, roundWinStatus: 0, paused: false, totalPausedTicks: 0, pauseObserved: false, clockContinuous: true } } : {}),
  })) })) };
  // Independent nomination signal keeps a real uncertainty cue even without self state.
  // This is a supplied synthetic model result, not a CS-Net inference run.
  const probability: WinProbabilityTimelineV1 = {
    version: "win-probability-timeline.v1", status: "AVAILABLE", tickRate: 64,
    model: { provider: "CS_NET", revision: "synthetic", assetUrl: "/synthetic.onnx", assetSha256: "a".repeat(64), assetBytes: 1, quantization: "INT8", temperature: 1, sourceCommit: "synthetic", featureVersion: "synthetic" },
    rounds: [{ roundNumber: 1, startTick: 1000, endTick: 1800, winner: "CT", economy: { ct: "FULL", t: "FULL", ctValue: 20000, tValue: 20000 }, samples: [
      { tick: 1064, probability: 0.3, roundNumber: 1, side: "CT", source: "CS_NET" },
      { tick: 1408, probability: 0.6, roundNumber: 1, side: "CT", source: "CS_NET" },
    ] }],
    swings: [{ id: "synthetic-drop", tick: 1408, before: 0.3, after: 0.6, delta: 0.3, direction: "UP", cause: "PLAYER_DEATH", selectedPlayerDeath: false, victimSide: "T", economy: "FULL" }], limitations: [],
  };
  const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "clock-diagnosis", ...(missingPlayer ? { winProbabilityTimeline: probability } : {}) });
  const cue = bundle.review_plan.cues[0], material = bundle.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const context = { plan: bundle.review_plan, cue, material, timeline: bundle.match_timeline, selectedPlayerId: self };
  const reflection = { cueId: cue.id, selectedGoal: "DELAY" as const, response: "ANSWERED" as const, source: "USER" as const, limitations: [] };
  return { context, reflection };
}
function ready(missingPlayer = false) {
  const { context, reflection } = fixture(true, missingPlayer);
  const diagnosisInput = buildTeachingDiagnosisInput(context, reflection);
  const output = diagnoseTeachingCue(diagnosisInput);
  const { plan, cue } = context;
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  for (let i = 0; i < 30 && session.phase !== "PAUSED_FOR_COACHING"; i++) {
    const active = getCurrentCue(plan, session);
    session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" }
      : active ? { type: "TICK", tick: active.outcome_end_tick } : { type: "ADVANCE_SEGMENT" });
  }
  expect(session.phase).toBe("PAUSED_FOR_COACHING");
  expect(session.outcome_completion?.status).toBe("COMPLETE");
  expect(session.current_cue_id).toBe(cue.id);
  session = reduceCoachingSession(plan, session, { type: "RECORD_TEACHING_CASE", ...output });
  const cache = new CurrentCueResourceCache();
  const input = { plan, session, generation: 1, diagnosticsEnabled: true, cueCase: output.cueCase, busy: false, takenOver: false, resourceSource: cache.read(context) };
  return { context, diagnosisInput, output, cache, input };
}
const question = "当时回合还剩多久？";
it.each([false, true])("repeats the actual displayed clock after the full outcome gate (missing self: %s)", missingSelf => {
  const f = ready(missingSelf), before = structuredClone(f.output);
  if (missingSelf) expect(f.diagnosisInput.decisionResources).toBeUndefined();
  const value = Math.ceil(f.diagnosisInput.decisionClock!.remainingSeconds);
  f.input.cueCase = JSON.parse(JSON.stringify(f.output.cueCase));
  const context = buildCurrentCueQuestionContext(f.input)!;
  expect(context).toBeDefined();
  const answer = answerGroundedCueQuestion(context, question);
  expect(answer.items).toHaveLength(1);
  expect(answer.items[0]).toEqual({ text: `决策前最近采样的回合剩余时间（约）：${value}秒。`, refs: f.diagnosisInput.decisionClock!.evidenceRefs });
  expect(answer.text).toContain("不是 C4 倒计时");
  expect(answer.text).toContain("不能据此判断等待是否正确");
  const diagnostic = renderToStaticMarkup(createElement(TeachingDiagnosisPanel, { cue: f.context.cue, decisionFacts: f.diagnosisInput.decisionFacts, cueCase: f.input.cueCase, hasTrustedDecisionContext: true, onSubmit() {}, onSkip() {}, onConfirm() {}, onDisagree() {} }));
  expect(diagnostic).toContain(`${value}秒`);
  const state = updateCurrentCueQuestions(undefined, context.key, context, { type: "ASK", question })!;
  const html = renderToStaticMarkup(createElement(CurrentCueQuestionsPanel, { state, onDraft() {}, onAsk() {} }));
  expect(html).toContain(`：${value}秒`);
  expect(f.output).toEqual(before);
});

it.each(["missing", "value", "string-value", "id", "duplicate-id", "label", "unit", "refs", "empty-refs", "duplicate-refs"])("rejects saved clock measurement mismatch: %s", kind => {
  const f = ready(), result = f.input.cueCase.diagnosticResult!, m = result.measurements[0];
  if (kind === "missing") result.measurements = [];
  if (kind === "value") m.value = Number(m.value) + 1;
  if (kind === "string-value") m.value = String(m.value);
  if (kind === "id") m.id = "measurement-other-round-time";
  if (kind === "duplicate-id") result.measurements = [...result.measurements, { ...m }];
  if (kind === "label") m.label = "C4剩余时间";
  if (kind === "unit") m.unit = "分钟";
  if (kind === "refs") m.evidenceRefs = ["unrelated"];
  if (kind === "empty-refs") m.evidenceRefs = [];
  if (kind === "duplicate-refs") m.evidenceRefs = [...m.evidenceRefs, ...m.evidenceRefs];
  const answer = answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question);
  expect(answer.items).toEqual([]); expect(answer.text).toContain("无法可靠核对回合剩余时间");
});

it.each(["unknown", "zero", "nan", "stale", "future", "player", "round", "decision", "demo", "hidden", "outcome-ref", "unobserved", "forged-source"])("does not repeat a saved clock when current provenance is %s", kind => {
  const f = ready(), snapshot = structuredClone(f.context.material.decisionSnapshot!);
  if (kind === "unknown") snapshot.clock.value!.remainingSeconds = null;
  if (kind === "zero") snapshot.clock.value!.remainingSeconds = 0;
  if (kind === "nan") snapshot.clock.value!.remainingSeconds = NaN;
  if (kind === "stale") snapshot.sampledAtTick = f.context.cue.decision_tick - f.context.timeline.tick_rate;
  if (kind === "future") snapshot.sampledAtTick = f.context.cue.decision_tick + 1;
  if (kind === "player") snapshot.selectedPlayerId = "other";
  if (kind === "round") snapshot.roundNumber++;
  if (kind === "decision") snapshot.decisionTick++;
  if (kind === "hidden") snapshot.clock.boundary = "GROUND_TRUTH";
  if (kind === "outcome-ref") snapshot.clock.evidenceRefs = [f.diagnosisInput.outcomeFacts[0].id];
  const context = { ...f.context, timeline: { ...f.context.timeline, ...(kind === "demo" ? { demo_id: "other" } : {}) },
    material: { ...f.context.material, decisionSnapshot: snapshot, decisionFacts: kind === "unobserved" ? f.context.material.decisionFacts.map(fact => ({ ...fact, observed_by_player: false })) : f.context.material.decisionFacts } };
  f.input.resourceSource = f.cache.read(context);
  if (kind === "forged-source") f.input.resourceSource = { revision: f.input.resourceSource!.revision };
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
});

it.each(["C4还剩多久？", "当时炸弹还剩多久？", "如果还剩30秒该等待吗？", "当时回合还剩多久，所以应该等吗？", "下一个点当时回合还剩多久？"])("does not map other clocks or hypothetical advice into a round clock: %s", q => {
  const f = ready();
  const answer = answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, q);
  expect(answer.items).toEqual([]); expect(answer.source).toBe("当前追问的能力边界");
});

it("keeps unknown parser clocks unknown and the ordinary outcome gate closed", () => {
  const f = ready(), unknown = fixture(false);
  const input = buildTeachingDiagnosisInput(unknown.context, unknown.reflection);
  const output = diagnoseTeachingCue(input);
  expect(output.cueCase.diagnosticResult!.measurements).toEqual([]);
  const context = buildCurrentCueQuestionContext({ ...f.input, plan: unknown.context.plan, cueCase: output.cueCase, resourceSource: f.cache.read(unknown.context) })!;
  expect(answerGroundedCueQuestion(context, question).items).toEqual([]);
  const replaying = reduceCoachingSession(f.input.plan, f.input.session, { type: "REPLAY_OUTCOME" });
  expect(buildCurrentCueQuestionContext({ ...f.input, session: replaying })).toBeUndefined();
  expect(buildCurrentCueQuestionContext({ ...f.input, busy: true })).toBeUndefined();
  expect(buildCurrentCueQuestionContext({ ...f.input, takenOver: true })).toBeUndefined();
});

it("caches projection while typing and invalidates old tokens and callbacks when the analysis changes", () => {
  const f = ready(), original = f.input.resourceSource;
  const spy = vi.spyOn(projection, "currentDiagnosisSnapshot");
  try {
    const context = buildCurrentCueQuestionContext(f.input)!;
    let state = updateCurrentCueQuestions(undefined, context.key, context, { type: "ASK", question });
    for (let i = 1; i < 8; i++) {
      f.input.resourceSource = f.cache.read({ ...f.context });
      state = updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(f.input), { type: "DRAFT", text: "问".repeat(i) });
    }
    expect(spy).not.toHaveBeenCalled();
    f.input.resourceSource = f.cache.read({ ...f.context, timeline: { ...f.context.timeline } });
    const changed = buildCurrentCueQuestionContext(f.input)!;
    expect(changed.key).not.toBe(context.key);
    expect(updateCurrentCueQuestions(state, context.key, changed, { type: "ASK", question })).toBe(state);
    expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, resourceSource: original })!, question).items).toEqual([]);
    f.cache.read(undefined);
    expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
  } finally { spy.mockRestore(); }
});
