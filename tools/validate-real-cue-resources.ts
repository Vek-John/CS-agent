import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { initSync, parse_demo } from "../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js";
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle } from "../libs/cs2d-analysis-adapter/src/index";
import { createSyntheticMirageTimeline } from "../libs/demo-domain/src/index";
import { createFixtureReviewPlan } from "../libs/review-planner/src/index";
import { createCoachingSession, reduceCoachingSession } from "../libs/session/src/index";
import { buildTeachingDiagnosisInput, buildTeachingDiagnosisSubmissionEvent, runTeachingDiagnosis, type TeachingDiagnosisHostContext } from "../apps/web/lib/coaching/teaching-diagnosis-host";
import { restoreCheckpointTeachingCase } from "../apps/web/lib/recovery/cs2d-session-recovery";
import { diagnoseTeachingCue, TeachingDiagnosisOutputSchema, createRemoteCoachAgentDispatchEnvelope, parseRemoteCoachAgentDispatchEnvelope } from "../libs/coach-agent/src/remote-dispatch-client";
import type { ReviewPlan, UserReflection } from "../libs/contracts/src/index";

// Only --smoke uses synthetic data. Real mode reads the Demo once and retains all bulk in-process.
// Caller must enforce a 120-second process timeout. No model, network, DB or browser is used.
let fetchCalls = 0, diagnosisCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls++; throw Error("Network is forbidden during this validation"); };
const began = performance.now();

function pausedAt(plan: ReviewPlan, cueId: string) {
  let state = reduceCoachingSession(plan, createCoachingSession(plan, "isolated-validation"), { type: "START" });
  for (let i = 0; i < plan.segments.length * 5 + 10; i++) {
    if (state.phase === "PAUSED_FOR_COACHING" && state.current_cue_id === cueId) return state;
    const segment = plan.segments[state.current_segment_index];
    if (!segment) break;
    state = state.phase === "SKIPPING"
      ? reduceCoachingSession(plan, state, { type: "SKIP_SEGMENT" })
      : state.phase === "PAUSED_FOR_COACHING"
      ? reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" })
      : reduceCoachingSession(plan, state, { type: "TICK", tick: segment.end_tick });
  }
  throw Error("Could not reach the existing cue through the session reducer");
}

function consume(context: TeachingDiagnosisHostContext, goal: "OTHER" | "TRADE", onEvidence?: (value: unknown) => void) {
  const reflection: UserReflection = { cueId: context.cue.id, selectedGoal: goal, source: "USER", response: "ANSWERED", limitations: [] };
  const input = buildTeachingDiagnosisInput(context, reflection);
  diagnosisCalls++;
  const local = runTeachingDiagnosis(context, reflection);
  const event = buildTeachingDiagnosisSubmissionEvent(context, reflection, { eventType: "SUBMIT_REFLECTION", eventId: "isolated-probe", identity: { runId: "validation-run", sessionId: "validation-session", demoId: "validation-demo", demoContentHash: "validation-only", selectedPlayerId: context.selectedPlayerId, routeId: context.plan.id, routeHash: "validation-route" } });
  const envelope = parseRemoteCoachAgentDispatchEnvelope(JSON.parse(JSON.stringify(createRemoteCoachAgentDispatchEnvelope(event))));
  assert(envelope.event.type === "SUBMIT_REFLECTION");
  assert(!("decisionState" in envelope.event.input));
  assert(!/"(?:player_id|tick|world_position|inventory)"/.test(JSON.stringify({ resources: envelope.event.input.decisionResources, roster: envelope.event.input.decisionRoster })));
  diagnosisCalls++;
  const compact = diagnoseTeachingCue({ ...envelope.event.input, reflection: envelope.event.reflection });
  assert.deepEqual(compact, local);
  const saved = TeachingDiagnosisOutputSchema.parse(JSON.parse(JSON.stringify(local)));
  assert.deepEqual(saved, local);
  onEvidence?.({ goal, resources: input.decisionResources ?? null, roster: input.decisionRoster ?? null, result: local.cueCase.diagnosticResult, verdict: local.cueCase.verdict?.type });
  const before = { diagnosisCalls, fetchCalls };
  let restoration: { sameValues: boolean; fetchDelta: number; diagnosisDelta: number; error?: string };
  try {
    const session = pausedAt(context.plan, context.cue.id);
    const restored = restoreCheckpointTeachingCase(context.plan, session, saved.cueCase, saved.learningThread);
    assert.deepEqual(restored.cue_cases?.[context.cue.id]?.diagnosticResult, local.cueCase.diagnosticResult);
    assert.deepEqual(restored.outcome_completion, session.outcome_completion);
    assert.deepEqual({ diagnosisCalls, fetchCalls }, before);
    restoration = { sameValues: true, fetchDelta: 0, diagnosisDelta: 0 };
  } catch (error) {
    restoration = { sameValues: false, fetchDelta: fetchCalls - before.fetchCalls, diagnosisDelta: diagnosisCalls - before.diagnosisCalls, error: error instanceof Error ? error.message.slice(0, 600) : "Recovery failed" };
  }
  return { input, result: local.cueCase.diagnosticResult!, verdict: local.cueCase.verdict?.type, restoration };
}

