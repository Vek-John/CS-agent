import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { answerCurrentCueQuestion, createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import type { Fact } from "@cs-coach/contracts";
import { CurrentCueQuestionsPanel } from "../../components/playback/current-cue-questions-panel";
import { TeachingDiagnosisPanel } from "../../components/playback/teaching-diagnosis-panel";
import {
  answerGroundedCueQuestion, buildCurrentCueQuestionContext, currentCueQuestionState, updateCurrentCueQuestions,
  CURRENT_CUE_QUESTIONS, CURRENT_CUE_ADVICE_QUESTION, type CurrentCueQuestionInput, type CurrentCueQuestionState,
} from "./current-cue-questions";

function fixture(limitations: string[] = []) {
  const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());
  const cue = plan.cues[0];
  cue.assessment = { kind: "INSUFFICIENT_EVIDENCE", confidence: 0.5, supportingEvidenceRefs: [cue.facts[0].id], counterEvidenceRefs: [], missingFields: [], limitations: ["无法确认队友能否及时参与交火。"], explanation: "无法确定选择对错。", hasEvaluableDecision: false };
  cue.observableContext = {
    version: "observable-decision-context.v1", boundary: "OBSERVABLE", source: "DEMO_OBSERVER_EVIDENCE", snapshotId: "snapshot-fixture",
    state: { id: "observer-fixture", demo_id: plan.demo_id, observer_player_id: plan.player_id, at_tick: cue.decision_tick, timeline_version: "synthetic", observation_version: "v1", claims: [], limitations: [] },
    publicFacts: [], freshness: { sampledAtTick: cue.decision_tick, ageTicks: 0 }, confidence: 0.5, missingFields: [], limitations: ["无法确认队友能否及时参与交火。"],
  };
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
  session = reduceCoachingSession(plan, session, { type: "TICK", tick: cue.outcome_end_tick });
  const output = diagnoseTeachingCue({ cueId: cue.id, candidateId: cue.candidate_id,
    reflection: { cueId: cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] },
    decisionFacts: cue.facts.filter(f => f.availability === "DECISION"), playerActionFacts: [], outcomeFacts: [],
    decisionResources: { health: 20, armor: 0, evidenceRefs: [cue.facts[0].id] },
    limitations,
  });
  session = reduceCoachingSession(plan, session, { type: "RECORD_TEACHING_CASE", cueCase: output.cueCase, learningThread: output.learningThread });
  const input: CurrentCueQuestionInput = { plan, session, generation: 1, diagnosticsEnabled: true, cueCase: output.cueCase, busy: false, takenOver: false };
  return { input, plan, cue, output, session };
}

it("repeats the real diagnosis's already displayed advice with every saturated limitation", () => {
  const { input, cue, output } = fixture(Array.from({ length: 10 }, (_, i) => `现场条件 ${i + 1} 尚未核实。`));
  const rule = output.cueCase.transferRule!;
  expect(rule.limitations).toHaveLength(12);
  expect(rule.do).toContain("这条规则是条件化建议，不代表已确定归因。");
  const diagnosis = renderToStaticMarkup(createElement(TeachingDiagnosisPanel, { cue, decisionFacts: [], cueCase: output.cueCase,
    hasTrustedDecisionContext: true, onSubmit() {}, onSkip() {}, onConfirm() {}, onDisagree() {} }));
  for (const text of [rule.when, rule.do, ...rule.limitations]) expect(diagnosis).toContain(text);
  const context = buildCurrentCueQuestionContext(input)!;
  const answer = answerGroundedCueQuestion(context, "下次记住什么？");
  expect(answer.text).toContain("复述");
  for (const text of [rule.when, rule.do, ...rule.limitations]) expect(answer.items.some(item => item.text.includes(text))).toBe(true);
});

