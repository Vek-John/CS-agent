import {
  COACH_AGENT_EVENT_VERSION,
  COACH_AGENT_GRAPH_VERSION,
  COACH_AGENT_RECOVERY_VERSION,
  COACH_AGENT_SESSION_VERSION,
  COACH_AGENT_STATE_VERSION,
  SessionRecoveryRecordSchema,
  reconnectDispositionFromLedger,
  type CoachAgentEvent,
  type HostToolLedgerSummary,
  type PreparedNarrationArtifact,
  type SessionRecoveryRecord,
} from "@cs-coach/coach-agent/client";
import type {
  CoachingRouteState,
  CoachingSessionState,
  NarrationBundle,
  ReviewPlan,
} from "@cs-coach/contracts";
import type { Cs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import {
  captureSessionRecovery,
  rehydrateSessionRecovery,
  type SessionRecoveryBoundaryKind,
  type SessionRecoverySnapshot,
} from "@cs-coach/session";
import { buildStage3NarrationSummary } from "../coaching/coach-agent-stage3-host-adapter";
import {
  buildInitialCoachingRouteState,
  createCs2dReviewPreparationDependencies,
  type ReviewPreparationDependencies,
} from "../coaching/cs2d-route-integration";
import { assertValidReviewPlan } from "@cs-coach/review-planner";

export interface RecoverySessionIdentity {
  readonly recoveryId: string;
  readonly sessionId: string;
  readonly runId: string;
}

export interface RecoveryAgentCheckpointMeta {
  readonly checkpointId: string | null;
  readonly activeCueId: string | null;
  readonly currentSessionPhase: string;
  readonly routeCursor: number;
  readonly sessionStatus: "ACTIVE" | "TAKEN_OVER" | "CANCELLED" | "COMPLETED";
}

export function checkpointForRecoveryBoundary(
  meta: RecoveryAgentCheckpointMeta | undefined,
  boundary: SessionRecoveryRecord["boundary"],
): string | null {
  if (!meta?.checkpointId || boundary.kind === "ROUTE_START") return null;
  if (boundary.kind === "CUE_PAUSED") {
    return meta.activeCueId === boundary.cueId &&
      meta.currentSessionPhase === "PAUSED_FOR_COACHING" &&
      meta.routeCursor === boundary.segmentIndex
      ? meta.checkpointId
      : null;
  }
  return meta.sessionStatus === "COMPLETED" && meta.routeCursor === boundary.segmentIndex
    ? meta.checkpointId
    : null;
}

export interface RecoveryRecordInput {
  readonly identity: RecoverySessionIdentity;
  readonly demoContentHash: string;
  readonly selectedPlayerId: string;
  readonly plan: ReviewPlan;
  readonly routeState: CoachingRouteState;
  readonly session: CoachingSessionState;
  readonly boundaryKind: SessionRecoveryBoundaryKind;
  readonly narrationByCue: Readonly<Record<string, NarrationBundle>>;
  readonly analysis: Cs2dAnalysisBundle;
  readonly agentCheckpointId: string | null;
  readonly toolLedger?: readonly HostToolLedgerSummary[];
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export function assertCurrentRecoveryRecord(record: SessionRecoveryRecord): ReviewPlan {
  const plan = record.frozenReviewPlan as unknown as ReviewPlan;
  const directorVersion = plan.director_decision_set?.manifest.promptVersion ?? plan.generation_manifest.prompt_version;
  if (record.schemaVersion !== "session-recovery-record.v1" ||
    record.versions.graph !== COACH_AGENT_GRAPH_VERSION ||
    record.versions.agentState !== COACH_AGENT_STATE_VERSION ||
    record.versions.sessionSchema !== COACH_AGENT_SESSION_VERSION ||
    record.versions.reviewPlanSchema !== "review-plan.v1" ||
    record.versions.parser !== plan.generation_manifest.parser_version ||
    record.versions.planCompiler !== plan.planner_version ||
    record.versions.director !== directorVersion) {
    throw new Error("Recovery record versions do not match the current runtime and frozen plan.");
  }
  return plan;
}

function idPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 100) || "boundary";
}

export function createRecoverySessionIdentity(
  randomUuid: () => string = () => crypto.randomUUID(),
): RecoverySessionIdentity {
  return {
    recoveryId: `recovery-${randomUuid()}`,
    sessionId: `session-${randomUuid()}`,
    runId: `run-${randomUuid()}`,
  };
}

function boundaryId(recoveryId: string, boundary: SessionRecoverySnapshot["boundary"]): string {
  const suffix = boundary.kind === "CUE_PAUSED"
    ? `${boundary.kind}-${boundary.segmentIndex}-${boundary.cueId}`
    : `${boundary.kind}-${boundary.segmentIndex}`;
  return idPart(`${recoveryId}-${suffix}`);
}