try {
  const [path, playerName] = process.argv.slice(2);
  if (path === "--replay-summary") {
    if (!playerName) throw Error("--replay-summary requires the captured small summary path");
    const file = JSON.parse(readFileSync(playerName, "utf8"));
    const captured = file.successfulAttemptBeforeTextFix ?? file;
    const rows = captured.rows.map((row: any) => {
      const cueId = `captured-projection-${row.ordinal}`;
      diagnosisCalls++;
      const output = diagnoseTeachingCue({ cueId, reflection: { cueId, selectedGoal: "TRADE", source: "USER", response: "ANSWERED", limitations: [] }, decisionFacts: [], playerActionFacts: [], outcomeFacts: [], ...(row.resources ? { decisionResources: row.resources } : {}), ...(row.roster ? { decisionRoster: row.roster } : {}) });
      const result = output.cueCase.diagnosticResult!;
      assert.equal(result.status, row.trade.status);
      assert.equal(output.cueCase.verdict?.type, row.trade.verdict);
      if (row.roster?.aliveTeammates > 0) {
        assert(result.explanation.includes(`当时还有${row.roster.aliveTeammates}名存活队友`));
        assert(!result.explanation.includes("还缺少队友是否存活"));
        assert(row.roster.evidenceRefs.every((ref: string) => result.evidenceRefs.includes(ref)));
      }
      return { ordinal: row.ordinal, status: result.status, explanation: result.explanation, evidenceRefs: result.evidenceRefs, verdict: output.cueCase.verdict?.type };
    });
    console.log(JSON.stringify({ mode: "MINIMIZED_CAPTURED_RESOURCE_PROJECTIONS", demoReads: 0, fetchCalls, diagnosisCalls, limitation: "Replays captured resources/roster only, not the full original cue or Replay.", rows }, null, 2));
  } else if (path === "--smoke") {
    const timeline = structuredClone(createSyntheticMirageTimeline());
    const plan = createFixtureReviewPlan(timeline);
    // The original fixture only has automatic freeze skips. Include an ordinary
    // explicit SKIP and visit every fixture cue so the real recovery path is smoked.
    plan.segments[1].mode = "SKIP";
    const audits = plan.cues.map(cue => {
      const isolated = { ...timeline, player_state_tracks: [{ player_id: timeline.selected_player_id, tick: cue.decision_tick, side: "T" as const, world_position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, alive: true, health: 70, armor: 80, has_helmet: false, inventory: [], fact_refs: ["synthetic-current-resource"], missing_fields: ["helmet"] }] };
      const audit = consume({ timeline: isolated, plan, cue, selectedPlayerId: timeline.selected_player_id }, "OTHER");
      assert.equal(audit.input.decisionResources?.health, 70);
      assert.equal(audit.input.decisionResources?.armor, 80);
      assert.equal(audit.input.decisionResources?.hasHelmet, undefined);
      assert.equal(audit.result.status, "UNVERIFIABLE");
      assert.equal(audit.restoration.sameValues, true);
      return { measurements: audit.result.measurements, restoration: audit.restoration };
    });
    console.log(JSON.stringify({ mode: "SYNTHETIC_SMOKE", demoReads: 0, importHostDiagnosisEnvelopeRecovery: "PASS", ordinarySkip: true, fixtureCues: audits.length, audits, fetchCalls, diagnosisCalls }));
  } else {
    if (!path || !playerName) throw Error("Usage: pnpm exec tsx tools/validate-real-cue-resources.ts --smoke | --replay-summary <summary.json> | <existing.dem> <player-name>");
    initSync({ module: readFileSync(".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm") });
    const parsed = parse_demo(readFileSync(path), 8, undefined);
    let replay: any;
    try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
    const parseMs = Math.round(performance.now() - began);
    process.stderr.write(JSON.stringify({ stage: "PARSED", parsePasses: 1, parseMs }) + "\n");
    assert.equal(replay.generatedBy, "cs2-demo-parser-wasm@0.0.0+cs-coach.hurt-events.v1.shot-identity.v2");
    const player = replay.players.find((p: any) => p.name === playerName);
    assert(player, "Existing selection missing");
    const original = buildCs2dAnalysisBundle({ replay, selectedSteamId: player.steamId, demoId: "real-cue-resource-validation" });
    const bundle = deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(original));
    const redact = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(player.steamId, "selected-player"));
    const rows = bundle.review_plan.cues.map((cue, index) => {
      try {
      const material = bundle.candidate_set.materials.find(m => m.candidateId === cue.candidate_id);
      const context = { plan: bundle.review_plan, cue, material, timeline: bundle.match_timeline, selectedPlayerId: player.steamId };
      const round = bundle.match_timeline.rounds.find(r => r.start_tick <= cue.decision_tick && cue.decision_tick < r.end_tick)!;
      const rawRound = replay.rounds.find((r: any) => r.number === round.round_number);
      const frame = rawRound.frames.filter((f: any) => f.tick <= cue.decision_tick && f.tick >= rawRound.freezeStartTick).sort((a: any, b: any) => b.tick - a.tick)[0];
      const raw = frame?.players.find((p: any) => p.steamId === player.steamId);
      const snapshot = material?.decisionSnapshot ?? cue.decisionSnapshot;
      const onEvidence = (value: unknown) => process.stderr.write(JSON.stringify(redact({ stage: "CUE_CONSUMED_BEFORE_RECOVERY", ordinal: index + 1, decisionTick: cue.decision_tick, evidence: value })) + "\n");
      const risk = consume(context, "OTHER", onEvidence);
      const trade = consume(context, "TRADE", onEvidence);
      const beforeRoundTripInput = buildTeachingDiagnosisInput({ ...context, timeline: original.match_timeline, plan: original.review_plan, cue: original.review_plan.cues[index], material: original.candidate_set.materials.find(m => m.candidateId === cue.candidate_id) }, { cueId: cue.id, selectedGoal: "OTHER", source: "USER", response: "ANSWERED", limitations: [] });
      assert.deepEqual(beforeRoundTripInput, risk.input);
      const resources = risk.input.decisionResources;
      if (resources) {
        assert(frame.tick <= cue.decision_tick && frame.tick >= round.start_tick && cue.decision_tick - frame.tick <= Math.ceil(bundle.match_timeline.tick_rate / 2));
        assert.equal(snapshot?.sampledAtTick, frame.tick);
        if (resources.health !== undefined) assert.equal(resources.health, raw.health);
        if (resources.armor !== undefined) assert.equal(resources.armor, raw.armor);
        if (resources.hasHelmet !== undefined) assert.equal(resources.hasHelmet, raw.helmet);
        if (raw.helmet === undefined || snapshot?.selectedPlayer.value?.helmet === null) assert.equal(resources.hasHelmet, undefined);
        if (resources.utilityCount !== undefined) assert.equal(resources.utilityCount, raw.grenades.length);
        for (const measurement of risk.result.measurements) assert(measurement.evidenceRefs.every(ref => resources.evidenceRefs.includes(ref)));
      }
      const fields = ["health", "armor", "hasHelmet", "money", "equipmentValue", "utilityCount"] as const;
      const unknown = fields.filter(field => resources?.[field] === undefined).map(field => ({ field, reason: !resources ? "WHOLE_SAMPLE_UNAVAILABLE" : field === "hasHelmet" && (raw.helmet === undefined || snapshot?.selectedPlayer.value?.helmet === null) ? "PARSER_FIELD_ABSENT_SNAPSHOT_UNKNOWN" : "FIELD_UNAVAILABLE_MISSING_OR_CONFLICT" }));
      return redact({ ordinal: index + 1, round: round.round_number, decisionTick: cue.decision_tick, sourceSampleTick: frame?.tick ?? null, ageTicks: frame ? cue.decision_tick - frame.tick : null, ageLimitTicks: Math.ceil(bundle.match_timeline.tick_rate / 2), sameRound: frame?.tick >= round.start_tick && frame?.tick < round.end_tick,
        source: { health: raw?.health ?? null, armor: raw?.armor ?? null, helmet: raw?.helmet ?? null, grenadeCount: Array.isArray(raw?.grenades) ? raw.grenades.length : null, money: raw?.money ?? null, equipmentValue: raw?.equipValue ?? null },
        snapshot: { sampledAtTick: snapshot?.sampledAtTick ?? null, health: snapshot?.selectedPlayer.value?.health ?? null, armor: snapshot?.selectedPlayer.value?.armor ?? null, helmet: snapshot?.selectedPlayer.value?.helmet ?? null },
        resources: resources ?? null, unknown, roster: risk.input.decisionRoster ?? null,
        risk: { probe: "SYNTHETIC_OTHER_INTENT", status: risk.result.status, measurements: risk.result.measurements, explanation: risk.result.explanation, verdict: risk.verdict },
        trade: { probe: "SYNTHETIC_TRADE_INTENT", status: trade.result.status, measurements: trade.result.measurements, explanation: trade.result.explanation, verdict: trade.verdict }, restoration: { risk: risk.restoration, trade: trade.restoration } });
      } catch (error) {
        return redact({ ordinal: index + 1, decisionTick: cue.decision_tick, failure: error instanceof Error ? error.message.slice(0, 1000) : "Cue consumption failed" });
      }
    });
    if (rows.some(row => row.failure || !row.restoration?.risk.sameValues || !row.restoration?.trade.sameValues)) process.exitCode = 1;
    console.log(JSON.stringify({ mode: "REAL_DEMO_SYNTHETIC_INTENT_PROBES", parsePasses: 1, parseMs, totalMs: Math.round(performance.now() - began), rounds: replay.rounds.length, candidates: bundle.candidate_set.candidates.length, formalCues: rows.length, bundleRoundTrip: true, fetchCalls, diagnosisCalls, rows }, null, 2));
  }
} finally { globalThis.fetch = originalFetch; }
