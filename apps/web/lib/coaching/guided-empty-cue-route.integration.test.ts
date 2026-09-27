import { afterEach, expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { assertValidReviewPlan } from "@cs-coach/review-planner";
import { emptyCueViewerReplay, twoCueViewerPlayer } from "../../../../tools/cs2d-host/viewer-two-cue-fixture";
import { buildInitialCoachingRouteState } from "./cs2d-route-integration";

import { createCoachAgentRuntime } from "@cs-coach/coach-agent";
import type { CoachAgentEvent, CoachAgentResult, SessionWrapUpRequest, SessionWrapUpResult } from "@cs-coach/coach-agent/client";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import { createCs2dReviewPreparationDependencies, createReviewPreparationOrchestrator, type ReviewPreparationEvent } from "./cs2d-route-integration";
import { requestDecisionAssessments } from "./decision-assessment-host";
import { CoachAgentStage3Controller } from "./coach-agent-stage3-controller";
import { CoachAgentStage3HostAdapter } from "./coach-agent-stage3-host-adapter";
import { guidedPlaybackDirective } from "./cs2d-guided-session";
import { completeStage3SessionWrapUp } from "./session-wrap-up-completion";
import { buildStage3WrapUpInput } from "./coach-agent-stage3-wrap-up";
import { hostCoachingCueSurface } from "../playback/cs2d-playback-host";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("naturally compiles a startable complete route without candidates or cues", () => {
  const network = vi.fn(() => { throw Error("NETWORK_NOT_EXPECTED"); });
  vi.stubGlobal("fetch", network);
  // Synthetic frame/event times, never measurements from a parsed Demo.
  const replay = emptyCueViewerReplay();
  const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: twoCueViewerPlayer, demoId: "synthetic-empty-route" });
  const plan = bundle.review_plan;
  expect(bundle.candidate_set.candidates).toHaveLength(0);
  expect(plan.cues).toHaveLength(0);
  assertValidReviewPlan(bundle.match_timeline, plan);
  expect(plan.segments.length).toBeGreaterThan(0);
  expect(plan.segments[0].start_tick).toBe(replay.rounds[0].freezeStartTick);
  expect(plan.segments.at(-1)!.end_tick).toBe(replay.rounds.at(-1)!.postEndTick);
  for (let i = 1; i < plan.segments.length; i++) expect(plan.segments[i].start_tick).toBe(plan.segments[i - 1].end_tick);
  expect(buildInitialCoachingRouteState(plan).startable).toBe(true);
  expect(network).not.toHaveBeenCalled();
  console.log(JSON.stringify({ candidates: 0, cues: 0, segments: plan.segments.length, modes: plan.segments.map(segment => segment.mode), startable: true }));
});


