import { afterEach, expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachAgentRuntime } from "@cs-coach/coach-agent";
import { SessionRecoveryRecordSchema, type CoachAgentResult } from "@cs-coach/coach-agent/client";
import { createCoachingSession, reduceCoachingSession, captureSessionRecovery, rehydrateSessionRecovery } from "@cs-coach/session";
import { emptyCueViewerReplay, twoCueViewerReplay, twoCueViewerPlayer } from "../../../../tools/cs2d-host/viewer-two-cue-fixture";
import { buildInitialCoachingRouteState } from "../coaching/cs2d-route-integration";
import { CoachAgentStage3Controller } from "../coaching/coach-agent-stage3-controller";
import { CoachAgentStage3HostAdapter } from "../coaching/coach-agent-stage3-host-adapter";
import { guidedPlaybackDirective } from "../coaching/cs2d-guided-session";
import { buildRecoveryNarrationArtifacts, buildCheckpointedRecoveryRecord, buildReconnectReplayEvent, buildSessionRecoveryRecord, createRecoverySessionIdentity,
  restoreRecoveryArtifacts, type RecoveryAgentCheckpointMeta } from "./cs2d-session-recovery";

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  vi.stubGlobal("fetch", () => { throw Error("NETWORK_NOT_EXPECTED"); });
  const analysis = buildCs2dAnalysisBundle({ replay: emptyCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: "ordinary-recovery", demoContentHash: "a".repeat(64) });
  const plan = analysis.review_plan, routeState = buildInitialCoachingRouteState(plan), identity = createRecoverySessionIdentity();
  const base = { identity, analysis, plan, routeState, narrationByCue: {}, demoContentHash: "a".repeat(64), selectedPlayerId: twoCueViewerPlayer, agentCheckpointId: null };
  let session = reduceCoachingSession(plan, createCoachingSession(plan, identity.sessionId, routeState), { type: "START" });
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  let latest: CoachAgentResult | undefined;
  const controller = new CoachAgentStage3Controller({ adapter: new CoachAgentStage3HostAdapter(), post: () => { throw Error("TOOL_NOT_EXPECTED"); },
    dispatch: async event => { latest = await runtime.dispatch(event); return latest; }, bridgeAvailable: () => true, isLive: () => false, onState: () => undefined });
  try {
    for (let i = 0; i < plan.segments.length; i++) {
      const segment = plan.segments[session.current_segment_index];
      controller.observeSegment({ ...base, sessionId: identity.sessionId, runId: identity.runId }, segment.id, session.current_segment_index,
        segment.mode === "SKIP" ? "SKIP" : segment.mode === "BRIEF" ? "BRIEF" : "OBSERVE", session.phase === "SKIPPING" ? "SKIPPING" : "PLAYING");
      await vi.waitFor(() => expect(latest?.state.routeCursor).toBe(session.current_segment_index));
      if (segment.round_number === 2 && session.phase === "PLAYING") {
        session = reduceCoachingSession(plan, session, { type: "TICK", tick: segment.start_tick + 8 }); break;
      }
      const directive = guidedPlaybackDirective(plan, session);
      session = reduceCoachingSession(plan, session, directive.automaticAction ?? { type: "TICK", tick: segment.end_tick });
    }
    if (!latest) throw Error("NO_GRAPH_CHECKPOINT");
    const checkpoint: RecoveryAgentCheckpointMeta = { ...latest.state, checkpointId: latest.checkpoint.checkpointId };
    return { base, session, checkpoint, runtime, latest };
  } finally { controller.dispose(); }
}

it("round-trips a real ordinary Session to its frozen segment start and reconnects the exact Graph checkpoint", async () => {
  const { base, session, checkpoint, runtime } = await fixture();
  expect(base.plan.segments[session.current_segment_index].round_number).toBe(2);
  const snapshot = captureSessionRecovery(base.plan, session, "ORDINARY_SEGMENT", base.routeState);
  const restoredSession = rehydrateSessionRecovery(JSON.parse(JSON.stringify(snapshot)), base.plan);
  expect(restoredSession.current_tick).toBe(base.plan.segments[session.current_segment_index].start_tick);
  expect(restoredSession.current_tick).toBeLessThan(session.current_tick);
  expect(restoredSession.phase).toBe("PLAYING"); expect(restoredSession.current_cue_id).toBeUndefined();
  const record = buildCheckpointedRecoveryRecord({ ...base, session, boundaryKind: "ORDINARY_SEGMENT" }, checkpoint);
  if (!record) throw Error("NO_ORDINARY_RECORD");
  const read = SessionRecoveryRecordSchema.parse(JSON.parse(JSON.stringify(record)));
  expect(restoreRecoveryArtifacts(read).session).toEqual(restoredSession);
  const connected = await runtime.dispatch(buildReconnectReplayEvent(read));
  expect(connected.restored).toBe("MATCHED"); expect(connected.state.routeCursor).toBe(session.current_segment_index);
  expect(connected.state.currentSessionPhase).toBe("PLAYING");
});

