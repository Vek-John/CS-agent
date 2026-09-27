import { afterEach, expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { fireReplay, self, shot } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "./cs2d-coaching-view";
import { CurrentCueResourceCache, getBaselineCueAmmo } from "./current-cue-resource-source";
import { answerGroundedCueQuestion, buildCurrentCueQuestionContext, availableCurrentCueResourceQuestions, updateCurrentCueQuestions } from "./current-cue-questions";
import { buildTeachingDiagnosisInput } from "./teaching-diagnosis-host";

const question = "当时弹匣还有几发？";
afterEach(() => vi.unstubAllGlobals());
function fixture(clip = 7, mode: "normal" | "same-tick-shot" | "latest-missing" | "handle-mismatch" = "normal") {
  // Synthetic events and samples, not measured Demo ticks.
  const raw=fireReplay("DEATH",mode==="same-tick-shot"?[shot(1400),shot(1404)]:[shot(1404)]);
  const replay={...raw,rounds:raw.rounds.map(round=>({...round,frames:round.frames.map(frame=>({...frame,players:frame.players.map(player=>({...player,weapon:"AK-47",activeWeaponHandle:mode==="handle-mismatch"&&frame.tick===1400?114698:114697,ammoSamplingVersion:2 as const,weaponAmmo:mode==="latest-missing"&&frame.tick===1400?undefined:{source:"SOURCE2_ACTIVE_WEAPON" as const,phase:"TICK_END" as const,version:2 as const,sampledAtTick:frame.tick-1,weapon:"AK-47",weaponHandle:114697,clip}}))}))}))};
  const analysis=buildCs2dAnalysisBundle({replay,selectedSteamId:self,demoId:"synthetic-baseline-ammo"});
  const plan = analysis.review_plan, cue = plan.cues[0];
  const material = analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const coaching = buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence);
  const narration = deterministicNarrationBundle(coaching, buildOutcomePackage(cue, analysis.candidate_set));
  const state = playerStateAtOrBefore(analysis.match_timeline.player_state_tracks ?? [], self, cue.decision_tick)!;
  const cache = new CurrentCueResourceCache(), origin = { plan, cue, material, timeline: analysis.match_timeline, selectedPlayerId: self };
  const resourceSource=cache.read(origin), baselineAmmo=getBaselineCueAmmo(resourceSource,plan,cue);
  const viewInput = { narration, cue, baselineAmmo, decisionState: state, semantics: { ...material, ...cue }, decisionTick: cue.decision_tick,
    decisionFacts: buildCoachingCueView(cue, false).decisionFacts, outcomeFacts: [] };
  const view = buildThreeStageCoachingView(viewInput);
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  for (let i = 0; i < 30 && session.phase !== "PAUSED_FOR_COACHING"; i++) {
    const active = getCurrentCue(plan, session);
    session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" }
      : active ? { type: "TICK", tick: active.outcome_end_tick } : { type: "ADVANCE_SEGMENT" });
  }
  expect(session.current_cue_id).toBe(cue.id); expect(session.outcome_completion?.status).toBe("COMPLETE");
  const input = { plan, session, generation: 1, diagnosticsEnabled: false, presentableNarration: narration, busy: false, takenOver: false,
    displayedAmmoText: view.currentState.priorWeaponAmmo?.text, resourceSource };
  return { analysis, origin, cache, input, state, viewInput, view };
}
it.each([7,0])("shows and answers the actual strict-prior clip %s after Session completion",clip=>{
 const f=fixture(clip), context=buildCurrentCueQuestionContext(f.input)!;
 expect(f.input.displayedAmmoText).toContain(`AK-47 · ${clip} 发`);
 const answer=answerGroundedCueQuestion(context,question);
 expect(answer.items).toHaveLength(1);
 expect(answer.items[0].text).toBe(f.input.displayedAmmoText);
 expect(answer.source).toContain("当前状态");expect(answer.source).not.toContain("诊断");
 expect(answer.items[0].refs).toEqual(["state-1-1400-weapon-ammo-end-at-1399"]);
 expect(answer.items[0].refs).not.toEqual(f.origin.material.decisionSnapshot!.selectedPlayer.evidenceRefs);
 expect(availableCurrentCueResourceQuestions(context)).toContain("弹匣当时还有几发？");
});

it.each(["same-tick-shot","latest-missing","handle-mismatch"] as const)("keeps %s unknown instead of falling back or rendering a quantity",mode=>{
 const f=fixture(7,mode),context=buildCurrentCueQuestionContext(f.input)!;
 expect(f.view.currentState.priorWeaponAmmo).toBeUndefined();
 expect(getBaselineCueAmmo(f.input.resourceSource,f.origin.plan,f.origin.cue)).toBeUndefined();
 expect(answerGroundedCueQuestion(context,question).items).toEqual([]);
 expect(availableCurrentCueResourceQuestions(context)).not.toContain("弹匣当时还有几发？");
});

it("binds complete displayed text and invalidates previous answers without parsing a supplied number",()=>{
 const f=fixture(),context=buildCurrentCueQuestionContext(f.input)!;
 const previous=updateCurrentCueQuestions(undefined,context.key,context,{type:"ASK",question});
 for(const displayedAmmoText of [undefined,"AK-47 · 7 发",f.input.displayedAmmoText!.replace("7 发","8 发")]){
  const changed=buildCurrentCueQuestionContext({...f.input,displayedAmmoText})!;
  expect(changed.key).not.toBe(context.key);
  expect(answerGroundedCueQuestion(changed,question).items).toEqual([]);
  expect(updateCurrentCueQuestions(previous,context.key,changed,{type:"ASK",question})).toBe(previous);
 }
});

