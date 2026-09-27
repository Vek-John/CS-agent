import { afterEach, expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "./cs2d-coaching-view";
import { CurrentCueResourceCache } from "./current-cue-resource-source";
import { answerGroundedCueQuestion, buildCurrentCueQuestionContext, availableCurrentCueResourceQuestions, updateCurrentCueQuestions } from "./current-cue-questions";
import { buildTeachingDiagnosisInput } from "./teaching-diagnosis-host";

const question = "当时有多少护甲？";
afterEach(() => vi.unstubAllGlobals());
function fixture(armor = 100, helmet: boolean | undefined = true, missingHelmet = false) {
  // Synthetic events and samples, not measured Demo ticks.
  const analysis = buildCs2dAnalysisBundle({ replay: { ...fireReplay("DEATH"), rounds: fireReplay("DEATH").rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({...frame,players:frame.players.map(player=>({...player,armor,helmet:missingHelmet?undefined:helmet}))})) })) }, selectedSteamId: self, demoId: "synthetic-baseline-armor" });
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
    displayedArmorText: view.currentState.chips.find(chip => chip.kind === "armor")?.text, resourceSource: cache.read(origin) };
  return { analysis, origin, cache, input, state, viewInput };
}
it("answers the actual baseline armor chip after the real Session result gate", () => {
 const fetch=vi.fn(()=>{throw Error("NO_NETWORK");});vi.stubGlobal("fetch",fetch);
 const f=fixture(), before=JSON.stringify(f.analysis), context=buildCurrentCueQuestionContext(f.input)!;
 expect(f.input.displayedArmorText).toBe("100 头甲");
 const answer=answerGroundedCueQuestion(context,question);
 expect(answer.items).toEqual([{text:"100 甲",refs:f.origin.material.decisionSnapshot!.selectedPlayer.evidenceRefs}]);
 expect(answer.source).toContain("当前状态");expect(answer.source).not.toContain("诊断");
 expect(availableCurrentCueResourceQuestions(context)).toContain(question);
 expect(JSON.stringify(f.analysis)).toBe(before);expect(fetch).not.toHaveBeenCalled();
});

it.each([
 [0,false,"没甲"], [0,true,"0 甲 · 有头盔"], [45,false,"45 甲"], [45,true,"45 头甲"],
 [45,undefined,"45 甲 · 头盔未知"],
] as const)("keeps armor %s separate from helmet %s while matching the real chip",(armor,helmet,text)=>{
 const f=fixture(armor,helmet,helmet===undefined), context=buildCurrentCueQuestionContext(f.input)!;
 expect(f.input.displayedArmorText).toBe(text);
 const answer=answerGroundedCueQuestion(context,question);
 expect(answer.items[0].text).toBe(`${armor} 甲`);
 expect(answer.items[0].text).not.toMatch(/头盔|头甲/);
});

it("does not turn unknown armor into zero or let a known helmet supply it",()=>{
 const f=fixture(NaN,true), context=buildCurrentCueQuestionContext(f.input)!;
 expect(f.input.displayedArmorText).toBeUndefined();
 expect(answerGroundedCueQuestion(context,question).items).toEqual([]);
 expect(availableCurrentCueResourceQuestions(context)).not.toContain(question);
});

it("invalidates the answer when any part of the actual chip changes or its source expires",()=>{
 const f=fixture(), context=buildCurrentCueQuestionContext(f.input)!;
 const state=updateCurrentCueQuestions(undefined,context.key,context,{type:"ASK",question});
 for(const displayedArmorText of [undefined,"100 甲","100 甲 · 头盔未知","99 头甲"]){
  const changed=buildCurrentCueQuestionContext({...f.input,displayedArmorText})!;
  expect(changed.key).not.toBe(context.key);
  expect(answerGroundedCueQuestion(changed,question).items).toEqual([]);
  expect(updateCurrentCueQuestions(state,context.key,changed,{type:"ASK",question})).toBe(state);
 }
 const old=f.input.resourceSource;
 f.cache.read({...f.origin,timeline:{...f.origin.timeline}});
 expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({...f.input,resourceSource:old})!,question).items).toEqual([]);
 expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({...f.input,resourceSource:{revision:1}})!,question).items).toEqual([]);
});

