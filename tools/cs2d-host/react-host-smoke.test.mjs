import { expect, it, vi } from 'vitest';
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle } from '../../libs/cs2d-analysis-adapter/src/index.ts';
import { deterministicDirectorFallback } from '../../libs/review-planner/src/index.ts';
import { createCs2dReviewPreparationDependencies, createReviewPreparationOrchestrator } from '../../apps/web/lib/coaching/cs2d-route-integration.ts';
import { requestNarrationBundle } from '../../apps/web/lib/coaching/narrator-contract.ts';
import { createCoachingSession, reduceCoachingSession, getCurrentCue } from '../../libs/session/src/index.ts';
import { CoachAgentStage3HostAdapter } from '../../apps/web/lib/coaching/coach-agent-stage3-host-adapter.ts';
import { createRemoteCoachAgentDispatchEnvelope } from '../../libs/coach-agent/src/remote-dispatch-client.ts';
import { twoCueViewerReplay, twoCueViewerPlayer } from './viewer-two-cue-fixture.ts';

it('prepares the actual synthetic bundle and dispatches valid observed segments and first cue through the smoke memory Runtime', async () => {
 const previousFetch=globalThis.fetch;
 try {
  const {dispatch,metrics}=await import('./react-host-smoke-runtime.ts');
  await expect(dispatch({success:true})).rejects.toThrow();expect(metrics.dispatches).toBe(0);
  const bundle=deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(buildCs2dAnalysisBundle({replay:twoCueViewerReplay(),selectedSteamId:twoCueViewerPlayer,demoId:'synthetic-react-host',demoContentHash:'a'.repeat(64)})));
  const fetcher=vi.fn(()=>{throw Error('PROVIDER_NOT_EXPECTED')});
  const dependencies=createCs2dReviewPreparationDependencies({candidateSet:bundle.candidate_set,observationEvidence:bundle.observation_evidence,matchTimeline:bundle.match_timeline,winProbabilityTimeline:bundle.win_probability_timeline,selectedPlayerId:bundle.selected_steam_id},{
   assessDecisions:async candidateSet=>({candidateSet,run:{version:'decision-assessment-run.v1',mode:'RULE_BASELINE',calls:0,accepted:0,records:[]}}),
   director:async set=>deterministicDirectorFallback(set), narrator:(context,options)=>requestNarrationBundle(context,{...options,fetcher})});
  const prep=createReviewPreparationOrchestrator('smoke',bundle.review_plan,{},dependencies);let ready;const narrations={};
  await prep.run(event=>{if(event.type==='NARRATION_UPDATE')narrations[event.cueId]=event.result.narration;if(event.type==='READY_TO_START')ready=event});
  expect(ready.routeState.startable).toBe(true);expect(ready.plan.cues).toHaveLength(2);expect(Object.keys(narrations)).toHaveLength(2);expect(fetcher).not.toHaveBeenCalled();
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
  expect(result.checkpoint.backend).toBe('MEMORY');expect(result.state.runStatus).toBe('WAITING_TOOL');expect(result.state.activeCueId).toBe(cue.id);expect(metrics.externalFetches).toBe(0);expect(metrics.events.START_CUE).toBe(1);
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