export function projectRecoveryBoundary(
  recoveryId: string,
  boundary: SessionRecoverySnapshot["boundary"],
): SessionRecoveryRecord["boundary"] {
  if (boundary.kind === "ROUTE_START") {
    return { kind: "ROUTE_START", boundaryId: boundaryId(recoveryId, boundary), segmentIndex: 0 };
  }
  if (boundary.kind === "WRAP_UP") {
    return { kind: "WRAP_UP", boundaryId: boundaryId(recoveryId, boundary), segmentIndex: boundary.segmentIndex };
  }
  return {
    kind: "CUE_PAUSED",
    boundaryId: boundaryId(recoveryId, boundary),
    segmentId: boundary.segmentId,
    segmentIndex: boundary.segmentIndex,
    cueId: boundary.cueId,
    sessionPhase: "PAUSED_FOR_COACHING",
    outcomeGateStatus: "COMPLETE",
  };
}

function cueWindow(
  plan: ReviewPlan,
  routeState: CoachingRouteState,
  session: CoachingSessionState,
): readonly string[] {
  if (session.phase === "WRAP_UP" || session.phase === "COMPLETED") return [];
  const activeIndex = session.current_cue_id ? routeState.cueOrder.indexOf(session.current_cue_id) : 0;
  return routeState.cueOrder.slice(Math.max(0, activeIndex), Math.max(0, activeIndex) + 3)
    .filter((cueId) => plan.cues.some((cue) => cue.id === cueId));
}

export function buildRecoveryNarrationArtifacts(
  plan: ReviewPlan,
  routeState: CoachingRouteState,
  session: CoachingSessionState,
  narrationByCue: Readonly<Record<string, NarrationBundle>>,
): PreparedNarrationArtifact[] {
  return cueWindow(plan, routeState, session).flatMap((cueId) => {
    const narration = narrationByCue[cueId];
    const readiness = routeState.readiness[cueId];
    if (!narration || (readiness !== "READY" && readiness !== "FALLBACK")) return [];
    const presentable = session.phase === "PAUSED_FOR_COACHING" &&
      session.current_cue_id === cueId &&
      session.outcome_completion?.cueId === cueId &&
      session.outcome_completion.status === "COMPLETE";
    return [{
      cueId,
      readiness,
      presentation: presentable ? "PRESENTABLE" as const : "PREPARED" as const,
      narrationSummary: buildStage3NarrationSummary(narration, readiness),
    }];
  });
}

function recoveryVersions(plan: ReviewPlan, analysis: Cs2dAnalysisBundle): SessionRecoveryRecord["versions"] {
  return {
    parser: plan.generation_manifest.parser_version,
    analysisAdapter: analysis.metadata.adapter_version,
    candidateGenerator: analysis.candidate_set.generationManifest.candidateGeneratorVersion,
    director: plan.director_decision_set?.manifest.promptVersion ?? plan.generation_manifest.prompt_version,
    planCompiler: plan.planner_version,
    reviewPlanSchema: "review-plan.v1",
    sessionSchema: COACH_AGENT_SESSION_VERSION,
    graph: COACH_AGENT_GRAPH_VERSION,
    agentState: COACH_AGENT_STATE_VERSION,
  };
}

export function buildSessionRecoveryRecord(input: RecoveryRecordInput): SessionRecoveryRecord {
  const snapshot = captureSessionRecovery(input.plan, input.session, input.boundaryKind, input.routeState);
  const now = input.updatedAt ?? Date.now();
  return SessionRecoveryRecordSchema.parse({
    schemaVersion: "session-recovery-record.v1",
    status: "INCOMPLETE",
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    recoveryId: input.identity.recoveryId,
    sessionId: input.identity.sessionId,
    runId: input.identity.runId,
    demoContentHash: input.demoContentHash.toLowerCase(),
    selectedPlayerId: input.selectedPlayerId,
    routeId: input.plan.id,
    routeHash: input.routeState.routeFingerprint,
    versions: recoveryVersions(input.plan, input.analysis),
    frozenReviewPlan: snapshot.frozenPlan,
    routeReadiness: { ...input.routeState.readiness },
    boundary: projectRecoveryBoundary(input.identity.recoveryId, snapshot.boundary),
    cueProgress: {
      completedCueIds: [...input.session.consumed_cue_ids],
      consumedCueIds: [...input.session.consumed_cue_ids],
      revealedCueIds: [...input.session.revealed_cue_ids],
    },
    agentCheckpointId: input.agentCheckpointId,
    toolLedger: [...(input.toolLedger ?? [])].slice(-64),
    narrationArtifacts: buildRecoveryNarrationArtifacts(
      input.plan,
      input.routeState,
      input.session,
      input.narrationByCue,
    ),
  });
}

