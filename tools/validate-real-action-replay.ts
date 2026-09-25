import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { initSync, parse_demo } from "../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js";
import { buildCs2dAnalysisBundle, type Cs2dReplay } from "../libs/cs2d-analysis-adapter/src/index";
import { createSyntheticMirageTimeline } from "../libs/demo-domain/src/index";
import { assembleCandidateSet, compileReviewPlan, deterministicDirectorFallback, buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "../libs/review-planner/src/index";
import { decisionSnapshotFixture } from "../libs/review-planner/src/teaching-gate-fixtures";
import { createCoachingSession, reduceCoachingSession } from "../libs/session/src/index";
import { createCoachAgentRuntime } from "../libs/coach-agent/src/runtime";
import { buildInitialCoachingRouteState } from "../apps/web/lib/coaching/cs2d-route-integration";
import { CoachAgentStage3HostAdapter, type Stage3HostAdapterInput } from "../apps/web/lib/coaching/coach-agent-stage3-host-adapter";
import type { CandidateSet, CandidateMaterial, TeachingCandidate, ReviewPlan, ObservableState, NarrationBundle } from "../libs/contracts/src/index";

// Bulk stays in one process. Caller MUST impose a 120-second process deadline:
// a JS timer cannot interrupt synchronous WASM. This tool never calls a model.
const began = performance.now();
let demoReads = 0, parsePasses = 0, fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls++; throw Error("NETWORK_FORBIDDEN"); };
let redact = (value: unknown): unknown => value;
const stage = (value: unknown) => process.stderr.write(JSON.stringify(redact(value)) + "\n");

type RouteInput = { plan: ReviewPlan; set: CandidateSet; observations: readonly ObservableState[]; tickRate: number; hash: string; player: number };

// Diagnostic mirror only: production Host and Policy make all authorization decisions.
function actionAudit(input: Stage3HostAdapterInput) {
  const candidate = input.evidence.candidate!;
  const material = input.evidence.material!;
  return {
    candidateActionCount: candidate.actionRefs.length,
    cueActionRefs: input.cue.action_fact_refs ?? [],
    narrationActionRefs: input.narration.playerAction.refs,
    actions: material.playerActionFacts.map(fact => ({
      id: fact.id, at: fact.availableAtTick,
      demoSource: fact.source === "DEMO", selectedActor: fact.actorPlayerId === input.selectedPlayerId,
      inWindow: fact.availableAtTick >= input.cue.decision_tick && fact.availableAtTick <= input.cue.outcome_end_tick,
      candidateBound: candidate.actionRefs.includes(fact.id),
      cueBound: Boolean(input.cue.action_fact_refs?.includes(fact.id)),
      factBound: Boolean(input.cue.action_facts?.some(bound => bound.id === fact.id && bound.actorPlayerId === fact.actorPlayerId && bound.availableAtTick === fact.availableAtTick)),
      narrated: input.narration.playerAction.refs.includes(fact.id),
    })),
  };
}

