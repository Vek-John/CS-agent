import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, type Cs2dReplay } from "../libs/cs2d-analysis-adapter/src/index";
// Run each mode under 120 seconds. Large Replay stays in this process; local compressed
// baseline preserves exact source samples without printing identities or positions.
const [mode, path, snapshot] = process.argv.slice(2);
assert(["--baseline", "--verify"].includes(mode) && path && snapshot);
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); };
const parser = await import("../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js");
parser.initSync({ module: readFileSync(".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm") });
const began = performance.now();
let bytes: Buffer | undefined = readFileSync(path); const demoBytes = bytes.length;
const parsed = parser.parse_demo(bytes, 8, undefined); bytes = undefined;
let replay: Cs2dReplay;
try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
const parseMs = Math.round(performance.now() - began);
// Compare the persisted JSON contract: JSON normalizes -0 to 0 and omits undefined.
const jsonValue = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const projection = jsonValue(replay.rounds.map(round => ({ number: round.number, freezeStartTick: round.freezeStartTick, startTick: round.startTick, decidedTick: round.decidedTick, endTick: round.endTick, postEndTick: round.postEndTick, frames: round.frames })));
const frames = replay.rounds.reduce((n,round) => n+round.frames.length,0);
const players = replay.rounds.reduce((n,round) => n+round.frames.reduce((m,frame) => m+frame.players.length,0),0);
assert(frames>0 && players>0);
if (mode === "--baseline") {
  assert(replay.generatedBy?.endsWith(".death-identity.v1"));
  const compressed=gzipSync(JSON.stringify(projection)); writeFileSync(snapshot,compressed,{mode:0o600});
  console.log(JSON.stringify({mode,demoBytes,demoReads:1,parsePasses:1,parseMs,frames,players,baselineBytes:compressed.length,networkCalls}));
} else {
  assert(replay.generatedBy?.endsWith(".frame-identity.v1"));
  const before=JSON.parse(gunzipSync(readFileSync(snapshot)).toString()) as typeof projection;
  const same=isDeepStrictEqual(projection,before);
  if(!same){
    writeFileSync(`${snapshot}.current.gz`,gzipSync(JSON.stringify(projection)),{mode:0o600});
    console.log(JSON.stringify({stage:"CHANGED_PROJECTION",rounds:projection.map(round=>{const old=before.find(r=>r.number===round.number);return {round:round.number,changedBounds:(["freezeStartTick","startTick","decidedTick","endTick","postEndTick"] as const).filter(k=>old?.[k]!==round[k]),beforeFrames:old?.frames.length,afterFrames:round.frames.length,beforePlayers:old?.frames.reduce((n,f)=>n+f.players.length,0),afterPlayers:round.frames.reduce((n,f)=>n+f.players.length,0)};})}));
  }
  const negativeZeroCoordinates=replay.rounds.reduce((n,r)=>n+r.frames.reduce((m,f)=>m+f.players.filter(p=>[p.x,p.y,p.z,p.yaw].some(v=>Object.is(v,-0))).length,0),0);
  let bundles=0;
  for(const player of replay.players){
    const bundle=buildCs2dAnalysisBundle({replay,selectedSteamId:player.steamId,demoId:"frame-identity-validation"});
    assert(bundle.review_plan.generation_manifest.parser_version.endsWith("/frame-identity.v1"));
    assert(isDeepStrictEqual(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle)).match_timeline,jsonValue(bundle.match_timeline)),"TIMELINE_ROUNDTRIP_MISMATCH");
    bundles++;
  }
  assert.equal(networkCalls,0);
  console.log(JSON.stringify({mode,demoBytes,demoReads:1,parsePasses:1,parseMs,totalMs:Math.round(performance.now()-began),rounds:replay.rounds.length,frames,players,sameFramesAndRoundBounds:same,negativeZeroCoordinates,bundles,networkCalls,limitation:"Single sample coverage only; invalid binding behavior is exercised in synthetic source-injected lifecycle tests."},null,2));
  assert(same,"FRAME_OR_ROUND_BOUNDARY_CHANGED_REQUIRES_INVESTIGATION");
}