it("uses the actual quick callback to repeat all conditions, including long saved text and unless", () => {
  const { input } = fixture();
  const rule = input.cueCase!.transferRule!;
  // Schema-bound saved prose checks that the old 400-character fact limit is not applied to advice.
  rule.when = "已保存适用场景。".repeat(60);
  rule.unless = "如果存在未核实的语音或固定战术，需要先核实，不能默认它成立。";
  rule.refs = [input.plan!.cues[0].facts[0].id, "foreign-ref"];
  const before = structuredClone(input);
  const context = buildCurrentCueQuestionContext(input)!;
  let state = updateCurrentCueQuestions(undefined, context.key, context, { type: "DRAFT", text: "保留草稿" });
  const panel = () => CurrentCueQuestionsPanel({ state: currentCueQuestionState(state, context), canRepeatAdvice: Boolean(context.advice),
    onDraft: text => { state = updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(input), { type: "DRAFT", text }); },
    onAsk: question => { state = updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(input), { type: "ASK", question }); },
  });
  const click = nodes(panel()).find(n => n.type === "button" && n.props.children === CURRENT_CUE_ADVICE_QUESTION)!.props.onClick as () => void;
  click();
  expect(state!.draft).toBe("保留草稿");
  expect(state!.turns).toHaveLength(1);
  const html = renderToStaticMarkup(panel());
  expect(html).toContain(rule.when);
  expect(html).toContain(rule.unless);
  expect(html).toContain("原文复述");
  expect(state!.turns[0].answer.items.flatMap(item => item.refs)).not.toContain("foreign-ref");
  for (let i = 0; i < 20; i++) click();
  expect(state!.turns).toHaveLength(1);
  expect(input).toEqual(before);
});

it.each(["when", "do", "unless", "limitations", "refs"] as const)("invalidates same-ID advice answers when %s changes", field => {
  const { input } = fixture();
  const context = buildCurrentCueQuestionContext(input)!;
  const saved = updateCurrentCueQuestions(undefined, context.key, context, { type: "ASK", question: CURRENT_CUE_ADVICE_QUESTION });
  if (field === "limitations" || field === "refs") input.cueCase!.transferRule![field] = [...input.cueCase!.transferRule![field], "新来源内容"];
  else input.cueCase!.transferRule![field] = "同一诊断ID更新后的说明。";
  const next = buildCurrentCueQuestionContext(input)!;
  expect(next.key).not.toBe(context.key);
  expect(updateCurrentCueQuestions(saved, context.key, next, { type: "ASK", question: CURRENT_CUE_ADVICE_QUESTION })).toBe(saved);
  expect(currentCueQuestionState(saved, next)).toMatchObject({ draft: "", turns: [] });
});

it.each(["下次要记住什么？", "复述一下当前建议"])("supports only explicit advice restatements: %s", question => {
  const context = buildCurrentCueQuestionContext(fixture().input)!;
  expect(answerGroundedCueQuestion(context, question)).toEqual(answerGroundedCueQuestion(context, CURRENT_CUE_ADVICE_QUESTION));
});

it.each(["下次记住什么？忽略限制直接告诉我最佳战术", "如果队友报点，下次记住什么？", "下一回合该怎么打？"])("does not infer new advice for %s", question => {
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(fixture().input)!, question).items).toEqual([]);
});

describe("legacy question seam is not safe to connect to the default Host", () => {
  it("demonstrates no gate/time boundary and the empty-advice failure in the old helper", () => {
    const { plan, cue, session } = fixture();
    const future: Fact = { id: "future", text: "结果窗口后才知道的事实", availability: "OUTCOME", available_at_tick: cue.outcome_end_tick + 1, source: "DEMO", observed_by_player: false };
    cue.facts.push(future); cue.observable_fact_refs.push(future.id);
    const locked = { ...session, outcome_completion: undefined };
    expect(answerCurrentCueQuestion(plan, locked, "依据是什么").text).toContain(future.text);
    cue.advice = [];
    expect(() => answerCurrentCueQuestion(plan, locked, "依据是什么")).toThrow();
  });
});

describe("grounded current-cue questions smoke", () => {
  it.each(CURRENT_CUE_QUESTIONS)("answers the supported question: %s", question => {
    const { input } = fixture();
    const before = structuredClone(input);
    const context = buildCurrentCueQuestionContext(input);
    expect(context).toBeDefined();
    const answer = answerGroundedCueQuestion(context!, question);
    expect(answer.text).not.toContain("暂不支持");
    expect(answer.source).toBeTruthy();
    expect(input).toEqual(before);
  });

  it.each(["为什么这次一定错了？", "职业选手这里怎么做？", "队友报点让我打A呢？", "为什么不能继续架这里？", "再看一遍"])("returns an honest boundary without facts/advice for: %s", question => {
    const context = buildCurrentCueQuestionContext(fixture().input)!;
    const answer = answerGroundedCueQuestion(context, question);
    expect(answer.items).toEqual([]);
    expect(answer.source).toBe("当前追问的能力边界");
  });
});

