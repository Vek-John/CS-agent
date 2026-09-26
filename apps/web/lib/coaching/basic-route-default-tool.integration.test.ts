import { afterEach, expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { createCoachAgentRuntime } from "@cs-coach/coach-agent";
import type { CoachAgentEvent, CoachAgentResult } from "@cs-coach/coach-agent/client";
import type { PlaybackCommand, TeachingToolAckEvent } from "@cs-coach/contracts";
import { assertValidReviewPlan, buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildInitialCoachingRouteState } from "./cs2d-route-integration";
import { CoachAgentStage3HostAdapter, buildStage3StartCue, type Stage3HostAdapterInput } from "./coach-agent-stage3-host-adapter";
import { CoachAgentStage3Controller, type Stage3ControllerScheduler } from "./coach-agent-stage3-controller";

afterEach(() => vi.unstubAllGlobals());

it.each(["ack", "timeout"] as const)("closes a natural basic-route default tool exactly once after %s", async (completion) => {
  const fetch = vi.fn(() => { throw new Error("NETWORK_NOT_EXPECTED"); });
  vi.stubGlobal("fetch", fetch);
  // Synthetic event coordinates/times are fixture inputs, not measured Demo ticks.
  const bundle = buildCs2dAnalysisBundle({ replay: fireReplay("DEATH"), selectedSteamId: self, demoId: `synthetic-basic-tool-${completion}` });
  const plan = bundle.review_plan;
  assertValidReviewPlan(bundle.match_timeline, plan);
  expect(bundle.win_probability_timeline.status).toBe("UNAVAILABLE");
  expect(bundle.candidate_set.candidates.some(candidate => candidate.source.kind === "WIN_RATE_DROP")).toBe(false);
  const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, deterministicNarrationBundle(
    buildCoachingPackage(cue, bundle.candidate_set, bundle.observation_evidence),
    buildOutcomePackage(cue, bundle.candidate_set, bundle.outcome_impacts.find(impact => impact.cueId === cue.id)),
  )]));
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue });
  expect(routeState).toMatchObject({ startable: true, routeFrozen: true });
  const identity = { plan, routeState, analysis: bundle, demoContentHash: "a".repeat(64), selectedPlayerId: self,
    sessionId: `basic-tool-${completion}`, runId: `basic-tool-${completion}` };
  let session = reduceCoachingSession(plan, createCoachingSession(plan, identity.sessionId, routeState), { type: "START" });
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" }); // Actual default policy; no policy override.
  const events: CoachAgentEvent[] = [];
  const posted: PlaybackCommand[] = [];
  let latest: CoachAgentResult | undefined;
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const scheduler: Stage3ControllerScheduler = {
    now: () => 0,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: handle => { timers.delete(handle as number); },
  };
  const adapter = new CoachAgentStage3HostAdapter();
  const controller = new CoachAgentStage3Controller({ adapter, scheduler,
    dispatch: async event => { events.push(event); latest = await runtime.dispatch(event); return latest; },
    post: command => posted.push(command), bridgeAvailable: () => true,
    isLive: input => session.phase === "PAUSED_FOR_COACHING" && session.current_cue_id === input.cue.id,
  });
  try {
    for (let step = 0; step < plan.segments.length * 3 && session.phase !== "PAUSED_FOR_COACHING"; step++) {
      const segment = plan.segments[session.current_segment_index];
      if (segment.cue_ids.length === 0) {
        const mode = segment.mode === "SKIP" ? segment.reason_code === "FREEZE_TIME" ? "FREEZE" : "SKIP" : segment.mode;
        if (mode !== "FREEZE" && mode !== "SKIP" && mode !== "BRIEF" && mode !== "OBSERVE") throw new Error("Unexpected ordinary segment");
        controller.observeSegment(identity, segment.id, session.current_segment_index, mode, session.phase === "SKIPPING" ? "SKIPPING" : "PLAYING");
      }
      session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" } : { type: "TICK", tick: segment.end_tick });
    }
    if (session.phase !== "PAUSED_FOR_COACHING") throw new Error("Session did not reach the coaching pause");
    const cue = plan.cues.find(item => item.id === session.current_cue_id)!;
    expect(cue).toBeDefined();
    expect(session.outcome_completion).toMatchObject({ status: "COMPLETE", completedAtTick: cue.outcome_end_tick });
    const input: Stage3HostAdapterInput = { ...identity, cue, narration: narrationByCue[cue.id], generation: 1,
      tickRate: bundle.match_timeline.tick_rate, currentSessionPhase: session.phase, outcomeGate: session.outcome_completion!,
      evidence: { candidate: bundle.candidate_set.candidates.find(item => item.candidateId === cue.candidate_id),
        material: bundle.candidate_set.materials.find(item => item.candidateId === cue.candidate_id),
        winProbabilityTimeline: bundle.win_probability_timeline } };
    expect(cue.action_fact_refs ?? []).not.toHaveLength(0);
    const tools = buildStage3StartCue(input).capabilities.map(capability => capability.tool);
    expect(tools).toContain("REPLAY_CUE_SLOW");
    expect(tools).not.toContain("SHOW_WIN_RATE_IMPACT");
    controller.start(input);
    await vi.waitFor(() => expect(controller.currentState.playback).toBeDefined());
    const preceding = plan.segments.slice(0, plan.segments.findIndex(segment => segment.id === cue.segment_id));
    expect(events.filter(event => event.type === "OBSERVE_SEGMENT").map(event => event.segmentId)).toEqual(preceding.map(segment => segment.id));
    expect(latest!.state.selectedTeachingMove).toMatchObject({ presentationPurpose: "ACTION_FACT_REPLAY" });
    const command = posted.find(command => command.type === "teachingTool");
    if (!command || command.type !== "teachingTool" || command.tool !== "REPLAY_CUE_SLOW") throw new Error("Default Graph did not request action replay");
    expect(command.args).toMatchObject({ speed: 0.5, outcomeEndCanonicalTick: cue.outcome_end_tick });
    expect(timers.size).toBe(1);
    const ack: TeachingToolAckEvent = { type: "TEACHING_TOOL_ACK", schemaVersion: "cs2d-teaching-tool-ack.v1",
      tool: command.tool, callId: command.callId, runId: command.runId, cueId: command.cueId, generation: command.generation,
      status: "SUCCEEDED", observationCode: "CUE_PLAYED", completed: true, limitations: [] };
    const lateTimeout = [...timers.values()][0];
    if (completion === "ack") controller.acceptAck(ack);
    else { const [id, timeout] = [...timers.entries()][0]; timers.delete(id); timeout(); }
    await vi.waitFor(() => expect(controller.currentState.status).toBe("COMPLETED"));
    const completed = latest!;
    expect(completed.state.toolHistory).toHaveLength(1);
    expect(completed.state.toolHistory[0].status).toBe(completion === "ack" ? "SUCCEEDED" : "FAILED");
    expect(completed.state.completedCueIds.filter(id => id === cue.id)).toHaveLength(1);
    expect(events.filter(event => event.type === "RESUME_TOOL")).toHaveLength(1);
    expect(timers.size).toBe(0);
    // Tool completion resumes Graph once; advancing the Session remains a separate action.
    expect(session).toMatchObject({ phase: "PAUSED_FOR_COACHING", current_cue_id: cue.id });
    controller.acceptAck(ack); controller.acceptAck(ack); lateTimeout(); controller.start(input);
    await Promise.resolve(); await Promise.resolve();
    expect(latest).toBe(completed);
    expect(events.filter(event => event.type === "RESUME_TOOL")).toHaveLength(1);
    expect(posted.filter(command => command.type === "teachingTool")).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  } finally { controller.dispose(); expect(timers.size).toBe(0); }
});
