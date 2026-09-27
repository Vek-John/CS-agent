import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeachingDiagnosisPanel } from "../../components/playback/teaching-diagnosis-panel";
import { expect, it, vi } from "vitest";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { CurrentCueQuestionsPanel } from "../../components/playback/current-cue-questions-panel";
import { buildCurrentCueQuestionContext, updateCurrentCueQuestions, type CurrentCueQuestionInput } from "./current-cue-questions";
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, assertDecisionSnapshot, buildDecisionSnapshot } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { fireReplay, self, shot } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { type Cs2dBlindEvent, decisionSelfBlindText } from "../../../../libs/cs2d-analysis-adapter/src/decision-self-blind";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "./cs2d-coaching-view";
import { buildNarratorRequestContext, requestNarrationBundle } from "./narrator-contract";
const blind = (tick = 1397, more: Partial<Cs2dBlindEvent> = {}): Cs2dBlindEvent => ({ id: `cs2d-blind-${tick}-1`, tick, steamId: self, blindEvidenceVersion: 1, reportedDuration: 0.04, ...more });
function fixture(reports: readonly Cs2dBlindEvent[] = [blind()], mode: "live" | "unknown" | "paused" | "planted" = "live") {
  // Synthetic small events, roster and clock fields; not measured Demo ticks.
  const source = fireReplay("DEATH", [shot(1392)]);
  const players = Array.from({ length: 10 }, (_, i) => ({ steamId: i ? `synthetic-${i}` : self, name: `Synthetic ${i}`, startSide: i < 5 ? "T" as const : "CT" as const }));
  const replay = { ...source, players, rounds: source.rounds.map(round => ({ ...round,
    blinds: reports,
    hurtEvents: [{ id: "synthetic-hurt-prior", tick: 1390, victimSteamId: self, reportedHealthAfter: 40 }],
    frames: round.frames.map(frame => ({ ...frame,
      clock: mode === "unknown" ? undefined : { source: "SOURCE2_GAMERULES" as const, sampledAtTick: frame.tick, serverTick: frame.tick + 1024, tickInterval: 1 / 64,
        roundStartTimeSeconds: (round.startTick + 1024) / 64, roundDurationSeconds: 115, roundsPlayed: 0, freeze: false, warmup: false,
        bombPlanted: mode === "planted", roundWinStatus: 0, paused: mode === "paused", totalPausedTicks: 0, pauseObserved: false, clockContinuous: true },
      players: players.map((p, i) => ({ ...frame.players[0], steamId: p.steamId, side: p.startSide, alive: i ? true : frame.players[0].alive, health: i ? 100 : frame.players[0].health, weapon: i ? frame.players[0].weapon : "c4" })),
    })),
  })) };
  const analysis = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-clock-coverage" });
  const candidate = analysis.candidate_set.candidates.find(c => c.source.kind === "DEATH")!;
  const cue = analysis.review_plan.cues.find(c => c.candidate_id === candidate.candidateId)!;
  const material = analysis.candidate_set.materials.find(m => m.candidateId === candidate.candidateId)!;
  const coaching = buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence);
  const outcome = buildOutcomePackage(cue, analysis.candidate_set);
  return { analysis, cue, material, coaching, outcome, replay };
}

it("carries a verified prior event through actual narration", async () => {
 const f = fixture();
 expect(f.material.decisionSnapshot!.sampledAtTick).toBe(1400);
 expect(f.material.decisionSnapshot!.selfBlindEvents).toEqual([{ source: "DEMO_PLAYER_BLIND", sourceRef: "cs2d-blind-1397-1", tick: 1397 }]);
 const fetcher = vi.fn(() => { throw Error("NO_NETWORK"); });
 const result = await requestNarrationBundle(buildNarratorRequestContext(f.coaching, f.outcome), { fetcher });
 expect(result.bundle.currentSituation.text).toContain(decisionSelfBlindText());
 expect(fetcher).not.toHaveBeenCalled();
});