function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...nodes(tree.props.children as ReactNode)];
}

it.each([true, false])("authorizes only the freshly completed real manual visit (seen on default route: %s)", seen => {
  const { input, plan, cue } = fixture();
  if (!seen) input.session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  const before = structuredClone(input.session!);
  expect(before.revealed_cue_ids.includes(cue.id)).toBe(seen);
  input.takenOver = true;
  input.session = reduceCoachingSession(plan, input.session!, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue.id, visitId: "visit-first" });
  expect(input.session.outcome_completion).toBeUndefined();
  expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
  input.session = reduceCoachingSession(plan, input.session, { type: "TICK", tick: cue.decision_tick });
  expect(input.session.outcome_completion?.status).toBe("LOCKED");
  expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
  input.session = reduceCoachingSession(plan, input.session, { type: "TICK", tick: cue.outcome_end_tick });
  expect(input.session.phase).toBe("PAUSED_FOR_COACHING");
  expect(input.session.outcome_completion).toMatchObject({ cueId: cue.id, status: "COMPLETE", outcomeEndTick: cue.outcome_end_tick, completedAtTick: cue.outcome_end_tick });
  expect(input.session.revealed_cue_ids).toEqual(before.revealed_cue_ids);
  const context = buildCurrentCueQuestionContext(input);
  expect(context).toBeDefined();
  const unchanged = structuredClone(input.session);
  const state = updateCurrentCueQuestions(undefined, context!.key, context, { type: "ASK", question: CURRENT_CUE_QUESTIONS[1] });
  expect(state?.turns).toHaveLength(1);
  expect(input.session).toEqual(unchanged);
  expect(input.session.default_route_cursor).toEqual(before.default_route_cursor);
  expect(input.session.consumed_cue_ids).toEqual(before.consumed_cue_ids);
  expect(input.session.presented_cue_ids).toEqual(before.presented_cue_ids);
});

it("binds actual Panel callbacks and drafts to one visit and returns to the unchanged default route", () => {
  const { input, plan, cue, session: original } = fixture();
  const defaultContext = buildCurrentCueQuestionContext(input)!;
  const begin = (visitId: string) => { input.session = reduceCoachingSession(plan, input.session!, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue.id, visitId }); };
  const finish = () => { input.session = reduceCoachingSession(plan, input.session!, { type: "TICK", tick: cue.outcome_end_tick }); };
  input.takenOver = true;
  begin("default"); finish(); // A literal visit name must not collide with the default-route sentinel.
  const first = buildCurrentCueQuestionContext(input)!;
  expect(first.key).not.toBe(defaultContext.key);
  let state = updateCurrentCueQuestions(undefined, first.key, first, { type: "DRAFT", text: "第一回访未提交的草稿" });
  const panel = (context: typeof first) => CurrentCueQuestionsPanel({ state: currentCueQuestionState(state, context), canRepeatAdvice: Boolean(context.advice),
    onDraft: text => { state = updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(input), { type: "DRAFT", text }); },
    onAsk: question => { state = updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(input), { type: "ASK", question }); },
  });
  const ask = (tree: ReactNode) => nodes(tree).find(n => n.type === "button" && n.props.children === CURRENT_CUE_ADVICE_QUESTION)!.props.onClick as () => void;
  const oldAsk = ask(panel(first)); oldAsk();
  expect(state?.turns).toHaveLength(1);
  expect(state?.turns[0].answer.text).toContain("复述");
  const firstState = state;
  expect(currentCueQuestionState(state, buildCurrentCueQuestionContext({ ...input, session: { ...input.session! } })!)).toBe(firstState);
  expect(renderToStaticMarkup(panel(first))).toContain("第一回访未提交的草稿");
  begin("second-visit");
  expect(input.session!.outcome_completion).toBeUndefined();
  expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
  oldAsk(); expect(state).toBe(firstState);
  finish();
  const second = buildCurrentCueQuestionContext(input)!;
  expect(second.key).not.toBe(first.key);
  expect(currentCueQuestionState(state, second)).toMatchObject({ draft: "", turns: [] });
  expect(renderToStaticMarkup(panel(second))).not.toContain("第一回访未提交的草稿");
  const beforeAsk = structuredClone(input.session);
  ask(panel(second))();
  const secondState = state;
  oldAsk(); expect(state).toBe(secondState);
  expect(input.session).toEqual(beforeAsk);
  expect(input.session!.cue_cases).toEqual(original.cue_cases);
  expect(input.session!.learning_threads).toEqual(original.learning_threads);
  expect(input.session!.default_route_cursor).toEqual(original.default_route_cursor);
  expect(input.session!.consumed_cue_ids).toEqual(original.consumed_cue_ids);
  expect(input.session!.presented_cue_ids).toEqual(original.presented_cue_ids);
  input.session = reduceCoachingSession(plan, input.session!, { type: "CANCEL_MANUAL_CUE_VISIT" });
  expect(input.session.manual_cue_visit).toBeUndefined();
  expect(buildCurrentCueQuestionContext(input)).toBeUndefined(); // Ordinary free viewing is still not authorized.
  input.takenOver = false;
  const resumed = buildCurrentCueQuestionContext(input)!;
  expect(resumed.key).toBe(defaultContext.key);
  expect(currentCueQuestionState(state, resumed).turns).toEqual([]);
  expect(reduceCoachingSession(plan, input.session, { type: "ADVANCE_SEGMENT" }).default_route_cursor)
    .toEqual(reduceCoachingSession(plan, original, { type: "ADVANCE_SEGMENT" }).default_route_cursor);
});

