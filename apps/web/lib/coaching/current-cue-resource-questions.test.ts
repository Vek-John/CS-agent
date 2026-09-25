import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { decisionSnapshotFixture } from "../../../../libs/review-planner/src/teaching-gate-fixtures";
import { normalizeWeaponAmmo } from "../../../../libs/cs2d-analysis-adapter/src/weapon-ammo";
import { TeachingDiagnosisPanel } from "../../components/playback/teaching-diagnosis-panel";
import { CurrentCueQuestionsPanel } from "../../components/playback/current-cue-questions-panel";
import { buildTeachingDiagnosisInput, type TeachingDiagnosisHostContext } from "./teaching-diagnosis-host";
import { CurrentCueResourceCache } from "./current-cue-resource-source";
import { answerGroundedCueQuestion, buildCurrentCueQuestionContext, currentCueQuestionState, updateCurrentCueQuestions } from "./current-cue-questions";
import * as resourceProjection from "./diagnosis-decision-state";

/** Synthetic protocol/source fixture. No real Demo tick or model claim. */
function fixture() {
  const timeline = createSyntheticMirageTimeline();
  const plan = createFixtureReviewPlan(timeline), cue = plan.cues[0];
  cue.candidate_id = "candidate-resource-question";
  const snapshot = decisionSnapshotFixture(cue.decision_tick, "resource-source");
  snapshot.selectedPlayerId = plan.player_id; snapshot.roundNumber = 2;
  snapshot.selectedPlayer.value = { ...snapshot.selectedPlayer.value!, side: "T", alive: true, health: 35, armor: 0, helmet: false, weapon: "AK-47", grenades: [], money: 800, equipmentValue: 4100 };
  const state = { player_id: plan.player_id, tick: cue.decision_tick, side: "T" as const, world_position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
    alive: true, health: 35, armor: 0, has_helmet: false, money: 800, equipment_value: 4100, inventory: [], fact_refs: ["resource-source"], missing_fields: [],
    active_item: { item_id: "AK-47", item_class: "WEAPON", entity_handle: 114697, ammo_sampling_version: 2 as const,
      ...normalizeWeaponAmmo({ version: 2, source: "SOURCE2_ACTIVE_WEAPON", phase: "TICK_END", sampledAtTick: cue.decision_tick - 1, weapon: "AK-47", weaponHandle: 114697, clip: 0 }, "AK-47", cue.decision_tick, "current-frame", true, 2) } };
  const material = { candidateId: cue.candidate_id, decisionSnapshot: snapshot, decisionFacts: cue.facts.filter(f => f.availability === "DECISION"), playerActionFacts: [], outcomeFacts: [], inferences: [], advice: [], evidence: [], limitations: [] };
  const sourceContext: TeachingDiagnosisHostContext = { plan, cue, material, timeline: { ...timeline, player_state_tracks: [state], match_events: [] }, selectedPlayerId: plan.player_id };
  cue.assessment = { kind: "INSUFFICIENT_EVIDENCE", confidence: 0.5, supportingEvidenceRefs: [], counterEvidenceRefs: [], missingFields: [], limitations: [], explanation: "不能确定对错。", hasEvaluableDecision: false };
  cue.observableContext = { version: "observable-decision-context.v1", boundary: "OBSERVABLE", source: "DEMO_OBSERVER_EVIDENCE", snapshotId: snapshot.snapshotId,
    state: { id: "observer-fixture", demo_id: plan.demo_id, observer_player_id: plan.player_id, at_tick: cue.decision_tick, timeline_version: "synthetic", observation_version: "v1", claims: [], limitations: [] },
    publicFacts: [], freshness: { sampledAtTick: cue.decision_tick, ageTicks: 0 }, confidence: 0.5, missingFields: [], limitations: [] };
  const diagnosisInput = buildTeachingDiagnosisInput(sourceContext, { cueId: cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] });
  const output = diagnoseTeachingCue(diagnosisInput);
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
  session = reduceCoachingSession(plan, session, { type: "TICK", tick: cue.outcome_end_tick });
  session = reduceCoachingSession(plan, session, { type: "RECORD_TEACHING_CASE", ...output });
  const cache = new CurrentCueResourceCache();
  const input = { plan, session, generation: 1, diagnosticsEnabled: true, cueCase: output.cueCase, busy: false, takenOver: false, resourceSource: cache.read(sourceContext) };
  return { input, cache, sourceContext, diagnosisInput, output, state, snapshot, cue };
}

const examples = [
  ["我当时多少血？", "决策时血量", 35, "HP"],
  ["当时有多少护甲？", "决策时护甲", 0, "甲"],
  ["当时有几颗道具？", "决策时道具数量", 0, "颗"],
  ["弹匣当时还有几发？", "AK-47 决策前最近记录弹匣", 0, "发"],
] as const;

