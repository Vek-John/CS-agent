import { readFileSync } from 'node:fs';
import { initSync, parse_demo } from '../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js';
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle } from '../libs/cs2d-analysis-adapter/src/index';
import { buildCoachingPackage, buildOutcomePackage } from '../libs/review-planner/src/narration-package-builder';
import { deterministicNarrationBundle } from '../libs/review-planner/src/teaching-pipeline';
// Replay stays in this process; output contains only bounded telemetry. Run with a 120s process timeout.
const [demoPath, playerName] = process.argv.slice(2);
if (!demoPath || !playerName) throw Error('Usage: pnpm exec tsx tools/validate-self-hurt.ts <existing.dem> <player-name>');
const begin=performance.now();
initSync({ module: readFileSync('.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm') });
const result=parse_demo(readFileSync(demoPath),8,undefined);
const replay=JSON.parse(result.replay); result.free();
const parsedMs=performance.now()-begin;
const selected=replay.players.find((p:any)=>p.name===playerName); if(!selected)throw Error('Existing selected player not found');
const bundle=buildCs2dAnalysisBundle({replay,selectedSteamId:selected.steamId,demoId:'self-hurt-real-validation'});
const restored=deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle));
const hurts=replay.rounds.flatMap((r:any)=>r.hurtEvents??[]);
const snapshots=bundle.candidate_set.materials.filter(m=>m.decisionSnapshot?.selfHurtEvents?.length);
const packages=restored.review_plan.cues.map(cue=>{ const pack=buildCoachingPackage(cue,restored.candidate_set,restored.observation_evidence); const outcome=buildOutcomePackage(cue,restored.candidate_set);return {cue,pack,outcome,narration:deterministicNarrationBundle(pack,outcome)}; });
const consumers=packages.filter(({pack})=>pack.decisionContext.facts.some(f=>f.text.includes('本人受击')));
for(const m of snapshots)for(const h of m.decisionSnapshot!.selfHurtEvents!){if(h.tick>=m.decisionSnapshot!.decisionTick || /reported|attacker|weapon/i.test(JSON.stringify(h)))throw Error('Unsafe self hurt projection');}
if(!hurts.length||!snapshots.length||!consumers.length)throw Error(`Missing consumption: ${hurts.length}/${snapshots.length}/${consumers.length}`);
if(consumers.some(({narration})=>!narration.currentSituation.text.includes('本人受击')))throw Error('Narration did not consume prior self hurt');
const oldReplay={...replay,generatedBy:undefined,rounds:replay.rounds.map((r:any)=>{const {hurtEvents,...old}=r;return old;})};
const old=buildCs2dAnalysisBundle({replay:oldReplay,selectedSteamId:selected.steamId,demoId:'self-hurt-real-validation'});
const beforeCues=old.review_plan.cues.map(c=>({tick:c.decision_tick,candidate:c.candidate_id}));
const afterCues=restored.review_plan.cues.map(c=>({tick:c.decision_tick,candidate:c.candidate_id}));
if(JSON.stringify(beforeCues)!==JSON.stringify(afterCues))throw Error('Unexpected route nomination change');
console.log(JSON.stringify({parsePasses:1,parsedMs:Math.round(parsedMs),totalMs:Math.round(performance.now()-begin),generatedBy:replay.generatedBy,rounds:replay.rounds.length,hurtEvents:hurts.length,resolvedVictims:hurts.filter((h:any)=>h.victimSteamId).length,unresolvedVictims:hurts.filter((h:any)=>!h.victimSteamId).length,selectedPlayerHurtEvents:hurts.filter((h:any)=>h.victimSteamId===selected.steamId).length,reportedZeroHealth:hurts.filter((h:any)=>h.reportedHealthAfter===0).length,candidates:bundle.candidate_set.materials.length,snapshotsWithPriorSelfHurt:snapshots.length,cues:packages.length,packagesWithPriorSelfHurt:consumers.length,narrationsWithPriorSelfHurt:consumers.length,outcomesWithSelfHurt:packages.filter(({outcome})=>outcome.outcomeFacts.some(f=>f.evidenceRefs.some(ref=>ref.startsWith('cs2d-hurt-')))).length,historyRoundTrip:true,sameReplayAblation:{oldSnapshotsWithSelfHurt:old.candidate_set.materials.filter(m=>m.decisionSnapshot?.selfHurtEvents?.length).length,oldPackagesWithSelfHurt:old.review_plan.cues.map(c=>buildCoachingPackage(c,old.candidate_set,old.observation_evidence)).filter(p=>p.decisionContext.facts.some(f=>f.text.includes('本人受击'))).length,candidateCount:old.candidate_set.candidates.length,cueRouteUnchanged:true,frameHealthStepsBefore:old.match_timeline.match_events?.filter(e=>e.source_parser_event==='cs2d:frame-health-step').length,frameHealthStepsAfter:bundle.match_timeline.match_events?.filter(e=>e.source_parser_event==='cs2d:frame-health-step').length,exactHurtTimelineEvents:bundle.match_timeline.match_events?.filter(e=>e.source_parser_event==='cs2d:player_hurt').length},examples:consumers.slice(0,3).map(({cue,pack})=>({decisionTick:cue.decision_tick,sourceEvents:bundle.candidate_set.materials.find(m=>m.candidateId===cue.candidate_id)?.decisionSnapshot?.selfHurtEvents,facts:pack.decisionContext.facts.filter(f=>f.text.includes('本人受击')).map(f=>({text:f.text,availableAtTick:f.available_at_tick})),assessment:pack.assessment.kind}))},null,2));
