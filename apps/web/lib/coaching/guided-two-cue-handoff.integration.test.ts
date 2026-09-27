import { afterEach, expect, it, vi } from "vitest";
import * as analysisAdapter from "@cs-coach/cs2d-analysis-adapter";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";

function fixture() {
  // Entirely synthetic times and events, not parsed Demo ticks.
  const first = fireReplay("DEATH");
  const rounds = [0, 1].map(index => {
    const source = (index === 0 ? first : fireReplay("HP_CHANGE")).rounds[0], offset = index * 1200;
    return { ...source, number: index + 1, scoreCt: index,
      freezeStartTick: source.freezeStartTick + offset, startTick: source.startTick + offset,
      decidedTick: source.decidedTick + offset, endTick: source.endTick + offset, postEndTick: source.postEndTick + offset,
      frames: source.frames.map(frame => ({ ...frame, tick: frame.tick + offset })),
      events: source.events.map(event => ({ ...event, tick: event.tick + offset })),
    };
  });
  return buildCs2dAnalysisBundle({ replay: { ...first, rounds }, selectedSteamId: self, demoId: "synthetic-two-cue-handoff" });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
import * as planner from "@cs-coach/review-planner";
import { createCoachAgentRuntime } from "@cs-coach/coach-agent";
import type { CoachAgentEvent, CoachAgentResult } from "@cs-coach/coach-agent/client";
import type { CoachCue, PlaybackCommand, TeachingToolAckEvent } from "@cs-coach/contracts";
import { createCoachingSession, getCurrentCue, reduceCoachingSession, type SessionAction } from "@cs-coach/session";
import { buildInitialCoachingRouteState } from "./cs2d-route-integration";
import { CoachAgentStage3Controller, type Stage3ControllerScheduler } from "./coach-agent-stage3-controller";
import { CoachAgentStage3HostAdapter, type Stage3HostAdapterInput } from "./coach-agent-stage3-host-adapter";
import { createGuidedSeekGate, guidedPlaybackDirective, guidedTransitionKey, isGuidedSeekLanding, type GuidedSeekGate } from "./cs2d-guided-session";
import { cuePresentedActionForTerminal, hostCoachingCueSurface, HostPlaybackControl } from "../playback/cs2d-playback-host";

it.each([false, true])("hands off two natural cues through the real session/default Graph/Host controller (late first ACK=%s)", async lateFirstAck => {
  const fetcher = vi.fn(() => { throw Error("NETWORK_NOT_EXPECTED"); }); vi.stubGlobal("fetch", fetcher);
  const bundle = fixture(), plan = bundle.review_plan;
  planner.assertValidReviewPlan(bundle.match_timeline, plan);
  expect(plan.cues).toHaveLength(2);
  expect(plan.cues.map(cue => bundle.candidate_set.candidates.find(c => c.candidateId === cue.candidate_id)!.roundNumber)).toEqual([1, 2]);
  expect(bundle.win_probability_timeline.status).toBe("UNAVAILABLE");
  const narrations = Object.fromEntries(plan.cues.map(cue => [cue.id, planner.deterministicNarrationBundle(
    planner.buildCoachingPackage(cue, bundle.candidate_set, bundle.observation_evidence), planner.buildOutcomePackage(cue, bundle.candidate_set),
  )]));
  const generateAnalysis = vi.spyOn(analysisAdapter, "buildCs2dAnalysisBundle"), generateNarration = vi.spyOn(planner, "deterministicNarrationBundle");
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue: narrations });
  const identity = { plan, routeState, analysis: bundle, demoContentHash: "a".repeat(64), selectedPlayerId: self, sessionId: `two-cue-${lateFirstAck}`, runId: `two-cue-${lateFirstAck}` };
  let session = createCoachingSession(plan, identity.sessionId, routeState);
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" }); // Actual default adapter/policy.
  const transport = new HostPlaybackControl();
  const commands: PlaybackCommand[] = [], events: CoachAgentEvent[] = [];
  const covered = new Set<string>();
  let latest: CoachAgentResult | undefined, seekGate: GuidedSeekGate | undefined, seekEpoch = 0;
  // Explicit test boundary: fake iframe state/clock and ACK, never a browser playback claim.
  let viewerTick = plan.segments[0].start_tick, viewerPlaying = false;
  const timers = new Map<number, () => void>(); let timer = 0;
  const scheduler: Stage3ControllerScheduler = { now: () => 0, setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: key => { timers.delete(key as number); } };
  const reduce = (action: SessionAction) => {
    session = reduceCoachingSession(plan, session, action);
    for (const event of session.user_events) if (event.type === "SEGMENT_SKIPPED" && event.detail === "AUTO_FREEZE_TIME" && event.segment_id) covered.add(event.segment_id);
  };
  const controller = new CoachAgentStage3Controller({ adapter: new CoachAgentStage3HostAdapter(), scheduler,
    dispatch: async event => { events.push(event); latest = await runtime.dispatch(event); return latest; },
    post: command => { commands.push(command); }, bridgeAvailable: () => true,
    isLive: input => session.phase === "PAUSED_FOR_COACHING" && session.current_cue_id === input.cue.id,
    onState: state => { const action = cuePresentedActionForTerminal(session, state); if (action) reduce(action); },
  });
  function receivePlayback(tick: number, playing: boolean) {
    if (seekGate) { if (!isGuidedSeekLanding(seekGate, tick)) return false; seekGate = undefined; }
    viewerTick = tick; viewerPlaying = playing;
    const observation = transport.observe(playing); commands.push(...observation.commands);
    if (observation.advance && transport.canAdvance(session, false) && ["PLAYING", "REVEALING", "REPLAYING"].includes(session.phase)) reduce({ type: "TICK", tick });
    return true;
  }
  function applyDirective() {
    const segment = plan.segments[session.current_segment_index]; if (segment) covered.add(segment.id);
    const directive = guidedPlaybackDirective(plan, session, bundle.match_timeline.tick_rate);
    if (!transport.claimTransition(`${session.id}:${guidedTransitionKey(session)}`, Boolean(directive.automaticAction))) return;
    const seek = directive.commands.find((c): c is Extract<PlaybackCommand, { type: "seekCanonicalTick" }> => c.type === "seekCanonicalTick");
    if (seek) seekGate = createGuidedSeekGate(++seekEpoch, seek.canonicalTick, bundle.match_timeline.tick_rate);
    for (const command of directive.commands) {
      commands.push(command);
      if (command.type === "pause") viewerPlaying = false;
      if (command.type === "play") viewerPlaying = true;
      if (command.type === "seekCanonicalTick") viewerTick = command.canonicalTick;
    }
    receivePlayback(viewerTick, viewerPlaying);
    if (directive.automaticAction && transport.canAdvance(session, false)) reduce(directive.automaticAction);
  }
  async function observeOrdinary(segment: typeof plan.segments[number]) {
    const mode = segment.mode === "SKIP" ? segment.reason_code === "FREEZE_TIME" ? "FREEZE" : "SKIP" : segment.mode;
    if (mode !== "FREEZE" && mode !== "SKIP" && mode !== "BRIEF" && mode !== "OBSERVE") throw Error("Unexpected ordinary segment");
    controller.observeSegment(identity, segment.id, session.current_segment_index, mode, session.phase === "SKIPPING" ? "SKIPPING" : "PLAYING");
    // Explicit fake-clock policy: drain real observer work before advancing ordinary playback time.
    await vi.waitFor(() => expect(latest?.state.routeCursor).toBe(plan.segments.indexOf(segment)));
  }
  async function traverseToCue(cue: CoachCue) {
    for (let count = 0; count < plan.segments.length && session.current_cue_id !== cue.id; count++) {
      const segment = plan.segments[session.current_segment_index];
      expect(segment.cue_ids).toHaveLength(0);
      await observeOrdinary(segment);
      applyDirective();
      if (session.current_segment_index === plan.segments.indexOf(segment)) receivePlayback(segment.end_tick, true);
    }
    expect(session.current_cue_id).toBe(cue.id); applyDirective();
  }
  function surface() { const cue = getCurrentCue(plan, session); return hostCoachingCueSurface(cue, session.phase, session.outcome_completion, cue ? narrations[cue.id] : undefined); }
  let firstAck: TeachingToolAckEvent | undefined;
  try {
    reduce({ type: "START" });
    for (const [index, cue] of plan.cues.entries()) {
      await traverseToCue(cue);
      expect(session.phase).toBe("PLAYING"); expect(surface()).toBeUndefined();
      receivePlayback(cue.decision_tick - 1, true); expect(surface()).toBeUndefined();
      receivePlayback(cue.decision_tick, true); applyDirective();
      expect(session.phase).toBe("REVEALING"); expect(session.outcome_completion?.status).not.toBe("COMPLETE"); expect(surface()).toBeUndefined();
      receivePlayback(cue.outcome_end_tick - 1, true); expect(surface()).toBeUndefined();
      receivePlayback(cue.outcome_end_tick, true); applyDirective();
      expect(session.phase).toBe("PAUSED_FOR_COACHING"); expect(session.current_tick).toBe(cue.decision_tick);
      expect(viewerTick).toBe(cue.decision_tick); expect(viewerPlaying).toBe(false);
      expect(session.outcome_completion).toMatchObject({ cueId: cue.id, status: "COMPLETE", completedAtTick: cue.outcome_end_tick });
      expect(surface()?.narration).toEqual(narrations[cue.id]);
      const commandCount = commands.length; applyDirective(); expect(commands).toHaveLength(commandCount);
      if (session.phase !== "PAUSED_FOR_COACHING") throw Error("Outcome did not complete at coaching pause");
      const input: Stage3HostAdapterInput = { ...identity, cue, narration: narrations[cue.id], generation: 1, tickRate: bundle.match_timeline.tick_rate,
        currentSessionPhase: session.phase, outcomeGate: session.outcome_completion!, evidence: {
          candidate: bundle.candidate_set.candidates.find(c => c.candidateId === cue.candidate_id),
          material: bundle.candidate_set.materials.find(m => m.candidateId === cue.candidate_id), winProbabilityTimeline: bundle.win_probability_timeline,
        } };
      controller.start(input);
      await vi.waitFor(() => expect(controller.currentState.playback?.cueId).toBe(cue.id));
      expect(latest?.state.activeCueId).toBe(cue.id);
      const tool = commands.filter((c): c is Extract<PlaybackCommand, { type: "teachingTool" }> => c.type === "teachingTool").at(-1)!;
      expect(tool.tool).toBe("REPLAY_CUE_SLOW"); expect(tool.cueId).toBe(cue.id);
      expect(tool.args).toMatchObject({ decisionCanonicalTick: cue.decision_tick, outcomeEndCanonicalTick: cue.outcome_end_tick });
      const ack: TeachingToolAckEvent = { type: "TEACHING_TOOL_ACK", schemaVersion: "cs2d-teaching-tool-ack.v1", tool: tool.tool,
        callId: tool.callId, runId: tool.runId, cueId: tool.cueId, generation: tool.generation,
        status: "SUCCEEDED", observationCode: "CUE_PLAYED", completed: true, limitations: [] };
      if (index === 1 && lateFirstAck) {
        const result = latest; controller.acceptAck(firstAck!); await Promise.resolve(); await Promise.resolve();
        expect(latest).toBe(result); expect(controller.currentState.playback?.cueId).toBe(cue.id);
        expect(session.presented_cue_ids).not.toContain(cue.id); expect(events.filter(e => e.type === "RESUME_TOOL")).toHaveLength(1);
      }
      controller.acceptAck(ack);
      await vi.waitFor(() => expect(controller.currentState.status).toBe("COMPLETED"));
      expect(session.presented_cue_ids.filter(id => id === cue.id)).toHaveLength(1);
      expect(session.consumed_cue_ids).not.toContain(cue.id);
      expect(cuePresentedActionForTerminal(session, controller.currentState)).toBeUndefined();
      controller.acceptAck(ack); controller.start(input); await Promise.resolve();
      expect(events.filter(e => e.type === "RESUME_TOOL")).toHaveLength(index + 1);
      expect(timers.size).toBe(0); firstAck ??= ack;
      // Existing user's “continue” action, only after the completed presentation.
      reduce({ type: "ADVANCE_SEGMENT" });
      expect(session.consumed_cue_ids.filter(id => id === cue.id)).toHaveLength(1);
      expect(surface()).toBeUndefined();
    }
    // Finish remaining ordinary coverage without inventing a third teaching point.
    for (let count = 0; count < plan.segments.length && session.phase !== "WRAP_UP"; count++) {
      const segment = plan.segments[session.current_segment_index]; expect(segment.cue_ids).toHaveLength(0);
      await observeOrdinary(segment);
      applyDirective(); if (session.current_segment_index === plan.segments.indexOf(segment)) receivePlayback(segment.end_tick, true);
    }
    expect(session.phase).toBe("WRAP_UP"); expect([...covered]).toEqual(plan.segments.map(s => s.id));
    expect(events.filter(e => e.type === "OBSERVE_SEGMENT").map(e => e.segmentId)).toEqual(plan.segments.filter(s => s.cue_ids.length === 0).map(s => s.id));
    expect(latest!.state.routeCursor).toBe(plan.segments.length - 1);
    expect(plan.segments[0].start_tick).toBe(bundle.match_timeline.start_tick);
    expect(plan.segments.at(-1)!.end_tick).toBe(bundle.match_timeline.end_tick);
    for (let i = 1; i < plan.segments.length; i++) expect(plan.segments[i].start_tick).toBe(plan.segments[i - 1].end_tick);
    expect(session.presented_cue_ids).toEqual(plan.cues.map(c => c.id)); expect(session.consumed_cue_ids).toEqual(plan.cues.map(c => c.id));
    expect(events.filter(e => e.type === "START_CUE")).toHaveLength(2); expect(events.filter(e => e.type === "RESUME_TOOL")).toHaveLength(2);
    expect(latest!.state.completedCueIds).toEqual(plan.cues.map(c => c.id)); expect(latest!.state.toolHistory).toHaveLength(2);
    expect(commands.filter(c => c.type === "teachingTool")).toHaveLength(2);
    expect(generateAnalysis).not.toHaveBeenCalled(); expect(generateNarration).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  } finally { controller.dispose(); expect(timers.size).toBe(0); }
});

