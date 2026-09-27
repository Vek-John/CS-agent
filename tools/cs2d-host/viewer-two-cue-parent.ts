import { buildCs2dAnalysisBundle } from "../../libs/cs2d-analysis-adapter/src/index";
import { assertValidReviewPlan, buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "../../libs/review-planner/src/index";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "../../libs/session/src/index";
import { AgentToolRequestSchema, type AgentToolRequest } from "../../libs/coach-agent/src/remote-dispatch-client";
import { PLAYBACK_BRIDGE_CHANNEL, isPlaybackCommandEnvelope, isPlaybackEventEnvelope } from "../../libs/contracts/src/playback-bridge";
import type { PlaybackCommand } from "../../libs/contracts/src/index";
import { buildInitialCoachingRouteState } from "../../apps/web/lib/coaching/cs2d-route-integration";
import { CoachAgentStage3HostAdapter, type Stage3ToolContext } from "../../apps/web/lib/coaching/coach-agent-stage3-host-adapter";
import { guidedPlaybackDirective, guidedTransitionKey, createGuidedSeekGate, isGuidedSeekLanding, type GuidedSeekGate } from "../../apps/web/lib/coaching/cs2d-guided-session";
import { HostPlaybackControl, hostCoachingCueSurface, cuePresentedActionForTerminal } from "../../apps/web/lib/playback/cs2d-playback-host";
import { twoCueViewerReplay, twoCueViewerPlayer } from "./viewer-two-cue-fixture";

const frame = document.querySelector<HTMLIFrameElement>("#viewer")!, start = document.querySelector<HTMLButtonElement>("#start")!, next = document.querySelector<HTMLButtonElement>("#continue")!;
const status = document.querySelector("#status")!, summary = document.querySelector("#summary")!, teaching = document.querySelector("#teaching")!;
const analysis = buildCs2dAnalysisBundle({ replay: twoCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: "synthetic-two-cue-viewer" });
const plan = analysis.review_plan; assertValidReviewPlan(analysis.match_timeline, plan);
if (plan.cues.length !== 2) throw Error("TWO_NATURAL_CUES_REQUIRED");
const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set))]));
const routeState = buildInitialCoachingRouteState(plan, { narrationByCue });
let session = createCoachingSession(plan, "synthetic-viewer-handoff", routeState);
const adapter = new CoachAgentStage3HostAdapter(), transport = new HostPlaybackControl();
let seek: GuidedSeekGate | undefined, seekEpoch = 0, pending: { request: AgentToolRequest; context: Stage3ToolContext } | undefined;
let totalTimer: ReturnType<typeof setTimeout> | undefined, stageTimer: ReturnType<typeof setTimeout> | undefined, stageKey = "";
const state = { ready: false, started: false, complete: false, driver: "CONTROLLED_LEGAL_HOST_CAPABILITY_NO_GRAPH_RUNTIME", phase: session.phase as string,
  cueCount: plan.cues.length, segmentCount: plan.segments.length, terminalTargetTick: null as number | null, terminalPausedConfirmed: false, lastTick: 0, playing: false, commands: 0, ignoredBeforeSeek: 0, errors: [] as string[],
  cues: plan.cues.map((cue, i) => ({ ordinal: i + 1, decision: cue.decision_tick, outcomeEnd: cue.outcome_end_tick,
    outcomeGateComplete: false, toolPosted: false, ackCount: 0, ackStatus: "", minToolPlayingTick: null as number | null, maxToolPlayingTick: null as number | null,
    returnedPaused: false, presented: false, narrationVisible: false, continueClicks: 0 })), presentedCount: 0, consumedCount: 0 };
