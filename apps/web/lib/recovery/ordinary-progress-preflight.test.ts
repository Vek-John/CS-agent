import { writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { createCoachAgentRuntime } from "@cs-coach/coach-agent";
import type { CoachAgentResult } from "@cs-coach/coach-agent/client";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import { emptyCueViewerReplay, twoCueViewerPlayer } from "../../../../tools/cs2d-host/viewer-two-cue-fixture";
import { buildInitialCoachingRouteState } from "../coaching/cs2d-route-integration";
import { CoachAgentStage3Controller } from "../coaching/coach-agent-stage3-controller";
import { CoachAgentStage3HostAdapter } from "../coaching/coach-agent-stage3-host-adapter";
import { guidedPlaybackDirective } from "../coaching/cs2d-guided-session";
import { buildSessionRecoveryRecord, buildCheckpointedRecoveryRecord, checkpointForRecoveryBoundary,
  createRecoverySessionIdentity, restoreRecoveryArtifacts, shouldReconnectRecoveryAgent } from "./cs2d-session-recovery";

afterEach(() => vi.unstubAllGlobals());

it("keeps ordinary progress separate from a recoverable boundary and measures synthetic replay work", async () => {
  const network = vi.fn(() => { throw Error("NETWORK_NOT_EXPECTED"); }); vi.stubGlobal("fetch", network);
  const replay = emptyCueViewerReplay();
  const analysis = buildCs2dAnalysisBundle({ replay, selectedSteamId: twoCueViewerPlayer, demoId: "synthetic-ordinary-progress", demoContentHash: "a".repeat(64) });
  const plan = analysis.review_plan, routeState = buildInitialCoachingRouteState(plan);
  expect(plan.cues).toEqual([]); expect(plan.segments).toHaveLength(7);
  const recoveryIdentity = createRecoverySessionIdentity();
  const base = { identity: recoveryIdentity, analysis, plan, routeState, narrationByCue: {}, demoContentHash: "a".repeat(64), selectedPlayerId: twoCueViewerPlayer, agentCheckpointId: null };
  let session = createCoachingSession(plan, recoveryIdentity.sessionId, routeState);
  const stable = buildSessionRecoveryRecord({ ...base, session, boundaryKind: "ROUTE_START" });
  const frozenStable = JSON.stringify(stable);
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  const identity = { ...base, sessionId: recoveryIdentity.sessionId, runId: recoveryIdentity.runId };
  let latest: CoachAgentResult | undefined;
  let observerCalls = 0;
  const post = vi.fn();
  const controller = new CoachAgentStage3Controller({ adapter: new CoachAgentStage3HostAdapter(),
    dispatch: async event => { expect(event.type).toBe("OBSERVE_SEGMENT"); observerCalls++; latest = await runtime.dispatch(event); return latest; },
    post, bridgeAvailable: () => true, isLive: () => false, onState: () => undefined,
  });
  const observedPhases = new Set<string>();
  try {
    session = reduceCoachingSession(plan, session, { type: "START" });
    let interrupted = false;
    for (let i = 0; i < plan.segments.length; i++) {
      const index = session.current_segment_index, segment = plan.segments[index];
      const mode = segment.mode === "SKIP" ? segment.reason_code === "FREEZE_TIME" ? "FREEZE" : "SKIP" : segment.mode;
      if (mode !== "FREEZE" && mode !== "SKIP" && mode !== "BRIEF" && mode !== "OBSERVE") throw Error("UNEXPECTED_CUE");
      controller.observeSegment(identity, segment.id, index, mode, session.phase === "SKIPPING" ? "SKIPPING" : "PLAYING");
      await vi.waitFor(() => expect(latest?.state.routeCursor).toBe(index));
      observedPhases.add(session.phase);
      if (session.phase === "PLAYING" && segment.start_tick >= replay.rounds[1].startTick) {
        session = reduceCoachingSession(plan, session, { type: "TICK", tick: Math.floor((segment.start_tick + segment.end_tick) / 2) });
        interrupted = true; break;
      }
      // All attempted kinds are existing production kinds, with the real current
      // Session. No invented phase, boundary or checkpoint is supplied.
      for (const boundaryKind of ["ROUTE_START", "CUE_PAUSED", "WRAP_UP"] as const)
        expect(() => buildSessionRecoveryRecord({ ...base, session, boundaryKind })).toThrow();
      const directive = guidedPlaybackDirective(plan, session, analysis.match_timeline.tick_rate);
      session = reduceCoachingSession(plan, session, directive.automaticAction ?? { type: "TICK", tick: segment.end_tick });
    }
    expect(interrupted).toBe(true); expect(session.phase).toBe("PLAYING");
    if (!latest) throw Error("MISSING_ACTUAL_GRAPH_CHECKPOINT");
    const checkpoint = { checkpointId: latest.checkpoint.checkpointId, activeCueId: latest.state.activeCueId,
      currentSessionPhase: latest.state.currentSessionPhase, routeCursor: latest.state.routeCursor, sessionStatus: latest.state.sessionStatus };
    expect(checkpoint.checkpointId).toBeTruthy(); expect(checkpoint.routeCursor).toBe(session.current_segment_index);
    expect(checkpoint.sessionStatus).toBe("ACTIVE");
    for (const boundaryKind of ["ROUTE_START", "CUE_PAUSED", "WRAP_UP"] as const)
      expect(() => buildCheckpointedRecoveryRecord({ ...base, session, boundaryKind }, checkpoint)).toThrow();
    expect(checkpointForRecoveryBoundary(checkpoint, stable.boundary)).toBeNull();
    expect(shouldReconnectRecoveryAgent(stable)).toBe(false);
    expect(JSON.stringify(stable)).toBe(frozenStable);
    const restored = restoreRecoveryArtifacts(stable);
    expect(restored.session.phase).toBe("INTRO"); expect(restored.session.current_segment_index).toBe(0);
    expect(restored.session.current_tick).toBe(plan.segments[0].start_tick);
    const restarted = reduceCoachingSession(plan, restored.session, { type: "START" });
    // Estimate only playback duration from the production directive's default
    // speed. Skip commands cost zero here; transport/loading/user delays excluded.
    const tickRate = analysis.match_timeline.tick_rate;
    let estimatedPlaybackSeconds = 0, playbackSegments = 0, skippedSegments = 0;
    for (const segment of plan.segments) {
      const elapsedTicks = Math.max(0, Math.min(session.current_tick, segment.end_tick) - segment.start_tick);
      if (!elapsedTicks) continue;
      if (segment.mode === "SKIP") { skippedSegments++; continue; }
      let replaySession = restarted;
      for (let i = 0; i < plan.segments.length && replaySession.current_segment_index < plan.segments.indexOf(segment); i++) {
        const current = plan.segments[replaySession.current_segment_index];
        const directive = guidedPlaybackDirective(plan, replaySession, tickRate);
        replaySession = reduceCoachingSession(plan, replaySession, directive.automaticAction ?? { type: "TICK", tick: current.end_tick });
      }
      expect(replaySession.current_segment_index).toBe(plan.segments.indexOf(segment));
      const speed = guidedPlaybackDirective(plan, replaySession, tickRate).commands.find(command => command.type === "setSpeed");
      if (!speed || speed.type !== "setSpeed") throw Error("MISSING_ACTUAL_DEFAULT_SPEED");
      estimatedPlaybackSeconds += elapsedTicks / tickRate / speed.speed; playbackSegments++;
    }
    const summary = { schemaVersion: "ordinary-progress-preflight.v1", synthetic: true, players: replay.players.length, rounds: replay.rounds.length,
      candidates: analysis.candidate_set.candidates.length, cues: plan.cues.length, routeSegments: plan.segments.length,
      interruptedSegmentIndex: session.current_segment_index, graphRouteCursor: checkpoint.routeCursor, graphObserverCalls: observerCalls,
      observedSessionPhases: [...observedPhases], recoveredBoundary: stable.boundary.kind, checkpointPromoted: false,
      fullyTraversedSegments: session.current_segment_index, partiallyTraversedSegments: 1,
      syntheticTimelineSecondsFromSavedBoundary: (session.current_tick - restored.session.current_tick) / tickRate,
      automaticInitialSkipSeconds: (restarted.current_tick - restored.session.current_tick) / tickRate,
      repeatedPlaybackSegments: playbackSegments, repeatedSkippedSegments: skippedSegments, estimatedReplayPlaybackSeconds: estimatedPlaybackSeconds,
      limitations: ["Two-player synthetic times, not parsed Demo ticks or a real-match estimate.", "Fake playback reports; real Session/directives/Controller/memory Graph.", "Estimate excludes loading, seeking, transport and user delays; no SQLite/head write is executed."] };
    expect(playbackSegments).toBeGreaterThan(0); expect(estimatedPlaybackSeconds).toBeGreaterThan(0);
    expect(post).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    const output = process.env.CS_COACH_ORDINARY_PROGRESS_OUTPUT;
    if (output) writeFileSync(output, JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  } finally { controller.dispose(); }
}, 60_000);