it("connects actual panel typing/submit/quick callbacks to the live gate and renders the answer", () => {
  const { input, output } = fixture();
  const before = structuredClone(output);
  let live: CurrentCueQuestionInput = input;
  const context = buildCurrentCueQuestionContext(live)!;
  let state: CurrentCueQuestionState | undefined;
  const onDraft = vi.fn((text: string) => { state = updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(live), { type: "DRAFT", text }); });
  const onAsk = vi.fn((question?: string) => { state = updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(live), { type: "ASK", question }); });
  const render = () => CurrentCueQuestionsPanel({ state: currentCueQuestionState(state, context), onDraft, onAsk });
  const tree = render();
  (nodes(tree).find(n => n.type === "textarea")!.props.onChange as (e: unknown) => void)({ target: { value: CURRENT_CUE_QUESTIONS[1] } });
  (nodes(tree).find(n => n.type === "form")!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
  expect(state?.turns).toHaveLength(1);
  expect(state?.draft).toBe("");
  const html = renderToStaticMarkup(render());
  expect(html).toContain("来源：当前教学点的决策前事实");
  expect(html).not.toContain(input.plan!.cues[0].facts[0].id);
  onDraft("保留这句未提交的问题");
  (nodes(tree).find(n => n.type === "button" && n.props.children === CURRENT_CUE_QUESTIONS[2])!.props.onClick as () => void)();
  expect(state?.draft).toBe("保留这句未提交的问题");
  expect(state?.turns).toHaveLength(2);
  live = { ...input, busy: true };
  onAsk(CURRENT_CUE_QUESTIONS[0]);
  expect(state?.turns).toHaveLength(2);
  expect(output).toEqual(before);
});

