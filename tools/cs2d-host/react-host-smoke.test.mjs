import { expect, it, vi } from 'vitest';
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle } from '../../libs/cs2d-analysis-adapter/src/index.ts';
import { deterministicDirectorFallback } from '../../libs/review-planner/src/index.ts';
import { createCs2dReviewPreparationDependencies, createReviewPreparationOrchestrator } from '../../apps/web/lib/coaching/cs2d-route-integration.ts';
import { requestNarrationBundle } from '../../apps/web/lib/coaching/narrator-contract.ts';
import { createCoachingSession, reduceCoachingSession, getCurrentCue } from '../../libs/session/src/index.ts';
import { CoachAgentStage3HostAdapter } from '../../apps/web/lib/coaching/coach-agent-stage3-host-adapter.ts';
import { createRemoteCoachAgentDispatchEnvelope } from '../../libs/coach-agent/src/remote-dispatch-client.ts';
import { twoCueViewerReplay, twoCueViewerPlayer } from './viewer-two-cue-fixture.ts';

async function prepareSmoke(){
  const bundle=deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(buildCs2dAnalysisBundle({replay:twoCueViewerReplay(),selectedSteamId:twoCueViewerPlayer,demoId:'synthetic-react-host',demoContentHash:'a'.repeat(64)})));
  const fetcher=vi.fn(()=>{throw Error('PROVIDER_NOT_EXPECTED')});
  const dependencies=createCs2dReviewPreparationDependencies({candidateSet:bundle.candidate_set,observationEvidence:bundle.observation_evidence,matchTimeline:bundle.match_timeline,winProbabilityTimeline:bundle.win_probability_timeline,selectedPlayerId:bundle.selected_steam_id},{
   assessDecisions:async candidateSet=>({candidateSet,run:{version:'decision-assessment-run.v1',mode:'RULE_BASELINE',calls:0,accepted:0,records:[]}}),
   director:async set=>deterministicDirectorFallback(set), narrator:(context,options)=>requestNarrationBundle(context,{...options,fetcher})});
  const prep=createReviewPreparationOrchestrator('smoke',bundle.review_plan,{},dependencies);let ready;const narrations={},preparationCounts={route:0,narration:0};
  await prep.run(event=>{if(event.type==='ROUTE_FROZEN')preparationCounts.route++;if(event.type==='NARRATION_UPDATE'){preparationCounts.narration++;narrations[event.cueId]=event.result.narration;}if(event.type==='READY_TO_START')ready=event});
  expect(ready.routeState.startable).toBe(true);expect(ready.plan.cues).toHaveLength(2);expect(Object.keys(narrations)).toHaveLength(2);expect(fetcher).not.toHaveBeenCalled();
  return {bundle,ready,narrations,preparationCounts};
}

it('prepares the actual synthetic bundle and dispatches valid observed segments and first cue through the smoke memory Runtime', async () => {
 const previousFetch=globalThis.fetch;
 try {
  const {dispatch,metrics}=await import('./react-host-smoke-runtime.ts');
  const blockedFetch=vi.fn(async()=>{throw Error('EXTERNAL_FETCH_FORBIDDEN')});globalThis.fetch=blockedFetch;
  await expect(dispatch({success:true})).rejects.toThrow();expect(metrics.dispatches).toBe(0);
  const {bundle,ready,narrations}=await prepareSmoke();
  const plan=ready.plan,routeState=ready.routeState,adapter=new CoachAgentStage3HostAdapter();
  const identity={plan,routeState,analysis:bundle,demoContentHash:'a'.repeat(64),selectedPlayerId:twoCueViewerPlayer,sessionId:'react-host-smoke-test',runId:'react-host-smoke-test'};
  let session=reduceCoachingSession(plan,createCoachingSession(plan,identity.sessionId,routeState),{type:'START'});
  for(let i=0;i<plan.segments.length*3&&session.phase!=='PAUSED_FOR_COACHING';i++){
   const segment=plan.segments[session.current_segment_index];
   session=reduceCoachingSession(plan,session,session.phase==='SKIPPING'?{type:'SKIP_SEGMENT'}:{type:'TICK',tick:segment.end_tick});
  }
  // The real controller synchronizes every preceding segment, including START's automatically skipped freeze.
  for(const [index,segment] of plan.segments.slice(0,session.current_segment_index).entries()){const mode=segment.mode==='SKIP'?(segment.reason_code==='FREEZE_TIME'?'FREEZE':'SKIP'):segment.mode;await dispatch(createRemoteCoachAgentDispatchEnvelope(adapter.createObserveSegmentEvent(identity,segment.id,index,mode,'PLAYING',`observe-${index}`)));}
  const cue=getCurrentCue(plan,session);expect(session.outcome_completion.status).toBe('COMPLETE');
  const start=adapter.prepareStart({...identity,cue,narration:narrations[cue.id],generation:1,tickRate:64,currentSessionPhase:session.phase,outcomeGate:session.outcome_completion,evidence:{candidate:bundle.candidate_set.candidates.find(c=>c.candidateId===cue.candidate_id),material:bundle.candidate_set.materials.find(m=>m.candidateId===cue.candidate_id),winProbabilityTimeline:bundle.win_probability_timeline}});
  const result=await dispatch(createRemoteCoachAgentDispatchEnvelope(start.event));
  expect(result.checkpoint.backend).toBe('MEMORY');expect(result.state.runStatus).toBe('WAITING_TOOL');expect(result.state.activeCueId).toBe(cue.id);expect(metrics.externalFetches).toBe(0);expect(blockedFetch).not.toHaveBeenCalled();expect(metrics.events.START_CUE).toBe(1);
 } finally {globalThis.fetch=previousFetch;}
});