it.each(examples)("answers an already displayed, production-verified resource: %s", (question, label, value, unit) => {
  const { input, output, cue } = fixture();
  const before = structuredClone(output);
  const html = renderToStaticMarkup(createElement(TeachingDiagnosisPanel, { cue, decisionFacts: [], cueCase: output.cueCase, hasTrustedDecisionContext: true, onSubmit() {}, onSkip() {}, onConfirm() {}, onDisagree() {} }));
  expect(html).toContain(`${label}</b><span>${value}${unit}`);
  const context = buildCurrentCueQuestionContext(input)!;
  const answer = answerGroundedCueQuestion(context, question);
  expect(answer.items).toHaveLength(1);
  expect(answer.items[0].text).toContain(`${value}${unit}`);
  expect(answer.items[0].refs.length).toBeGreaterThan(0);
  expect(answer.text).not.toContain("暂不支持");
  if (unit === "发") {
    expect(answer.items[0].text).toContain("决策前最近记录");
    expect(answer.text).toContain("备弹未知");
    expect(answer.text).toContain("不能保证决策瞬间的精确余量");
  }
  expect(output).toEqual(before);
});

it.each(["missing", "value", "string-value", "label", "unit", "refs", "empty-refs", "duplicate-id", "wrong-id", "forged-source"])("does not trust a measurement with %s", reason => {
  const { input } = fixture();
  const result = input.cueCase.diagnosticResult!;
  const m = result.measurements.find(m => m.id.endsWith("-health"))!;
  if (reason === "missing") result.measurements = result.measurements.filter(row => row !== m);
  if (reason === "value") m.value = 5;
  if (reason === "string-value") m.value = "35";
  if (reason === "label") m.label = "敌人血量";
  if (reason === "unit") m.unit = "发";
  if (reason === "refs") m.evidenceRefs = ["other-source"];
  if (reason === "empty-refs") m.evidenceRefs = [];
  if (reason === "duplicate-id") result.measurements = [...result.measurements, { ...m }];
  if (reason === "wrong-id") m.id = "measurement-other-health";
  if (reason === "forged-source") input.resourceSource = { revision: input.resourceSource!.revision };
  const answer = answerGroundedCueQuestion(buildCurrentCueQuestionContext(input)!, "我当时多少血？");
  expect(answer.items).toEqual([]);
  expect(answer.text).toContain("无法可靠核对血量");
});

it.each(["missing-health", "zero-alive-health", "missing-armor", "missing-inventory", "empty-source-refs", "wrong-player", "wrong-demo", "wrong-material", "stale", "future-only"])("preserves the existing resource gate for %s even if a value was saved", reason => {
  const { input, sourceContext, state } = fixture();
  let source = sourceContext;
  let question = "我当时多少血？";
  if (reason === "missing-health") state.missing_fields = ["health"] as never;
  if (reason === "zero-alive-health") state.health = 0;
  if (reason === "missing-armor") { state.missing_fields = ["armor"] as never; question = "当时有多少护甲？"; }
  if (reason === "missing-inventory") { state.missing_fields = ["inventory"] as never; question = "当时有几颗道具？"; }
  if (reason === "empty-source-refs") state.fact_refs = [];
  if (reason === "wrong-player") source = { ...sourceContext, selectedPlayerId: "another-player" };
  if (reason === "wrong-demo") sourceContext.timeline!.demo_id = "another-demo";
  if (reason === "wrong-material") sourceContext.material!.candidateId = "another-candidate";
  if (reason === "stale") state.tick -= sourceContext.timeline!.tick_rate;
  if (reason === "future-only") state.tick++;
  // New immutable analysis source; the old saved diagnosis remains unchanged.
  input.resourceSource = new CurrentCueResourceCache().read(source);
  const answer = answerGroundedCueQuestion(buildCurrentCueQuestionContext(input)!, question);
  expect(answer.items).toEqual([]);
  expect(answer.text).toContain("不能把未知补成0");
});