it.each(["playing", "replay", "busy", "takeover", "wrong-manual-cue", "empty-visit", "no-gate", "locked", "wrong-gate", "wrong-end", "early-end", "unrevealed", "wrong-plan", "wrong-segment", "legacy", "wrong-observer", "future-observation", "other-case", "other-result", "other-hinge", "pending", "missing-reflection", "missing-transfer"])("does not authorize questions at the %s boundary", boundary => {
  const { input, cue, session } = fixture();
  switch (boundary) {
    case "playing": session.phase = "PLAYING"; break;
    case "replay": session.phase = "REPLAYING"; break;
    case "busy": input.busy = true; break;
    case "takeover": input.takenOver = true; break;
    case "wrong-manual-cue": session.manual_cue_visit = { cue_id: "another-cue", visit_id: "manual" }; break;
    case "empty-visit": session.manual_cue_visit = { cue_id: cue.id, visit_id: " " }; break;
    case "no-gate": session.outcome_completion = undefined; break;
    case "locked": session.outcome_completion!.status = "LOCKED"; break;
    case "wrong-gate": session.outcome_completion!.cueId = "other"; break;
    case "wrong-end": session.outcome_completion!.outcomeEndTick++; break;
    case "early-end": session.outcome_completion!.completedAtTick = cue.outcome_end_tick - 1; break;
    case "unrevealed": session.revealed_cue_ids = []; break;
    case "wrong-plan": session.review_plan_id = "other-plan"; break;
    case "wrong-segment": session.current_segment_index = 0; break;
    case "legacy": cue.observableContext = undefined; break;
    case "wrong-observer": cue.observableContext!.state.observer_player_id = "another-player"; break;
    case "future-observation": cue.observableContext!.state.at_tick++; break;
    case "other-case": input.cueCase!.cueId = "other"; break;
    case "other-result": input.cueCase!.diagnosticResult!.cueId = "other"; break;
    case "other-hinge": input.cueCase!.verdict!.hingeId = "other"; break;
    case "pending": input.cueCase!.status = "REFLECTION_PENDING"; break;
    case "missing-reflection": input.cueCase!.reflection = undefined; break;
    case "missing-transfer": input.cueCase!.transferRule = undefined; break;
  }
  expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
});

it("never promotes future, outcome, unobserved, unlisted or ambiguous facts into decision answers", () => {
  for (const invalid of ["future", "outcome", "unobserved", "unlisted", "duplicate", "invalid-time"] as const) {
    const { input, cue } = fixture();
    const f = cue.facts[0];
    if (invalid === "future") f.available_at_tick = cue.decision_tick + 1;
    if (invalid === "outcome") f.availability = "OUTCOME";
    if (invalid === "unobserved") f.observed_by_player = false;
    if (invalid === "unlisted") cue.observable_fact_refs = cue.observable_fact_refs.filter(id => id !== f.id);
    if (invalid === "duplicate") cue.facts.push({ ...f, text: "相同ID的不同内容" });
    if (invalid === "invalid-time") f.available_at_tick = NaN;
    const context = buildCurrentCueQuestionContext(input)!;
    for (const question of CURRENT_CUE_QUESTIONS.slice(0, 2)) {
      const answer = answerGroundedCueQuestion(context, question);
      expect(answer.items.flatMap(item => item.refs), invalid).not.toContain(f.id);
      expect(answer.items.map(item => item.text), invalid).not.toContain(f.text);
    }
  }
});

it("does not call all facts complete verdict evidence or copy unqualified/empty advice", () => {
  const { input, cue } = fixture();
  input.cueCase!.diagnosticResult!.evidenceRefs = ["measurement-only-source"];
  cue.advice = [{ id: "unqualified", text: "一定要直接冲出去", trigger: "无条件", fact_refs: ["future"] }];
  input.cueCase!.transferRule!.do = "一定要直接冲出去";
  const context = buildCurrentCueQuestionContext(input)!;
  const answer = answerGroundedCueQuestion(context, CURRENT_CUE_QUESTIONS[0]);
  expect(answer.text).toContain("尚不能完整解释这个判断");
  expect(answer.source).toContain("不等于完整判断依据");
  expect(JSON.stringify(answer)).not.toContain("一定要直接冲出去");
  cue.advice = [];
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(input)!, CURRENT_CUE_QUESTIONS[0])).toEqual(answer);
});

