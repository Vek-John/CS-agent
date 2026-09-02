import type {
  AppendArtifactInput,
  CommitRuntimeHeadInput,
  JsonValue,
  LoadedReview,
  ReviewArtifact,
  ReviewArtifactType,
} from "@cs-coach/review-library";
import { deserializeCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import {
  AgentToolResultSchema,
  CueCaseSchema,
  DiagnosticResultSchema,
  LearningThreadSchema,
  SessionRecoveryRecordSchema,
  SessionWrapUpResultSchema,
  TransferRuleSchema,
  UserReflectionSchema,
  type SessionRecoveryRecord,
} from "@cs-coach/coach-agent/client";
import {
  assertRecoveryMatchesActiveRevision,
  normalizeRecoveryAnalysis,
  restoreRecoveryArtifacts,
  validateStoredReviewArtifacts,
} from "../recovery/cs2d-session-recovery";

const SCHEMAS_BY_KIND = {
  ANALYSIS_BUNDLE: ["cs2d-analysis-bundle.v1"],
  CANDIDATE_SET: ["candidate-set.v1"],
  REVIEW_PLAN: ["review-plan.v1"],
  NARRATION_BUNDLE: ["narration-bundle.v1"],
  CUE_CASE: ["cue-case.v1"],
  DIAGNOSTIC_RESULT: ["diagnostic-result.v1"],
  TRANSFER_RULE: ["transfer-rule.v1"],
  LEARNING_THREAD: ["learning-thread.v1"],
  SESSION_RECOVERY: ["session-recovery-record.v2"],
  SESSION_SUMMARY: ["session-wrap-up.v1"],
  TOOL_RESULT: ["agent-tool-result.v1"],
  USER_INTERACTION: ["user-interaction.v1", "user-reflection.v1"],
} as const satisfies Record<ReviewArtifactType, readonly string[]>;

export class RevisionArtifactValidationError extends Error {
  readonly code = "REVISION_ARTIFACTS_INCOMPLETE";
}

const SESSION_ACTION_TYPES = new Set([
  "START", "TICK", "SEEK", "RETURN_TO_NEAREST_CUE", "BEGIN_MANUAL_CUE_VISIT",
  "CANCEL_MANUAL_CUE_VISIT", "RETURN_TO_DEFAULT_ROUTE", "CUE_PRESENTED",
  "NARRATION_READY", "SKIP_SEGMENT", "EXPAND_SKIP", "REVEAL_OUTCOME",
  "REPLAY_OUTCOME", "ADVANCE_SEGMENT", "QUESTION_ASKED", "RECORD_TEACHING_CASE",
  "CONFIRM_TEACHING_CASE", "COMPLETE_SESSION",
]);

type MaterializedArtifact = Pick<ReviewArtifact,
  "artifactType" | "artifactKey" | "artifactRevision" | "schemaVersion" | "createdAt" | "payload">;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function latestByKind(artifacts: readonly MaterializedArtifact[], kind: ReviewArtifactType): MaterializedArtifact | undefined {
  return artifacts.filter((artifact) => artifact.artifactType === kind && artifact.payload !== undefined).at(-1);
}

function latestByKey(artifacts: readonly MaterializedArtifact[], kind: ReviewArtifactType): Readonly<Record<string, unknown>> {
  const values = new Map<string, MaterializedArtifact>();
  for (const artifact of artifacts) {
    if (artifact.artifactType !== kind || artifact.payload === undefined) continue;
    const current = values.get(artifact.artifactKey);
    if (!current || artifact.artifactRevision >= current.artifactRevision) values.set(artifact.artifactKey, artifact);
  }
  return Object.fromEntries([...values].map(([key, artifact]) => [key, artifact.payload]));
}

function interaction(value: unknown, schemaVersion: string, cueIds: ReadonlySet<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid user interaction artifact.");
  const item = value as Record<string, unknown>;
  if (schemaVersion === "user-reflection.v1") {
    if (
      Object.keys(item).some((key) => key !== "kind" && key !== "reflection") ||
      (item.kind !== "REFLECTION" && item.kind !== "REFLECTION_SKIPPED" && item.kind !== "DISAGREEMENT")
    ) throw new Error("Invalid user reflection artifact.");
    const reflection = UserReflectionSchema.parse(item.reflection);
    if (!cueIds.has(reflection.cueId)) throw new Error("User reflection references an unknown cue.");
    return;
  }
  if (
    Object.keys(item).some((key) => key !== "action" && key !== "sessionId" && key !== "cueId") ||
    typeof item.sessionId !== "string" || !item.sessionId || item.sessionId.length > 160 ||
    (item.cueId !== null && (typeof item.cueId !== "string" || !item.cueId || item.cueId.length > 160)) ||
    !item.action || typeof item.action !== "object" || Array.isArray(item.action) ||
    typeof (item.action as Record<string, unknown>).type !== "string" ||
    !SESSION_ACTION_TYPES.has((item.action as Record<string, unknown>).type as string)
  ) throw new Error("Invalid user interaction artifact.");
}

function recoveryMatchesHead(record: SessionRecoveryRecord, head: CommitRuntimeHeadInput): boolean {
  const frozenPlan = record.frozenReviewPlan as { readonly cues?: readonly unknown[] };
  return record.sessionId === head.sessionId &&
    record.runId === head.runId &&
    record.demoContentHash === head.demoContentHash &&
    record.selectedPlayerId === head.selectedPlayerId &&
    record.routeId === head.routeId &&
    record.routeHash === head.routeHash &&
    record.agentCheckpointId === (head.checkpointId ?? null) &&
    record.boundary.kind === head.recoveryBoundary &&
    record.boundary.segmentIndex === head.defaultRouteCursor &&
    record.cueProgress.completedCueIds.length === head.completedCueCount &&
    Array.isArray(frozenPlan.cues) && frozenPlan.cues.length === head.totalCueCount &&
    (record.boundary.kind !== "CUE_PAUSED" || record.boundary.cueId === head.currentCueId);
}

function validateCollection(input: {
  readonly loaded: LoadedReview;
  readonly revisionId: string;
  readonly artifacts: readonly MaterializedArtifact[];
  readonly requireCritical: boolean;
  readonly appendType?: ReviewArtifactType;
  readonly head?: CommitRuntimeHeadInput;
}): void {
  const revision = input.loaded.revisions.find((item) => item.reviewRevisionId === input.revisionId);
  if (!revision || revision.reviewId !== input.loaded.review.reviewId) throw new Error("Revision does not belong to Review.");
  for (const artifact of input.artifacts) {
    if (!(SCHEMAS_BY_KIND[artifact.artifactType] as readonly string[]).includes(artifact.schemaVersion)) throw new Error("Artifact schema version is invalid.");
  }

  const analysisArtifact = latestByKind(input.artifacts, "ANALYSIS_BUNDLE");
  if (!analysisArtifact?.payload) {
    throw new Error("AnalysisBundle must be appended before dependent artifacts.");
  }
  const analysis = deserializeCs2dAnalysisBundle(JSON.stringify(analysisArtifact.payload));
  if (
    analysis.selected_steam_id !== input.loaded.review.selectedPlayerId ||
    analysis.metadata.demo_content_hash?.toLowerCase() !== input.loaded.demo.contentHash.toLowerCase()
  ) throw new Error("AnalysisBundle identity does not match Review.");

  const candidateArtifact = latestByKind(input.artifacts, "CANDIDATE_SET");
  if (candidateArtifact?.payload && stableJson(candidateArtifact.payload) !== stableJson(analysis.candidate_set)) {
    throw new Error("CandidateSet does not match AnalysisBundle.");
  }
  if (!candidateArtifact?.payload) {
    if (input.requireCritical || input.appendType !== "ANALYSIS_BUNDLE") {
      throw new Error("CandidateSet must be appended after AnalysisBundle.");
    }
    return;
  }

  const planArtifact = latestByKind(input.artifacts, "REVIEW_PLAN");
  if (!planArtifact?.payload) {
    if (
      input.requireCritical ||
      (input.appendType !== "ANALYSIS_BUNDLE" && input.appendType !== "CANDIDATE_SET")
    ) {
      throw new Error("ReviewPlan must be appended before session artifacts.");
    }
    return;
  }
  const narrationByCue = latestByKey(input.artifacts, "NARRATION_BUNDLE");
  const cueCases = latestByKey(input.artifacts, "CUE_CASE");
  const learningThreads = Object.values(latestByKey(input.artifacts, "LEARNING_THREAD"));
  const summary = latestByKind(input.artifacts, "SESSION_SUMMARY")?.payload ?? null;
  const validated = validateStoredReviewArtifacts({
    analysis,
    candidateSet: candidateArtifact?.payload,
    plan: planArtifact.payload,
    narrationByCue,
    cueCases,
    learningThreads,
    summary,
    selectedPlayerId: input.loaded.review.selectedPlayerId,
    demoContentHash: input.loaded.demo.contentHash,
    routeId: revision.routeId,
    routeHash: revision.routeHash,
  });

  const planCueIds = new Set(validated.plan.cues.map((cue) => cue.id));
  for (const artifact of input.artifacts) {
    if (artifact.payload === undefined) continue;
    if (artifact.artifactType === "DIAGNOSTIC_RESULT") DiagnosticResultSchema.parse(artifact.payload);
    if (artifact.artifactType === "TRANSFER_RULE") TransferRuleSchema.parse(artifact.payload);
    if (artifact.artifactType === "TOOL_RESULT") AgentToolResultSchema.parse(artifact.payload);
    if (artifact.artifactType === "USER_INTERACTION") interaction(
      artifact.payload,
      artifact.schemaVersion,
      planCueIds,
    );
    if (artifact.artifactType === "CUE_CASE") CueCaseSchema.parse(artifact.payload);
    if (artifact.artifactType === "LEARNING_THREAD") LearningThreadSchema.parse(artifact.payload);
    if (artifact.artifactType === "SESSION_SUMMARY") SessionWrapUpResultSchema.parse(artifact.payload);
  }

  const recoveryArtifacts = input.artifacts.filter((artifact) => artifact.artifactType === "SESSION_RECOVERY" && artifact.payload !== undefined);
  const recoveries = recoveryArtifacts.map((artifact) => ({
    artifact,
    record: SessionRecoveryRecordSchema.parse(artifact.payload),
  }));
  for (const { record } of recoveries) {
    normalizeRecoveryAnalysis(validated.analysis, record);
    restoreRecoveryArtifacts(record);
    assertRecoveryMatchesActiveRevision(record, validated.plan);
    for (const [cueId, readiness] of Object.entries(record.routeReadiness)) {
      if ((readiness === "READY" || readiness === "FALLBACK") && !validated.narrationByCue[cueId]) {
        throw new Error("A ready recovery cue is missing its NarrationBundle.");
      }
    }
  }
  if (input.requireCritical && recoveries.length === 0) throw new Error("SessionRecovery is required.");
  if (input.head) {
    const selected = recoveries.find(({ artifact }) =>
      artifact.artifactKey === input.head!.recoveryArtifactKey &&
      artifact.artifactRevision === input.head!.recoveryArtifactRevision);
    if (!selected || !recoveryMatchesHead(selected.record, input.head)) {
      throw new Error("RuntimeHead does not match its SessionRecovery artifact.");
    }
  }
}

export function validateReviewArtifactAppend(
  loaded: LoadedReview,
  input: AppendArtifactInput,
): void {
  if (!(SCHEMAS_BY_KIND[input.artifactType] as readonly string[]).includes(input.schemaVersion)) throw new Error("Artifact schema version is invalid.");
  const artifacts: MaterializedArtifact[] = loaded.artifacts
    .filter((artifact) => !(
      artifact.artifactType === input.artifactType &&
      artifact.artifactKey === input.artifactKey &&
      artifact.artifactRevision === input.artifactRevision
    ));
  artifacts.push({
    artifactType: input.artifactType,
    artifactKey: input.artifactKey,
    artifactRevision: input.artifactRevision,
    schemaVersion: input.schemaVersion,
    createdAt: new Date().toISOString(),
    payload: input.payload,
  });
  validateCollection({
    loaded,
    revisionId: input.reviewRevisionId,
    artifacts,
    requireCritical: false,
    appendType: input.artifactType,
  });
}

export function validateReadyRevisionArtifacts(
  loaded: LoadedReview,
  head: CommitRuntimeHeadInput,
): void {
  try {
    if (loaded.artifactIssues.length > 0) throw new Error("Revision contains unreadable artifacts.");
    validateCollection({
      loaded,
      revisionId: head.reviewRevisionId,
      artifacts: loaded.artifacts,
      requireCritical: true,
      head,
    });
  } catch (error) {
    const failure = new RevisionArtifactValidationError("Revision artifacts failed domain validation.");
    failure.cause = error;
    throw failure;
  }
}