function viewInput(f = fixture()) {
 const {analysis, cue, material} = f;
 return { narration: deterministicNarrationBundle(f.coaching, f.outcome), cue, tickRate: analysis.match_timeline.tick_rate, decisionTick: cue.decision_tick,
  semantics: {...material, ...cue}, decisionFacts: buildCoachingCueView(cue, false).decisionFacts,
  decisionState: playerStateAtOrBefore(analysis.match_timeline.player_state_tracks ?? [], self, cue.decision_tick), outcomeFacts: [] };
}
it("preserves all seven current facts, legacy narration budget, visible baseline and default Panel evidence", () => {
 const f=fixture(), input=viewInput(f), facts=f.coaching.decisionContext.facts;
 expect(facts).toHaveLength(7);
 expect(facts[2].text).toBe(decisionSelfBlindText());
 expect(input.narration.currentSituation.text).toBe(facts.map(f=>f.text).join(" "));
 expect(input.narration.currentSituation.text.length).toBeLessThanOrEqual(1600);
 expect(input.narration.currentSituation.refs).toEqual(facts.map(f=>f.id));
 expect(input.narration.currentSituation.text).toContain("约110秒");
 expect(input.narration.currentSituation.text).toContain("C4 状态：携带中");
 expect(buildThreeStageCoachingView(input).currentState.priorSelfBlind).toEqual({text:decisionSelfBlindText(),refs:f.material.decisionSnapshot!.selfBlindEvidenceRefs});
 const html=renderToStaticMarkup(createElement(TeachingDiagnosisPanel,{cue:f.cue,decisionFacts:input.decisionFacts,onSubmit:()=>{},onSkip:()=>{},onConfirm:()=>{},onDisagree:()=>{}}));
 expect(html).toContain(decisionSelfBlindText());
 const without=fixture([]);
 expect(f.analysis.candidate_set.candidates.map(c=>[c.candidateId,c.decisionTick,c.revealTick,c.deterministicScore])).toEqual(without.analysis.candidate_set.candidates.map(c=>[c.candidateId,c.decisionTick,c.revealTick,c.deterministicScore]));
 expect(f.cue.assessment?.kind).toBe(without.cue.assessment?.kind);
 expect(f.material.playerActionFacts).toEqual(without.material.playerActionFacts);
 expect(JSON.stringify(f.material.decisionSnapshot!.selfBlindEvents)).not.toMatch(/reportedDuration|flasher|steamId/);
});
it("accepts a strict prior event after the latest tick-start frame without changing that frame", () => {
 const f=fixture(), round={...f.replay.rounds[0], frames:f.replay.rounds[0].frames.filter(frame=>frame.tick!==1400)};
 const snapshot=buildDecisionSnapshot({round,selectedPlayerId:self,decisionTick:1400,tickRate:64,snapshotId:"synthetic-gap",rosterIds:f.replay.players.map(p=>p.steamId)});
 expect(snapshot.sampledAtTick).toBe(1392);expect(snapshot.selfBlindEvents?.[0].tick).toBe(1397);
});
it.each([
 ["legacy",blind(1397,{blindEvidenceVersion:undefined})], ["wrong-player",blind(1397,{steamId:"other"})], ["same-tick",blind(1400)], ["future",blind(1401)],
 ["expired",blind(700)], ["bad-duration",blind(1397,{reportedDuration:NaN})], ["zero",blind(1397,{reportedDuration:0})], ["wrong-id",blind(1397,{id:"cs2d-blind-1398-1"})],
] as const)("keeps %s unavailable without inventing a negative occurrence", (_, report) => {
 const f=fixture([report]);expect(f.material.decisionSnapshot!.selfBlindEvents).toBeUndefined();expect(buildThreeStageCoachingView(viewInput(f)).currentState.priorSelfBlind).toBeUndefined();
});
it("excludes every duplicate identity, including conflicts with other recipients, and bounds retained events", () => {
 expect(fixture([blind(),blind(1397,{steamId:"other"})]).material.decisionSnapshot!.selfBlindEvents).toBeUndefined();
 const f=fixture([1380,1385,1390,1397].map(t=>blind(t)));
 expect(f.material.decisionSnapshot!.selfBlindEvents?.map(e=>e.tick)).toEqual([1385,1390,1397]);
});
it("roundtrips current metadata and accepts actual old-shape analysis without inventing occurrences", () => {
 const f=fixture(), restored=deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(f.analysis));
 const cue=restored.review_plan.cues.find(c=>c.id===f.cue.id)!, material=restored.candidate_set.materials.find(m=>m.candidateId===cue.candidate_id)!;
 const coaching=buildCoachingPackage(cue,restored.candidate_set,restored.observation_evidence), outcome=buildOutcomePackage(cue,restored.candidate_set);
 expect(buildThreeStageCoachingView(viewInput({...f,analysis:restored,cue,material,coaching,outcome})).currentState.priorSelfBlind?.text).toBe(decisionSelfBlindText());
 expect(restored.candidate_set.materials[0].decisionSnapshot!.selfBlindEvents).toEqual(f.analysis.candidate_set.materials[0].decisionSnapshot!.selfBlindEvents);
 const generated=fixture([]).analysis; const old={...generated,metadata:{...generated.metadata,adapter_version:"cs2d-analysis-adapter/1.13.0" as const}};
 const json=serializeCs2dAnalysisBundle(old), saved=deserializeCs2dAnalysisBundle(json);
 expect(serializeCs2dAnalysisBundle(saved)).toBe(json);expect(saved.candidate_set.materials[0].decisionSnapshot!.selfBlindEvents).toBeUndefined();
});
it.each(["future", "bad-source", "raw-duration", "duplicate", "dead", "multi-ref", "missing-ref", "fact-time", "cross-round"])("rejects malformed saved blind context: %s", mode => {
 const f=fixture(), analysis=structuredClone(f.analysis), snapshot=analysis.candidate_set.materials.find(m=>m.candidateId===f.cue.candidate_id)!.decisionSnapshot!;
 if(mode==="future") Object.assign(snapshot.selfBlindEvents![0],{tick:snapshot.decisionTick,sourceRef:`cs2d-blind-${snapshot.decisionTick}-1`});
 if(mode==="bad-source") Object.assign(snapshot.selfBlindEvents![0],{source:"OTHER"});
 if(mode==="raw-duration") Object.assign(snapshot.selfBlindEvents![0],{reportedDuration:1});
 if(mode==="duplicate") snapshot.selfBlindEvents=[...snapshot.selfBlindEvents!,...snapshot.selfBlindEvents!];
 if(mode==="dead") snapshot.selectedPlayer.value!.alive=false;
 if(mode==="multi-ref") snapshot.selfBlindEvidenceRefs=[...snapshot.selfBlindEvidenceRefs!,"extra"];
 if(mode==="missing-ref") delete snapshot.selfBlindEvidenceRefs;
 if(mode==="cross-round") Object.assign(snapshot.selfBlindEvents![0],{tick:1063,sourceRef:"cs2d-blind-1063-1"});
 if(mode==="fact-time") Object.assign(analysis.candidate_set.materials.find(m=>m.candidateId===f.cue.candidate_id)!.decisionFacts.find(x=>x.id===snapshot.selfBlindEvidenceRefs![0])!,{available_at_tick:snapshot.decisionTick});
 expect(()=>deserializeCs2dAnalysisBundle(JSON.stringify(analysis))).toThrow();
});
it.each(["no-refs","old-prose","future","wrong-person","dead","stale","other-cue","fact-conflict","future-state","observer-scope"])("does not display a mismatched current occurrence: %s", mode=>{
 const input=structuredClone(viewInput()), snapshot=input.semantics.decisionSnapshot!;
 if(mode==="future-state") { snapshot.sampledAtTick=snapshot.decisionTick+8;input.decisionState!.tick=snapshot.sampledAtTick;input.decisionFacts=input.decisionFacts.map(f=>snapshot.selectedPlayer.evidenceRefs.includes(f.id)?{...f,available_at_tick:snapshot.sampledAtTick!}:f); }
 if(mode==="observer-scope") input.semantics.observableContext!.snapshotId="other-snapshot";
 if(mode==="no-refs") input.narration.currentSituation.refs=[];
 if(mode==="old-prose") input.narration.currentSituation.text=input.narration.currentSituation.text.replace(decisionSelfBlindText(),"");
 if(mode==="future") Object.assign(snapshot.selfBlindEvents![0],{tick:snapshot.decisionTick,sourceRef:`cs2d-blind-${snapshot.decisionTick}-1`});
 if(mode==="wrong-person") snapshot.selectedPlayerId="other";
 if(mode==="dead") snapshot.selectedPlayer.value!.alive=false;
 if(mode==="stale") snapshot.sampledAtTick=1000;
 if(mode==="other-cue") input.narration.cueId="other";
 if(mode==="fact-conflict") input.cue.facts=input.cue.facts.map(f=>f.id===snapshot.selfBlindEvidenceRefs![0]?{...f,observed_by_player:false}:f);
 expect(buildThreeStageCoachingView(input).currentState.priorSelfBlind).toBeUndefined();
});