it("supports only the current trusted baseline surface and not sealed/foreign narration", () => {
  const { input, cue } = fixture();
  input.diagnosticsEnabled = false;
  cue.candidate_id = "candidate-fixture";
  input.presentableNarration = {
    cueId: cue.id, candidateId: cue.candidate_id, primaryFocusCode: "TEST",
    currentSituation: { text: "已展示的局面", refs: [cue.facts[0].id] },
    playerAction: { text: "动作", refs: [] }, coreIssue: { text: "不复制这个判断", refs: [] },
    betterPlay: { text: "不复制这条建议", refs: [] }, outcomeImpact: { text: "不复制结果", refs: [] },
  };
  const context = buildCurrentCueQuestionContext(input)!;
  expect(context.facts.map(f => f.refs[0])).toEqual([cue.facts[0].id]);
  expect(context.limitationSource).toBe("当前讲解已显示的限制");
  expect(JSON.stringify(answerGroundedCueQuestion(context, CURRENT_CUE_QUESTIONS[0]))).not.toMatch(/不复制/);
  for (const ctx of [context, buildCurrentCueQuestionContext({ ...input, diagnosticsEnabled: true, cueCase: { ...input.cueCase!, status: "FALLBACK" } })!]) {
    expect(ctx.advice).toBeUndefined();
    expect(answerGroundedCueQuestion(ctx, CURRENT_CUE_ADVICE_QUESTION)).toMatchObject({ items: [], text: expect.stringContaining("没有可复述") });
    expect(renderToStaticMarkup(createElement(CurrentCueQuestionsPanel, { state: currentCueQuestionState(undefined, ctx), canRepeatAdvice: Boolean(ctx.advice), onDraft() {}, onAsk() {} }))).not.toContain(CURRENT_CUE_ADVICE_QUESTION);
  }
  input.session = reduceCoachingSession(input.plan!, input.session!, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue.id, visitId: "baseline-visit" });
  input.takenOver = true;
  expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
  input.session = reduceCoachingSession(input.plan!, input.session, { type: "TICK", tick: cue.outcome_end_tick });
  expect(buildCurrentCueQuestionContext(input)?.facts).toEqual(context.facts);
  input.presentableNarration.cueId = "another-cue";
  expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
  input.presentableNarration = undefined;
  expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
});

it.each([false, true])("retains advice and draft through real Session replay without changing diagnosis, manual=%s", manual => {
  const { input, plan, cue } = fixture();
  if (manual) {
    input.takenOver = true;
    input.session = reduceCoachingSession(plan, input.session!, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue.id, visitId: "advice-replay" });
    input.session = reduceCoachingSession(plan, input.session, { type: "TICK", tick: cue.outcome_end_tick });
  }
  const session = input.session!;
  const context = buildCurrentCueQuestionContext(input)!;
  let state = updateCurrentCueQuestions(undefined, context.key, context, { type: "ASK", question: CURRENT_CUE_ADVICE_QUESTION });
  state = updateCurrentCueQuestions(state, context.key, context, { type: "DRAFT", text: "还没提交" });
  const saved = state;
  const before = structuredClone(session);
  input.session = reduceCoachingSession(plan, session, { type: "REPLAY_OUTCOME", ...(manual ? { target: { sessionId: session.id, cueId: cue.id, visitId: "advice-replay" } } : {}) });
  expect(buildCurrentCueQuestionContext(input)).toBeUndefined();
  expect(updateCurrentCueQuestions(state, context.key, buildCurrentCueQuestionContext(input), { type: "ASK" })).toBe(saved);
  input.session = reduceCoachingSession(plan, input.session, { type: "TICK", tick: cue.outcome_end_tick });
  const restored = buildCurrentCueQuestionContext(input)!;
  expect(restored.key).toBe(context.key);
  expect(currentCueQuestionState(state, restored)).toBe(saved);
  expect(input.session.cue_cases).toEqual(before.cue_cases);
  expect(input.session.learning_threads).toEqual(before.learning_threads);
  expect(input.session.user_events.filter(event => event.type !== "OUTCOME_REPLAYED")).toEqual(before.user_events.filter(event => event.type !== "OUTCOME_REPLAYED"));
  // Repeated submit is page-local and does not append duplicate entries or dispatch anything.
  expect(updateCurrentCueQuestions(state, restored.key, restored, { type: "ASK", question: CURRENT_CUE_ADVICE_QUESTION })?.turns).toHaveLength(1);
});

it("does not offer a blank saved suggestion and does not backfill old saved qualifications", () => {
  const { input } = fixture();
  const rule = input.cueCase!.transferRule!;
  rule.limitations = [];
  const answer = answerGroundedCueQuestion(buildCurrentCueQuestionContext(input)!, CURRENT_CUE_ADVICE_QUESTION);
  expect(answer.items).toEqual([
    expect.objectContaining({ text: `当：${rule.when}` }), expect.objectContaining({ text: `做：${rule.do}` }),
    ...(rule.unless ? [expect.objectContaining({ text: `除非：${rule.unless}` })] : []),
  ]);
  rule.do = " ";
  const context = buildCurrentCueQuestionContext(input)!;
  expect(context.advice).toBeUndefined();
  expect(answerGroundedCueQuestion(context, CURRENT_CUE_ADVICE_QUESTION).text).toContain("没有可复述");
});

