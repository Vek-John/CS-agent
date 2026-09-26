import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCs2dAnalysisBundle, type Cs2dReplay } from "../libs/cs2d-analysis-adapter/src/index";
import { fireReplay, self } from "../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { assertValidReviewPlan, buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "../libs/review-planner/src/index";
import { createCoachingSession, reduceCoachingSession } from "../libs/session/src/index";
import { createCoachAgentRuntime } from "../libs/coach-agent/src/runtime";
import type { NarrationBundle } from "../libs/contracts/src/index";
import type { SessionWrapUpResult } from "../libs/coach-agent/src/client";
import { buildInitialCoachingRouteState } from "../apps/web/lib/coaching/cs2d-route-integration";
import { CoachAgentStage3Controller } from "../apps/web/lib/coaching/coach-agent-stage3-controller";
import { CoachAgentStage3HostAdapter, type Stage3HostAdapterInput } from "../apps/web/lib/coaching/coach-agent-stage3-host-adapter";
import { baselineCueCase, reflectionForSkip, buildTeachingDiagnosisSubmissionEvent } from "../apps/web/lib/coaching/teaching-diagnosis-host";
import { skipReflectionToBaseline } from "../apps/web/lib/coaching/skip-reflection-flow";
import { buildStage3WrapUpInput } from "../apps/web/lib/coaching/coach-agent-stage3-wrap-up";
import { completeStage3SessionWrapUp } from "../apps/web/lib/coaching/session-wrap-up-completion";