it("rejects missing or mismatched ordinary checkpoint ownership and transient playback", async () => {
  const { base, session, checkpoint, runtime } = await fixture();
  const input = { ...base, session, boundaryKind: "ORDINARY_SEGMENT" as const };
  for (const mutation of [{ activeSegmentId: "other" }, { currentSegmentMode: "SKIP" }, { currentSessionPhase: "SKIPPING" },
    { routeCursor: checkpoint.routeCursor - 1 }, { runStatus: "WAITING_TOOL" }, { pendingToolCall: {} }, { pendingToolCall: undefined },
    { activeCueSource: "MANUAL" as const }, { activeManualVisitId: "visit" }, { sessionStatus: "TAKEN_OVER" as const }])
    expect(buildCheckpointedRecoveryRecord(input, { ...checkpoint, ...mutation })).toBeUndefined();
  expect(buildCheckpointedRecoveryRecord(input, undefined)).toBeUndefined();
  expect(buildCheckpointedRecoveryRecord(input, { ...checkpoint, activeCueId: "prior-cue" })).toBeDefined();
  for (const mutation of [{ phase: "SKIPPING" as const }, { current_tick: base.plan.segments[session.current_segment_index].end_tick }])
    expect(() => buildSessionRecoveryRecord({ ...input, session: { ...session, ...mutation } })).toThrow();
  const record = buildCheckpointedRecoveryRecord(input, checkpoint)!;
  const reconnect = buildReconnectReplayEvent(record);
  if (record.boundary.kind !== "ORDINARY_SEGMENT") throw Error("WRONG_BOUNDARY");
  expect((await runtime.dispatch({ ...reconnect, eventId: "wrong-ordinary-segment", boundary: { ...record.boundary, segmentId: "other" } })).restored).toBe("DORMANT_RECOVERY_MISMATCH");
  expect(() => SessionRecoveryRecordSchema.parse({ ...record, boundary: { ...record.boundary, segmentIndex: 0, segmentId: base.plan.segments[0].id } })).toThrow();
});


it("requires all prior cues consumed and forbids future cue progress in snapshots and records", () => {
  const analysis = buildCs2dAnalysisBundle({ replay: twoCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: "ordinary-with-cues" });
  const plan = analysis.review_plan, routeState = buildInitialCoachingRouteState(plan), identity = createRecoverySessionIdentity();
  expect(plan.cues).toHaveLength(2);
  // Ready narration is a Session transport prerequisite; teaching content is not
  // consumed by this reducer-only progress test.
  let session = reduceCoachingSession(plan, createCoachingSession(plan, identity.sessionId), { type: "START" });
  let found = false;
  for (let i = 0; i < 30; i++) {
    const segment = plan.segments[session.current_segment_index];
    if (session.phase === "PLAYING" && segment.cue_ids.length === 0 && session.consumed_cue_ids.length === 1) { found = true; break; }
    if (session.phase === "PAUSED_FOR_COACHING") {
      session = reduceCoachingSession(plan, session, { type: "CUE_PRESENTED", cueId: session.current_cue_id! });
      session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
    } else {
      const cue = plan.cues.find(c => c.id === session.current_cue_id);
      const directive = guidedPlaybackDirective(plan, session);
      session = reduceCoachingSession(plan, session, directive.automaticAction ?? { type: "TICK", tick: cue?.outcome_end_tick ?? segment.end_tick });
    }
  }
  expect(found).toBe(true);
  const snapshot = captureSessionRecovery(plan, session, "ORDINARY_SEGMENT");
  expect(rehydrateSessionRecovery(snapshot).consumed_cue_ids).toEqual([plan.cues[0].id]);
  expect(() => rehydrateSessionRecovery({ ...snapshot, consumedCueIds: [] })).toThrow("unconsumed");
  expect(() => rehydrateSessionRecovery({ ...snapshot, presentedCueIds: [...snapshot.presentedCueIds, plan.cues[1].id] })).toThrow("future progress");
  const input = { identity, analysis, plan, routeState, narrationByCue: {}, demoContentHash: "a".repeat(64), selectedPlayerId: twoCueViewerPlayer, agentCheckpointId: null, session, boundaryKind: "ORDINARY_SEGMENT" as const };
  const record = buildSessionRecoveryRecord(input);
  expect(() => SessionRecoveryRecordSchema.parse({ ...record, cueProgress: { ...record.cueProgress, consumedCueIds: [] } })).toThrow();
  expect(() => SessionRecoveryRecordSchema.parse({ ...record, cueProgress: { ...record.cueProgress, completedCueIds: [plan.cues[1].id] } })).toThrow();
  expect(() => SessionRecoveryRecordSchema.parse({ ...record, cueProgress: { ...record.cueProgress, presentedCueIds: [plan.cues[0].id, plan.cues[0].id] } })).toThrow();
});