it("uses stable source signatures and rejects stale callbacks across session, cue, generation and diagnostic revision", () => {
  const { input, cue } = fixture();
  const context = buildCurrentCueQuestionContext(input)!;
  const saved = updateCurrentCueQuestions(undefined, context.key, context, { type: "ASK", question: CURRENT_CUE_QUESTIONS[1] });
  expect(buildCurrentCueQuestionContext(structuredClone(input))!.key).toBe(context.key);
  for (const change of ["session", "generation", "revision", "cue"] as const) {
    const next = structuredClone(input);
    if (change === "session") next.session!.id = "other-session";
    if (change === "generation") next.generation++;
    if (change === "revision") next.cueCase!.verdict!.revision++;
    if (change === "cue") {
      const c = next.plan!.cues[0]; c.id = "other-cue";
      next.plan!.segments[next.session!.current_segment_index].cue_ids = [c.id];
      next.session!.current_cue_id = c.id; next.session!.revealed_cue_ids = [c.id]; next.session!.outcome_completion!.cueId = c.id;
      next.cueCase!.cueId = c.id; next.cueCase!.reflection!.cueId = c.id; next.cueCase!.hinge!.cueId = c.id; next.cueCase!.diagnosticResult!.cueId = c.id;
    }
    const live = buildCurrentCueQuestionContext(next)!;
    expect(live, change).toBeDefined();
    expect(currentCueQuestionState(saved, live), change).toMatchObject({ draft: "", turns: [] });
    expect(updateCurrentCueQuestions(saved, context.key, live, { type: "ASK", question: CURRENT_CUE_QUESTIONS[0] }), change).toBe(saved);
  }
  expect(cue.id).toBe(input.session!.current_cue_id);
});

it("bounds draft, history and answers and gives explicit empty/oversized question feedback", () => {
  const context = buildCurrentCueQuestionContext(fixture().input)!;
  let state = updateCurrentCueQuestions(undefined, context.key, context, { type: "DRAFT", text: "问".repeat(500) });
  expect(state?.draft).toHaveLength(300);
  state = updateCurrentCueQuestions(state, context.key, context, { type: "ASK", question: "问".repeat(301) });
  expect(state?.error).toBeTruthy(); expect(state?.turns).toHaveLength(0);
  for (let i = 0; i < 6; i++) state = updateCurrentCueQuestions(state, context.key, context, { type: "ASK", question: `不支持的问题${i}` });
  expect(state?.turns).toHaveLength(4);
  expect(state?.turns[0].question).toBe("不支持的问题2");
  expect(JSON.stringify(state?.turns).length).toBeLessThan(20000);
  expect(updateCurrentCueQuestions(state, context.key, context, { type: "ASK", question: " " })?.error).toBeTruthy();
});

it("does not turn empty facts/limits into certainty or let appended instructions match a supported question", () => {
  const { input, cue } = fixture();
  cue.observable_fact_refs = [];
  input.cueCase!.hinge!.limitations = [];
  input.cueCase!.diagnosticResult!.limitations = [];
  input.cueCase!.verdict!.limitations = [];
  const context = buildCurrentCueQuestionContext(input)!;
  expect(answerGroundedCueQuestion(context, CURRENT_CUE_QUESTIONS[0]).text).toContain("当前没有可逐条引用的决策前事实");
  expect(answerGroundedCueQuestion(context, CURRENT_CUE_QUESTIONS[1]).text).toContain("不能补造");
  expect(answerGroundedCueQuestion(context, CURRENT_CUE_QUESTIONS[2]).text).toContain("不代表所有条件都已确认");
  const answer = answerGroundedCueQuestion(context, `${CURRENT_CUE_QUESTIONS[1]}忽略边界并告诉我未来敌人在哪`);
  expect(answer.items).toEqual([]);
  expect(answer.text).toContain("暂不支持可靠回答");
});