it.each(["value-conflict","unknown-snapshot","future","ref-conflict"])("requires the same verified armor provenance: %s",mode=>{
 const f=fixture(), snapshot=structuredClone(f.origin.material.decisionSnapshot!);
 if(mode==="value-conflict") snapshot.selectedPlayer.value!.armor=99;
 if(mode==="unknown-snapshot") snapshot.selectedPlayer.value!.armor=null;
 if(mode==="future") snapshot.sampledAtTick=f.origin.cue.decision_tick+1;
 if(mode==="ref-conflict") snapshot.selectedPlayer.evidenceRefs=f.state.fact_refs;
 const material={...f.origin.material,decisionSnapshot:snapshot};
 const input={...f.input,resourceSource:f.cache.read({...f.origin,material})};
 expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(input)!,question).items).toEqual([]);
});

it("uses baseline fallback armor but keeps a completed diagnosis behind its own measurement gate",()=>{
 const f=fixture();
 const skipped=diagnoseTeachingCue(buildTeachingDiagnosisInput(f.origin,{cueId:f.origin.cue.id,response:"SKIPPED",source:"USER",limitations:[]}));
 expect(skipped.cueCase.status).toBe("FALLBACK");
 const fallback=buildCurrentCueQuestionContext({...f.input,diagnosticsEnabled:true,cueCase:skipped.cueCase})!;
 expect(answerGroundedCueQuestion(fallback,question).items[0].text).toBe("100 甲");
 const diagnosed=diagnoseTeachingCue(buildTeachingDiagnosisInput(f.origin,{cueId:f.origin.cue.id,selectedGoal:"DELAY",response:"ANSWERED",source:"USER",limitations:[]}));
 const cueCase=structuredClone(diagnosed.cueCase);
 cueCase.diagnosticResult!.measurements=cueCase.diagnosticResult!.measurements.filter(m=>m.id!==`measurement-${f.origin.cue.id}-armor`);
 const diagnostic=buildCurrentCueQuestionContext({...f.input,diagnosticsEnabled:true,cueCase})!;
 expect(diagnostic).toBeDefined();expect(answerGroundedCueQuestion(diagnostic,question).items).toEqual([]);
});

it("keeps completion and current-owner gates, and does not route hypothetical armor advice",()=>{
 const f=fixture();
 const session=reduceCoachingSession(f.input.plan,f.input.session,{type:"REPLAY_OUTCOME"});
 expect(buildCurrentCueQuestionContext({...f.input,session})).toBeUndefined();
 expect(buildCurrentCueQuestionContext({...f.input,busy:true})).toBeUndefined();
 expect(buildCurrentCueQuestionContext({...f.input,takenOver:true})).toBeUndefined();
 expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!,"如果当时100甲应该怎么打？").items).toEqual([]);
});

it("does not answer fractional armor just because its unknown chip matches",()=>{
 const f=fixture(1.5,true),context=buildCurrentCueQuestionContext(f.input)!;
 expect(f.input.displayedArmorText).toBe("护甲未知 · 有头盔");
 expect(answerGroundedCueQuestion(context,question).items).toEqual([]);
});
it("respects the actually displayed cue snapshot missing armor even when material armor is known",()=>{
 const f=fixture(), snapshot=structuredClone(f.origin.material.decisionSnapshot!);
 snapshot.missingFields=[...snapshot.missingFields,"armor"];
 const cue={...f.origin.cue,decisionSnapshot:snapshot}, plan={...f.origin.plan,cues:f.origin.plan.cues.map(c=>c.id===cue.id?cue:c)};
 const view=buildThreeStageCoachingView({...f.viewInput,semantics:{...f.origin.material,...cue}});
 const displayedArmorText=view.currentState.chips.find(chip=>chip.kind==="armor")!.text;
 expect(displayedArmorText).toBe("护甲未知 · 有头盔");
 const context=buildCurrentCueQuestionContext({...f.input,plan,displayedArmorText,resourceSource:f.cache.read({...f.origin,plan,cue})})!;
 expect(context).toBeDefined();expect(answerGroundedCueQuestion(context,question).items).toEqual([]);
});