it.each(["same-tick", "future", "stale", "previous-round", "entity", "fire", "reload", "drop", "pickup", "missing-latest"])("does not repeat saved ammo after source invalidation: %s", reason => {
  const { input, sourceContext, state, cue } = fixture();
  const ammo = state.active_item.ammo_evidence!;
  if (reason === "same-tick") ammo.sampled_at_tick = cue.decision_tick;
  if (reason === "future") ammo.sampled_at_tick = cue.decision_tick + 1;
  if (reason === "stale") ammo.sampled_at_tick -= sourceContext.timeline!.tick_rate;
  if (reason === "previous-round") ammo.sampled_at_tick = sourceContext.timeline!.rounds[1].start_tick - 1;
  if (reason === "entity") ammo.weapon_handle++;
  if (reason === "missing-latest") delete state.active_item.ammo_evidence;
  if (["fire", "reload", "drop", "pickup"].includes(reason)) sourceContext.timeline!.match_events = [{
    id: "change", tick: cue.decision_tick, event_type: reason === "fire" ? "WEAPON_FIRE" : reason === "reload" ? "RELOAD" : reason === "drop" ? "ITEM_DROP" : "ITEM_PICKUP",
    actor_player_id: sourceContext.selectedPlayerId, payload: {}, source_parser_event: "fixture", fact_confidence: 1, fact_refs: [], missing_fields: [],
  }];
  input.resourceSource = new CurrentCueResourceCache().read(sourceContext);
  const answer = answerGroundedCueQuestion(buildCurrentCueQuestionContext(input)!, "弹匣当时还有几发？");
  expect(answer.items).toEqual([]);
  expect(answer.text).toContain("无法可靠核对决策前最近弹匣记录");
  expect(answer.text).toContain("备弹也未知");
});

it.each(["如果只有5滴血该怎么打？", "我说自己有5滴血，我当时多少血？", "下一个点我当时多少血？", "职业选手当时有多少护甲？", "队友报点之后弹匣当时还有几发？", "当时有几颗道具，所以一定错了？"])("does not treat a hypothetical or unrelated question as a resource request: %s", question => {
  const { input } = fixture();
  const answer = answerGroundedCueQuestion(buildCurrentCueQuestionContext(input)!, question);
  expect(answer.items).toEqual([]);
  expect(answer.source).toBe("当前追问的能力边界");
});

it("does not promote untrusted history or baseline measurements through the resource token", () => {
  const { input, cue } = fixture();
  cue.observableContext = undefined;
  expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
  const other = fixture();
  other.input.diagnosticsEnabled = false;
  const context = buildCurrentCueQuestionContext({ ...other.input, presentableNarration: {
    cueId: other.cue.id, candidateId: other.cue.candidate_id!, primaryFocusCode: "TEST",
    currentSituation: { text: "已展示", refs: [] }, playerAction: { text: "动作", refs: [] }, coreIssue: { text: "判断", refs: [] },
    betterPlay: { text: "建议", refs: [] }, outcomeImpact: { text: "结果", refs: [] },
  } })!;
  expect(answerGroundedCueQuestion(context, "我当时多少血？").items).toEqual([]);
});

it("reuses the production projection during editing and replay, invalidates new sources, and isolates old callbacks", () => {
  const { input, cache, sourceContext, cue } = fixture();
  const project = vi.spyOn(resourceProjection, "currentDiagnosisResources");
  try {
    const context = buildCurrentCueQuestionContext(input)!;
    const originalSource = input.resourceSource;
    let state = updateCurrentCueQuestions(undefined, context.key, context, { type: "ASK", question: "我当时多少血？" });
    for (let i = 1; i <= 20; i++) {
      input.resourceSource = cache.read({ ...sourceContext });
      state = updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(input), { type: "DRAFT", text: "问".repeat(i) });
    }
    const saved = state;
    input.session = reduceCoachingSession(input.plan, input.session, { type: "REPLAY_OUTCOME" });
    input.resourceSource = cache.read({ ...sourceContext });
    expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
    input.session = reduceCoachingSession(input.plan, input.session, { type: "TICK", tick: cue.outcome_end_tick });
    input.resourceSource = cache.read({ ...sourceContext });
    expect(currentCueQuestionState(state, buildCurrentCueQuestionContext(input)!)).toBe(saved);
    expect(project).not.toHaveBeenCalled();
    // Replacing the immutable timeline invalidates the cached source, even at the same cue.
    const newTimeline = { ...sourceContext, timeline: { ...sourceContext.timeline! } };
    input.resourceSource = cache.read(newTimeline);
    expect(project).toHaveBeenCalledTimes(1);
    const changed = buildCurrentCueQuestionContext(input)!;
    expect(changed.key).not.toBe(context.key);
    expect(currentCueQuestionState(state, changed).turns).toEqual([]);
    expect(updateCurrentCueQuestions(state, context.key, changed, { type: "ASK", question: "我当时多少血？" })).toBe(saved);
    expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...input, resourceSource: originalSource })!, "我当时多少血？").items).toEqual([]);
    const newMaterial = { ...newTimeline, material: { ...sourceContext.material! } };
    input.resourceSource = cache.read(newMaterial);
    expect(project).toHaveBeenCalledTimes(2);
    expect(buildCurrentCueQuestionContext(input)!.key).not.toBe(changed.key);
    input.resourceSource = cache.read({ ...newMaterial });
    expect(project).toHaveBeenCalledTimes(2);
  } finally { project.mockRestore(); }
});