async function consumeRoute(source: RouteInput) {
  const { plan, set } = source;
  const narrations: Record<string, NarrationBundle> = {};
  const preparationErrors: Record<string, string> = {};
  for (const cue of plan.cues) {
    try {
      narrations[cue.id] = deterministicNarrationBundle(buildCoachingPackage(cue, set, source.observations), buildOutcomePackage(cue, set));
    } catch (error) { preparationErrors[cue.id] = String(error).slice(0, 400); }
  }
  const routeState = buildInitialCoachingRouteState(plan, {
    readiness: Object.fromEntries(plan.cues.map(cue => [cue.id, narrations[cue.id] ? "FALLBACK" : "PENDING"])), narrationByCue: narrations,
  });
  stage({ stage: "PREPARED", player: source.player, candidates: set.candidates.length, cues: plan.cues.length, narrationFailures: Object.keys(preparationErrors).length });
  const adapter = new CoachAgentStage3HostAdapter();
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  const identityInput = { plan, routeState, analysis: { demo_id: plan.demo_id, selected_steam_id: plan.player_id }, demoContentHash: source.hash, selectedPlayerId: plan.player_id, sessionId: `validation-session-${source.player}`, runId: `validation-run-${source.player}` };
  let session = reduceCoachingSession(plan, createCoachingSession(plan, identityInput.sessionId, routeState), { type: "START" });
  const rows: Record<string, unknown>[] = [];
  let graphCursor = -1;
  let ticks = 0, ordinarySkips = 0;
  try {
    for (let steps = 0; steps < plan.segments.length * 8 + 30; steps++) {
      if (session.phase === "WRAP_UP") session = reduceCoachingSession(plan, session, { type: "COMPLETE_SESSION" });
      if (session.phase === "COMPLETED") break;
      const index = session.current_segment_index;
      const segment = plan.segments[index];
      assert(segment, "SESSION_SEGMENT_MISSING");
      if (session.phase === "SKIPPING") {
        if (segment.reason_code !== "FREEZE_TIME") ordinarySkips++;
        session = reduceCoachingSession(plan, session, { type: "SKIP_SEGMENT" });
        continue;
      }
      if (session.phase === "PAUSED_FOR_COACHING") {
        const cue = plan.cues.find(c => c.id === session.current_cue_id)!;
        const row: Record<string, unknown> = { cue: cue.id, round: segment.round_number, window: { decision: cue.decision_tick, reveal: cue.reveal_tick, end: cue.outcome_end_tick }, focus: cue.primary_focus_code, assessment: cue.assessment?.kind, gate: session.outcome_completion };
        rows.push(row);
        try {
          assert(narrations[cue.id], preparationErrors[cue.id] ?? "NARRATION_MISSING");
          assert(session.outcome_completion?.status === "COMPLETE", "SESSION_GATE_INCOMPLETE");
          assert.equal(session.outcome_completion.completedAtTick, cue.outcome_end_tick);
          const input: Stage3HostAdapterInput = {
            ...identityInput, cue, narration: narrations[cue.id], generation: 1, tickRate: source.tickRate,
            currentSessionPhase: session.phase, outcomeGate: session.outcome_completion,
            evidence: { candidate: set.candidates.find(c => c.candidateId === cue.candidate_id), material: set.materials.find(m => m.candidateId === cue.candidate_id) },
          };
          row.actionAudit = actionAudit(input);
          // Mirror the production Controller's preceding-segment queue. Session
          // automatically consumes freeze segments; Graph still observes each one.
          for (let prior = graphCursor + 1; prior < index; prior++) {
            const previous = plan.segments[prior];
            assert(previous.cue_ids.length === 0, "PRIOR_CUE_NOT_CONSUMED");
            assert(previous.mode === "SKIP" || previous.mode === "BRIEF" || previous.mode === "OBSERVE");
            const mode = previous.reason_code === "FREEZE_TIME" ? "FREEZE" : previous.mode;
            await runtime.dispatch(adapter.createObserveSegmentEvent(identityInput, previous.id, prior, mode, "SKIPPING", `observe-${prior}`));
            graphCursor = prior;
          }
          const prepared = adapter.prepareStart(input);
          row.capabilities = prepared.capabilities.map(c => ({ tool: c.tool, purpose: c.presentationPurpose, refs: c.evidenceRefs }));
          stage({ stage: "HOST_QUALIFIED", player: source.player, ...row });
          const result = await runtime.dispatch(prepared.event);
          graphCursor = index;
          row.graphStatus = result.status;
          row.effectCount = result.effects.length;
          row.fallbackReasons = result.state.fallbackReasons;
          assert.equal(result.effects.length, prepared.capabilities.length ? 1 : 0);
          if (result.effects.length) {
            const request = result.effects[0];
            assert.equal(request.tool, "REPLAY_CUE_SLOW");
            assert.equal(result.state.selectedTeachingMove?.presentationPurpose, "ACTION_FACT_REPLAY");
            const context = { generation: 1, currentSessionPhase: session.phase, outcomeGate: session.outcome_completion };
            const command = adapter.createTeachingToolCommand(request, context);
            assert(command?.type === "teachingTool" && command.args.tool === "REPLAY_CUE_SLOW", "HOST_COMMAND_MISSING");
            assert.equal(command.args.outcomeEndCanonicalTick, cue.outcome_end_tick);
            assert.equal(command.args.decisionCanonicalTick, cue.decision_tick);
            assert.equal(command.args.startCanonicalTick, Math.max(segment.start_tick, cue.decision_tick - Math.round(source.tickRate)));
            assert.equal(command.args.speed, 0.5);
            assert.equal(adapter.createTeachingToolCommand(request, context), undefined);
            row.command = { ...command.args, callIdFromGraph: command.callId === request.callId, duplicateSuppressed: true };
            // A synthetic ACK closes the in-memory lifecycle so the next natural cue
            // can be tested. It is not evidence of Viewer playback or pause success.
            const accepted = adapter.acceptTeachingToolAck(request, {
              type: "TEACHING_TOOL_ACK", schemaVersion: "cs2d-teaching-tool-ack.v1", runId: command.runId, cueId: command.cueId, callId: command.callId, generation: command.generation, tool: command.tool,
              status: "SUCCEEDED", observationCode: "CUE_PLAYED", completed: true, limitations: ["SIMULATED_TRANSPORT_NO_VIEWER"],
            }, context);
            assert(accepted);
            const resume = adapter.createResumeEvent(request, accepted, context, `simulated-ack-${index}`);
            assert(resume);
            const resumed = await runtime.dispatch(resume);
            assert.equal(resumed.state.runStatus, "CUE_COMPLETED");
            assert.equal(resumed.effects.length, 0);
            row.simulatedAckClosed = true;
          } else {
            assert.equal(result.state.runStatus, "CUE_COMPLETED");
            const audit = row.actionAudit as ReturnType<typeof actionAudit>;
            row.rejection = audit.actions.length === 0 ? "NO_PLAYER_ACTION_FACTS" : "ACTION_SOURCE_WINDOW_BINDING_OR_NARRATION_GATE";
          }
        } catch (error) { row.failure = String(error).slice(0, 500); }
        stage({ stage: "CUE_CONSUMED", player: source.player, ...row });
        session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
        continue;
      }
      const cue = plan.cues.find(c => c.id === session.current_cue_id);
      let tick = segment.end_tick;
      if (cue) {
        if (session.current_tick < cue.decision_tick) tick = cue.decision_tick;
        else if (session.current_tick < cue.outcome_end_tick - 1) tick = cue.outcome_end_tick - 1;
        else tick = cue.outcome_end_tick;
      }
      session = reduceCoachingSession(plan, session, { type: "TICK", tick });
      ticks++;
      if (cue && tick === cue.outcome_end_tick - 1) assert.equal(session.outcome_completion?.status, "LOCKED");
    }
    assert.equal(session.phase, "COMPLETED", "SESSION_DID_NOT_FINISH");
    assert.equal(rows.length, plan.cues.length, "MISSED_CUES");
    return { player: source.player, candidates: set.candidates.length, cues: rows.length, ticks, ordinarySkips, sessionCompleted: true, rows };
  } finally { adapter.reset(); }
}

