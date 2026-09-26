import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, type Cs2dReplay, type Cs2dBombEvent } from "../libs/cs2d-analysis-adapter/src/index";

// Run under a 120-second process deadline. Demo bytes and Replay remain in this process.
const path = process.argv[2];
assert(path, "Usage: tsx tools/validate-bomb-identity.ts <authorized-demo.dem>");
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); };
const parser = await import("../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js");
parser.initSync({ module: readFileSync(".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm") });
const began = performance.now();
let bytes: Buffer | undefined = readFileSync(path);
const demoBytes = bytes.length;
const parsed = parser.parse_demo(bytes, 8, undefined);
bytes = undefined;
let replay: Cs2dReplay;
try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
const parseMs = Math.round(performance.now() - began);
assert(replay.generatedBy?.endsWith(".ammo-clip.v2.bomb-identity.v1"));
const bombs = replay.rounds.flatMap(round => round.events.filter((event): event is Cs2dBombEvent => event.type.startsWith("bomb_")));
assert(bombs.length > 0, "SAMPLE_MUST_CONTAIN_BOMB_EVENTS");
const actorIds = new Set(replay.players.map(player => player.steamId));
assert(bombs.every(event => event.playerSteamId === null || actorIds.has(event.playerSteamId)));
let personalEvents = 0, bundles = 0;
for (const player of replay.players) {
  const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: player.steamId, demoId: "bomb-identity-validation" });
  assert(bundle.review_plan.generation_manifest.parser_version.endsWith("/ammo-clip.v2/bomb-identity.v1"));
  const own = bundle.match_timeline.match_events?.filter(event => ["BOMB_PLANT", "BOMB_DEFUSE"].includes(event.event_type)) ?? [];
  for (const event of own) assert(bombs.some(source => source.tick === event.tick && source.playerSteamId === player.steamId && source.type === (event.event_type === "BOMB_PLANT" ? "bomb_planted" : "bomb_defused")));
  personalEvents += own.length;
  assert.deepEqual(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle)).match_timeline.match_events, bundle.match_timeline.match_events);
  bundles++;
}
assert.equal(personalEvents, bombs.filter(event => event.type !== "bomb_exploded" && event.playerSteamId !== null).length);
assert.equal(networkCalls, 0);
console.log(JSON.stringify({ demoBytes, demoReads: 1, parsePasses: 1, parseMs, totalMs: Math.round(performance.now() - began), rounds: replay.rounds.length,
  bombs: ["bomb_planted", "bomb_defused", "bomb_exploded"].map(type => ({ type, total: bombs.filter(event => event.type === type).length, unknownActor: bombs.filter(event => event.type === type && event.playerSteamId === null).length })),
  personalEvents, bundles, networkCalls, limitation: "Real sample consumption and provenance only; recycled-entity cases are synthetic lifecycle tests, not measured in this Demo." }, null, 2));