function narrationFromArtifact(plan: ReviewPlan, artifact: PreparedNarrationArtifact): NarrationBundle {
  const cue = plan.cues.find((candidate) => candidate.id === artifact.cueId);
  if (!cue?.candidate_id || cue.primary_focus_code !== artifact.narrationSummary.primaryFocusCode) {
    throw new Error("Stored narration identity does not match the frozen cue.");
  }
  const fields = artifact.narrationSummary.fields;
  return {
    cueId: cue.id,
    candidateId: cue.candidate_id,
    primaryFocusCode: cue.primary_focus_code,
    currentSituation: fields.currentSituation,
    playerAction: fields.playerAction,
    coreIssue: fields.coreIssue,
    betterPlay: fields.betterPlay,
    outcomeImpact: fields.outcomeImpact,
  };
}

export function restoreRecoveryArtifacts(record: SessionRecoveryRecord): {
  readonly plan: ReviewPlan;
  readonly routeState: CoachingRouteState;
  readonly session: CoachingSessionState;
  readonly narrationByCue: Readonly<Record<string, NarrationBundle>>;
} {
  const plan = assertCurrentRecoveryRecord(record);
  const narrationByCue = Object.fromEntries(record.narrationArtifacts.map((artifact) => [
    artifact.cueId,
    narrationFromArtifact(plan, artifact),
  ]));
  const preparedReadiness = Object.fromEntries(record.narrationArtifacts.map((artifact) => [artifact.cueId, artifact.readiness]));
  const initialRoute = buildInitialCoachingRouteState(plan, { readiness: preparedReadiness, narrationByCue });
  if (!initialRoute.routeFrozen || initialRoute.routeFingerprint !== record.routeHash || initialRoute.cueOrder.join("\0") !== plan.cues.map((cue) => cue.id).join("\0")) {
    throw new Error("Stored route does not match the frozen ReviewPlan.");
  }
  const routeState: CoachingRouteState = {
    ...initialRoute,
    consumedCueIds: [...record.cueProgress.consumedCueIds],
  };
  const snapshot: SessionRecoverySnapshot = {
    schemaVersion: "session-recovery-session.v1",
    sessionId: record.sessionId,
    routeFingerprint: record.routeHash,
    frozenPlan: plan,
    boundary: record.boundary.kind === "ROUTE_START"
      ? { kind: "ROUTE_START", segmentIndex: 0 }
      : record.boundary.kind === "WRAP_UP"
        ? { kind: "WRAP_UP", segmentIndex: record.boundary.segmentIndex }
        : {
            kind: "CUE_PAUSED",
            segmentId: record.boundary.segmentId,
            segmentIndex: record.boundary.segmentIndex,
            cueId: record.boundary.cueId,
          },
    consumedCueIds: [...record.cueProgress.consumedCueIds],
    revealedCueIds: [...record.cueProgress.revealedCueIds],
    expandedSegmentIds: [],
    narrationReadiness: { ...routeState.readiness },
  };
  return { plan, routeState, session: rehydrateSessionRecovery(snapshot, plan), narrationByCue };
}

