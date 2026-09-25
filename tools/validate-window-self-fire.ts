import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildCs2dAnalysisBundle, type Cs2dAnalysisBundle, type Cs2dReplay } from "../libs/cs2d-analysis-adapter/src/index";
import { assembleCandidateSet, compileReviewPlan, deterministicDirectorFallback, buildDirectorRequest } from "../libs/review-planner/src/index";
import { consumeRoute, type RouteInput } from "./validate-real-action-replay";
import { analyzeFire, fireReplay } from "../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";

// Caller must enforce a 120-second process-group deadline; synchronous WASM
// cannot be interrupted by a JS timer. Only compact action/window summaries leave.
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw Error("NETWORK_FORBIDDEN"); };
const began = performance.now();
let demoReads = 0, parsePasses = 0;

async function compare(bundle: Cs2dAnalysisBundle, hash: string) {
  const source = bundle.candidate_set;
  const extraIds = new Set(source.materials.flatMap(m => m.playerActionFacts.filter(f => f.presentationOnly).map(f => f.id)));
  // Fact ablation only: same Replay/observations/candidates/windows. No second
  // adapter/parse, no deletion or reindexing of the original parser events.
  const ablated = assembleCandidateSet({ ...source,
    candidates: source.candidates.map(c => ({ ...c, actionRefs: c.actionRefs.filter(ref => !extraIds.has(ref)) })),
    materials: source.materials.map(m => ({ ...m, playerActionFacts: m.playerActionFacts.filter(f => !f.presentationOnly) })),
  });
  const { plan: before } = compileReviewPlan({ timeline: bundle.match_timeline, candidateSet: ablated, directorDecisionSet: deterministicDirectorFallback(ablated), planId: bundle.review_plan.id, observationVersion: bundle.review_plan.observation_version, signalVersion: bundle.review_plan.signal_version });
  const after = bundle.review_plan;
  const signatures = (plan: typeof after) => ({
    segments: plan.segments.map(s => ({ id: s.id, round: s.round_number, start: s.start_tick, end: s.end_tick, mode: s.mode, cueIds: s.cue_ids })),
    cues: plan.cues.map(c => ({ id: c.id, candidate: c.candidate_id, decision: c.decision_tick, reveal: c.reveal_tick, end: c.outcome_end_tick, assessment: c.assessment, focus: c.primary_focus_code })),
  });
  assert.deepEqual(signatures(after), signatures(before), "FACT_ENRICHMENT_CHANGED_ROUTE_OR_ASSESSMENT");
  assert.deepEqual(buildDirectorRequest(source).candidates, buildDirectorRequest(ablated).candidates, "DIRECTOR_PACKET_DRIFT");
  assert.deepEqual(source.candidates.map(c => c.assessment), ablated.candidates.map(c => c.assessment), "CANDIDATE_ASSESSMENT_DRIFT");
  const facts = source.materials.flatMap(m => {
    const candidate = source.candidates.find(c => c.candidateId === m.candidateId)!;
    return m.playerActionFacts.filter(f => f.presentationOnly).map(f => ({ candidate: candidate.candidateId, kind: candidate.source.kind, round: candidate.roundNumber, window: { decision: candidate.decisionTick, reveal: candidate.revealTick }, action: { id: f.id, at: f.availableAtTick, refs: f.evidenceRefs, presentationOnly: f.presentationOnly }, selectedCue: after.cues.find(c => c.candidate_id === candidate.candidateId)?.id ?? null }));
  });
  process.stderr.write(JSON.stringify({ stage: "ABLATION_COMPARED_BEFORE_CONSUMPTION", candidates: source.candidates.length, formalCues: after.cues.length, addedFacts: facts, sameRoute: true, sameDirectorPacket: true, sameAssessments: true }) + "\n");
  const common = { observations: bundle.observation_evidence, tickRate: bundle.match_timeline.tick_rate, hash, player: 1 } satisfies Omit<RouteInput, "plan" | "set">;
  const baseline = await consumeRoute({ ...common, plan: before, set: ablated });
  const enriched = await consumeRoute({ ...common, plan: after, set: source });
  assert([...baseline.rows, ...enriched.rows].every(row => !row.failure), "CUE_CONSUMPTION_FAILURE");
  return { candidates: source.candidates.length, formalCues: after.cues.length, addedFacts: facts,
    sameRoute: true, sameDirectorPacket: true, sameAssessments: true,
    baseline: { effects: baseline.rows.filter(r => r.effectCount === 1).length, ...baseline },
    enriched: { effects: enriched.rows.filter(r => r.effectCount === 1).length, ...enriched } };
}

try {
  const [path, playerName] = process.argv.slice(2);
  if (path === "--smoke") {
    const result = await compare(analyzeFire(fireReplay("DEATH")), "a".repeat(64));
    assert.equal(result.baseline.effects, 0);
    assert.equal(result.enriched.effects, 1);
    console.log(JSON.stringify({ mode: "SYNTHETIC_FACT_ABLATION_SMOKE", demoReads, parsePasses, fetchCalls, result }, null, 2));
  } else {
    assert(path && playerName, "Usage: --smoke | <existing.dem> <player-name>");
    const { initSync, parse_demo } = await import("../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js");
    initSync({ module: readFileSync(".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm") });
    let bytes: Buffer | undefined = readFileSync(path); demoReads++;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const parsed = parse_demo(bytes, 8, undefined); parsePasses++; bytes = undefined;
    let replay: Cs2dReplay;
    try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
    const parseMs = Math.round(performance.now() - began);
    process.stderr.write(JSON.stringify({ stage: "PARSED", demoReads, parsePasses, parseMs }) + "\n");
    const player = replay.players.find(p => p.name === playerName);
    assert(player, "SELECTED_PLAYER_MISSING");
    const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: player.steamId, demoId: "window-fire-validation", demoContentHash: hash });
    const result = await compare(bundle, hash);
    assert.equal(fetchCalls, 0);
    console.log(JSON.stringify({ mode: "REAL_RULE_ROUTE_FACT_ABLATION_SIMULATED_TRANSPORT", demoReads, parsePasses, parseMs, totalMs: Math.round(performance.now() - began), fetchCalls, result }, null, 2));
  }
} finally { globalThis.fetch = originalFetch; }
