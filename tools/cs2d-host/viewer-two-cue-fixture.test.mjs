import { expect, it } from 'vitest';
import { twoCueViewerReplay, twoCueViewerPlayer } from './viewer-two-cue-fixture.ts';
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle } from '../../libs/cs2d-analysis-adapter/src/index.ts';
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle, assertValidReviewPlan } from '../../libs/review-planner/src/index.ts';
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from '../../libs/session/src/index.ts';
import { buildInitialCoachingRouteState } from '../../apps/web/lib/coaching/cs2d-route-integration.ts';
import { CoachAgentStage3HostAdapter } from '../../apps/web/lib/coaching/coach-agent-stage3-host-adapter.ts';

it('uses increasing real Viewer frame times and natural compiled action capabilities for both synthetic rounds',()=>{
 const replay=twoCueViewerReplay();expect(replay.rounds).toHaveLength(2);expect(replay.rounds.reduce((n,r)=>n+r.frames.length,0)).toBeLessThan(1000);
 for(const round of replay.rounds) {
  expect(round.postEndTick).toBe(round.frames.at(-1).tick+1);
  expect(round.frames.at(-1).tick).toBeGreaterThanOrEqual(round.endTick);
  for(const [index,frame] of round.frames.entries()){
  expect(frame.t).toBe((frame.tick-round.freezeStartTick)/64);
  if(index)expect(frame.t).toBeGreaterThan(round.frames[index-1].t);
  expect(frame.players.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))).toBe(true);
 }
 }
 const analysis=buildCs2dAnalysisBundle({replay,selectedSteamId:twoCueViewerPlayer,demoId:'synthetic-two-cue-viewer'}),plan=analysis.review_plan;
 assertValidReviewPlan(analysis.match_timeline,plan);expect(plan.cues).toHaveLength(2);expect(()=>serializeCs2dAnalysisBundle(analysis)).not.toThrow();
 const narrationByCue=Object.fromEntries(plan.cues.map(cue=>[cue.id,deterministicNarrationBundle(buildCoachingPackage(cue,analysis.candidate_set,analysis.observation_evidence),buildOutcomePackage(cue,analysis.candidate_set))]));
 const routeState=buildInitialCoachingRouteState(plan,{narrationByCue});let session=reduceCoachingSession(plan,createCoachingSession(plan,'synthetic-fixture',routeState),{type:'START'});
 const seen=[];
 for(let step=0;step<plan.segments.length*4&&session.phase!=='WRAP_UP';step++){
  if(session.phase==='PAUSED_FOR_COACHING'){
   const cue=getCurrentCue(plan,session);const adapter=new CoachAgentStage3HostAdapter();
   const prepared=adapter.prepareStart({plan,routeState,analysis,demoContentHash:'a'.repeat(64),selectedPlayerId:twoCueViewerPlayer,sessionId:session.id,runId:session.id,cue,narration:narrationByCue[cue.id],generation:1,tickRate:64,currentSessionPhase:session.phase,outcomeGate:session.outcome_completion,
    evidence:{candidate:analysis.candidate_set.candidates.find(c=>c.candidateId===cue.candidate_id),material:analysis.candidate_set.materials.find(m=>m.candidateId===cue.candidate_id),winProbabilityTimeline:analysis.win_probability_timeline}});
   expect(prepared.capabilities.map(c=>c.tool)).toContain('REPLAY_CUE_SLOW');seen.push(cue.id);session=reduceCoachingSession(plan,session,{type:'ADVANCE_SEGMENT'});
  } else {const segment=plan.segments[session.current_segment_index];session=reduceCoachingSession(plan,session,session.phase==='SKIPPING'?{type:'SKIP_SEGMENT'}:{type:'TICK',tick:segment.end_tick});}
 }
 expect(seen).toEqual(plan.cues.map(c=>c.id));
});


it('carries the optional synthetic self-blind occurrence through the actual first teaching package',()=>{
 const replay=twoCueViewerReplay({priorSelfBlind:true});
 const analysis=buildCs2dAnalysisBundle({replay,selectedSteamId:twoCueViewerPlayer,demoId:'synthetic-prior-blind'});
 const cue=analysis.review_plan.cues[0],material=analysis.candidate_set.materials.find(m=>m.candidateId===cue.candidate_id);
 expect(material.decisionSnapshot.selfBlindEvents).toEqual([{source:'DEMO_PLAYER_BLIND',sourceRef:'cs2d-blind-1300-1',tick:1300}]);
 const pack=buildCoachingPackage(cue,analysis.candidate_set,analysis.observation_evidence);
 const fact=pack.decisionContext.facts.find(f=>material.decisionSnapshot.selfBlindEvidenceRefs.includes(f.id));
 expect(fact.available_at_tick).toBe(1300);
 const narration=deterministicNarrationBundle(pack,buildOutcomePackage(cue,analysis.candidate_set));
 expect(narration.currentSituation.text).toContain(fact.text);
 expect(narration.currentSituation.refs).toContain(fact.id);
 expect(twoCueViewerReplay().rounds[0].blinds).toEqual([]);
});
