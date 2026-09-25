import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildCs2dAnalysisBundle, type Cs2dReplay } from "../libs/cs2d-analysis-adapter/src/index";
import { fireReplay, self } from "../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildTeachingDiagnosisInput, runTeachingDiagnosis } from "../apps/web/lib/coaching/teaching-diagnosis-host";

// Invoke under an external 120-second process-group deadline. Bulk never leaves this process.
let demoReads = 0, parsePasses = 0, networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); };
const began = performance.now();
const mode = process.argv[2];
let replay: Cs2dReplay; let selected: string; let parseMs = 0; let demoHash = "a".repeat(64);
if (mode === "--smoke") {
  const source = fireReplay("DEATH", []);
  replay = { ...source, rounds: source.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame, tick: frame.tick, players: frame.players.map(p => ({ ...p, alive: frame.tick - 1 < 1408, health: frame.tick - 1 < 1408 ? 40 : 0, weapon: "AK-47", activeWeaponHandle: 114697, ammoSamplingVersion: 2 as const, weaponAmmo: { source: "SOURCE2_ACTIVE_WEAPON" as const, phase: "TICK_END" as const, version: 2 as const, sampledAtTick: frame.tick - 1, weapon: "AK-47", weaponHandle: 114697, clip: 7 } })) })) })) };
  selected = self;
} else {
  assert(mode && process.argv[3], "Usage: --smoke | <authorized-demo.dem> <player-name>");
  const parser = await import("../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js");
  parser.initSync({ module: readFileSync(".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm") });
  assert(!("ammo_probe_summary" in parser), "PRODUCTION_WASM_WITHOUT_PROBE_REQUIRED");
  let bytes: Buffer | undefined = readFileSync(mode); demoReads++;
  demoHash = createHash("sha256").update(bytes).digest("hex");
  const started = performance.now(); const parsed = parser.parse_demo(bytes, 8, undefined); parsePasses++; bytes = undefined;
  try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
  parseMs = Math.round(performance.now() - started);
  selected = replay.players.find(p => p.name === process.argv[3])?.steamId ?? ""; assert(selected, "PLAYER_MISSING");
  process.stderr.write(JSON.stringify({ stage: "PARSED", demoReads, parsePasses, parseMs }) + "\n");
}
const sourceSamples = replay.rounds.flatMap(r => r.frames.flatMap(f => f.players.filter(p => p.steamId === selected).map(p => ({ player: p, round: r.number, tick: f.tick }))));
const emitted = sourceSamples.filter(s => s.player.weaponAmmo);
const cacheMaxEntries = (replay as Cs2dReplay & { ammoCacheMaxEntries?: number }).ammoCacheMaxEntries;
if (mode !== "--smoke") assert(Number.isSafeInteger(cacheMaxEntries) && cacheMaxEntries! <= replay.players.length, "BOUNDED_CACHE_REQUIRED");
const sourceSummary = { cacheMaxEntries, sampleGapTicks: [...new Set(emitted.map(s => s.tick - s.player.weaponAmmo!.sampledAtTick))], frames: sourceSamples.length, emitted: emitted.length, valid: emitted.every(s => s.player.weaponAmmo!.source === "SOURCE2_ACTIVE_WEAPON" && s.player.weaponAmmo!.version === 2 && s.player.ammoSamplingVersion === 2 && s.player.weaponAmmo!.sampledAtTick < s.tick && s.player.weaponAmmo!.weapon === s.player.weapon), zeroClips: emitted.filter(s => s.player.weaponAmmo!.clip === 0).length };
const enriched = buildCs2dAnalysisBundle({ replay, selectedSteamId: selected, demoId: "ammo-validation", demoContentHash: demoHash });
// Same parsed Replay; temporarily remove only the new field. No second Demo read/parse.
for (const row of emitted) delete (row.player as { weaponAmmo?: unknown }).weaponAmmo;
const baseline = buildCs2dAnalysisBundle({ replay, selectedSteamId: selected, demoId: "ammo-validation", demoContentHash: demoHash });
assert.deepEqual(enriched.candidate_set.candidates.map(c => c.assessment), baseline.candidate_set.candidates.map(c => c.assessment));
assert.deepEqual(enriched.review_plan, baseline.review_plan, "AMMO_CHANGED_PLAN");
const beforeContexts = new Map(baseline.review_plan.cues.map(cue => [cue.id, { plan: baseline.review_plan, cue, material: baseline.candidate_set.materials.find(m => m.candidateId === cue.candidate_id), timeline: baseline.match_timeline, selectedPlayerId: selected }]));
const rows = enriched.review_plan.cues.map(cue => {
  const context = { plan: enriched.review_plan, cue, material: enriched.candidate_set.materials.find(m => m.candidateId === cue.candidate_id), timeline: enriched.match_timeline, selectedPlayerId: selected };
  const reflection = { cueId: cue.id, selectedGoal: "OTHER" as const, response: "ANSWERED" as const, source: "USER" as const, limitations: [] };
  const input = buildTeachingDiagnosisInput(context, reflection);
  const result = runTeachingDiagnosis(context, reflection);
  const before = runTeachingDiagnosis(beforeContexts.get(cue.id)!, reflection);
  assert.deepEqual(result.cueCase.verdict, before.cueCase.verdict);
  assert.deepEqual(result.cueCase.transferRule, before.cueCase.transferRule);
  assert.equal(result.cueCase.diagnosticResult?.status, before.cueCase.diagnosticResult?.status);
  const ammo = input.decisionResources?.weaponAmmo;
  const consumed = result.cueCase.diagnosticResult?.measurements.find(m => m.id.endsWith("weapon-clip"));
  if (ammo && consumed) { assert.equal(consumed.value, ammo.clip); assert.deepEqual(consumed.evidenceRefs, ammo.evidenceRefs); }
  const states = context.timeline.player_state_tracks?.filter(s => s.player_id === selected && s.tick <= cue.decision_tick).sort((a,b) => b.tick-a.tick) ?? [];
  const current = states[0];
  const prior = current?.active_item?.ammo_sampling_version === 2 ? current : states.find(s => s.tick < cue.decision_tick);
  const sampleTick = prior?.active_item?.ammo_evidence?.sampled_at_tick;
  const changes = context.timeline.match_events?.filter(e => e.actor_player_id === selected && sampleTick !== undefined && e.tick > sampleTick && e.tick <= cue.decision_tick && ["WEAPON_FIRE", "RELOAD", "ITEM_PICKUP", "ITEM_DROP"].includes(e.event_type)).map(e => ({ type: e.event_type, tick: e.tick })) ?? [];
  const binding = { currentTick: current?.tick, containerTick: prior?.tick, sampleTick,
    strictPrior: Boolean(sampleTick !== undefined && sampleTick < cue.decision_tick), priorAmmo: Boolean(prior?.active_item?.ammo_evidence),
    sameEntityAtEndpoints: Boolean(prior?.active_item?.ammo_evidence && prior.active_item.ammo_evidence.weapon_handle === current?.active_item?.entity_handle),
    interveningChanges: changes };
  return { cue: cue.id, round: context.material?.decisionSnapshot?.roundNumber, decision: cue.decision_tick,
    binding, ammo: ammo ?? null, consumed: consumed ? { value: consumed.value, refs: consumed.evidenceRefs, label: consumed.label } : null,
    verdictUnchanged: true, status: result.cueCase.diagnosticResult?.status };
});
assert.equal(networkCalls, 0); assert(sourceSummary.valid);
if (mode === "--smoke") assert(rows.some(row => row.consumed), "SMOKE_MUST_CONSUME_AMMO");
console.log(JSON.stringify({ mode: mode === "--smoke" ? "SYNTHETIC_TIME_CACHE_SMOKE" : "REAL_WASM_PRIOR_CACHE_ONE_PARSE", demoReads, parsePasses, parseMs, totalMs: Math.round(performance.now() - began), networkCalls, sourceSummary,
  candidates: enriched.candidate_set.candidates.length, formalCues: rows.length, ammoCues: rows.filter(r => r.ammo).length, consumedCues: rows.filter(r => r.consumed).length,
  sameAssessments: true, samePlan: true, sameVerdictsAndAdvice: true, rows }, null, 2));
