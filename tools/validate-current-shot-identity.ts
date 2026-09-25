import { readFileSync } from "node:fs";
import { initSync, parse_demo } from "../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js";
import { buildCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, serializeCs2dAnalysisBundle } from "../libs/cs2d-analysis-adapter/src/index";
import { buildCoachingPackage } from "../libs/review-planner/src/narration-package-builder";
// Run only after a successful current WASM build, with a 120-second process timeout.
// Raw bytes and Replay remain in this process. Output contains only counts/timings.
const [demoPath, playerName] = process.argv.slice(2);
if (!demoPath || !playerName) throw Error("Usage: pnpm exec tsx tools/validate-current-shot-identity.ts <existing.dem> <player-name>");
const began = performance.now();
initSync({ module: readFileSync(".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm") });
const parsed = parse_demo(readFileSync(demoPath), 8, undefined);
let replay: any;
try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
const parseMs = Math.round(performance.now() - began);
if (replay.generatedBy !== "cs2-demo-parser-wasm@0.0.0+cs-coach.hurt-events.v1.shot-identity.v2") throw Error("Unexpected parser revision");
const selected = replay.players.find((p: any) => p.name === playerName);
if (!selected) throw Error("Selected player missing");
const roster = new Set(replay.players.map((p: any) => p.steamId));
const shots = replay.rounds.flatMap((r: any) => r.events.filter((e: any) => e.type === "shot").map((e: any) => ({ e, r })));
const hurt = replay.rounds.flatMap((r: any) => r.hurtEvents ?? []);
const invalidGeometry = shots.filter(({ e }: any) => ![e.x, e.y, e.yaw].every(Number.isFinite)).length;
const invalidTick = shots.filter(({ e, r }: any) => !Number.isSafeInteger(e.tick) || e.tick < r.freezeStartTick || e.tick >= r.postEndTick).length;
const invalidActor = shots.filter(({ e }: any) => e.shooterSteamId !== null && (typeof e.shooterSteamId !== "string" || !roster.has(e.shooterSteamId))).length;
if (invalidGeometry || invalidTick || invalidActor) throw Error(`Invalid shot geometry/tick/actor: ${invalidGeometry}/${invalidTick}/${invalidActor}`);
const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: selected.steamId, demoId: "current-shot-identity-validation" });
const restored = deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(bundle));
const packages = restored.review_plan.cues.map(c => buildCoachingPackage(c, restored.candidate_set, restored.observation_evidence));
const parserVersion = restored.review_plan.generation_manifest.parser_version;
if (!parserVersion.endsWith("/hurt-events.v1/shot-identity.v2")) throw Error("Lost parser provenance");
console.log(JSON.stringify({ parsePasses: 1, parseMs, totalMs: Math.round(performance.now() - began),
  generatedBy: replay.generatedBy, parserVersion, rounds: replay.rounds.length,
  shots: shots.length, withActor: shots.filter(({ e }: any) => typeof e.shooterSteamId === "string").length,
  nullActor: shots.filter(({ e }: any) => e.shooterSteamId === null).length, invalidGeometry, invalidTick, invalidActor,
  selectedPlayerShots: shots.filter(({ e }: any) => e.shooterSteamId === selected.steamId).length,
  selectedTimelineWeaponFire: bundle.match_timeline.match_events?.filter(e => e.event_type === "WEAPON_FIRE").length,
  returnAndFireCandidates: bundle.candidate_set.candidates.filter(c => c.source.kind === "RETURN_AND_FIRE").length,
  candidates: bundle.candidate_set.candidates.length, cues: packages.length,
  hurtEvents: hurt.length, resolvedHurtVictims: hurt.filter((h: any) => h.victimSteamId !== null).length,
  selectedPlayerHurt: hurt.filter((h: any) => h.victimSteamId === selected.steamId).length,
  snapshotsWithSelfHurt: bundle.candidate_set.materials.filter(m => m.decisionSnapshot?.selfHurtEvents?.length).length,
  snapshotsWithClock: bundle.candidate_set.materials.filter(m => typeof m.decisionSnapshot?.clock.value?.remainingSeconds === "number").length,
  packagesWithSelfHurt: packages.filter(p => p.decisionContext.facts.some(f => f.text.includes("本人受击"))).length,
  packagesWithClock: packages.filter(p => p.decisionContext.facts.some(f => f.text.includes("回合剩余时间"))).length,
  historyRoundTrip: true,
  limitation: "Single-Demo compatibility, not a ground-truth actor accuracy or professional teaching quality measurement."
}, null, 2));