it("prepares zero narrations and covers every ordinary segment before one empty Graph wrap-up", async () => {
  const network = vi.fn(() => { throw Error("NETWORK_NOT_EXPECTED"); });
  vi.stubGlobal("fetch", network);
  const bundle = buildCs2dAnalysisBundle({ replay: emptyCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: "synthetic-empty-route" });
  const director = vi.fn(() => { throw Error("DIRECTOR_NOT_EXPECTED"); });
  const narrator = vi.fn(() => { throw Error("NARRATION_NOT_EXPECTED"); });
  // Only the local assessment config response is stubbed. Actual assessment,
  // deterministic empty-candidate Director fallback and Compiler still execute.
  const config = vi.fn(async () => Response.json({ mode: "RULE_BASELINE", acceptance: "DISABLED" }));
  const dependencies = createCs2dReviewPreparationDependencies({ candidateSet: bundle.candidate_set,
    observationEvidence: bundle.observation_evidence, matchTimeline: bundle.match_timeline,
    winProbabilityTimeline: bundle.win_probability_timeline, selectedPlayerId: twoCueViewerPlayer }, {
    director, narrator, assessDecisions: (set, options) => requestDecisionAssessments(set, { ...options, fetcher: config }),
  });
  const prepareRoute = vi.spyOn(dependencies, "prepareRoute");
  const prepareNarration = vi.spyOn(dependencies, "prepareNarration");
  const preparation = createReviewPreparationOrchestrator("empty-route-generation", bundle.review_plan, {}, dependencies);
  const preparationEvents: ReviewPreparationEvent[] = [];
  let controller: CoachAgentStage3Controller | undefined;
  try {
    await preparation.run(event => preparationEvents.push(event));
    expect(preparationEvents.map(event => event.type)).toEqual(["ROUTE_FROZEN", "READY_TO_START"]);
    const ready = preparationEvents.find(event => event.type === "READY_TO_START");
    if (!ready || ready.type !== "READY_TO_START") throw Error("EMPTY_ROUTE_NOT_READY");
    const { plan, routeState } = ready;
    assertValidReviewPlan(bundle.match_timeline, plan);
    expect(routeState.startable).toBe(true); expect(plan.cues).toHaveLength(0);
    const identity = { plan, routeState, analysis: bundle, demoContentHash: "a".repeat(64),
      selectedPlayerId: twoCueViewerPlayer, sessionId: "empty-route-session", runId: "empty-route-run" };
    let session = createCoachingSession(plan, identity.sessionId, routeState);
    const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
    const events: CoachAgentEvent[] = [];
    let latest: CoachAgentResult | undefined;
    const post = vi.fn();
    controller = new CoachAgentStage3Controller({ adapter: new CoachAgentStage3HostAdapter(),
      dispatch: async event => { events.push(event); latest = await runtime.dispatch(event); return latest; },
      post, bridgeAvailable: () => true, isLive: () => false, onState: () => undefined,
    });
    session = reduceCoachingSession(plan, session, { type: "START" });
    const traversed: string[] = [];
    // Fake playback clock only. Drain real Graph observer work before each
    // synthetic segment boundary; no fake tools, ACKs or completion results.
    for (let i = 0; i < plan.segments.length && session.phase !== "WRAP_UP"; i++) {
      const segmentIndex = session.current_segment_index;
      const segment = plan.segments[segmentIndex];
      expect(segment.cue_ids).toHaveLength(0); traversed.push(segment.id);
      const mode = segment.mode === "SKIP" ? segment.reason_code === "FREEZE_TIME" ? "FREEZE" : "SKIP" : segment.mode;
      if (mode !== "FREEZE" && mode !== "SKIP" && mode !== "BRIEF" && mode !== "OBSERVE") throw Error("UNEXPECTED_TEACHING_SEGMENT");
      controller.observeSegment(identity, segment.id, session.current_segment_index, mode, session.phase === "SKIPPING" ? "SKIPPING" : "PLAYING");
      await vi.waitFor(() => expect(latest?.state.observedSegmentIds).toContain(segment.id));
      expect(hostCoachingCueSurface(getCurrentCue(plan, session), session.phase, session.outcome_completion, undefined)).toBeUndefined();
      const directive = guidedPlaybackDirective(plan, session, bundle.match_timeline.tick_rate);
      if (directive.automaticAction) session = reduceCoachingSession(plan, session, directive.automaticAction);
      else {
        expect(directive.commands).toContainEqual({ type: "play" });
        session = reduceCoachingSession(plan, session, { type: "TICK", tick: segment.end_tick - 1 });
        expect(session.current_segment_index).toBe(segmentIndex);
        session = reduceCoachingSession(plan, session, { type: "TICK", tick: segment.end_tick });
      }
    }
    const automaticFreezes = session.user_events.filter(event => event.type === "SEGMENT_SKIPPED" && event.detail === "AUTO_FREEZE_TIME").map(event => event.segment_id);
    expect(new Set([...traversed, ...automaticFreezes])).toEqual(new Set(plan.segments.map(segment => segment.id)));
    expect(session.phase).toBe("WRAP_UP");
    expect(session.current_tick).toBe(plan.segments.at(-1)!.end_tick);
    expect(guidedPlaybackDirective(plan, session).commands).toContainEqual({ type: "pause" });
    expect(session.presented_cue_ids).toEqual([]); expect(session.consumed_cue_ids).toEqual([]);
    expect(session.user_events.filter(event => event.type === "SEGMENT_SKIPPED").map(event => event.segment_id))
      .toEqual(plan.segments.filter(segment => segment.mode === "SKIP").map(segment => segment.id));
    let claimed = false, request: SessionWrapUpRequest | undefined, result: SessionWrapUpResult | undefined;
    const onResult = vi.fn((value: SessionWrapUpResult) => { result = value; });
    const completion: Parameters<typeof completeStage3SessionWrapUp>[0] = { controller, identity,
      isCurrent: () => session.phase === "WRAP_UP" || session.phase === "COMPLETED", persistence: undefined,
      claim: () => { if (claimed) return false; claimed = true; return true; }, onStart: vi.fn(),
      onRequest: value => { request = value; }, onResult, onSaveError: () => { throw Error("PERSISTENCE_NOT_EXPECTED"); },
      buildInput: value => {
        if (!value.state.sessionSummaryInput) throw Error("MISSING_ACTUAL_SUMMARY");
        return buildStage3WrapUpInput(plan, value.state.sessionSummaryInput, {}, bundle.candidate_set);
      },
    };
    await completeStage3SessionWrapUp(completion);
    expect(latest?.state.runStatus).toBe("COMPLETED"); expect(latest?.state.routeCursor).toBe(plan.segments.length);
    expect(latest?.state.observedSegmentIds).toEqual(plan.segments.map(segment => segment.id)); expect(latest?.state.completedCueIds).toEqual([]);
    expect(request?.themes).toEqual([]); expect(result?.manifest.reason).toBe("NO_REPEATED_THEME"); expect(result?.bundle.themes).toEqual([]);
    session = reduceCoachingSession(plan, session, { type: "COMPLETE_SESSION" });
    expect(session.phase).toBe("COMPLETED");
    await completeStage3SessionWrapUp(completion);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(events.map(event => event.type)).toEqual([...plan.segments.map(() => "OBSERVE_SEGMENT"), "COMPLETE_SESSION"]);
    expect(prepareRoute).toHaveBeenCalledTimes(1); expect(config).toHaveBeenCalledTimes(1);
    for (const operation of [prepareNarration, director, narrator, post, network]) expect(operation).not.toHaveBeenCalled();
    console.log(JSON.stringify({ session: session.phase, segments: plan.segments.length, graphEvents: events.length,
      routePreparations: prepareRoute.mock.calls.length, narrationPreparations: prepareNarration.mock.calls.length,
      summaryReason: result?.manifest.reason, externalRequests: network.mock.calls.length }));
  } finally { controller?.dispose(); preparation.cancel(); }
});