function firstCueInput(runId: string): Stage3HostAdapterInput {
  const analysis = fixture(), plan = analysis.review_plan;
  const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, planner.deterministicNarrationBundle(
    planner.buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), planner.buildOutcomePackage(cue, analysis.candidate_set),
  )]));
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue });
  let session = reduceCoachingSession(plan, createCoachingSession(plan, runId, routeState), { type: "START" });
  for (let count = 0; count < plan.segments.length * 3 && session.phase !== "PAUSED_FOR_COACHING"; count++) {
    const segment = plan.segments[session.current_segment_index];
    session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" } : { type: "TICK", tick: segment.end_tick });
  }
  if (session.phase !== "PAUSED_FOR_COACHING") throw Error("No natural first cue");
  const cue = getCurrentCue(plan, session)!;
  return { plan, routeState, analysis, demoContentHash: "a".repeat(64), selectedPlayerId: self, sessionId: runId, runId,
    cue, narration: narrationByCue[cue.id], generation: 1, tickRate: analysis.match_timeline.tick_rate,
    currentSessionPhase: session.phase, outcomeGate: session.outcome_completion!, evidence: {
      candidate: analysis.candidate_set.candidates.find(c => c.candidateId === cue.candidate_id),
      material: analysis.candidate_set.materials.find(m => m.candidateId === cue.candidate_id), winProbabilityTimeline: analysis.win_probability_timeline,
    } };
}
function deferredVoid() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
it.each(["response", "mirror"])("does not skip an unconfirmed reserved observer when cue start overtakes its %s", async stage => {
  const input = firstCueInput(`observer-race-${stage}`), runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  const hold = deferredVoid(), entered = deferredVoid();
  const events: CoachAgentEvent[] = []; let held = false, latest: CoachAgentResult | undefined;
  const controller = new CoachAgentStage3Controller({
    dispatch: async event => {
      events.push(event); const result = await runtime.dispatch(event); latest = result;
      if (stage === "response" && event.type === "OBSERVE_SEGMENT" && !held) { held = true; entered.resolve(); await hold.promise; }
      return result;
    },
    onAgentResult: async event => { if (stage === "mirror" && event.type === "OBSERVE_SEGMENT" && !held) { held = true; entered.resolve(); await hold.promise; } },
    post: () => {}, bridgeAvailable: () => true, isLive: () => true,
  });
  try {
    const firstOrdinary = input.plan.segments.findIndex(s => s.mode === "BRIEF");
    expect(firstOrdinary).toBeGreaterThan(0);
    controller.observeSegment(input, input.plan.segments[firstOrdinary].id, firstOrdinary, "BRIEF", "PLAYING");
    await entered.promise; controller.start(input); hold.resolve();
    await vi.waitFor(() => expect(controller.currentState.playback?.cueId).toBe(input.cue.id));
    expect(latest!.state.fallbackReasons).not.toContain("ROUTE_ORDER_MISMATCH");
    const target = input.plan.segments.findIndex(s => s.id === input.cue.segment_id);
    expect(latest!.state.routeCursor).toBe(target);
    const observations = events.filter((e): e is Extract<CoachAgentEvent, { type: "OBSERVE_SEGMENT" }> => e.type === "OBSERVE_SEGMENT");
    expect([...new Set(observations.map(e => e.segmentIndex))]).toEqual(Array.from({ length: target }, (_, i) => i));
    for (const event of observations) expect(latest!.state.processedEventIds.filter(id => id === event.eventId)).toHaveLength(1);
    expect(events.filter(e => e.type === "START_CUE")).toHaveLength(1);
  } finally { hold.resolve(); controller.dispose(); }
});
it("does not let a cancelled old observer completion publish recovery-required over a new run", async () => {
  const old = firstCueInput("old-observer-owner"), current = firstCueInput("current-observer-owner"), runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  const hold = deferredVoid(), entered = deferredVoid(), states: string[] = []; let held = false;
  const controller = new CoachAgentStage3Controller({
    dispatch: async event => { const result = await runtime.dispatch(event);
      if (event.type === "OBSERVE_SEGMENT" && event.identity.runId === old.runId && !held) { held = true; entered.resolve(); await hold.promise; }
      return result;
    }, post: () => {}, bridgeAvailable: () => true, isLive: () => true, onState: state => states.push(state.status),
  });
  try {
    controller.observeSegment(old, old.plan.segments[1].id, 1, "BRIEF", "PLAYING"); await entered.promise;
    controller.start(old); controller.reset(); controller.start(current);
    await vi.waitFor(() => expect(controller.currentState.playback?.runId).toBe(current.runId));
    const offset = states.length; hold.resolve(); await vi.waitFor(() => expect(states.slice(offset)).not.toContain("RECOVERY_REQUIRED"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.currentState.playback?.runId).toBe(current.runId);
    expect(states.slice(offset)).not.toContain("RECOVERY_REQUIRED");
  } finally { hold.resolve(); controller.dispose(); }
});
