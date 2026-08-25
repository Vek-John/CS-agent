import { describe, expect, it } from "vitest";
import {
  buildCs2dAnalysisBundle,
  type Cs2dReplay,
} from "@cs-coach/cs2d-analysis-adapter";
import { createCoachingSession } from "@cs-coach/session";
import { buildInitialCoachingRouteState } from "../coaching/cs2d-route-integration";
import type { CoachCue, NarrationBundle } from "@cs-coach/contracts";
import {
  buildReconnectReplayEvent,
  buildSessionRecoveryRecord,
  checkpointForRecoveryBoundary,
  createRecoverySessionIdentity,
  normalizeRecoveryAnalysis,
  restoreRecoveryArtifacts,
  isPreAgentRouteStartRecovery,
  shouldReconnectRecoveryAgent,
  shouldPersistToolTransitionToRecovery,
} from "./cs2d-session-recovery";

const HASH = "8".repeat(64);

function state(steamId: string, tick: number, health: number) {
  return {
    steamId,
    x: 100 + tick / 10,
    y: 200 + tick / 10,
    z: 64,
    yaw: 90,
    health,
    alive: health > 0,
    side: steamId === "dog" ? "T" as const : "CT" as const,
    weapon: steamId === "dog" ? "AK-47" : "M4A1-S",
    lastPlaceName: "Connector",
    money: 4200,
    equipValue: 5000,
    armor: 100,
    helmet: true,
    grenades: ["Smoke"],
  };
}

function replay(): Cs2dReplay {
  return {
    map: "de_mirage",
    demoTickRate: 64,
    frameRate: 8,
    players: [
      { steamId: "dog", name: "Dog", startSide: "T" },
      { steamId: "opponent", name: "Opponent", startSide: "CT" },
    ],
    rounds: [{
      number: 1,
      freezeStartTick: 0,
      startTick: 64,
      decidedTick: 640,
      endTick: 700,
      postEndTick: 760,
      winner: "CT",
      scoreCt: 0,
      scoreT: 0,
      frames: [
        { tick: 64, t: 1, players: [state("dog", 64, 100), state("opponent", 64, 100)] },
        { tick: 160, t: 2.5, players: [state("dog", 160, 100), state("opponent", 160, 100)] },
        { tick: 256, t: 4, players: [state("dog", 256, 70), state("opponent", 256, 100)] },
        { tick: 352, t: 5.5, players: [state("dog", 352, 0), state("opponent", 352, 100)] },
        { tick: 544, t: 8.5, players: [state("dog", 544, 0), state("opponent", 544, 100)] },
      ],
      events: [{
        type: "kill",
        tick: 352,
        t: 5.5,
        attackerSteamId: "opponent",
        victimSteamId: "dog",
        assisterSteamId: null,
        assistedFlash: false,
        weapon: "M4A1-S",
        headshot: false,
        x: 500,
        y: 300,
        z: 64,
      }],
      grenadePaths: [],
    }],
  };
}

function narration(cue: CoachCue): NarrationBundle {
  const ref = cue.observable_fact_refs[0] ?? cue.advice[0]?.id ?? "fixture-ref";
  const field = { text: "fixture narration", refs: [ref], limitations: [] };
  return {
    cueId: cue.id,
    candidateId: cue.candidate_id!,
    primaryFocusCode: cue.primary_focus_code!,
    currentSituation: field,
    playerAction: field,
    coreIssue: field,
    betterPlay: field,
    outcomeImpact: field,
  };
}

function fixture() {
  const analysis = buildCs2dAnalysisBundle({
    replay: replay(),
    selectedSteamId: "dog",
    demoId: "cs2d-local-demo",
    demoContentHash: HASH,
    demoContentHashLatencyMs: 1,
  });
  const narrationByCue = Object.fromEntries(analysis.review_plan.cues.map((cue) => [cue.id, narration(cue)]));
  const readiness = Object.fromEntries(analysis.review_plan.cues.map((cue) => [cue.id, "READY" as const]));
  const routeState = buildInitialCoachingRouteState(analysis.review_plan, { narrationByCue, readiness });
  const identity = createRecoverySessionIdentity(() => "00000000-0000-4000-8000-000000000001");
  const session = createCoachingSession(analysis.review_plan, identity.sessionId, routeState);
  return { analysis, narrationByCue, routeState, identity, session };
}