function post(command: PlaybackCommand) {
  const envelope = { channel: PLAYBACK_BRIDGE_CHANNEL, direction: "command", payload: command };
  if (!isPlaybackCommandEnvelope(envelope)) throw Error("INVALID_HOST_COMMAND");
  state.commands++; frame.contentWindow!.postMessage(envelope, location.origin);
}
function fail(code: string) {
  if (state.errors.length || state.complete) return;
  state.errors.push(code.slice(0, 100)); clearTimeout(totalTimer); clearTimeout(stageTimer); next.disabled = true; start.disabled = true;
  post({ type: "pause" }); render();
}
function deadline(key: string) {
  if (key === stageKey) return; stageKey = key; clearTimeout(stageTimer);
  stageTimer = setTimeout(() => fail(`STAGE_TIMEOUT:${key}`), 30_000);
}
function render() {
  state.phase = session.phase; state.presentedCount = session.presented_cue_ids.length; state.consumedCount = session.consumed_cue_ids.length;
  summary.textContent = JSON.stringify(state, null, 2);
  status.textContent = state.errors.length ? `验收停止：${state.errors[0]}` : state.complete ? "两个教学点均完成真实播放与暂停回看" : !state.started ? state.ready ? "Viewer 就绪，可开始" : "等待 Viewer 挂载" : !next.disabled ? "讲解已就绪，请明确继续" : "正在连续带看，等待真实播放状态与 ACK";
}
function surface() { const cue = getCurrentCue(plan, session); return hostCoachingCueSurface(cue, session.phase, session.outcome_completion, cue ? narrationByCue[cue.id] : undefined); }
function pump() {
  if (!state.started || state.errors.length || state.complete) return;
  for (let i = 0; i <= plan.segments.length; i++) {
    const directive = guidedPlaybackDirective(plan, session, analysis.match_timeline.tick_rate);
    if (!transport.claimTransition(`${session.id}:${guidedTransitionKey(session)}`, Boolean(directive.automaticAction))) break;
    const target = directive.commands.find((c): c is Extract<PlaybackCommand, { type: "seekCanonicalTick" }> => c.type === "seekCanonicalTick");
    if (target) seek = createGuidedSeekGate(++seekEpoch, target.canonicalTick, analysis.match_timeline.tick_rate);
    directive.commands.forEach(post);
    if (!directive.automaticAction) break;
    session = reduceCoachingSession(plan, session, directive.automaticAction);
  }
  if (session.phase === "WRAP_UP") {
    state.terminalTargetTick = session.current_tick;
    if (!state.cues.every(cue => cue.ackCount === 1 && cue.returnedPaused && cue.continueClicks === 1) || session.consumed_cue_ids.length !== 2) {
      fail("WRAP_UP_WITHOUT_BOTH_CUES");
    } else if (!seek && !state.playing && Math.abs(state.lastTick - session.current_tick) <= 1) {
      // Completion requires the actual Viewer report after the terminal pause/seek directive.
      state.terminalPausedConfirmed = true; state.complete = true;
      clearTimeout(totalTimer); clearTimeout(stageTimer);
    } else deadline("terminal-return");
  } else deadline(pending ? `tool-${session.current_cue_id}` : guidedTransitionKey(session));
}
function maybeTeaching() {
  const cue = getCurrentCue(plan, session); if (!cue || session.phase !== "PAUSED_FOR_COACHING" || session.outcome_completion?.status !== "COMPLETE") return;
  const row = state.cues[plan.cues.indexOf(cue)]; row.outcomeGateComplete = true;
  if (state.playing || Math.abs(state.lastTick - cue.decision_tick) > 1 || seek) return;
  if (!row.toolPosted) {
    const input = { plan, routeState, analysis, demoContentHash: "a".repeat(64), selectedPlayerId: twoCueViewerPlayer,
      sessionId: session.id, runId: session.id, cue, narration: narrationByCue[cue.id], generation: 1, tickRate: analysis.match_timeline.tick_rate,
      currentSessionPhase: session.phase, outcomeGate: session.outcome_completion,
      evidence: { candidate: analysis.candidate_set.candidates.find(c => c.candidateId === cue.candidate_id), material: analysis.candidate_set.materials.find(m => m.candidateId === cue.candidate_id), winProbabilityTimeline: analysis.win_probability_timeline } };
    const prepared = adapter.prepareStart(input);
    const capability = prepared.capabilities.find(c => c.tool === "REPLAY_CUE_SLOW");
    if (!capability) return fail("NATURAL_REPLAY_CAPABILITY_MISSING");
    const request = AgentToolRequestSchema.parse({ callId: `synthetic-two-cue-${row.ordinal}`, runId: session.id, cueId: cue.id, capabilityId: capability.capabilityId, tool: capability.tool, evidenceRefs: capability.evidenceRefs });
    const context: Stage3ToolContext = { generation: 1, currentSessionPhase: session.phase, outcomeGate: session.outcome_completion };
    const command = adapter.createTeachingToolCommand(request, context); if (!command) return fail("HOST_TOOL_COMMAND_MISSING");
    pending = { request, context }; row.toolPosted = true; deadline(`tool-${cue.id}`); post(command); return;
  }
  if (row.ackCount !== 1 || row.ackStatus !== "SUCCEEDED" || row.minToolPlayingTick === null || row.maxToolPlayingTick === null || row.maxToolPlayingTick <= row.minToolPlayingTick) return;
  row.returnedPaused = true;
  const action = cuePresentedActionForTerminal(session, { status: "COMPLETED", source: "DEFAULT", cueId: cue.id });
  if (action) session = reduceCoachingSession(plan, session, action);
  row.presented = session.presented_cue_ids.includes(cue.id);
  const current = surface(); if (!current?.narration) return fail("PRESENTATION_GATE_FAILED");
  teaching.textContent = current.narration.currentSituation.text; row.narrationVisible = true;
  next.textContent = row.ordinal === 1 ? "继续到第二教学点" : "完成这次验收"; next.disabled = false;
  clearTimeout(stageTimer); stageKey = `waiting-user-${cue.id}`;
}
window.addEventListener("message", event => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
  try {
    if (event.data?.channel === "synthetic-viewer-smoke" && event.data.type === "host-ready") { state.ready = true; start.disabled = state.started; render(); return; }
    if (event.data?.channel === "synthetic-viewer-smoke" && event.data.type === "error") return fail("VIEWER_ERROR");
    if (!isPlaybackEventEnvelope(event.data) || !state.started || state.complete || state.errors.length) return;
    const message = event.data.payload;
    if (message.type === "PLAYBACK_STATE") {
      if (seek) { if (!isGuidedSeekLanding(seek, message.canonicalTick)) { state.ignoredBeforeSeek++; render(); return; } seek = undefined; }
      state.lastTick = message.canonicalTick; state.playing = message.playing;
      const row = state.cues.find(c => plan.cues[c.ordinal - 1].id === session.current_cue_id);
      if (pending && row && message.playing) { row.minToolPlayingTick = Math.min(row.minToolPlayingTick ?? Infinity, message.canonicalTick); row.maxToolPlayingTick = Math.max(row.maxToolPlayingTick ?? -Infinity, message.canonicalTick); }
      const observation = transport.observe(message.playing); observation.commands.forEach(post);
      if (observation.advance && transport.canAdvance(session, false) && ["PLAYING", "REVEALING", "REPLAYING"].includes(session.phase)) session = reduceCoachingSession(plan, session, { type: "TICK", tick: message.canonicalTick });
      if (session.outcome_completion?.status !== "COMPLETE" && surface()) return fail("EARLY_TEACHING_EXPOSURE");
      pump(); maybeTeaching();
    }
    if (message.type === "TEACHING_TOOL_ACK" && pending) {
      const request = pending.request;
      if (message.callId !== request.callId || message.runId !== request.runId || message.cueId !== request.cueId) return;
      const result = adapter.acceptTeachingToolAck(request, message, pending.context); if (!result) return;
      const row = state.cues[plan.cues.findIndex(c => c.id === request.cueId)]; row.ackCount++; row.ackStatus = result.status;
      if (result.status !== "SUCCEEDED" || !result.observation.completed || result.observation.code !== "CUE_PLAYED") return fail("VIEWER_TOOL_FAILED");
      maybeTeaching();
    }
    render();
  } catch { fail("CONTROLLED_DRIVER_ERROR"); }
});
start.addEventListener("click", () => {
  if (!state.ready || state.started) return;
  state.started = true; start.disabled = true; totalTimer = setTimeout(() => fail("TOTAL_TIMEOUT"), 90_000);
  session = reduceCoachingSession(plan, session, { type: "START" }); pump(); render();
});
next.addEventListener("click", () => {
  if (next.disabled || state.errors.length) return;
  const cue = getCurrentCue(plan, session); if (!cue) return;
  const row = state.cues[plan.cues.indexOf(cue)]; if (!row.returnedPaused || !row.presented || row.continueClicks) return;
  row.continueClicks++; next.disabled = true; teaching.textContent = ""; pending = undefined;
  session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" }); pump(); render();
});
window.addEventListener("pagehide", () => { clearTimeout(totalTimer); clearTimeout(stageTimer); }, { once: true });
frame.src = "/child.html?parentOrigin=" + encodeURIComponent(location.origin); render();
