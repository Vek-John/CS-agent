import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionWrapUpResult } from "@cs-coach/coach-agent/client";
import { completeAndSaveSessionWrapUp } from "../coaching/session-wrap-up-completion";
import { sessionWrapUpPresentation, SessionWrapUpPanel } from "../coaching/session-wrap-up-presentation";
import { HistoryPersistenceController } from "./history-persistence-controller";
import { describe, expect, it, vi } from "vitest";
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
        { tick: 256, t: 4, players: [player("player-a", 256, 30), player("opponent", 256, 100)] },
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
  it("accepts legacy and visit-bound replay records while rejecting unbound identity and tick fields", () => {
    const { loaded, head } = fixture();
    const plan = loaded.artifacts.find(a => a.artifactType === "REVIEW_PLAN")!.payload as Record<string, JsonValue>;
    const cueId = (plan.cues as readonly Record<string, JsonValue>[])[0].id as string;
    const base = { reviewRevisionId: "revision-a", artifactType: "USER_INTERACTION" as const, artifactKey: "manual-replay-test", artifactRevision: 1, schemaVersion: "user-interaction.v1", idempotencyKey: "manual-replay-test" };
    const target = { sessionId: "session-a", cueId, visitId: "manual-uuid" };
    for (const action of [{ type: "REPLAY_OUTCOME" }, { type: "REPLAY_OUTCOME", target: { sessionId: "session-a", cueId } }, { type: "REPLAY_OUTCOME", target }]) {
      const payload = json({ action, sessionId: "session-a", cueId });
      expect(() => validateReviewArtifactAppend(loaded, { ...base, payload })).not.toThrow();
      expect(() => validateReadyRevisionArtifacts({ ...loaded, artifacts: [...loaded.artifacts, { ...loaded.artifacts[0], ...base, payload }] }, head)).not.toThrow();
    }
    for (const action of [
      { type: "REPLAY_OUTCOME", target: { ...target, sessionId: "other" } },
      { type: "REPLAY_OUTCOME", target: { ...target, cueId: "other" } },
      { type: "REPLAY_OUTCOME", target: { ...target, visitId: " " } },
      { type: "REPLAY_OUTCOME", target: { ...target, tick: 123 } },
      { type: "REPLAY_OUTCOME", tick: 123 },
    ]) expect(() => validateReviewArtifactAppend(loaded, { ...base, payload: json({ action, sessionId: "session-a", cueId }) })).toThrow(/replay/i);
  });
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