it.each(["dead", "zero-health", "stale", "unknown-death-time", "death-before", "fatal-hurt"])("rejects source state/death uncertainty: %s", mode => {
 const f=fixture();let round=structuredClone(f.replay.rounds[0]);
 if(mode==="dead" || mode==="zero-health") round={...round,frames:round.frames.map(frame=>({...frame,players:frame.players.map(p=>p.steamId===self?{...p,alive:mode==="dead"?false:p.alive,health:0}:p)}))};
 if(mode==="stale") round={...round,frames:round.frames.filter(frame=>frame.tick<1300)};
 if(mode==="unknown-death-time" || mode==="death-before") round={...round,events:round.events.map(event=>event.type==="kill"?{...event,tick:mode==="unknown-death-time"?NaN:1399}:event)};
 if(mode==="fatal-hurt") round={...round,hurtEvents:[{id:"fatal",victimSteamId:self,tick:1399,reportedHealthAfter:0}]};
 const snapshot=buildDecisionSnapshot({round,selectedPlayerId:self,decisionTick:1400,tickRate:64,snapshotId:"synthetic-source",rosterIds:f.replay.players.map(p=>p.steamId)});
 expect(snapshot.selfBlindEvents).toBeUndefined();
});

function questionFixture() {
  const f = fixture(), plan = f.analysis.review_plan;
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  session = reduceCoachingSession(plan, session, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: f.cue.id, visitId: "seven-facts" });
  session = reduceCoachingSession(plan, session, { type: "TICK", tick: f.cue.outcome_end_tick });
  const input: CurrentCueQuestionInput = { plan, session, generation: 1, diagnosticsEnabled: false,
    presentableNarration: deterministicNarrationBundle(f.coaching, f.outcome), busy: false, takenOver: true };
  return { ...f, input };
}