it('uses the explicit synthetic selection seam once, producing a validated real bundle only after loading', async()=>{
 const {createSyntheticHostSelection}=await import('./react-host-smoke-selection.ts');
 let loaded=false;const events=[];const choose=createSyntheticHostSelection(twoCueViewerReplay(),()=>loaded,event=>events.push(event));
 expect(choose(twoCueViewerPlayer)).toBe(false);expect(events).toHaveLength(0);
 loaded=true;expect(choose('other')).toBe(false);expect(choose(twoCueViewerPlayer)).toBe(true);
 expect(events.map(event=>event.type)).toEqual(['PLAYER_SELECTED','ANALYSIS_READY']);
 const analysis=deserializeCs2dAnalysisBundle(events[1].bundleJson);
 expect(analysis.selected_steam_id).toBe(twoCueViewerPlayer);expect(analysis.metadata.demo_content_hash).toBe('a'.repeat(64));expect(analysis.review_plan.cues).toHaveLength(2);
 expect(choose(twoCueViewerPlayer)).toBe(false);expect(events).toHaveLength(2);
});

it.each(['ANSWERED','SKIPPED'])('uses the actual Host diagnosis synchronization and Graph submission for %s without a visual tool or external provider',async response=>{
 const previousFetch=globalThis.fetch;let controller;
 try {
  const {dispatch,metrics}=await import('./react-host-smoke-runtime.ts');
  const blockedFetch=vi.fn(async()=>{throw Error('EXTERNAL_FETCH_FORBIDDEN')});globalThis.fetch=blockedFetch;
  const {CoachAgentStage3Controller}=await import('../../apps/web/lib/coaching/coach-agent-stage3-controller.ts');
  const {buildTeachingDiagnosisSubmissionEvent,reflectionForGoal,reflectionForSkip}=await import('../../apps/web/lib/coaching/teaching-diagnosis-host.ts');
  const {bundle,ready,narrations}=await prepareSmoke(),plan=ready.plan,routeState=ready.routeState;
  const identity={plan,routeState,analysis:bundle,demoContentHash:'a'.repeat(64),selectedPlayerId:twoCueViewerPlayer,sessionId:`react-host-${response}`,runId:`react-host-${response}`};
  let session=reduceCoachingSession(plan,createCoachingSession(plan,identity.sessionId,routeState),{type:'START'});
  for(let i=0;i<plan.segments.length*3&&session.phase!=='PAUSED_FOR_COACHING';i++){
   const segment=plan.segments[session.current_segment_index];session=reduceCoachingSession(plan,session,session.phase==='SKIPPING'?{type:'SKIP_SEGMENT'}:{type:'TICK',tick:segment.end_tick});
  }
  const cue=getCurrentCue(plan,session),material=bundle.candidate_set.materials.find(m=>m.candidateId===cue.candidate_id);
  const context={plan,cue,material,timeline:bundle.match_timeline,selectedPlayerId:twoCueViewerPlayer,learningThreads:[]};
  const input={...identity,cue,narration:narrations[cue.id],generation:1,tickRate:64,currentSessionPhase:session.phase,outcomeGate:session.outcome_completion,evidence:{candidate:bundle.candidate_set.candidates.find(c=>c.candidateId===cue.candidate_id),material}};
  const post=vi.fn(()=>{throw Error('VISUAL_TOOL_NOT_EXPECTED')});
  controller=new CoachAgentStage3Controller({adapter:new CoachAgentStage3HostAdapter(),dispatch:event=>dispatch(createRemoteCoachAgentDispatchEnvelope(event)),post,bridgeAvailable:()=>true,isLive:input=>session.current_cue_id===input.cue.id&&session.phase==='PAUSED_FOR_COACHING'});
  const synced=await controller.synchronizeDiagnosis(input);expect(synced.state.activeCueId).toBe(cue.id);expect(synced.state.pendingToolCall).toBeNull();
  const reflection=response==='SKIPPED'?reflectionForSkip(cue.id):reflectionForGoal(cue.id,'GET_INFO');
  const event=buildTeachingDiagnosisSubmissionEvent(context,reflection,{eventType:'SUBMIT_REFLECTION',eventId:`reflection-${response}`,identity:{runId:identity.runId,sessionId:identity.sessionId,demoId:bundle.demo_id,demoContentHash:identity.demoContentHash,selectedPlayerId:identity.selectedPlayerId,routeId:plan.id,routeHash:routeState.routeFingerprint}});
  const result=await dispatch(createRemoteCoachAgentDispatchEnvelope(event)),cueCase=result.state.cueCases[cue.id];
  expect(cueCase.reflection.response).toBe(response);expect(cueCase.attemptBudget.reflection).toBe(1);expect(result.state.pendingToolCall).toBeNull();expect(post).not.toHaveBeenCalled();expect(metrics.externalFetches).toBe(0);expect(blockedFetch).not.toHaveBeenCalled();
  if(response==='SKIPPED'){expect(cueCase.status).toBe('FALLBACK');expect(cueCase.diagnosticResult).toBeUndefined();expect(result.state.learningThreads).toHaveLength(0);}
  else {expect(cueCase.status).toBe('AWAITING_CONFIRMATION');expect(cueCase.diagnosticResult.status).toBe('UNVERIFIABLE');expect(cueCase.verdict.type).toBe('INCONCLUSIVE');expect(result.state.learningThreads).toHaveLength(1);}
  const repeated=await dispatch(createRemoteCoachAgentDispatchEnvelope(event));expect(repeated.state.cueCases[cue.id]).toEqual(cueCase);expect(repeated.state.learningThreads).toEqual(result.state.learningThreads);
  const metric=metrics.reflections.at(-1);expect(metric.response).toBe(response);expect(metric.caseStatus).toBe(cueCase.status);expect(Object.keys(metric).sort()).toEqual(['caseStatus','diagnostic','evidenceRefCount','learningThreadCount','response','verdict']);
 }finally{controller?.dispose();globalThis.fetch=previousFetch;}
});