describe("Host summary save → validated artifact → history restore → actual panel", () => {
  it.each(["MISSING_SESSION_SUMMARY", "INVALID_PRESENTABLE_INPUT", "SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT", "NO_REPEATED_THEME", "CLOSED_SESSION_PROJECTION", "SAVED_DEEPSEEK", "LEGACY_MISSING"])("preserves %s without regeneration", async (reason) => {
    const { loaded, head } = fixture();
    const stored: ReviewArtifact[] = [...loaded.artifacts];
    const appendArtifact = vi.fn(async (reviewId, input) => {
      expect(reviewId).toBe("review-a");
      validateReviewArtifactAppend(loaded, {
        reviewRevisionId: input.revisionId, artifactType: input.artifactType, artifactKey: input.artifactKey,
        artifactRevision: input.artifactRevision, schemaVersion: input.schemaVersion,
        payload: json(input.payload), idempotencyKey: input.idempotencyKey,
      });
      stored.push({ ...stored[0], artifactId: "summary", reviewRevisionId: input.revisionId,
        artifactType: input.artifactType, artifactKey: input.artifactKey, schemaVersion: input.schemaVersion,
        artifactRevision: input.artifactRevision, payload: json(input.payload) });
    });
    const controller = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(), appendArtifact,
      commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
    controller.adopt("review-a", "revision-a", "managed-demo-a");
    let original: SessionWrapUpResult | undefined;
    const fetcher = vi.fn(() => { throw new Error("restore must not request generation"); });
    vi.stubGlobal("fetch", fetcher);
    try {
      if (reason === "CLOSED_SESSION_PROJECTION" || reason === "SAVED_DEEPSEEK") {
        const status = reason === "SAVED_DEEPSEEK" ? "SUCCEEDED" : "DISABLED";
        original = { status, bundle: { schemaVersion: "coach-agent-session-wrap-up.v1",
          themes: [{ focus: "saved", summary: { text: "旧总结正文", refs: ["saved-cue"] }, trainingAdvice: { text: "旧训练建议", refs: ["saved-advice"] } }], limitations: ["旧限定"] },
          manifest: { status, provider: status === "SUCCEEDED" ? "DEEPSEEK" : "DETERMINISTIC", reason, limitations: [] } };
        await controller.artifact("SESSION_SUMMARY", "session-summary", original, "session-wrap-up.v1");
      } else if (reason !== "LEGACY_MISSING") {
        await completeAndSaveSessionWrapUp({ persistence: controller, isCurrent: () => true,
          buildInput: () => {
            if (reason === "MISSING_SESSION_SUMMARY") return null;
            if (reason !== "NO_REPEATED_THEME") throw new Error(reason);
            return { summary: { schemaVersion: "coach-agent-session-summary.v1", themes: [], completedCues: [], limitations: [] }, presentableCues: {} };
          }, onRequest: vi.fn(), onResult: result => { original = result; }, onSaveError: () => { throw new Error("save unexpectedly failed"); },
        });
      }
      const writesBeforeRestore = appendArtifact.mock.calls.length;
      const restored = restoreHistoryControlPlane({
        review: { id: "review-a", demoId: "managed-demo-a", title: "saved", status: "COMPLETED", selectedPlayerId: "player-a" },
        revision: { id: "revision-a", status: "READY", artifactContractVersion: 2, routeId: head.routeId, routeHash: head.routeHash },
        artifacts: stored.map(a => ({ kind: a.artifactType, key: a.artifactKey, payload: a.payload })), runtimeHead: null,
      });
      const validated = validateStoredReviewArtifacts({ ...restored, selectedPlayerId: "player-a", demoContentHash: HASH });
      expect(validated.summary).toEqual(original ?? null);
      const presentation = sessionWrapUpPresentation(validated.summary);
      const html = renderToStaticMarkup(createElement(SessionWrapUpPanel, { ...presentation, result: validated.summary ?? undefined, phase: "WRAP_UP", onComplete: () => {} }));
      expect(html).toContain("完成本次复盘");
      if (reason === "LEGACY_MISSING") {
        expect(html).toContain("未保存");
        expect(html).toContain("无法确认");
        expect(html).not.toContain("未生成");
        expect(writesBeforeRestore).toBe(0);
      } else {
        expect(writesBeforeRestore).toBe(1);
        expect(appendArtifact.mock.calls[0][1]).toMatchObject({ revisionId: "revision-a", idempotencyKey: "revision-a:SESSION_SUMMARY:session-summary:v1" });
        if (["MISSING_SESSION_SUMMARY", "INVALID_PRESENTABLE_INPUT", "SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT"].includes(reason)) {
          expect(validated.summary).toMatchObject({ status: "FALLBACK", manifest: { reason, provider: "DETERMINISTIC" } });
          expect(html).toContain("未生成");
          expect(html).toContain("回看不受影响");
          expect(JSON.stringify(validated.summary)).not.toContain("NO_REPEATED_THEME");
        } else if (reason === "NO_REPEATED_THEME") expect(html).toContain("没有足够重复");
        else {
          expect(html).toContain("旧总结正文"); expect(html).toContain("旧训练建议"); expect(html).toContain("旧限定");
          expect(presentation).toEqual({ status: "READY", error: undefined });
        }
      }
      if (reason !== "NO_REPEATED_THEME") expect(html).not.toContain("没有足够重复");
      expect(appendArtifact).toHaveBeenCalledTimes(writesBeforeRestore);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
