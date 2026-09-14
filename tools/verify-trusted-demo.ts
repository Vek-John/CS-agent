/** Real cs2d WASM acceptance. Bulk Replay never leaves this process; only bounded cue evidence is written. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle } from '../libs/cs2d-analysis-adapter/src/index.ts';
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle, assertValidNarrationBundle, assertValidReviewPlan, buildDirectorRequest } from '../libs/review-planner/src/index.ts';
const root=process.cwd();
const out=resolve(root,'.local-data/acceptance-trusted-decisions');
mkdirSync(out,{recursive:true});
const parser=await import(pathToFileURL(resolve(root,'.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js')).href);
const bytes=readFileSync(resolve(root,'demoTests/test_demo.dem'));
const hash=createHash('sha256').update(bytes).digest('hex');
assert.equal(hash,'84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2');
parser.initSync({module:readFileSync(resolve(root,'.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm'))});
const started=performance.now();
const parsed=parser.parse_demo(bytes,8);
const replay=JSON.parse(parsed.replay); parsed.free();
const parseMs=Math.round(performance.now()-started);
assert.equal(replay.map,'de_mirage'); assert.equal(replay.players.length,10);
const forbidden=/ObservationState|ObservableState|renderer|\btick\b|lossless|refId|schema|\bTRADE\b|\b[A-Z]+(?:_[A-Z]+)+\b|\bpipeline\b|\bfallback\b|\bcandidate\b/i;
const cases=[]; const players=[]; let assertions=3;
for(const player of replay.players){
 const bundle=buildCs2dAnalysisBundle({replay,selectedSteamId:player.steamId,demoId:`cs2d-${hash}`,demoContentHash:hash});
 const plan=assertValidReviewPlan(bundle.match_timeline,bundle.review_plan);
 const wire=serializeCs2dAnalysisBundle(bundle); deserializeCs2dAnalysisBundle(wire);
 assert(Buffer.byteLength(wire)<=16*1024*1024); assertions++;
 const director=buildDirectorRequest(bundle.candidate_set);
 assert(!/"frames"|"grenadePaths"|"world_position"|"decisionSnapshot"/.test(JSON.stringify(director))); assertions++;
 for(const candidate of bundle.candidate_set.candidates){
  const material=bundle.candidate_set.materials.find(x=>x.candidateId===candidate.candidateId);
  const snapshot=candidate.decisionSnapshot ?? material?.decisionSnapshot;
  assert(snapshot,'every real candidate needs decision snapshot');
  assert(snapshot.sampledAtTick===null||snapshot.sampledAtTick<=candidate.decisionTick);
  assert(Buffer.byteLength(JSON.stringify(snapshot))<=16*1024);
  assert(snapshot.players.length<=10); assertions+=4;
  const text=JSON.stringify(material?.playerActionFacts);
  assert(!/继续留在这条枪线|主动接了这波对枪|继续接了这波对枪/.test(text)); assertions++;
 }
 for(const cue of plan.cues){
  assert.equal(plan.player_id,player.steamId); assertions++;
  const coaching=buildCoachingPackage(cue,bundle.candidate_set,bundle.observation_evidence);
  const outcome=buildOutcomePackage(cue,bundle.candidate_set,bundle.outcome_impacts.find(x=>x.cueId===cue.id));
  const narration=deterministicNarrationBundle(coaching,outcome);
  assertValidNarrationBundle(narration,coaching,outcome); assertions++;
  const publicText=['currentSituation','playerAction','coreIssue','betterPlay','outcomeImpact'].map(k=>narration[k].text).join(' ');
  assert(!forbidden.test(publicText),publicText); assertions++;
  const r=replay.rounds.find(r=>r.number===plan.segments.find(s=>s.id===cue.segment_id)?.round_number);
  const frame=r.frames.filter(f=>f.tick<=cue.decision_tick).at(-1);
  const self=frame?.players.find(p=>p.steamId===player.steamId);
  const allies=frame?.players.filter(p=>p.side===self?.side&&p.steamId!==player.steamId&&p.alive&&p.health>0);
  if(allies?.length===0){ assert(!/让高血量队友|跟着补枪|让队友先|跟队友补枪/.test(narration.betterPlay.text)); assertions++; }
  if(cue.assessment?.kind==='DECISION_ERROR') assert(cue.behaviorHypotheses?.some(h=>h.allowedAsTeachingJudgment&&h.supportingEvidenceRefs.length));
  cases.push({player:player.name,candidateId:cue.candidate_id,cueId:cue.id,round:r.number,decision:cue.decision_tick,health:self?.health,aliveTeammates:allies?.length,assessment:cue.assessment,adviceOptions:cue.adviceOptions,narration});
 }
 players.push({player:player.name,rounds:bundle.match_timeline.rounds.length,candidates:bundle.candidate_set.candidates.length,snapshotCount:bundle.candidate_set.materials.filter(m=>m.decisionSnapshot).length,maxSnapshotBytes:Math.max(0,...bundle.candidate_set.materials.map(m=>Buffer.byteLength(JSON.stringify(m.decisionSnapshot??null)))),cues:plan.cues.length,segments:plan.segments.length,bundleBytes:Buffer.byteLength(wire)});
}
const result={status:'PASS',hash,parseMs,assertions,players,cases};
writeFileSync(resolve(out,'after.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({status:result.status,hash,parseMs,assertions,players},null,2));