describe("cs2d recovery Host Adapter", () => {
  it("keeps manual tool transitions out of the stable RecoveryBoundary store", () => {
    expect(shouldPersistToolTransitionToRecovery("MANUAL")).toBe(false);
    expect(shouldPersistToolTransitionToRecovery("DEFAULT")).toBe(true);
  });
  it("builds and restores a bounded route-start record", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: "checkpoint-1",
      createdAt: 1,
      updatedAt: 2,
    });
    const restored = restoreRecoveryArtifacts(record);

    expect(record).toMatchObject({
      recoveryId: input.identity.recoveryId,
      sessionId: input.identity.sessionId,
      runId: input.identity.runId,
      boundary: { kind: "ROUTE_START", segmentIndex: 0 },
    });
    expect(restored.plan.id).toBe(input.analysis.review_plan.id);
    expect(restored.session).toMatchObject({ id: input.identity.sessionId, phase: "INTRO", current_segment_index: 0 });
    expect(Object.keys(restored.narrationByCue).length).toBeLessThanOrEqual(3);
  });

  it("accepts the same structured analysis and rejects identity, hash, player, route, and tick drift", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: "checkpoint-1",
    });

    expect(normalizeRecoveryAnalysis(input.analysis, record)).toBe(input.analysis);
    expect(() => normalizeRecoveryAnalysis({ ...input.analysis, demo_id: "other-demo" }, record)).toThrow("Demo identity");
    expect(() => normalizeRecoveryAnalysis({ ...input.analysis, metadata: { ...input.analysis.metadata, demo_content_hash: "f".repeat(64) } }, record)).toThrow("Demo hash");
    const { demo_content_hash: _missingHash, ...metadataWithoutHash } = input.analysis.metadata;
    expect(() => normalizeRecoveryAnalysis({ ...input.analysis, metadata: metadataWithoutHash }, record)).toThrow("Demo hash");
    expect(() => normalizeRecoveryAnalysis({ ...input.analysis, selected_steam_id: "opponent" }, record)).toThrow("player");
    expect(() => restoreRecoveryArtifacts({ ...record, routeHash: "other-route" })).toThrow("route");

    const cue = input.analysis.review_plan.cues[0]!;
    const candidates = input.analysis.candidate_set.candidates.map((candidate) => candidate.candidateId === cue.candidate_id
      ? { ...candidate, decisionTick: candidate.decisionTick + 1 }
      : candidate);
    expect(() => normalizeRecoveryAnalysis({
      ...input.analysis,
      candidate_set: { ...input.analysis.candidate_set, candidates },
    }, record)).toThrow("candidate/tick");
  });

  it("builds reconnect from the persisted random identity and exact checkpoint", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: "checkpoint-exact",
    });
    const reconnect = buildReconnectReplayEvent(record);

    expect(reconnect.identity).toMatchObject({
      runId: input.identity.runId,
      sessionId: input.identity.sessionId,
      demoId: "cs2d-local-demo",
      routeId: record.routeId,
      routeHash: record.routeHash,
    });
    expect(reconnect.expectedCheckpointId).toBe("checkpoint-exact");
    expect(reconnect.pendingToolDisposition).toEqual({ status: "NONE" });
    expect(() => buildReconnectReplayEvent({
      ...record,
      versions: { ...record.versions, graph: "coach-agent-graph.v999" },
    })).toThrow("versions");
  });

  it("keeps a pre-Agent ROUTE_START recovery out of Graph reconnect", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: null,
    });

    expect(shouldReconnectRecoveryAgent(record)).toBe(false);
    expect(isPreAgentRouteStartRecovery(record)).toBe(true);
    expect(() => buildReconnectReplayEvent(record)).toThrow("no Agent checkpoint");
  });

  it("does not accept a checkpointless mid-route boundary as a pre-Agent recovery", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: null,
    });
    const cue = input.analysis.review_plan.cues[0]!;
    const invalidMidRoute = {
      ...record,
      boundary: {
        kind: "CUE_PAUSED" as const,
        boundaryId: "boundary-cue",
        segmentId: cue.segment_id,
        segmentIndex: input.analysis.review_plan.segments.findIndex((segment) => segment.id === cue.segment_id),
        cueId: cue.id,
        sessionPhase: "PAUSED_FOR_COACHING" as const,
        outcomeGateStatus: "COMPLETE" as const,
      },
    };
    expect(shouldReconnectRecoveryAgent(invalidMidRoute)).toBe(false);
    expect(isPreAgentRouteStartRecovery(invalidMidRoute)).toBe(false);
  });

  it("never binds a previous cue checkpoint to the next paused boundary", () => {
    const boundary = {
      kind: "CUE_PAUSED" as const,
      boundaryId: "boundary-cue-2",
      segmentId: "segment-2",
      segmentIndex: 4,
      cueId: "cue-2",
      sessionPhase: "PAUSED_FOR_COACHING" as const,
      outcomeGateStatus: "COMPLETE" as const,
    };
    expect(checkpointForRecoveryBoundary({
      checkpointId: "checkpoint-cue-1",
      activeCueId: "cue-1",
      currentSessionPhase: "PAUSED_FOR_COACHING",
      routeCursor: 3,
      sessionStatus: "ACTIVE",
    }, boundary)).toBeNull();
    expect(checkpointForRecoveryBoundary({
      checkpointId: "checkpoint-cue-2",
      activeCueId: "cue-2",
      currentSessionPhase: "PAUSED_FOR_COACHING",
      routeCursor: 4,
      sessionStatus: "ACTIVE",
    }, boundary)).toBe("checkpoint-cue-2");
  });

  it("round-trips presented cues independently from consumed/completed progress", () => {
    const input = fixture();
    const cue = input.analysis.review_plan.cues[0]!;
    const session = {
      ...input.session,
      presented_cue_ids: [cue.id],
      consumed_cue_ids: [],
    };
    const record = buildSessionRecoveryRecord({
      ...input,
      session,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: null,
    });
    expect(record.cueProgress).toMatchObject({ presentedCueIds: [cue.id], completedCueIds: [], consumedCueIds: [] });
    expect(restoreRecoveryArtifacts(record).session.presented_cue_ids).toEqual([cue.id]);
  });

  it("binds WRAP_UP only to the completed checkpoint at the matching route cursor", () => {
    const boundary = {
      kind: "WRAP_UP" as const,
      boundaryId: "boundary-wrap-up",
      segmentIndex: 9,
    };
    expect(checkpointForRecoveryBoundary({
      checkpointId: "checkpoint-completed",
      activeCueId: "cue-last",
      currentSessionPhase: "PAUSED_FOR_COACHING",
      routeCursor: 9,
      sessionStatus: "COMPLETED",
    }, boundary)).toBe("checkpoint-completed");
    expect(checkpointForRecoveryBoundary({
      checkpointId: "checkpoint-active",
      activeCueId: "cue-last",
      currentSessionPhase: "WRAP_UP",
      routeCursor: 9,
      sessionStatus: "ACTIVE",
    }, boundary)).toBeNull();
    expect(checkpointForRecoveryBoundary({
      checkpointId: "checkpoint-previous-cue",
      activeCueId: "cue-last",
      currentSessionPhase: "PAUSED_FOR_COACHING",
      routeCursor: 8,
      sessionStatus: "COMPLETED",
    }, boundary)).toBeNull();
  });
});