it("answers all seven actually narrated facts, including C4, through the existing question action and Panel", () => {
  const f = questionFixture(), before = structuredClone(f.input), facts = f.coaching.decisionContext.facts;
  expect(facts).toHaveLength(7);
  expect(facts[6].text).toContain("C4 状态：携带中");
  expect(f.input.presentableNarration!.currentSituation.text).toContain(facts[6].text);
  const context = buildCurrentCueQuestionContext(f.input)!;
  const state = updateCurrentCueQuestions(undefined, context.key, context, { type: "ASK", question: "当时有哪些已知事实？" })!;
  expect(state.turns[0].answer.items).toEqual(facts.map(fact => ({ text: fact.text, refs: [fact.id] })));
  const html = renderToStaticMarkup(createElement(CurrentCueQuestionsPanel, { state, onDraft() {}, onAsk() {} }));
  for (const fact of facts) expect(html).toContain(fact.text);
  expect(f.input).toEqual(before);
});

it("does not expand old three-fact prose merely because its saved references include all seven", () => {
  const f = questionFixture(), facts = f.coaching.decisionContext.facts;
  f.input.presentableNarration!.currentSituation.text = facts.slice(0, 3).map(f => f.text).join(" ");
  expect(buildCurrentCueQuestionContext(f.input)!.facts).toEqual(facts.slice(0, 3).map(f => ({ text: f.text, refs: [f.id] })));
});

