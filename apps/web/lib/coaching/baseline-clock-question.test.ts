import { expect, it, vi, afterEach } from "vitest";
import { buildCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, serializeCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { CurrentCueResourceCache } from "./current-cue-resource-source";
import { buildCurrentCueQuestionContext, answerGroundedCueQuestion, updateCurrentCueQuestions } from "./current-cue-questions";
import { buildInitialCoachingRouteState } from "./cs2d-route-integration";

const question = "当时回合还剩多久？";
afterEach(() => vi.unstubAllGlobals());
function fixture(mode: "live" | "unknown" | "paused" | "planted" | "subsecond" = "live") {
  // Synthetic fixture clock fields and ticks, not a parsed Demo measurement.
  const raw = fireReplay("DEATH");
  const replay = { ...raw, rounds: raw.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame,
    ...(mode !== "unknown" ? { clock: { source: "SOURCE2_GAMERULES" as const, sampledAtTick: frame.tick, serverTick: frame.tick,
      tickInterval: 1 / 64, roundStartTimeSeconds: round.startTick / 64, roundDurationSeconds: mode === "subsecond" ? 6 : 115,
      roundsPlayed: 0, freeze: false, warmup: false, bombPlanted: mode === "planted", roundWinStatus: 0,
      paused: mode === "paused", totalPausedTicks: 0, pauseObserved: false, clockContinuous: true } } : {}),
  })) })) };
  const bundle = deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-baseline-clock" })));
  const plan = bundle.review_plan, cue = plan.cues[0];
  const material = bundle.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const coaching = buildCoachingPackage(cue, bundle.candidate_set, bundle.observation_evidence);
  const narration = deterministicNarrationBundle(coaching, buildOutcomePackage(cue, bundle.candidate_set));
  const route = buildInitialCoachingRouteState(plan, { narrationByCue: { [cue.id]: narration } });
  let session = reduceCoachingSession(plan, createCoachingSession(plan, "baseline-clock-session", route), { type: "START" });
  for (let i = 0; i < 30 && session.phase !== "PAUSED_FOR_COACHING"; i++) {
    const current = getCurrentCue(plan, session);
    session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" }
      : current ? { type: "TICK", tick: current.outcome_end_tick } : { type: "ADVANCE_SEGMENT" });
  }
  expect(session.phase).toBe("PAUSED_FOR_COACHING"); expect(session.outcome_completion?.status).toBe("COMPLETE");
  const cache = new CurrentCueResourceCache();
  const origin = { plan, cue, material, timeline: bundle.match_timeline, selectedPlayerId: self };
  const input = { plan, session, generation: 1, diagnosticsEnabled: false, presentableNarration: narration,
    busy: false, takenOver: false, resourceSource: cache.read(origin) };
  return { input, cache, origin, coaching };
}

it("answers the displayed baseline clock from the same opaque source after the actual outcome gate", () => {
  const fetcher = vi.fn(() => { throw Error("NETWORK_NOT_EXPECTED"); }); vi.stubGlobal("fetch", fetcher);
  const f = fixture(), before = JSON.stringify(f.input);
  const clockRef = f.origin.material.decisionSnapshot!.clock.evidenceRefs[0];
  const clockFact = f.coaching.decisionContext.facts.find(fact => fact.id === clockRef)!;
  expect(f.input.presentableNarration.currentSituation.text).toContain(clockFact.text);
  const context = buildCurrentCueQuestionContext(f.input)!;
  expect(answerGroundedCueQuestion(context, question).items).toEqual([{ text: clockFact.text, refs: [clockRef] }]);
  expect(answerGroundedCueQuestion(context, question).source).toContain("当前讲解");
  expect(answerGroundedCueQuestion(context, question).source).not.toContain("诊断");
  expect(JSON.stringify(f.input)).toBe(before); expect(fetcher).not.toHaveBeenCalled();
});

it("preserves the sourced subsecond wording instead of rounding it into one second", () => {
  const f = fixture("subsecond");
  const answer = answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question);
  expect(answer.items).toHaveLength(1);
  expect(answer.items[0].text).toContain("不足1秒");
  expect(answer.items[0].text).not.toContain("约1秒");
  expect(answer.text).toContain("不是 C4 倒计时");
  expect(answer.text).toContain("不能据此判断等待是否正确");
});

it.each(["text-missing", "text-changed", "partial-text", "ref-missing", "ref-wrong", "ref-duplicate"])("does not borrow a clock missing from the actual baseline display: %s", mismatch => {
  const f = fixture(), ref = f.origin.material.decisionSnapshot!.clock.evidenceRefs[0];
  const text = f.coaching.decisionContext.facts.find(fact => fact.id === ref)!.text;
  const shown = f.input.presentableNarration.currentSituation;
  if (mismatch === "text-missing") shown.text = shown.text.replace(text, "");
  if (mismatch === "text-changed") shown.text = shown.text.replace(text, "决策前最近采样的回合剩余时间约120秒。");
  if (mismatch === "partial-text") shown.text = shown.text.replace(text, "约110秒");
  if (mismatch === "ref-missing") shown.refs = shown.refs.filter(value => value !== ref);
  if (mismatch === "ref-wrong") shown.refs = shown.refs.map(value => value === ref ? "other-clock" : value);
  if (mismatch === "ref-duplicate") shown.refs = [...shown.refs, ref];
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
});