it("does not reuse an old cue projection or a saved label without the live opaque source",()=>{
 const f=fixture(),projection=getBaselineCueAmmo(f.input.resourceSource,f.origin.plan,f.origin.cue)!;
 const otherCue={...f.origin.cue,id:"other-cue"};
 expect(getBaselineCueAmmo(f.input.resourceSource,f.origin.plan,otherCue)).toBeUndefined();
 expect(getBaselineCueAmmo(f.input.resourceSource,{...f.origin.plan},f.origin.cue)).toBeUndefined();
 expect(buildThreeStageCoachingView({...f.viewInput,cue:otherCue,narration:{...f.viewInput.narration,cueId:otherCue.id},baselineAmmo:projection}).currentState.priorWeaponAmmo).toBeUndefined();
 expect(getBaselineCueAmmo({revision:f.input.resourceSource!.revision},f.origin.plan,f.origin.cue)).toBeUndefined();
 expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({...f.input,resourceSource:undefined})!,question).items).toEqual([]);
 const old=f.input.resourceSource;f.cache.read({...f.origin,timeline:{...f.origin.timeline}});
 expect(getBaselineCueAmmo(old,f.origin.plan,f.origin.cue)).toBeUndefined();
});

it.each(["weapon-conflict","missing-ammo","unobserved-state"])("aligns with the actual View snapshot and canonical state binding: %s",mode=>{
 const f=fixture(), snapshot=structuredClone(f.origin.material.decisionSnapshot!);
 if(mode==="weapon-conflict") snapshot.selectedPlayer.value!.weapon="M4A4";
 if(mode==="missing-ammo") snapshot.missingFields=[...snapshot.missingFields,"active_item.ammo_clip"];
 const cue={...f.origin.cue,decisionSnapshot:snapshot,facts:f.origin.cue.facts.map(fact=>mode==="unobserved-state"&&snapshot.selectedPlayer.evidenceRefs.includes(fact.id)?{...fact,observed_by_player:false}:fact)};
 const plan={...f.origin.plan,cues:f.origin.plan.cues.map(c=>c.id===cue.id?cue:c)};
 const source=f.cache.read({...f.origin,plan,cue});
 expect(getBaselineCueAmmo(source,plan,cue)).toBeUndefined();
 expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({...f.input,plan,resourceSource:source})!,question).items).toEqual([]);
});

it("keeps diagnostic measurements separate while letting actual FALLBACK use the shown baseline",()=>{
 const f=fixture();
 const skipped=diagnoseTeachingCue(buildTeachingDiagnosisInput(f.origin,{cueId:f.origin.cue.id,response:"SKIPPED",source:"USER",limitations:[]}));
 expect(skipped.cueCase.status).toBe("FALLBACK");
 expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({...f.input,diagnosticsEnabled:true,cueCase:skipped.cueCase})!,question).items).toHaveLength(1);
 const diagnosis=diagnoseTeachingCue(buildTeachingDiagnosisInput(f.origin,{cueId:f.origin.cue.id,selectedGoal:"OTHER",response:"ANSWERED",source:"USER",limitations:[]}));
 const caseWithoutMeasurement=structuredClone(diagnosis.cueCase);
 caseWithoutMeasurement.diagnosticResult!.measurements=caseWithoutMeasurement.diagnosticResult!.measurements.filter(m=>!m.id.endsWith("weapon-clip"));
 expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext({...f.input,diagnosticsEnabled:true,cueCase:caseWithoutMeasurement})!,question).items).toEqual([]);
});

it("reuses the immutable source without a fresh timeline scan on reads and keeps the outcome gate",()=>{
 const f=fixture(),cache=new CurrentCueResourceCache(),rows=f.origin.timeline.player_state_tracks;
 let reads=0;const timeline={...f.origin.timeline,get player_state_tracks(){reads++;return rows;}};
 const origin={...f.origin,timeline},source=cache.read(origin);const initialReads=reads;
 expect(initialReads).toBeGreaterThan(0);
 for(let i=0;i<3;i++){expect(cache.read(origin)).toBe(source);expect(getBaselineCueAmmo(source,origin.plan,origin.cue)?.clip).toBe(7);}
 expect(reads).toBe(initialReads);
 const replaying=reduceCoachingSession(f.input.plan,f.input.session,{type:"REPLAY_OUTCOME"});
 expect(buildCurrentCueQuestionContext({...f.input,session:replaying})).toBeUndefined();
 expect(answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!,"我应该提前换弹吗？").items).toEqual([]);
});

it("keeps all raw source timing and handles in the source owner, with no model or history writes",()=>{
 const fetch=vi.fn(()=>{throw Error("NO_NETWORK");});vi.stubGlobal("fetch",fetch);
 const f=fixture(),before=JSON.stringify(f.analysis),projection=getBaselineCueAmmo(f.input.resourceSource,f.origin.plan,f.origin.cue)!;
 expect(projection.text).toContain("备弹未知");expect(projection.text).toContain("不代表决策瞬间");
 expect(Object.keys(projection).sort()).toEqual(["candidateId","clip","cueId","decisionTick","refs","text","weapon"]);
 expect(projection.refs).not.toEqual(f.origin.material.decisionSnapshot!.selectedPlayer.evidenceRefs);
 answerGroundedCueQuestion(buildCurrentCueQuestionContext(f.input)!,question);
 expect(JSON.stringify(f.analysis)).toBe(before);expect(fetch).not.toHaveBeenCalled();
});
