import { describe, expect, it } from "vitest";
import { buildCs2dAnalysisBundle, type Cs2dReplay } from "@cs-coach/cs2d-analysis-adapter";
import type { CommitRuntimeHeadInput, JsonValue, LoadedReview, ReviewArtifact } from "@cs-coach/review-library";
import { createCoachingSession } from "@cs-coach/session";
import {
  buildCoachingPackage,
  buildOutcomeImpactForCue,
  buildOutcomePackage,
  deterministicNarrationBundle,
} from "@cs-coach/review-planner";
import { buildInitialCoachingRouteState } from "../coaching/cs2d-route-integration";
import { reflectionForSkip } from "../coaching/teaching-diagnosis-host";
import { buildSessionRecoveryRecord, createRecoverySessionIdentity, validateStoredReviewArtifacts } from "../recovery/cs2d-session-recovery";
import { validateReadyRevisionArtifacts, validateReviewArtifactAppend } from "./artifact-validation";
import { restoreHistoryControlPlane, type ReviewHistoryDetail } from "./history-restore-controller";

const HASH = "9".repeat(64);

function player(steamId: string, tick: number, health: number) {
  return {
    steamId,
    x: tick,
    y: tick + 20,
    z: 64,
    yaw: 90,
    health,
    alive: health > 0,
    side: steamId === "player-a" ? "T" as const : "CT" as const,
    weapon: steamId === "player-a" ? "AK-47" : "M4A1-S",
    lastPlaceName: "Connector",
    money: 4_000,
    equipValue: 5_000,
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
      { steamId: "player-a", name: "A", startSide: "T" },
      { steamId: "opponent", name: "B", startSide: "CT" },
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
        { tick: 64, t: 1, players: [player("player-a", 64, 100), player("opponent", 64, 100)] },
        { tick: 256, t: 4, players: [player("player-a", 256, 70), player("opponent", 256, 100)] },
        { tick: 352, t: 5.5, players: [player("player-a", 352, 0), player("opponent", 352, 100)] },
      ],
      events: [{
        type: "kill",
        tick: 352,
        t: 5.5,
        attackerSteamId: "opponent",
        victimSteamId: "player-a",
        assisterSteamId: null,
        assistedFlash: false,
        weapon: "M4A1-S",
        headshot: false,
        x: 352,
        y: 372,
        z: 64,
      }],
      grenadePaths: [],
    }],
  };
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function fixture(): { loaded: LoadedReview; head: CommitRuntimeHeadInput } {
  const analysis = buildCs2dAnalysisBundle({
    replay: replay(),
    selectedSteamId: "player-a",
    demoId: "parser-demo-a",
    demoContentHash: HASH,
    demoContentHashLatencyMs: 1,
  });
  const narrationByCue = Object.fromEntries(analysis.review_plan.cues.map((cue) => {
    const coaching = buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence);
    const impact = buildOutcomeImpactForCue(cue, analysis.candidate_set, analysis.win_probability_timeline, analysis.match_timeline, analysis.selected_steam_id);
    return [cue.id, deterministicNarrationBundle(coaching, buildOutcomePackage(cue, analysis.candidate_set, impact))];
  }));
  const readiness = Object.fromEntries(analysis.review_plan.cues.map((cue) => [cue.id, "READY" as const]));
  const route = buildInitialCoachingRouteState(analysis.review_plan, { narrationByCue, readiness });
  const identity = createRecoverySessionIdentity(() => "00000000-0000-4000-8000-000000000009");
  const session = createCoachingSession(analysis.review_plan, identity.sessionId, route);
  const recovery = buildSessionRecoveryRecord({
    identity,
    demoContentHash: HASH,
    selectedPlayerId: "player-a",
    plan: analysis.review_plan,
    routeState: route,
    session,
    boundaryKind: "ROUTE_START",
    narrationByCue,
    analysis,
    agentCheckpointId: null,
  });
  const createdAt = "2026-09-02T00:00:00.000Z";
  const artifacts: ReviewArtifact[] = [
    ["ANALYSIS_BUNDLE", "analysis", "cs2d-analysis-bundle.v1", analysis],
    ["CANDIDATE_SET", analysis.candidate_set.id, "candidate-set.v1", analysis.candidate_set],
    ["REVIEW_PLAN", analysis.review_plan.id, "review-plan.v1", analysis.review_plan],
    ...Object.entries(narrationByCue).map(([cueId, narration]) => ["NARRATION_BUNDLE", cueId, "narration-bundle.v1", narration]),
    ["SESSION_RECOVERY", recovery.boundary.boundaryId, "session-recovery-record.v2", recovery],
  ].map(([artifactType, artifactKey, schemaVersion, payload], index) => ({
    artifactId: `artifact-${index}`,
    reviewRevisionId: "revision-a",
    artifactType: artifactType as ReviewArtifact["artifactType"],
    artifactKey: artifactKey as string,
    artifactRevision: 1,
    schemaVersion: schemaVersion as string,
    checksum: "a".repeat(64),
    storageKind: "SQLITE_JSON",
    byteSize: 1,
    idempotencyKey: `artifact-${index}`,
    createdAt,
    payload: json(payload),
  }));
  const loaded: LoadedReview = {
    demo: { demoId: "managed-demo-a", contentHash: HASH, originalFilename: "match.dem", byteSize: 8, status: "READY", importedAt: createdAt, lastOpenedAt: createdAt },
    review: { reviewId: "review-a", demoId: "managed-demo-a", originalFilename: "match.dem", selectedPlayerId: "player-a", selectedPlayerName: "A", title: "Review", status: "PREPARING", completedCueCount: 0, totalCueCount: 0, createdAt, lastOpenedAt: createdAt, demoStatus: "READY" },
    revisions: [{ reviewRevisionId: "revision-a", reviewId: "review-a", analysisVersion: analysis.metadata.adapter_version, graphVersion: "coach-agent-graph.v3", promptVersion: analysis.review_plan.generation_manifest.prompt_version, modelMetadata: {}, routeId: analysis.review_plan.id, routeHash: route.routeFingerprint, status: "PREPARING", artifactContractVersion: 2, createdAt }],
    artifacts,
    artifactIssues: [],
  };
  return {
    loaded,
    head: {
      reviewId: "review-a",
      reviewRevisionId: "revision-a",
      recoveryArtifactKey: recovery.boundary.boundaryId,
      recoveryArtifactRevision: 1,
      sessionId: identity.sessionId,
      runId: identity.runId,
      demoId: "managed-demo-a",
      demoContentHash: HASH,
      selectedPlayerId: "player-a",
      routeId: analysis.review_plan.id,
      routeHash: route.routeFingerprint,
      recoveryBoundary: "ROUTE_START",
      defaultRouteCursor: 0,
      completedCueCount: 0,
      totalCueCount: analysis.review_plan.cues.length,
      stableProgress: {},
    },
  };
}