// Caller imposes a 120s external deadline: a JS timer cannot interrupt synchronous WASM.
// Replay remains in this process. Output contains counts only, never identities or positions.
type Bundle = ReturnType<typeof buildCs2dAnalysisBundle>;
export async function consumeGuidedRoute(bundle: Bundle, hash: string, mode: "ALL_SKIP" | "MIXED") {
  const { review_plan: plan, candidate_set: set } = bundle;
  assertValidReviewPlan(bundle.match_timeline, plan);
  assert(plan.cues.length > 0, "NO_TEACHING_CUES");
  const narrationByCue: Record<string, NarrationBundle> = Object.fromEntries(plan.cues.map(cue => [cue.id,
    deterministicNarrationBundle(buildCoachingPackage(cue, set, bundle.observation_evidence), buildOutcomePackage(cue, set, bundle.outcome_impacts.find(item => item.cueId === cue.id))) ]));
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue });
  assert(routeState.routeFrozen && routeState.startable, "ROUTE_NOT_STARTABLE");
  const identity = { plan, routeState, analysis: bundle, demoContentHash: hash, selectedPlayerId: plan.player_id,
    sessionId: `validation-${mode}`, runId: `validation-${mode}` };
  let session = reduceCoachingSession(plan, createCoachingSession(plan, identity.sessionId, routeState), { type: "START" });
  let graphEvents = 0, toolPosts = 0, skips = 0, diagnoses = 0, storedCases = 0, summaryWrites = 0, ticks = 0;
  const runtime = createCoachAgentRuntime({ checkpoint: "memory", policy: { selectCapability: async () => { throw new Error("POLICY_NOT_EXPECTED"); } } });
  const adapter = new CoachAgentStage3HostAdapter();
  const controller = new CoachAgentStage3Controller({ adapter,
    dispatch: async event => { graphEvents++; const result = await runtime.dispatch(event); assert.equal(result.effects.length, 0, "NO_VISUAL_TOOL_EXPECTED"); return result; },
    post: () => { toolPosts++; }, bridgeAvailable: () => true,
    isLive: input => session.phase === "PAUSED_FOR_COACHING" && session.current_cue_id === input.cue.id,
  });
  const pendingSkips: Promise<unknown>[] = [];
  const started = performance.now();
  try {
    for (let step = 0; step < plan.segments.length * 8 + 30 && session.phase !== "WRAP_UP"; step++) {
      const index = session.current_segment_index, segment = plan.segments[index];
      assert(segment, "SESSION_SEGMENT_MISSING");
      if (session.phase === "PAUSED_FOR_COACHING") {
        const cue = plan.cues.find(item => item.id === session.current_cue_id);
        assert(cue && session.outcome_completion?.status === "COMPLETE", "OUTCOME_GATE_NOT_COMPLETE");
        assert.equal(session.outcome_completion.completedAtTick, cue.outcome_end_tick, "OUTCOME_ENDPOINT_MISMATCH");
        const input: Stage3HostAdapterInput = { ...identity, cue, narration: narrationByCue[cue.id], generation: 1,
          tickRate: bundle.match_timeline.tick_rate, currentSessionPhase: session.phase, outcomeGate: session.outcome_completion,
          evidence: { candidate: set.candidates.find(item => item.candidateId === cue.candidate_id), material: set.materials.find(item => item.candidateId === cue.candidate_id) } };
        if (mode === "ALL_SKIP" || (skips + diagnoses) % 2 === 0) {
          const reflection = reflectionForSkip(cue.id), baseline = baselineCueCase(cue, "Validation skip; no user intention inferred.");
          const skipped = { ...baseline, reflection, attemptBudget: { ...baseline.attemptBudget, reflection: 1 } };
          pendingSkips.push(skipReflectionToBaseline({ baseline: skipped,
            isCurrent: () => session.phase === "PAUSED_FOR_COACHING" && session.current_cue_id === cue.id,
            ownsHistory: () => true,
            publishLocal: cueCase => { assert(controller.recordPresentedBaseline(input, cueCase), "BASELINE_REGISTRATION_REJECTED"); session = reduceCoachingSession(plan, session, { type: "RECORD_TEACHING_CASE", cueCase, reflection }); },
            reconcile: () => { throw new Error("LATE_RECONCILIATION_NOT_EXPECTED"); },
            persistInteraction: async () => true,
            synchronize: async () => { throw new Error("FAST_SKIP_MUST_NOT_WAIT_FOR_GRAPH"); },
            persistCase: async () => { storedCases++; return true; },
          }));
          skips++;
        } else {
          const synced = await controller.synchronizeDiagnosis(input);
          assert(synced, "NEXT_DIAGNOSIS_NOT_SYNCHRONIZED");
          const reflection = { cueId: cue.id, response: "ANSWERED" as const, selectedGoal: "OTHER" as const, source: "USER" as const, limitations: [] };
          const event = buildTeachingDiagnosisSubmissionEvent({ plan, cue, material: input.evidence.material, timeline: bundle.match_timeline, selectedPlayerId: plan.player_id }, reflection,
            { eventType: "SUBMIT_REFLECTION", eventId: `validation-reflection-${diagnoses}`, identity: synced.identity });
          graphEvents++;
          const result = await runtime.dispatch(event), cueCase = result.state.cueCases[cue.id];
          assert(cueCase?.diagnosticResult, "DIAGNOSIS_NOT_PRODUCED");
          session = reduceCoachingSession(plan, session, { type: "RECORD_TEACHING_CASE", cueCase, reflection,
            learningThread: result.state.learningThreads.find(thread => thread.evidenceCueIds.includes(cue.id)) });
          session = reduceCoachingSession(plan, session, { type: "CONFIRM_TEACHING_CASE", cueId: cue.id });
          diagnoses++;
        }
        session = reduceCoachingSession(plan, session, { type: "CUE_PRESENTED", cueId: cue.id });
        session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
      } else {
        if (segment.cue_ids.length === 0) {
          const observationMode = segment.mode === "SKIP" ? segment.reason_code === "FREEZE_TIME" ? "FREEZE" : "SKIP" : segment.mode;
          assert(observationMode === "FREEZE" || observationMode === "SKIP" || observationMode === "BRIEF" || observationMode === "OBSERVE", "UNSUPPORTED_ORDINARY_MODE");
          controller.observeSegment(identity, segment.id, index, observationMode, session.phase === "SKIPPING" ? "SKIPPING" : "PLAYING");
        }
        session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" } : { type: "TICK", tick: segment.end_tick });
        ticks++;
      }
    }
    await Promise.all(pendingSkips);
    assert.equal(session.phase, "WRAP_UP", "ROUTE_DID_NOT_FINISH");
    assert.equal(session.presented_cue_ids.length, plan.cues.length, "PRESENTED_CUE_COUNT");
    assert.equal(session.consumed_cue_ids.length, plan.cues.length, "CONSUMED_CUE_COUNT");
    assert.equal(session.user_events.filter(event => event.type === "REFLECTION_SKIPPED").length, skips, "SKIP_EVENT_COUNT");
    const wrap: { value?: SessionWrapUpResult; graphCompleted?: number } = {};
    let claimed = false;
    const finish = () => completeStage3SessionWrapUp({ controller, identity, isCurrent: () => true,
      claim: () => { if (claimed) return false; claimed = true; return true; }, onStart: () => {},
      buildInput: result => { assert(result.state.sessionSummaryInput, "GRAPH_SUMMARY_MISSING"); wrap.graphCompleted = result.state.completedCueIds.length;
        return buildStage3WrapUpInput(plan, result.state.sessionSummaryInput, narrationByCue, set, Object.values(session.cue_cases ?? {})); },
      persistence: { artifact: async type => { assert.equal(type, "SESSION_SUMMARY"); summaryWrites++; } },
      onRequest: () => {}, onResult: result => { wrap.value = result; }, onSaveError: () => { throw new Error("SUMMARY_SAVE_FAILED"); },
    });
    await finish(); await finish();
    assert(wrap.value, "WRAP_UP_RESULT_MISSING");
    assert(!["MISSING_SESSION_SUMMARY", "INVALID_PRESENTABLE_INPUT"].includes(wrap.value.manifest.reason ?? ""), "WRAP_UP_FAILED");
    assert.equal(wrap.graphCompleted, plan.cues.length, "GRAPH_COMPLETED_CUE_COUNT");
    assert.equal(summaryWrites, 1, "SUMMARY_MUST_BE_WRITTEN_ONCE");
    session = reduceCoachingSession(plan, session, { type: "COMPLETE_SESSION" });
    assert.equal(session.phase, "COMPLETED"); assert.equal(toolPosts, 0); assert.equal(adapter.lifecycleDegraded, false);
    return { mode, rounds: bundle.match_timeline.rounds.length, segments: plan.segments.length, candidates: set.candidates.length, cues: plan.cues.length,
      skips, diagnoses, storedCases, graphEvents, graphCompletedCues: wrap.graphCompleted, summaryWrites, summaryStatus: wrap.value.status,
      summaryReason: wrap.value.manifest.reason, themes: wrap.value.bundle.themes.length, sessionStatus: session.phase,
      syntheticPlaybackNotifications: ticks, toolPosts, elapsedMs: Math.round(performance.now() - started) };
  } finally { controller.dispose(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const began = performance.now(); let stage = "LOAD", networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); };
  try {
    const [path, playerName] = process.argv.slice(2);
    let replay: Cs2dReplay, hash: string, selected: string, demoBytes = 0, parseMs = 0;
    if (path === "--smoke") {
      replay = fireReplay("DEATH"); hash = "a".repeat(64); selected = self;
    } else {
      assert(path && playerName, "Usage: --smoke | <existing.dem> <selected-player-name>");
      const parser = await import("../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js");
      parser.initSync({ module: readFileSync(".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm") });
      let bytes: Buffer | undefined = readFileSync(path); demoBytes = bytes.length;
      // The ordinary Host identity is computed from the same read; no separate integrity pass.
      hash = createHash("sha256").update(bytes).digest("hex"); stage = "PARSE";
      const start = performance.now(), parsed = parser.parse_demo(bytes, 8, undefined); bytes = undefined;
      try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
      parseMs = Math.round(performance.now() - start);
      const player = replay.players.find(item => item.name === playerName); assert(player, "PLAYER_NOT_FOUND"); selected = player.steamId;
    }
    stage = "ADAPTER";
    const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: selected, demoId: "guided-lifecycle-validation", demoContentHash: hash });
    stage = "CONSUME";
    const results = [];
    for (const mode of ["ALL_SKIP", "MIXED"] as const) results.push(await consumeGuidedRoute(bundle, hash, mode));
    assert.equal(networkCalls, 0);
    console.log(JSON.stringify({ status: "PASSED", source: path === "--smoke" ? "SYNTHETIC" : "REAL_DEMO", demoBytes,
      demoReads: demoBytes ? 1 : 0, parsePasses: demoBytes ? 1 : 0, parseMs, parserRevision: replay.generatedBy,
      winProbability: "NOT_RUN", networkCalls, totalMs: Math.round(performance.now() - began), results,
      limitation: "Session tick notifications are harness-driven, not Viewer/UI playback. Persistence is a counting seam, not SQLite. No CS-Net inference or model quality evaluation." }));
  } catch (error) {
    const reason = error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "VALIDATION_FAILED";
    console.error(JSON.stringify({ status: "FAILED", stage, reason, networkCalls }));
    process.exitCode = 1;
  }
}