it.each(["unknown", "paused", "planted"] as const)("keeps %s clock unavailable even if a displayed number is fabricated", mode => {
  const f = fixture(mode);
  f.input.presentableNarration.currentSituation.text += " 决策前最近采样的回合剩余时间约110秒。";
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
});

it.each(["future", "old", "player", "round", "fact-text", "unobserved"])("requires the current clock provenance: %s", mismatch => {
  const f = fixture(), snapshot = structuredClone(f.origin.material.decisionSnapshot!);
  if (mismatch === "future") snapshot.sampledAtTick = f.origin.cue.decision_tick + 1;
  if (mismatch === "old") snapshot.sampledAtTick = f.origin.cue.decision_tick - 64;
  if (mismatch === "player") snapshot.selectedPlayerId = "other-player";
  if (mismatch === "round") snapshot.roundNumber++;
  const refs = snapshot.clock.evidenceRefs;
  const material = { ...f.origin.material, decisionSnapshot: snapshot, decisionFacts: f.origin.material.decisionFacts.map(fact => refs.includes(fact.id)
    ? { ...fact, ...(mismatch === "fact-text" ? { text: "不同来源正文" } : {}), ...(mismatch === "unobserved" ? { observed_by_player: false } : {}) } : fact) };
  f.input.resourceSource = f.cache.read({ ...f.origin, material });
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
});

it("accepts a restored displayed sentence only with the current source, and never fills an old display omission", () => {
  const f = fixture();
  f.input.presentableNarration = JSON.parse(JSON.stringify(f.input.presentableNarration));
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toHaveLength(1);
  const clockRef = f.origin.material.decisionSnapshot!.clock.evidenceRefs[0];
  const clockText = f.coaching.decisionContext.facts.find(fact => fact.id === clockRef)!.text;
  f.input.presentableNarration.currentSituation.text = f.input.presentableNarration.currentSituation.text.replace(clockText, "");
  const before = JSON.stringify(f.input.presentableNarration);
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
  expect(JSON.stringify(f.input.presentableNarration)).toBe(before);
});

it("invalidates old source tokens and question callbacks without accepting a forged or other-cue source", () => {
  const f = fixture(), source = f.input.resourceSource!, current = buildCurrentCueQuestionContext(f.input)!;
  const state = updateCurrentCueQuestions(undefined, current.key, current, { type: "ASK", question });
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, resourceSource: { revision: source.revision } })!, question).items).toEqual([]);
  const other = fixture();
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, resourceSource: other.input.resourceSource })!, question).items).toEqual([]);
  f.input.resourceSource = f.cache.read({ ...f.origin, timeline: { ...f.origin.timeline } });
  const next = buildCurrentCueQuestionContext(f.input)!;
  expect(next.key).not.toBe(current.key);
  expect(updateCurrentCueQuestions(state, current.key, next, { type: "ASK", question })).toBe(state);
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({ ...f.input, resourceSource: source })!, question).items).toEqual([]);
  f.cache.read(undefined);
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
});

it("keeps the result gate, busy/takeover gate and precise supported wording", () => {
  const f = fixture();
  const replaying = reduceCoachingSession(f.input.plan, f.input.session, { type: "REPLAY_OUTCOME" });
  expect(buildCurrentCueQuestionContext({ ...f.input, session: replaying })).toBeUndefined();
  expect(buildCurrentCueQuestionContext({ ...f.input, busy: true })).toBeUndefined();
  expect(buildCurrentCueQuestionContext({ ...f.input, takenOver: true })).toBeUndefined();
  const context = buildCurrentCueQuestionContext(f.input)!;
  for (const unsupported of ["C4还剩多久？", "如果还剩30秒该等吗？", "下一个点当时回合还剩多久？"]) {
    expect(answerGroundedCueQuestion(context, unsupported).items).toEqual([]);
    expect(answerGroundedCueQuestion(context, unsupported).source).toBe("当前追问的能力边界");
  }
});


it("rejects a cue-side observed flag conflict even when the matching material fact remains legal", () => {
  const f = fixture(), ref = f.origin.material.decisionSnapshot!.clock.evidenceRefs[0];
  f.origin.cue.facts = f.origin.cue.facts.map(fact => fact.id === ref ? { ...fact, observed_by_player: false } : fact);
  expect(f.origin.material.decisionFacts.find(fact => fact.id === ref)!.observed_by_player).toBe(true);
  f.input.resourceSource = f.cache.read({ ...f.origin, material: { ...f.origin.material } });
  expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!, question).items).toEqual([]);
});
