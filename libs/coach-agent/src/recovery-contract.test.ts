import { describe, expect, it } from "vitest";
import {
  FrozenReviewPlanSchema,
  reconnectDispositionFromLedger,
  SessionRecoveryEventSchema,
  SessionRecoveryRecordSchema,
  SessionRecoveryResultSchema,
} from "./recovery-contract";

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    demo_id: "demo-1",
    player_id: "player-1",
    status: "COMPLETE" as const,
    match_timeline_version: "timeline.v1",
    observation_version: "observation.v1",
    signal_version: "signal.v1",
    planner_version: "planner.v1",
    estimated_duration_seconds: 120,
    available_until_round: 24,
    full_match_index_ready: true,
    global_aggregation_ready: true,
    segments: [{ id: "segment-1" }],
    cues: [{ id: "cue-1" }],
    habit_clusters: [],
    generation_manifest: { model: "provider-metadata-only" },
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "session-recovery-record.v1",
    status: "INCOMPLETE" as const,
    createdAt: 1,
    updatedAt: 2,
    recoveryId: "recovery-1",
    sessionId: "session-1",
    runId: "run-1",
    demoContentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    selectedPlayerId: "player-1",
    routeId: "route-1",
    routeHash: "route-hash-1",
    versions: {
      parser: "parser.v1",
      analysisAdapter: "analysis.v1",
      candidateGenerator: "candidate.v1",
      director: "director.v1",
      planCompiler: "planner.v1",
      reviewPlanSchema: "review-plan.v1",
      sessionSchema: "session.v1",
      graph: "coach-agent-graph.v2",
      agentState: "coach-agent-state.v2",
    },
    frozenReviewPlan: plan(),
    routeReadiness: { "cue-1": "READY" },
    boundary: { kind: "CUE_PAUSED" as const, boundaryId: "boundary-1", segmentId: "segment-1", segmentIndex: 0, cueId: "cue-1", sessionPhase: "PAUSED_FOR_COACHING" as const, outcomeGateStatus: "COMPLETE" as const },
    cueProgress: { completedCueIds: [], consumedCueIds: [], revealedCueIds: [] },
    agentCheckpointId: "checkpoint-1",
    toolLedger: [],
    narrationArtifacts: [{
      cueId: "cue-1",
      readiness: "READY" as const,
      presentation: "PRESENTABLE" as const,
      narrationSummary: {
        primaryFocusCode: "POSITIONING",
        readiness: "READY" as const,
        limitationCount: 0,
        fields: {
          currentSituation: { text: "当前情况", refs: ["d1"], limitations: [] },
          playerAction: { text: "玩家动作", refs: ["a1"], limitations: [] },
          coreIssue: { text: "核心问题", refs: ["a1"], limitations: [] },
          betterPlay: { text: "已有建议", refs: ["v1"], limitations: [] },
          outcomeImpact: { text: "结果影响", refs: ["o1"], limitations: [] },
        },
      },
    }],
    ...overrides,
  };
}