it("renders the actual resource answer after the Panel submit callback without changing the saved diagnosis", () => {
  const { input, output } = fixture();
  const before = structuredClone(output);
  const context = buildCurrentCueQuestionContext(input)!;
  let state = updateCurrentCueQuestions(undefined, context.key, context, { type: "DRAFT", text: "弹匣当时还有几发？" });
  const panel = CurrentCueQuestionsPanel({ state: currentCueQuestionState(state, context), onDraft() {}, onAsk(question) {
    state = updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(input), { type: "ASK", question });
  } });
  const form = (panel.props.children as import("react").ReactElement[]).find(node => node.type === "form")!;
  (form.props as { onSubmit: (event: { preventDefault(): void }) => void }).onSubmit({ preventDefault() {} });
  const html = renderToStaticMarkup(createElement(CurrentCueQuestionsPanel, { state: currentCueQuestionState(state, context), onDraft() {}, onAsk() {} }));
  expect(html).toContain("AK-47 决策前最近记录弹匣：0发");
  expect(html).toContain("不能保证决策瞬间的精确余量");
  expect(html).toContain("来源：当前诊断数值证据与本人资源记录交叉核对");
  expect(html).not.toMatch(/weapon_handle|current-frame|resource-source/);
  expect(output).toEqual(before);
});

it("preserves all four verified resources and the cache in a completed manual visit", () => {
  const { input, cache, sourceContext, output, cue } = fixture();
  const before = structuredClone(input.session);
  const defaultContext = buildCurrentCueQuestionContext(input)!;
  const project = vi.spyOn(resourceProjection, "currentDiagnosisResources");
  try {
    input.takenOver = true;
    input.session = reduceCoachingSession(input.plan, input.session, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue.id, visitId: "resources-manual" });
    expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
    input.session = reduceCoachingSession(input.plan, input.session, { type: "TICK", tick: cue.outcome_end_tick });
    input.resourceSource = cache.read({ ...sourceContext });
    const manualContext = buildCurrentCueQuestionContext(input)!;
    expect(manualContext.key).not.toBe(defaultContext.key);
    for (const [question] of examples) expect(answerGroundedCueQuestion(manualContext, question)).toEqual(answerGroundedCueQuestion(defaultContext, question));
    const sessionBeforeQuestions = structuredClone(input.session);
    const saved = updateCurrentCueQuestions(undefined, manualContext.key, manualContext, { type: "DRAFT", text: "我当时多少血？" });
    input.resourceSource = cache.read({ ...sourceContext });
    expect(currentCueQuestionState(saved, buildCurrentCueQuestionContext(input)!)).toBe(saved);
    const answered = updateCurrentCueQuestions(saved, manualContext.key, manualContext, { type: "ASK", question: "弹匣当时还有几发？" });
    const beforeReplay = input.session;
    input.session = reduceCoachingSession(input.plan, input.session, { type: "REPLAY_OUTCOME", target: { sessionId: input.session.id, cueId: cue.id, visitId: "resources-manual" } });
    expect(input.session.phase).toBe("REPLAYING");
    expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
    input.session = reduceCoachingSession(input.plan, input.session, { type: "TICK", tick: cue.outcome_end_tick });
    expect(currentCueQuestionState(answered, buildCurrentCueQuestionContext(input)!)).toBe(answered);
    expect(answered?.draft).toBe("我当时多少血？");
    expect(answered?.turns).toHaveLength(1);
    expect(input.session.cue_cases).toEqual(beforeReplay.cue_cases);
    expect(project).not.toHaveBeenCalled();
    expect(input.session.user_events.filter(event => event.type !== "OUTCOME_REPLAYED")).toEqual(sessionBeforeQuestions.user_events.filter(event => event.type !== "OUTCOME_REPLAYED"));
    expect(input.session.default_route_cursor).toEqual(before.default_route_cursor);
    expect(input.session.consumed_cue_ids).toEqual(before.consumed_cue_ids);
    expect(input.session.presented_cue_ids).toEqual(before.presented_cue_ids);
    expect(input.session.cue_cases?.[cue.id]).toEqual(output.cueCase);
    expect(input.session.learning_threads).toEqual(before.learning_threads);
    input.resourceSource = { revision: input.resourceSource!.revision };
    expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(input)!, "我当时多少血？").items).toEqual([]);
  } finally { project.mockRestore(); }
});