function smokeInput(): RouteInput {
  const timeline = createSyntheticMirageTimeline();
  const candidates: TeachingCandidate[] = [], materials: CandidateMaterial[] = [];
  for (const [i, decision] of [900, 4100].entries()) {
    const id = `smoke-${i}`, fact = `fact-${i}`, action = `action-${i}`, outcome = `outcome-${i}`;
    candidates.push({ candidateId: id, roundNumber: i * 2 + 1, source: { kind: "DEATH", refs: [outcome] }, preRollStart: decision - 64, decisionTick: decision, revealTick: decision + 20, outcomeEnd: decision + 120, factRefs: [fact], observableClaimRefs: [], actionRefs: i === 0 ? [action] : [], outcomeRefs: [outcome], evidenceRefs: [], winRateSignalRefs: [], economySignalRefs: [], missingFields: [], limitations: [], deterministicScore: 5, resultSummary: { selectedPlayerDeath: true, economyClass: "FULL", concurrentEvents: false, missingFields: [], limitations: [] } });
    materials.push({ candidateId: id, decisionFacts: [{ id: fact, text: "本人存活。", availability: "DECISION", available_at_tick: decision, source: "DEMO", observed_by_player: true }], playerActionFacts: i === 0 ? [{ id: action, text: "本人开枪。", actorPlayerId: timeline.selected_player_id, availableAtTick: decision + 10, source: "DEMO", evidenceRefs: [fact], limitations: [] }] : [], outcomeFacts: [{ id: outcome, text: "本人阵亡。", availableAtTick: decision + 20, source: "DEMO", outcomeKind: "DEATH", evidenceRefs: [outcome], limitations: [] }], inferences: [], advice: [], evidence: [], decisionSnapshot: { ...decisionSnapshotFixture(decision, fact), roundNumber: i * 2 + 1, selectedPlayerId: timeline.selected_player_id, aliveCounts: { ...decisionSnapshotFixture(decision, fact).aliveCounts, value: { allies: i + 1, enemies: 3, includesSelectedPlayer: true } } }, limitations: [] });
  }
  const set = assembleCandidateSet({ id: "smoke-set", version: "v1", demoId: timeline.demo_id, playerId: timeline.selected_player_id, candidates, materials, generationManifest: { timelineVersion: "t1", sceneIndexVersion: "s1", observationVersion: "o1", signalVersion: "s1", candidateGeneratorVersion: "g1" } });
  const { plan } = compileReviewPlan({ timeline, candidateSet: set, directorDecisionSet: deterministicDirectorFallback(set), planId: "smoke-plan", observationVersion: "o1", signalVersion: "s1" });
  assert.equal(plan.cues.length, 2);
  // Synthetic smoke explicitly covers an ordinary skip; real plans are untouched.
  const ordinary = plan.segments.find(segment => !segment.cue_ids.length && segment.reason_code !== "FREEZE_TIME");
  assert(ordinary);
  ordinary.mode = "SKIP";
  return { plan, set, observations: [], tickRate: timeline.tick_rate, hash: "a".repeat(64), player: 1 };
}