describe("Review artifact domain validation", () => {
  it("accepts a real current Analysis/Plan/Narration/Recovery set and rejects cross-boundary drift", () => {
    const { loaded, head } = fixture();
    expect(() => validateReadyRevisionArtifacts(loaded, head)).not.toThrow();
    expect(() => validateReadyRevisionArtifacts(loaded, { ...head, runId: "another-run" })).toThrow(/domain validation/u);
  });

  it("accepts the actual reflection interaction union and rejects an unknown cue", () => {
    const { loaded } = fixture();
    const plan = loaded.artifacts.find((artifact) => artifact.artifactType === "REVIEW_PLAN")!.payload as Record<string, JsonValue>;
    const cueId = (plan.cues as readonly Record<string, JsonValue>[])[0]!.id as string;
    const reflection = reflectionForSkip(cueId);
    const base = {
      reviewRevisionId: "revision-a",
      artifactType: "USER_INTERACTION" as const,
      artifactKey: "reflection-a",
      artifactRevision: 1,
      schemaVersion: "user-reflection.v1",
      idempotencyKey: "reflection-a",
    };
    expect(() => validateReviewArtifactAppend(loaded, {
      ...base,
      payload: json({ kind: "REFLECTION_SKIPPED", reflection }),
    })).not.toThrow();
    expect(() => validateReviewArtifactAppend(loaded, {
      ...base,
      artifactKey: "reflection-invalid",
      idempotencyKey: "reflection-invalid",
      payload: json({ kind: "DISAGREEMENT", reflection: { ...reflection, cueId: "unknown-cue" } }),
    })).toThrow(/unknown cue/u);
  });

  it("rejects a dependent artifact before AnalysisBundle and ReviewPlan exist", () => {
    const { loaded } = fixture();
    const emptyRevision = { ...loaded, artifacts: [] };
    expect(() => validateReviewArtifactAppend(emptyRevision, {
      reviewRevisionId: "revision-a",
      artifactType: "TOOL_RESULT",
      artifactKey: "tool-invalid",
      artifactRevision: 1,
      schemaVersion: "agent-tool-result.v1",
      payload: { notAToolResult: true },
      idempotencyKey: "tool-invalid",
    })).toThrow(/AnalysisBundle must be appended/u);
  });

  it("validates a completed v1 history restore using the embedded CandidateSet", () => {
    const { loaded, head } = fixture();
    const recovery = loaded.artifacts.find((artifact) => artifact.artifactType === "SESSION_RECOVERY")!;
    const detail: ReviewHistoryDetail = {
      review: {
        id: loaded.review.reviewId,
        demoId: loaded.review.demoId,
        title: loaded.review.title,
        status: "IN_PROGRESS",
        selectedPlayerId: loaded.review.selectedPlayerId,
        selectedPlayerName: loaded.review.selectedPlayerName,
      },
      revision: {
        id: "revision-a",
        status: "READY",
        artifactContractVersion: 1,
        routeId: head.routeId,
        routeHash: head.routeHash,
      },
      artifacts: loaded.artifacts
        .filter((artifact) => artifact.artifactType !== "CANDIDATE_SET")
        .map((artifact) => ({
          id: artifact.artifactId,
          kind: artifact.artifactType,
          key: artifact.artifactKey,
          revision: artifact.artifactRevision,
          createdAt: artifact.createdAt,
          payload: artifact.payload,
        })),
      runtimeHead: {
        ...head,
        recoveryArtifactId: recovery.artifactId,
        recoveryArtifactKey: recovery.artifactKey,
        recoveryArtifactRevision: recovery.artifactRevision,
        checkpointId: null,
      },
    };

    const restored = restoreHistoryControlPlane(detail);
    expect(restored.missingArtifacts).toEqual([]);
    expect(() => validateStoredReviewArtifacts({
      analysis: restored.analysis,
      candidateSet: restored.candidateSet,
      plan: restored.plan,
      narrationByCue: restored.narrationByCue,
      cueCases: restored.cueCases,
      learningThreads: restored.learningThreads,
      summary: restored.summary,
      selectedPlayerId: detail.review.selectedPlayerId,
      demoContentHash: HASH,
      routeId: detail.revision?.routeId,
      routeHash: detail.revision?.routeHash,
    })).not.toThrow();
  });
});