it("keeps complete diagnosis questions on its three displayed facts even with seven-fact baseline narration", () => {
  const f = questionFixture();
  const output = diagnoseTeachingCue({ cueId: f.cue.id, candidateId: f.cue.candidate_id,
    reflection: { cueId: f.cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] },
    decisionFacts: f.coaching.decisionContext.facts, playerActionFacts: [], outcomeFacts: [] });
  f.input.diagnosticsEnabled = true;
  f.input.cueCase = output.cueCase;
  expect(buildCurrentCueQuestionContext(f.input)!.facts).toEqual(f.coaching.decisionContext.facts.slice(0, 3).map(f => ({ text: f.text, refs: [f.id] })));
});

it.each(["missing-ref", "partial-prose", "future", "duplicate-id", "long-fact"])("keeps the seventh fact unavailable for %s", mode => {
  const f = questionFixture(), last = f.cue.facts.find(fact => fact.text.includes("C4 状态：携带中"))!;
  const situation = f.input.presentableNarration!.currentSituation;
  if (mode === "missing-ref") situation.refs = situation.refs.filter(ref => ref !== last.id);
  if (mode === "partial-prose") situation.text = situation.text.replace(last.text, last.text.slice(0, -1));
  if (mode === "future") last.available_at_tick = f.cue.decision_tick + 1;
  if (mode === "duplicate-id") f.cue.facts.push({ ...last });
  if (mode === "long-fact") { last.text = "有界文本".repeat(101); situation.text += last.text; }
  expect(buildCurrentCueQuestionContext(f.input)!.facts.flatMap(f => f.refs)).not.toContain(last.id);
});

it("invalidates the old question source when the displayed seventh fact disappears", () => {
  const f = questionFixture(), old = buildCurrentCueQuestionContext(f.input)!;
  const state = updateCurrentCueQuestions(undefined, old.key, old, { type: "ASK", question: "当时有哪些已知事实？" })!;
  const last = f.coaching.decisionContext.facts[6];
  f.input.presentableNarration!.currentSituation.text = f.input.presentableNarration!.currentSituation.text.replace(last.text, "");
  const next = buildCurrentCueQuestionContext(f.input)!;
  expect(next.key).not.toBe(old.key);
  expect(updateCurrentCueQuestions(state, old.key, next, { type: "ASK", question: "当时有哪些已知事实？" })).toBe(state);
  expect(updateCurrentCueQuestions(state, next.key, next, { type: "ASK", question: "当时有哪些已知事实？" })!.turns[0].answer.items.flatMap(f => f.refs)).not.toContain(last.id);
});

it.each([null, undefined, 40, 0])("preserves unknown hurt health separately from an explicit fatal zero: %s", reportedHealthAfter => {
  const f = fixture();
  const round = { ...f.replay.rounds[0], hurtEvents: [{ id: "synthetic-reported-health", tick: 1390, victimSteamId: self, reportedHealthAfter }] };
  const snapshot = buildDecisionSnapshot({ round, selectedPlayerId: self, decisionTick: 1400, tickRate: 64,
    snapshotId: "synthetic-payload-consumer", rosterIds: f.replay.players.map(p => p.steamId) });
  expect(snapshot.selfHurtEvents).toHaveLength(reportedHealthAfter === 0 ? 0 : 1);
  expect(snapshot.selfBlindEvents ?? []).toHaveLength(reportedHealthAfter === 0 ? 0 : 1);
  expect(snapshot.selectedPlayer.value?.health).toBe(f.material.decisionSnapshot!.selectedPlayer.value?.health);
  expect(JSON.stringify({ hurt: snapshot.selfHurtEvents, blind: snapshot.selfBlindEvents })).not.toContain("reportedHealthAfter");
});
