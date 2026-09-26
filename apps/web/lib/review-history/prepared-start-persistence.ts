import type { CoachingRouteState, NarrationBundle, ReviewPlan } from "@cs-coach/contracts";
import { COACH_AGENT_GRAPH_VERSION, type SessionRecoveryRecord } from "@cs-coach/coach-agent/client";
import type { Cs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import type { HistoryPersistenceController } from "./history-persistence-controller";

export interface PreparedStartPersistenceInput {
  history: HistoryPersistenceController;
  plan: ReviewPlan;
  routeState: CoachingRouteState;
  record: SessionRecoveryRecord;
  analysis: Cs2dAnalysisBundle;
  narrationByCue: Readonly<Record<string, NarrationBundle>>;
  readRawAnalysis: () => unknown;
  isCurrent: () => boolean;
}

/** The desktop Host's ordered durable startup; raw analysis is read only at its original save boundary. */
export async function persistPreparedReviewStart(input: PreparedStartPersistenceInput): Promise<void> {
  const { history, plan, routeState, record, analysis } = input;
  const owner = history.ownershipGeneration;
  const assertCurrent = () => { if (!input.isCurrent() || history.ownershipGeneration !== owner) throw new Error("STALE_PREPARED_START"); };
  const step = async (operation: () => Promise<unknown>) => { assertCurrent(); await operation(); assertCurrent(); };
  // Bind the same ready content used by the initial recovery record before yielding.
  const narrations = Object.entries(input.narrationByCue).filter(([cueId]) => ["READY", "FALLBACK"].includes(record.routeReadiness[cueId]));
  for (const [cueId, readiness] of Object.entries(record.routeReadiness)) {
    if (["READY", "FALLBACK"].includes(readiness) && !narrations.some(([id]) => id === cueId)) throw new Error("START_NARRATION_MISSING");
  }
  await step(() => history.beginRevision({ routeId: plan.id, routeHash: routeState.routeFingerprint,
    analysisVersion: analysis.metadata.adapter_version, graphVersion: COACH_AGENT_GRAPH_VERSION,
    promptVersion: plan.director_decision_set?.manifest.promptVersion ?? plan.generation_manifest.prompt_version,
    modelMetadata: { directorStatus: plan.director_decision_set?.manifest.status ?? "UNKNOWN",
      directorProvider: plan.director_decision_set?.manifest.provider ?? "UNKNOWN",
      ...(plan.director_decision_set?.manifest.model ? { directorModel: plan.director_decision_set.manifest.model } : {}),
      parserVersion: plan.generation_manifest.parser_version, plannerVersion: plan.planner_version },
  }));
  await step(() => history.artifact("ANALYSIS_BUNDLE", analysis.demo_id, input.readRawAnalysis(), "cs2d-analysis-bundle.v1"));
  await step(() => history.artifact("CANDIDATE_SET", analysis.candidate_set.id, analysis.candidate_set, "candidate-set.v1"));
  await step(() => history.artifact("REVIEW_PLAN", plan.id, plan, "review-plan.v1"));
  for (const [cueId, narration] of narrations) {
    await step(() => history.artifact("NARRATION_BUNDLE", cueId, narration, "narration-bundle.v1"));
  }
  await step(() => history.artifact("SESSION_RECOVERY", record.boundary.boundaryId, record, "session-recovery-record.v2"));
  await step(() => history.stableHead({ recoveryArtifactKey: record.boundary.boundaryId, sessionId: record.sessionId, runId: record.runId,
    demoContentHash: record.demoContentHash, selectedPlayerId: record.selectedPlayerId, routeId: plan.id,
    routeHash: routeState.routeFingerprint, recoveryBoundary: "ROUTE_START", defaultRouteCursor: 0, completedCueCount: 0,
    totalCueCount: routeState.selectedCueCount, stableProgress: { routeFrozen: true, readiness: routeState.readiness } }));
}

/** Keep the existing background dependency, but never resolve it against a newly adopted owner. */
export async function persistNarrationAfterStart(input: {
  history: HistoryPersistenceController; durability: Promise<void>; isCurrent: () => boolean; cueId: string; narration: NarrationBundle;
}): Promise<void> {
  const { history } = input;
  const owner = history.ownershipGeneration;
  await input.durability;
  if (!input.isCurrent() || history.ownershipGeneration !== owner) return;
  await history.artifact("NARRATION_BUNDLE", input.cueId, input.narration, "narration-bundle.v1");
}
