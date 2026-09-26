import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, type Cs2dReplay, type Cs2dKillEvent } from "../libs/cs2d-analysis-adapter/src/index";

// One parse per invocation; baseline and updated parser run separately under 120s deadlines.
// The small baseline stays local. Never print raw player identities or coordinates.
const [mode, path, snapshot] = process.argv.slice(2);
assert(["--baseline", "--verify"].includes(mode) && path && snapshot, "Usage: --baseline|--verify <authorized-demo.dem> <local-snapshot.json>");
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); };
const parser = await import("../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js");
parser.initSync({ module: readFileSync(".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm") });
const began = performance.now();
let bytes: Buffer | undefined = readFileSync(path);
const demoBytes = bytes.length;
const parsed = parser.parse_demo(bytes, 8, undefined); bytes = undefined;
let replay: Cs2dReplay;
try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
const parseMs = Math.round(performance.now() - began);
const kills = replay.rounds.flatMap(round => round.events.filter((event): event is Cs2dKillEvent => event.type === "kill").map(event => ({ round: round.number, ...event })));
assert(kills.length > 0);
if (mode === "--baseline") {
  assert(replay.generatedBy?.endsWith(".bomb-identity.v1"));
  writeFileSync(snapshot, JSON.stringify({ generatedBy: replay.generatedBy, kills }), { mode: 0o600 });
  console.log(JSON.stringify({ mode, demoBytes, demoReads: 1, parsePasses: 1, parseMs, rounds: replay.rounds.length, kills: kills.length, networkCalls }));
} else {
  assert(replay.generatedBy?.endsWith(".bomb-identity.v1.death-identity.v1"));
  const previous = JSON.parse(readFileSync(snapshot, "utf8")) as { generatedBy: string; kills: typeof kills };
  assert(previous.generatedBy.endsWith(".bomb-identity.v1"));
  // This particular authorized sample is the coverage baseline, not independent identity truth.
  assert(isDeepStrictEqual(kills, previous.kills), "DEATH_EVENTS_CHANGED_REQUIRES_INVESTIGATION");
  assert(kills.every(event => [event.x, event.y, event.z].every(Number.isFinite)), "NON_FINITE_GEOMETRY");
  const roster = new Set(replay.players.map(player => player.steamId));
  assert(kills.every(event => roster.has(event.victimSteamId) && (event.attackerSteamId === null || roster.has(event.attackerSteamId)) && (event.assisterSteamId === null || roster.has(event.assisterSteamId))));
  // This sample has explicit, valid formal-round bounds. Adapter intentionally
  // excludes post-official-end events from coaching; parser must still preserve them.
  assert(replay.rounds.every(round => round.number > 0 && Number.isInteger(round.freezeStartTick) && round.freezeStartTick < round.endTick && round.endTick <= round.postEndTick && round.winner !== null));
  const eligibleKills = replay.rounds.flatMap(round => round.events.filter((event): event is Cs2dKillEvent => event.type === "kill" && event.tick >= round.freezeStartTick && event.tick < round.endTick));
  let deaths = 0, bundles = 0;
  for (const player of replay.players) {
    const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: player.steamId, demoId: "death-identity-validation" });
    assert(bundle.review_plan.generation_manifest.parser_version.endsWith("/bomb-identity.v1/death-identity.v1"));
    const own = bundle.match_timeline.match_events?.filter(event => event.event_type === "PLAYER_DEATH") ?? [];
    for (const event of own) assert(kills.some(source => source.tick === event.tick && source.victimSteamId === player.steamId));
    deaths += own.length;
    assert(isDeepStrictEqual(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle)).match_timeline.match_events, bundle.match_timeline.match_events), "TIMELINE_ROUNDTRIP_MISMATCH");
    bundles++;
  }
  assert.equal(deaths, eligibleKills.length);
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ mode, demoBytes, demoReads: 1, parsePasses: 1, parseMs, totalMs: Math.round(performance.now() - began), rounds: replay.rounds.length,
    kills: kills.length, unknownAttacker: kills.filter(event => event.attackerSteamId === null).length, unknownAssister: kills.filter(event => event.assisterSteamId === null).length,
    sameEventsAsBaseline: true, coachingEligibleDeaths: eligibleKills.length, outsideCoachingRoundBounds: kills.length - eligibleKills.length, deaths, bundles, networkCalls, limitation: "One sample coverage/consumption only; entity lifecycle anomalies are synthetic tests, not external identity truth." }, null, 2));
}