it("selects future prepared narration beyond the three-item window (selector-only fixture)", () => {
  const analysis = buildCs2dAnalysisBundle({ replay: twoCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: "window-selector" });
  const original = analysis.review_plan, sourceCue = original.cues[0];
  const sourceNarration = deterministicNarrationBundle(buildCoachingPackage(sourceCue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(sourceCue, analysis.candidate_set));
  // This explicitly tests only bounded window selection, not plan compilation,
  // route hash validity or persistence. Those use natural plans above.
  const cues = [0, 1, 2, 3].map(index => ({ ...sourceCue, id: `window-cue-${index}`, segment_id: `window-segment-${index * 2}` }));
  const segments = cues.flatMap((cue, index) => [
    { ...original.segments[0], id: cue.segment_id, cue_ids: [cue.id] },
    { ...original.segments[1], id: `window-segment-${index * 2 + 1}`, cue_ids: [] },
  ]);
  const plan = { ...original, cues, segments };
  const narrationByCue = Object.fromEntries(cues.map(cue => [cue.id, { ...sourceNarration, cueId: cue.id }]));
  const route = buildInitialCoachingRouteState(plan, { narrationByCue });
  const session = { ...createCoachingSession(plan, "window-selector"), phase: "PLAYING" as const,
    current_segment_index: 5, consumed_cue_ids: cues.slice(0, 3).map(cue => cue.id) };
  expect(buildRecoveryNarrationArtifacts(plan, route, session, narrationByCue).map(item => item.cueId)).toEqual([cues[3].id]);
  expect(buildRecoveryNarrationArtifacts(plan, route, { ...session, current_segment_index: 7 }, narrationByCue)).toEqual([]);
});

it("fresh Controller adopts only its exact ordinary reconnect and continues beyond an already completed cue", async () => {
  const { startCueEvent } = await import("../../../../libs/coach-agent/src/test-fixtures");
  const { buildStage3Identity } = await import("../coaching/coach-agent-stage3-host-adapter");
  const { COACH_AGENT_GRAPH_VERSION, COACH_AGENT_STATE_VERSION } = await import("@cs-coach/coach-agent/client");
  const analysis = buildCs2dAnalysisBundle({ replay: twoCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: "fresh-controller-ordinary" });
  const plan = analysis.review_plan;
  const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set))]));
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue });
  const input = { plan, routeState, analysis, selectedPlayerId: twoCueViewerPlayer, demoContentHash: "a".repeat(64), sessionId: "fresh-ordinary-session", runId: "fresh-ordinary-run" };
  const identity = buildStage3Identity(input), runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  const adapter = new CoachAgentStage3HostAdapter();
  const firstCueIndex = plan.segments.findIndex(segment => segment.cue_ids.includes(plan.cues[0].id));
  const target = plan.segments.findIndex((segment, index) => index > firstCueIndex && segment.cue_ids.length === 0 && ["BRIEF", "OBSERVE"].includes(segment.mode));
  expect(target).toBeGreaterThan(firstCueIndex);
  let seeded: CoachAgentResult | undefined;
  for (let index = 0; index <= target; index++) {
    const segment = plan.segments[index];
    seeded = segment.cue_ids.length ? await runtime.dispatch(startCueEvent({ identity, capabilities: [], routeSegmentIndex: index,
      cueId: segment.cue_ids[0], segmentId: segment.id, eventId: `seed-cue-${index}` }))
      : await runtime.dispatch(adapter.createObserveSegmentEvent(input, segment.id, index, segment.mode === "SKIP" ? "SKIP" : segment.mode === "BRIEF" ? "BRIEF" : "OBSERVE", segment.mode === "SKIP" ? "SKIPPING" : "PLAYING", `seed-observe-${index}`));
  }
  if (!seeded?.checkpoint.checkpointId) throw Error("NO_SEEDED_CHECKPOINT");
  expect(seeded.state.completedCueIds).toContain(plan.cues[0].id);
  const event = { version: "coach-agent-event.v2" as const, type: "RECONNECT_REPLAY" as const, eventId: "ordinary-fresh-reconnect", identity,
    replayAvailability: "READY" as const, expectedCheckpointId: seeded.checkpoint.checkpointId,
    versions: { graph: COACH_AGENT_GRAPH_VERSION, state: COACH_AGENT_STATE_VERSION, session: "coaching-session.v2", recovery: "session-recovery-record.v2" },
    boundary: { kind: "ORDINARY_SEGMENT" as const, boundaryId: "ordinary-fresh-boundary", segmentId: plan.segments[target].id, segmentIndex: target, sessionPhase: "PLAYING" as const },
    pendingToolDisposition: { status: "NONE" as const } };
  const sent: import("@cs-coach/coach-agent/client").CoachAgentEvent[] = [];
  const liveAdapter = new CoachAgentStage3HostAdapter();
  const controller = new CoachAgentStage3Controller({ adapter: liveAdapter, dispatch: async next => { sent.push(next); return runtime.dispatch(next); },
    post: () => { throw Error("TOOL_NOT_EXPECTED"); }, bridgeAvailable: () => true, isLive: () => true });
  try {
    expect(controller.adoptRecoveredOrdinary(event, seeded)).toBe(false);
    const wrong = { ...event, eventId: "wrong-checkpoint", expectedCheckpointId: "wrong-checkpoint" };
    expect(controller.adoptRecoveredOrdinary(wrong, await controller.reconnect(wrong))).toBe(false);
    const result = await controller.reconnect(event);
    expect(controller.adoptRecoveredOrdinary({ ...event }, result)).toBe(false);
    expect(controller.adoptRecoveredOrdinary(event, result)).toBe(true);
    expect(liveAdapter.lifecycleCursor).toBe(target); expect(liveAdapter.lifecycleDegraded).toBe(false);
    const before = sent.length;
    controller.observeSegment(input, plan.segments[target].id, target, "BRIEF", "PLAYING");
    await Promise.resolve(); await Promise.resolve(); expect(sent).toHaveLength(before);
    let session = reduceCoachingSession(plan, createCoachingSession(plan, input.sessionId, routeState), { type: "START" });
    for (let count = 0; count < 30; count++) {
      if (session.phase === "PAUSED_FOR_COACHING" && session.current_cue_id === plan.cues[1].id) break;
      if (session.phase === "PAUSED_FOR_COACHING") {
        session = reduceCoachingSession(plan, session, { type: "CUE_PRESENTED", cueId: session.current_cue_id! });
        session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
      } else {
        const cue = plan.cues.find(item => item.id === session.current_cue_id), segment = plan.segments[session.current_segment_index], directive = guidedPlaybackDirective(plan, session);
        session = reduceCoachingSession(plan, session, directive.automaticAction ?? { type: "TICK", tick: cue?.outcome_end_tick ?? segment.end_tick });
      }
    }
    if (session.phase !== "PAUSED_FOR_COACHING" || !session.outcome_completion) throw Error("NO_SECOND_OUTCOME_GATE");
    const cue = plan.cues[1];
    const next = await controller.synchronizeDiagnosis({ ...input, cue, narration: narrationByCue[cue.id], generation: 1, tickRate: analysis.match_timeline.tick_rate,
      currentSessionPhase: session.phase, outcomeGate: session.outcome_completion,
      evidence: { candidate: analysis.candidate_set.candidates.find(c => c.candidateId === cue.candidate_id), material: analysis.candidate_set.materials.find(m => m.candidateId === cue.candidate_id), winProbabilityTimeline: analysis.win_probability_timeline } });
    expect(next?.state.activeCueId).toBe(cue.id); expect(liveAdapter.lifecycleDegraded).toBe(false);
    expect(sent.slice(before).filter(item => item.type === "OBSERVE_SEGMENT").every(item => item.segmentIndex > target)).toBe(true);
    expect(sent.slice(before).filter(item => item.type === "START_CUE").map(item => item.cueId)).toEqual([cue.id]);
    expect(session.presented_cue_ids).toEqual([plan.cues[0].id]);
    controller.reset(); expect(controller.adoptRecoveredOrdinary(event, result)).toBe(false);
  } finally { controller.dispose(); }
});