try {
  const [path, preferredName] = process.argv.slice(2);
  if (path === "--smoke") {
    const result = await consumeRoute(smokeInput());
    assert(result.ordinarySkips > 0);
    assert(result.rows.every(row => !row.failure));
    assert.equal(result.rows.filter(row => row.effectCount === 1).length, 1);
    assert.equal(result.rows.filter(row => row.effectCount === 0).length, 1);
    console.log(JSON.stringify({ mode: "SYNTHETIC_SMOKE", demoReads, parsePasses, fetchCalls, result }, null, 2));
  } else {
    assert(path && preferredName, "Usage: --smoke | <existing.dem> <preferred-player-name>");
    initSync({ module: readFileSync(".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm") });
    // Compute the normal Host identity from the same single read, not a separate audit.
    let bytes: Buffer | undefined = readFileSync(path); demoReads++;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const parsed = parse_demo(bytes, 8, undefined); parsePasses++; bytes = undefined;
    let replay: Cs2dReplay;
    try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
    const parseMs = Math.round(performance.now() - began);
    const preferred = replay.players.find(p => p.name === preferredName);
    assert(preferred, "PREFERRED_PLAYER_MISSING");
    const players = [preferred, ...replay.players.filter(p => p.steamId !== preferred.steamId)].slice(0, 10);
    redact = value => {
      let text = JSON.stringify(value);
      for (const [i, player] of players.entries()) text = text.replaceAll(player.steamId, `player-${i + 1}`);
      return JSON.parse(text);
    };
    stage({ stage: "PARSED", demoReads, parsePasses, parseMs, players: players.length, rounds: replay.rounds.length });
    const results = [];
    for (const [i, player] of players.entries()) {
      try {
        const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: player.steamId, demoId: "real-action-validation", demoContentHash: hash });
        stage({ stage: "DERIVED", player: i + 1, candidates: bundle.candidate_set.candidates.length, cues: bundle.review_plan.cues.length });
        const result = await consumeRoute({ plan: bundle.review_plan, set: bundle.candidate_set, observations: bundle.observation_evidence, tickRate: bundle.match_timeline.tick_rate, hash, player: i + 1 });
        results.push(result);
        // The preferred player's full route is always consumed. Only derive other
        // players if no legal case has been found; never retain their bundles.
        if (result.rows.some(row => row.effectCount === 1 && !row.failure)) break;
      } catch (error) { results.push({ player: i + 1, failure: String(error).slice(0, 500) }); stage(results.at(-1)); }
    }
    assert.equal(fetchCalls, 0);
    console.log(JSON.stringify(redact({ mode: "REAL_DEMO_RULE_ROUTE_SIMULATED_TRANSPORT", demoReads, parsePasses, parseMs, totalMs: Math.round(performance.now() - began), fetchCalls, route: "Adapter deterministic Director fallback; no CS-Net or model; not the earlier UI route", results }), null, 2));
    if (results.some(result => "failure" in result || result.rows.some(row => row.failure))) process.exitCode = 1;
  }
} finally { globalThis.fetch = originalFetch; }