it('rejects one validated reflection before Runtime, retains the local diagnosis, and advances to a successful second Graph diagnosis without preparation again',async()=>{
 const previousFetch=globalThis.fetch;let controller;
 try {
  const {createSmokeTransport,metrics}=await import('./react-host-smoke-runtime.ts');
  const blockedFetch=vi.fn(async()=>{throw Error('EXTERNAL_FETCH_FORBIDDEN')});globalThis.fetch=blockedFetch;
  const transport=createSmokeTransport({failFirstReflection:true}),before={...metrics};
  await expect(transport({event:{type:'SUBMIT_REFLECTION'}})).rejects.toThrow();expect(metrics.injectedFailures).toBe(before.injectedFailures);
  const {dispatchCoachAgentEvent}=await import('../../apps/web/lib/coaching/coach-agent-host-adapter.ts');
  const {CoachAgentStage3Controller}=await import('../../apps/web/lib/coaching/coach-agent-stage3-controller.ts');
  const {buildTeachingDiagnosisSubmissionEvent,reflectionForGoal,runTeachingDiagnosis}=await import('../../apps/web/lib/coaching/teaching-diagnosis-host.ts');
  const {bundle,ready,narrations,preparationCounts}=await prepareSmoke(),plan=ready.plan,routeState=ready.routeState;
  const identity={plan,routeState,analysis:bundle,demoContentHash:'a'.repeat(64),selectedPlayerId:twoCueViewerPlayer,sessionId:'react-host-fault',runId:'react-host-fault'};
  const fetcher=async(url,init)=>{expect(url).toBe('/api/coaching/agent');const reply=await transport(JSON.parse(init.body));return new Response(JSON.stringify(reply.payload),{status:reply.status,headers:{'content-type':'application/json'}})};
  const dispatch=event=>dispatchCoachAgentEvent(event,fetcher);
  let session=reduceCoachingSession(plan,createCoachingSession(plan,identity.sessionId,routeState),{type:'START'});
  const post=vi.fn(()=>{throw Error('VISUAL_TOOL_NOT_EXPECTED')});
  controller=new CoachAgentStage3Controller({adapter:new CoachAgentStage3HostAdapter(),dispatch,post,bridgeAvailable:()=>true,isLive:input=>session.current_cue_id===input.cue.id&&session.phase==='PAUSED_FOR_COACHING'});
  const advanceToPause=()=>{for(let i=0;i<plan.segments.length*3&&session.phase!=='PAUSED_FOR_COACHING';i++){const segment=plan.segments[session.current_segment_index];session=reduceCoachingSession(plan,session,session.phase==='SKIPPING'?{type:'SKIP_SEGMENT'}:{type:'TICK',tick:segment.end_tick});}expect(session.outcome_completion.status).toBe('COMPLETE');};
  let firstCueId;
  for(let ordinal=0;ordinal<2;ordinal++){
   advanceToPause();const cue=getCurrentCue(plan,session),material=bundle.candidate_set.materials.find(m=>m.candidateId===cue.candidate_id);
   const context={plan,cue,material,timeline:bundle.match_timeline,selectedPlayerId:twoCueViewerPlayer,learningThreads:Object.values(session.learning_threads??{})};
   const input={...identity,cue,narration:narrations[cue.id],generation:1,tickRate:64,currentSessionPhase:session.phase,outcomeGate:session.outcome_completion,evidence:{candidate:bundle.candidate_set.candidates.find(c=>c.candidateId===cue.candidate_id),material}};
   const synced=await controller.synchronizeDiagnosis(input);expect(synced.state.activeCueId).toBe(cue.id);
   const reflection=reflectionForGoal(cue.id,'GET_INFO'),event=buildTeachingDiagnosisSubmissionEvent(context,reflection,{eventType:'SUBMIT_REFLECTION',eventId:`fault-reflection-${ordinal}`,identity:{runId:identity.runId,sessionId:identity.sessionId,demoId:bundle.demo_id,demoContentHash:identity.demoContentHash,selectedPlayerId:identity.selectedPlayerId,routeId:plan.id,routeHash:routeState.routeFingerprint}});
   if(ordinal===0){
    firstCueId=cue.id;const dispatched=metrics.dispatches;
    await expect(dispatch(event)).rejects.toThrow('agent dispatch HTTP 503');expect(metrics.dispatches).toBe(dispatched);
    const output=runTeachingDiagnosis(context,reflection);expect(output.cueCase.reflection).toMatchObject(reflection);expect(output.cueCase.verdict.type).toBe('INCONCLUSIVE');
    session=reduceCoachingSession(plan,session,{type:'RECORD_TEACHING_CASE',cueCase:output.cueCase,learningThread:output.learningThread});
    session=reduceCoachingSession(plan,session,{type:'CONFIRM_TEACHING_CASE',cueId:cue.id});
    session=reduceCoachingSession(plan,session,{type:'CUE_PRESENTED',cueId:cue.id});
    session=reduceCoachingSession(plan,session,{type:'ADVANCE_SEGMENT'});expect(session.consumed_cue_ids).toEqual([cue.id]);
   }else{
    expect(cue.id).not.toBe(firstCueId);const result=await dispatch(event);
    expect(result.state.cueCases[firstCueId]).toBeUndefined();expect(result.state.cueCases[cue.id].status).toBe('AWAITING_CONFIRMATION');expect(result.state.cueCases[cue.id].reflection).toMatchObject(reflection);expect(result.state.routeCursor).toBe(session.current_segment_index);
   }
  }
  expect(metrics.injectedFailures-before.injectedFailures).toBe(1);expect(metrics.reflectionAttempts-before.reflectionAttempts).toBe(2);expect(preparationCounts).toEqual({route:1,narration:2});expect(post).not.toHaveBeenCalled();expect(blockedFetch).not.toHaveBeenCalled();
 }finally{controller?.dispose();globalThis.fetch=previousFetch;}
});