describe("schema-only Session Recovery contracts", () => {
  it("accepts the bounded v1 record and strict reconnect lifecycle effects", () => {
    const initial = SessionRecoveryRecordSchema.parse(record());
    expect(initial).toMatchObject({
      schemaVersion: "session-recovery-record.v1",
      agentCheckpointId: "checkpoint-1",
    });
    expect(SessionRecoveryEventSchema.parse({ type: "BOOT", eventId: "event-boot" })).toBeTruthy();
    expect(SessionRecoveryEventSchema.parse({ type: "SESSION_STARTED", eventId: "event-session-started", record: initial })).toBeTruthy();
    const stableBoundaryUpdate = {
      type: "STABLE_BOUNDARY_REACHED" as const,
      eventId: "event-stable-boundary",
      recoveryId: initial.recoveryId,
      boundary: initial.boundary,
      cueProgress: initial.cueProgress,
      routeReadiness: initial.routeReadiness,
      narrationArtifacts: initial.narrationArtifacts,
      agentCheckpointId: "checkpoint-2",
      updatedAt: 3,
    };
    expect(SessionRecoveryEventSchema.parse(stableBoundaryUpdate)).toBeTruthy();
    const postedEntry = {
      callId: "call-posted-boundary",
      cueId: "cue-1",
      capabilityId: "cap-cue1-slow-replay",
      status: "POSTED" as const,
      observationCode: null,
      result: null,
    };
    expect(SessionRecoveryEventSchema.parse({
      ...stableBoundaryUpdate,
      eventId: "event-stable-boundary-with-posted-tool",
      toolLedgerEntry: postedEntry,
    })).toBeTruthy();
    expect(() => SessionRecoveryEventSchema.parse({
      ...stableBoundaryUpdate,
      eventId: "event-stable-boundary-with-resulted-tool",
      toolLedgerEntry: { ...postedEntry, status: "RESULTED" },
    })).toThrow();
    expect(SessionRecoveryEventSchema.parse({
      type: "STABLE_BOUNDARY_REACHED",
      eventId: "event-stable-boundary",
      recoveryId: initial.recoveryId,
      boundary: initial.boundary,
      cueProgress: initial.cueProgress,
      routeReadiness: initial.routeReadiness,
      narrationArtifacts: initial.narrationArtifacts,
      agentCheckpointId: "checkpoint-2",
      updatedAt: 3,
    })).toBeTruthy();
    const toolResult = {
      callId: "call-recovery-1",
      status: "SUCCEEDED" as const,
      observation: { code: "CUE_PLAYED" as const, completed: true },
      limitations: [],
    };
    expect(SessionRecoveryEventSchema.parse({
      type: "TOOL_LEDGER_UPDATED",
      eventId: "event-tool-ledger",
      recoveryId: initial.recoveryId,
      entry: {
        callId: toolResult.callId,
        cueId: "cue-1",
        capabilityId: "cap-cue1-slow-replay",
        status: "RESULTED",
        observationCode: "CUE_PLAYED",
        result: toolResult,
      },
      agentCheckpointId: "checkpoint-3",
      updatedAt: 4,
    })).toBeTruthy();
    expect(SessionRecoveryEventSchema.parse({ type: "RECOVERY_HANDSHAKE_COMPLETED", eventId: "event-handshake-complete", recoveryId: initial.recoveryId })).toBeTruthy();
    expect(SessionRecoveryEventSchema.parse({ type: "RECOVERY_HANDSHAKE_FAILED", eventId: "event-handshake-failed", recoveryId: initial.recoveryId, reason: "PLAYBACK_UNAVAILABLE", degraded: true })).toBeTruthy();
    expect(SessionRecoveryEventSchema.parse({
      type: "REPLAY_READY",
      eventId: "event-replay-ready",
      recoveryId: "recovery-1",
      replayAvailability: "READY",
      demoContentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      availablePlayerIds: ["player-1", "player-2"],
    })).toBeTruthy();
    expect(SessionRecoveryEventSchema.parse({
      type: "ANALYSIS_READY",
      eventId: "event-analysis-ready",
      recoveryId: "recovery-1",
      demoContentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      selectedPlayerId: "player-1",
      routeId: "route-1",
      routeHash: "route-hash-1",
      versions: { parser: "parser.v1", analysisAdapter: "analysis.v1", planner: "planner.v1" },
    })).toBeTruthy();
    expect(SessionRecoveryResultSchema.parse({
      schemaVersion: "session-recovery-runtime.v1",
      status: "READY",
      recoveryId: "recovery-1",
      record: null,
      effects: [
        { type: "SELECT_PLAYER", recoveryId: "recovery-1", playerId: "player-1" },
        { type: "SEEK_RECOVERY_BOUNDARY", recoveryId: "recovery-1", boundary: record().boundary },
      ],
      reason: null,
    })).toBeTruthy();
  });

  it("rejects non-SHA256 demos, oversized route readiness, replay bulk objects, and non-ready replay", () => {
    expect(() => FrozenReviewPlanSchema.parse(plan({ status: "FAILED" }))).toThrow();
    expect(() => SessionRecoveryRecordSchema.parse(record({ demoContentHash: "demo-hash" }))).toThrow();
    expect(() => SessionRecoveryRecordSchema.parse(record({ routeReadiness: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`cue-${index}`, "READY"])) }))).toThrow();
    expect(() => FrozenReviewPlanSchema.parse(plan({ generation_manifest: { modelWeights: new Uint8Array([1, 2]) } }))).toThrow();
    expect(() => SessionRecoveryEventSchema.parse({
      type: "REPLAY_READY",
      eventId: "event-not-ready",
      recoveryId: "recovery-1",
      replayAvailability: "LOADING",
      demoContentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      availablePlayerIds: [],
    })).toThrow();
  });

  it("retains the complete tool result and reconstructs reconnect without guessing", () => {
    const succeededResult = {
      callId: "call-1",
      status: "SUCCEEDED" as const,
      observation: { code: "CUE_PLAYED" as const, completed: true },
      limitations: [],
    };
    const persisted = SessionRecoveryRecordSchema.parse(record({
      toolLedger: [{
        callId: "call-1",
        cueId: "cue-1",
        capabilityId: "cap-cue1-slow-replay",
        status: "RESULTED" as const,
        observationCode: "CUE_PLAYED" as const,
        result: succeededResult,
      }],
    }));
    expect(persisted.toolLedger[0]?.result).toEqual(succeededResult);
    expect(reconnectDispositionFromLedger(persisted.toolLedger[0]!)).toEqual({
      status: "SUCCEEDED",
      callId: "call-1",
      result: succeededResult,
    });

    expect(() => SessionRecoveryRecordSchema.parse(record({
      toolLedger: [{
        callId: "call-2",
        cueId: "cue-1",
        capabilityId: "cap-cue1-slow-replay",
        status: "POSTED",
        observationCode: null,
        result: succeededResult,
      }],
    }))).toThrow();
    expect(() => SessionRecoveryRecordSchema.parse(record({
      toolLedger: [{
        callId: "call-3",
        cueId: "cue-1",
        capabilityId: "cap-cue1-slow-replay",
        status: "RESULTED",
        observationCode: "UNAVAILABLE",
        result: { ...succeededResult, callId: "call-3", status: "FAILED", observation: { code: "UNAVAILABLE", completed: false } },
      }],
    }))).toBeTruthy();
    expect(() => SessionRecoveryRecordSchema.parse(record({
      toolLedger: [{
        callId: "call-3-mismatch",
        cueId: "cue-1",
        capabilityId: "cap-cue1-slow-replay",
        status: "RESULTED",
        observationCode: "CUE_PLAYED",
        result: { ...succeededResult, callId: "call-3-mismatch", status: "FAILED", observation: { code: "UNAVAILABLE", completed: false } },
      }],
    }))).toThrow();

    const resumed = SessionRecoveryRecordSchema.parse(record({
      toolLedger: [{
        callId: "call-4",
        cueId: "cue-1",
        capabilityId: "cap-cue1-slow-replay",
        status: "RESUMED",
        observationCode: "CUE_PLAYED",
        result: { ...succeededResult, callId: "call-4" },
      }],
    }));
    expect(reconnectDispositionFromLedger(resumed.toolLedger[0]!)).toEqual({ status: "NONE" });
  });
});