export function normalizeRecoveryAnalysis(
  analysis: Cs2dAnalysisBundle,
  record: SessionRecoveryRecord,
): Cs2dAnalysisBundle {
  const plan = assertCurrentRecoveryRecord(record);
  if (analysis.demo_id !== plan.demo_id || analysis.match_timeline.demo_id !== plan.demo_id || analysis.candidate_set.demoId !== plan.demo_id) {
    throw new Error("Rebuilt analysis Demo identity does not match the frozen plan.");
  }
  const hash = analysis.metadata.demo_content_hash?.toLowerCase();
  if (hash !== record.demoContentHash.toLowerCase()) throw new Error("Analysis Demo hash does not match recovery record.");
  if (analysis.selected_steam_id !== record.selectedPlayerId || analysis.match_timeline.selected_player_id !== record.selectedPlayerId) {
    throw new Error("Analysis player does not match recovery record.");
  }
  if (analysis.match_timeline.timeline_version !== plan.match_timeline_version ||
    analysis.review_plan.generation_manifest.parser_version !== record.versions.parser ||
    analysis.metadata.adapter_version !== record.versions.analysisAdapter ||
    analysis.candidate_set.generationManifest.candidateGeneratorVersion !== record.versions.candidateGenerator ||
    analysis.review_plan.planner_version !== record.versions.planCompiler) {
    throw new Error("Analysis versions do not match recovery record.");
  }
  assertValidReviewPlan(analysis.match_timeline, plan);
  const candidates = new Map(analysis.candidate_set.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const materialIds = new Set(analysis.candidate_set.materials.map((material) => material.candidateId));
  for (const cue of plan.cues) {
    if (!cue.candidate_id) continue;
    const candidate = candidates.get(cue.candidate_id);
    if (!candidate || !materialIds.has(cue.candidate_id) || candidate.decisionTick !== cue.decision_tick ||
      candidate.revealTick !== cue.reveal_tick || candidate.outcomeEnd !== cue.outcome_end_tick) {
      throw new Error("Frozen cue candidate/tick binding does not match rebuilt analysis.");
    }
  }
  return analysis;
}

/** Narration-only recovery seam: route preparation validates and returns the frozen plan. */
export function createRecoveryReviewPreparationDependencies(
  analysis: Cs2dAnalysisBundle,
  record: SessionRecoveryRecord,
): ReviewPreparationDependencies {
  const normalized = normalizeRecoveryAnalysis(analysis, record);
  const plan = record.frozenReviewPlan as unknown as ReviewPlan;
  const narration = createCs2dReviewPreparationDependencies({
    candidateSet: normalized.candidate_set,
    observationEvidence: normalized.observation_evidence,
    matchTimeline: normalized.match_timeline,
    winProbabilityTimeline: normalized.win_probability_timeline,
    selectedPlayerId: normalized.selected_steam_id,
  });
  return {
    prepareRoute: async ({ inputPlan }) => {
      if (inputPlan.id !== plan.id || inputPlan.compiler_provenance?.route_fingerprint !== record.routeHash) {
        throw new Error("Recovery narration route does not match the frozen plan.");
      }
      assertValidReviewPlan(normalized.match_timeline, plan);
      return plan;
    },
    prepareNarration: narration.prepareNarration,
    ...(narration.fallbackNarration ? { fallbackNarration: narration.fallbackNarration } : {}),
  };
}

export function pendingRecoveryLedger(record: SessionRecoveryRecord): HostToolLedgerSummary | undefined {
  return [...record.toolLedger].reverse().find((entry) => entry.status !== "RESUMED");
}

/** Final persisted ledger truth after a successful RECONNECT_REPLAY. */
export function reconciledRecoveryLedger(record: SessionRecoveryRecord): HostToolLedgerSummary | undefined {
  const pending = pendingRecoveryLedger(record);
  if (!pending) return undefined;
  const result = pending.result ?? {
    callId: pending.callId,
    status: "CANCELLED" as const,
    observation: { code: "UNAVAILABLE" as const, completed: false },
    limitations: ["RECOVERY_PENDING_TOOL_CANCELLED"],
  };
  return {
    ...pending,
    status: "RESUMED",
    observationCode: result.observation.code,
    result,
  };
}

export function buildReconnectReplayEvent(record: SessionRecoveryRecord): Extract<CoachAgentEvent, { type: "RECONNECT_REPLAY" }> {
  assertCurrentRecoveryRecord(record);
  if (!record.agentCheckpointId) throw new Error("Recovery record has no Agent checkpoint.");
  const pending = pendingRecoveryLedger(record);
  return {
    version: COACH_AGENT_EVENT_VERSION,
    type: "RECONNECT_REPLAY",
    eventId: idPart(`reconnect-${record.recoveryId}-${record.boundary.boundaryId}`),
    identity: {
      runId: record.runId,
      sessionId: record.sessionId,
      demoId: (record.frozenReviewPlan as unknown as ReviewPlan).demo_id,
      demoContentHash: record.demoContentHash,
      selectedPlayerId: record.selectedPlayerId,
      routeId: record.routeId,
      routeHash: record.routeHash,
    },
    replayAvailability: "READY",
    expectedCheckpointId: record.agentCheckpointId,
    versions: {
      graph: COACH_AGENT_GRAPH_VERSION,
      state: COACH_AGENT_STATE_VERSION,
      session: COACH_AGENT_SESSION_VERSION,
      recovery: COACH_AGENT_RECOVERY_VERSION,
    },
    boundary: record.boundary,
    pendingToolDisposition: pending ? reconnectDispositionFromLedger(pending) : { status: "NONE" },
  };
}

export function shouldReconnectRecoveryAgent(record: SessionRecoveryRecord): boolean {
  return record.agentCheckpointId !== null;
}

/** Only an untouched route start may legitimately predate the first Agent checkpoint. */
export function isPreAgentRouteStartRecovery(record: SessionRecoveryRecord): boolean {
  return record.boundary.kind === "ROUTE_START" && record.agentCheckpointId === null;
}
