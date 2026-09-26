import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCs2dAnalysisBundle, type Cs2dReplay } from "../libs/cs2d-analysis-adapter/src/index";
import { fireReplay, self } from "../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { assertValidReviewPlan, buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "../libs/review-planner/src/index";
import { createCoachingSession, reduceCoachingSession } from "../libs/session/src/index";
import { createCoachAgentRuntime } from "../libs/coach-agent/src/runtime";
import type { CoachAgentResult } from "../libs/coach-agent/src/types";
import type { TeachingToolAckEvent } from "../libs/contracts/src/index";
import { buildInitialCoachingRouteState } from "../apps/web/lib/coaching/cs2d-route-integration";
import { CoachAgentStage3HostAdapter, type Stage3HostAdapterInput } from "../apps/web/lib/coaching/coach-agent-stage3-host-adapter";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (!args.includes("--child")) {
  // Parent owns the hard deadline; a child JS timer cannot interrupt sync WASM.
  assert(args.length === 1 && args[0] === "--smoke" || args.length === 2, "Usage: --smoke | <existing.dem> <player-name>");
  const child = spawn(process.execPath, ["--max-old-space-size=3072", "--import", "tsx", fileURLToPath(import.meta.url), "--child", ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", outputBytes = 0, diagnosticBytes = 0, failure: string | undefined;
  const stop = (reason: string) => { failure ??= reason; child.kill("SIGKILL"); };
  const interrupted = () => stop("INTERRUPTED");
  const timer = setTimeout(() => stop("DEADLINE_120_SECONDS"), 120_000);
  process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes + diagnosticBytes > 64 * 1024) { stop("OUTPUT_LIMIT"); return; }
    output += chunk.toString("utf8");
  });
  // Raw loader/parser exceptions are never forwarded across the owner boundary.
  child.stderr.on("data", (chunk: Buffer) => { diagnosticBytes += chunk.length; if (outputBytes + diagnosticBytes > 64 * 1024) stop("OUTPUT_LIMIT"); });
  child.once("error", () => { failure = "CHILD_START_FAILED"; });
  child.once("close", code => {
    clearTimeout(timer); process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
    try {
      if (failure) throw new Error(failure);
      const summary = JSON.parse(output);
      if (code !== 0 || summary.status !== "PASSED") {
        process.stdout.write(JSON.stringify({ status: "FAILED", stage: summary.stage ?? "CHILD", reason: summary.reason ?? "CHILD_FAILED" }) + "\n");
        process.exitCode = 1; return;
      }
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    } catch {
      process.stdout.write(JSON.stringify({ status: "FAILED", reason: failure ?? "INVALID_CHILD_SUMMARY" }) + "\n");
      process.exitCode = 1;
    }
  });
} else {
  let stage = "LOAD", networkCalls = 0;
  const started = performance.now();
  globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); };
  try {
    const [, path, playerName] = args;
    const synthetic = path === "--smoke";
    let replay: Cs2dReplay, selected: string, hash: string, demoBytes = 0, parseMs = 0;
    if (synthetic) { replay = fireReplay("DEATH"); selected = self; hash = "a".repeat(64); }
    else {
      assert(path && playerName, "INPUT_REQUIRED");
      const metadata = statSync(path); assert(metadata.isFile() && metadata.size > 0 && metadata.size <= 128 * 1024 * 1024, "INPUT_SIZE_LIMIT");
      const parser = await import(/* @vite-ignore */ new URL("../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js", import.meta.url).href);
      parser.initSync({ module: readFileSync(resolve(root, ".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm")) });
      let bytes: Buffer | undefined = readFileSync(path); demoBytes = bytes.byteLength;
      assert(demoBytes <= 128 * 1024 * 1024, "INPUT_SIZE_LIMIT");
      hash = createHash("sha256").update(bytes).digest("hex");
      stage = "PARSE";
      const before = performance.now(), parsed = parser.parse_demo(bytes, 8, undefined); bytes = undefined;
      try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
      parseMs = Math.round(performance.now() - before);
      const player = replay.players.find(item => item.name === playerName); assert(player, "PLAYER_NOT_FOUND"); selected = player.steamId;
    }
    stage = "ADAPTER";
    const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: selected, demoId: "anonymous-tool-probe", demoContentHash: hash });
    const plan = bundle.review_plan, set = bundle.candidate_set;
    assertValidReviewPlan(bundle.match_timeline, plan);
    assert(plan.cues.length > 0 && plan.cues.length <= 128, "CUE_COUNT_LIMIT");
    assert.equal(bundle.win_probability_timeline.status, "UNAVAILABLE", "UNEXPECTED_WINRATE");
    const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, deterministicNarrationBundle(
      buildCoachingPackage(cue, set, bundle.observation_evidence), buildOutcomePackage(cue, set, bundle.outcome_impacts.find(item => item.cueId === cue.id)),
    )]));
    const routeState = buildInitialCoachingRouteState(plan, { narrationByCue });
    assert(routeState.startable && routeState.routeFrozen, "ROUTE_NOT_STARTABLE");
    const identity = { plan, routeState, analysis: bundle, demoContentHash: hash, selectedPlayerId: selected, sessionId: "anonymous-session", runId: "anonymous-run" };
    let session = reduceCoachingSession(plan, createCoachingSession(plan, identity.sessionId, routeState), { type: "START" });
    const runtime = createCoachAgentRuntime({ checkpoint: "memory" }); // No policy injection; actual default adapter.
    const adapter = new CoachAgentStage3HostAdapter();
    let latest: CoachAgentResult | undefined, graphCursor = -1, mockAcks = 0;
    const rows = [];
    stage = "DEFAULT_ROUTE";
    for (let step = 0; step < plan.segments.length * 8 + 30 && session.phase !== "WRAP_UP"; step++) {
      const segment = plan.segments[session.current_segment_index]; assert(segment, "SEGMENT_MISSING");
      if (session.phase !== "PAUSED_FOR_COACHING") {
        session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" } : { type: "TICK", tick: segment.end_tick });
        continue;
      }
      const cue = plan.cues.find(item => item.id === session.current_cue_id); assert(cue, "CUE_MISSING");
      assert(session.outcome_completion?.status === "COMPLETE" && session.outcome_completion.completedAtTick === cue.outcome_end_tick, "OUTCOME_NOT_COMPLETE");
      for (let index = graphCursor + 1; index < session.current_segment_index; index++) {
        const preceding = plan.segments[index];
        const mode = preceding.mode === "SKIP" ? preceding.reason_code === "FREEZE_TIME" ? "FREEZE" : "SKIP" : preceding.mode;
        assert(mode === "FREEZE" || mode === "SKIP" || mode === "BRIEF" || mode === "OBSERVE", "UNPROCESSED_TEACHING_SEGMENT");
        latest = await runtime.dispatch(adapter.createObserveSegmentEvent(identity, preceding.id, index, mode, "PLAYING", `observe-${index}`));
        graphCursor = latest.state.routeCursor;
        assert.equal(graphCursor, index, "OBSERVE_NOT_ACCEPTED");
      }
      const candidate = set.candidates.find(item => item.candidateId === cue.candidate_id);
      const material = set.materials.find(item => item.candidateId === cue.candidate_id);
      const input: Stage3HostAdapterInput = { ...identity, cue, narration: narrationByCue[cue.id], generation: 1, tickRate: bundle.match_timeline.tick_rate,
        currentSessionPhase: session.phase, outcomeGate: session.outcome_completion,
        evidence: { candidate, material, winProbabilityTimeline: bundle.win_probability_timeline, outcomeImpact: bundle.outcome_impacts.find(item => item.cueId === cue.id) } };
      const prepared = adapter.prepareStart(input);
      latest = await runtime.dispatch(prepared.event);
      assert(latest.state.activeCueId === cue.id && latest.state.activeSegmentId === segment.id && latest.state.routeCursor === session.current_segment_index, "START_SCOPE_NOT_ACCEPTED");
      const selectedMove = latest.state.selectedTeachingMove;
      rows.push({ ordinal: rows.length + 1, focus: cue.primary_focus_code ?? null, assessment: cue.assessment?.kind ?? null,
        actionRefs: cue.action_fact_refs?.length ?? 0, evidenceRefs: cue.evidence?.length ?? 0, decisionRefs: cue.observable_fact_refs.length,
        legalCapabilities: prepared.capabilities.map(capability => ({ tool: capability.tool, purpose: capability.presentationPurpose ?? null, evidenceRefCount: capability.evidenceRefs.length })),
        source: selectedMove?.source ?? "FINISH", selectedTool: selectedMove?.tool ?? null, purpose: selectedMove?.presentationPurpose ?? null,
        rationaleCode: null, rationaleAvailability: "NOT_RETAINED_OR_NOT_CALLED",
        policyCalls: latest.state.policyBudget.policyCalls, runStatus: latest.state.runStatus,
      });
      const context = { generation: input.generation, currentSessionPhase: input.currentSessionPhase, outcomeGate: input.outcomeGate };
      assert(latest.effects.length <= 1, "UNEXPECTED_MULTIPLE_TOOLS");
      for (const request of latest.effects) {
        const command = adapter.createTeachingToolCommand(request, context); assert(command?.type === "teachingTool", "TOOL_NOT_BOUND");
        // Explicitly simulated Viewer ACK; this probe does not claim playback/rendering.
        const ack: TeachingToolAckEvent = { type: "TEACHING_TOOL_ACK", schemaVersion: "cs2d-teaching-tool-ack.v1", tool: request.tool,
          callId: request.callId, runId: request.runId, cueId: request.cueId, generation: command.generation,
          status: "SUCCEEDED", observationCode: request.tool === "REPLAY_CUE_SLOW" ? "CUE_PLAYED" : "EVIDENCE_SHOWN", completed: true, limitations: [],
          ...(command.args.tool === "FOCUS_MAP_EVIDENCE" ? { annotationRef: command.args.annotationRef } : {}) };
        const result = adapter.acceptTeachingToolAck(request, ack, context); assert(result, "MOCK_ACK_REJECTED");
        const resume = adapter.createResumeEvent(request, result, context, `mock-resume-${rows.length}`); assert(resume, "RESUME_MISSING");
        latest = await runtime.dispatch(resume); mockAcks++;
      }
      assert.equal(latest.state.runStatus, "CUE_COMPLETED", "CUE_DID_NOT_COMPLETE");
      graphCursor = latest.state.routeCursor;
      session = reduceCoachingSession(plan, session, { type: "CUE_PRESENTED", cueId: cue.id });
      session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
    }
    assert.equal(session.phase, "WRAP_UP", "ROUTE_DID_NOT_FINISH"); assert.equal(rows.length, plan.cues.length, "MISSING_CUE_RESULT"); assert.equal(networkCalls, 0, "NETWORK_CALLED");
    console.log(JSON.stringify({ status: "PASSED", source: synthetic ? "SYNTHETIC" : "REAL_DEMO", demoBytes, demoReads: synthetic ? 0 : 1, parsePasses: synthetic ? 0 : 1, parseMs,
      rounds: replay.rounds.length, candidates: set.candidates.length, cues: plan.cues.length, winrateStatus: bundle.win_probability_timeline.status, networkCalls,
      defaultAdapter: "DETERMINISTIC", ruleSelections: rows.filter(row => row.source === "RULE").length,
      policyCalls: rows.reduce((sum, row) => sum + row.policyCalls, 0), finishCues: rows.filter(row => row.source === "FINISH").length,
      mockViewerAcks: mockAcks, rows, totalMs: Math.round(performance.now() - started),
      limitation: "Real Demo parsing and actual Adapter/default Runtime. Session ticks and successful Viewer ACKs are harness-driven, not rendering. Runtime source MODEL denotes the policy-adapter branch, not proof of a model request. No rationale retained by Runtime; no professional judgment quality evaluation." }));
  } catch (error) {
    const reason = error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "PROBE_FAILED";
    console.log(JSON.stringify({ status: "FAILED", stage, reason, networkCalls })); process.exitCode = 1;
  }
}
