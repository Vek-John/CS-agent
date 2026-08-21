import type {
  CandidateSet,
  CoachingRouteState,
  CueReadiness,
  DirectorDecisionSet,
  MatchTimeline,
  NarrationBundle,
  NarrationManifest,
  ObservableState,
  ReviewPlan,
  WinProbabilityTimelineV1
} from "@cs-coach/contracts";
import {
  buildCoachingRouteState,
  buildCoachingPackage,
  buildOutcomeImpactForCue,
  buildOutcomePackage,
  compileReviewPlan,
  deterministicDirectorFallback,
  mergeNarration,
  type NarrationMergeUpdate
} from "@cs-coach/review-planner";
import {
  requestTeachingDirector
} from "./deepseek-director";
import {
  buildNarratorRequestContext,
  requestNarrationBundle,
  type NarratorRequestContext
} from "./narrator-contract";

export interface RouteSnapshot {
  routeFingerprint: string;
  cueOrder: readonly string[];
  cueBindings: Readonly<Record<string, { candidateId: string; primaryFocusCode: string }>>;
  segmentShape: readonly { id: string; start_tick: number; end_tick: number; mode: ReviewPlan["segments"][number]["mode"] }[];
}

export interface PreparedNarrationState {
  readiness?: Readonly<Record<string, CueReadiness>>;
  narrationByCue?: Readonly<Record<string, NarrationBundle>>;
}

export interface NarrationPreparationRequest {
  generationId: string;
  cueId: string;
  candidateId: string;
  primaryFocusCode: string;
  routeFingerprint: string;
  cue: ReviewPlan["cues"][number];
  signal: AbortSignal;
}

export interface RoutePreparationRequest {
  generationId: string;
  /** Compact route input today; 02 will replace this with CandidateSet/packet input. */
  inputPlan: ReviewPlan;
  signal: AbortSignal;
}

export interface PreparedNarrationResult {
  readiness: Exclude<CueReadiness, "PENDING">;
  narration: NarrationBundle;
  manifest: NarrationManifest;
}

export interface ReviewPreparationDependencies {
  /** Director → PlanCompiler. The controller never treats the adapter plan as frozen by itself. */
  prepareRoute: (request: RoutePreparationRequest) => Promise<ReviewPlan>;
  /** Total adapter: DeepSeek failure is converted to a validated READY/FALLBACK result by 02. */
  prepareNarration: (request: NarrationPreparationRequest) => Promise<PreparedNarrationResult>;
  /** Optional explicit emergency fallback when the total adapter unexpectedly throws. */
  fallbackNarration?: (request: NarrationPreparationRequest, cause: string) => Promise<PreparedNarrationResult>;
}

export interface ReviewPreparationAnalysisInput {
  candidateSet: CandidateSet;
  observationEvidence: readonly ObservableState[];
  matchTimeline: MatchTimeline;
  winProbabilityTimeline: WinProbabilityTimelineV1;
  selectedPlayerId: string;
}

export interface ReviewPreparationProviderOverrides {
  director?: typeof requestTeachingDirector;
  narrator?: typeof requestNarrationBundle;
}

const MAX_DIRECTOR_CUES = 8;

/**
 * The real app seam: the adapter plan is only input.  Director and Compiler
 * return the sole plan that can become ROUTE_FROZEN; narration receives only
 * the final cue plus compact package inputs and never sees the Replay.
 */
export function createCs2dReviewPreparationDependencies(
  analysis: ReviewPreparationAnalysisInput,
  overrides: ReviewPreparationProviderOverrides = {}
): ReviewPreparationDependencies {
  const director = overrides.director ?? requestTeachingDirector;
  const narrator = overrides.narrator ?? requestNarrationBundle;
  return {
    prepareRoute: async ({ inputPlan, signal }) => {
      if (analysis.candidateSet.status === "FAILED") {
        throw new Error(`CANDIDATE_SET_FAILED:${analysis.candidateSet.failureReason ?? "UNKNOWN"}`);
      }
      const directorDecisionSet: DirectorDecisionSet = analysis.candidateSet.candidates.length === 0
        ? deterministicDirectorFallback(analysis.candidateSet, "NO_CANDIDATES", 0)
        : await director(analysis.candidateSet, { signal, maxSelected: MAX_DIRECTOR_CUES });
      const compiled = compileReviewPlan({
        timeline: analysis.matchTimeline,
        candidateSet: analysis.candidateSet,
        directorDecisionSet,
        planId: inputPlan.id,
        observationVersion: analysis.candidateSet.generationManifest.observationVersion,
        signalVersion: analysis.candidateSet.generationManifest.signalVersion,
        plannerVersion: inputPlan.planner_version,
        parserVersion: inputPlan.generation_manifest.parser_version,
        promptVersion: directorDecisionSet.manifest.promptVersion ?? inputPlan.generation_manifest.prompt_version,
        maxCues: MAX_DIRECTOR_CUES
      });
      return compiled.plan;
    },
    prepareNarration: async ({ cue, signal }) => {
      const coachingPackage = buildCoachingPackage(
        cue,
        analysis.candidateSet,
        analysis.observationEvidence
      );
      const outcomeImpact = buildOutcomeImpactForCue(
        cue,
        analysis.candidateSet,
        analysis.winProbabilityTimeline,
        analysis.matchTimeline,
        analysis.selectedPlayerId
      );
      const outcomePackage = buildOutcomePackage(cue, analysis.candidateSet, outcomeImpact);
      const context: NarratorRequestContext = buildNarratorRequestContext(coachingPackage, outcomePackage);
      const result = await narrator(context, { signal });
      return {
        readiness: result.status === "SUCCEEDED" ? "READY" : "FALLBACK",
        narration: result.bundle,
        manifest: result.manifest
      };
    }
  };
}

/**
 * Explicit seam state used while the Director → Compiler adapter is not
 * wired into this app entry point.  Keeping this as a rejecting dependency is
 * safer than treating the adapter's deterministic plan as ROUTE_FROZEN: the
 * caller can show a recoverable preparation error without allowing narration
 * to rewrite a route.
 */
export function createUnwiredReviewPreparationDependencies(): ReviewPreparationDependencies {
  return {
    prepareRoute: async () => {
      throw new Error("ROUTE_PREPARATION_NOT_WIRED");
    },
    prepareNarration: async () => {
      throw new Error("NARRATION_PREPARATION_NOT_WIRED");
    }
  };
}

export type ReviewPreparationEvent =
  | { type: "ROUTE_FROZEN"; generationId: string; plan: ReviewPlan; routeState: CoachingRouteState }
  | { type: "NARRATION_UPDATE"; generationId: string; cueId: string; result: PreparedNarrationResult; routeState: CoachingRouteState }
  | { type: "NARRATION_REJECTED"; generationId: string; cueId: string; reason: string; routeState: CoachingRouteState }
  | { type: "READY_TO_START"; generationId: string; plan: ReviewPlan; routeState: CoachingRouteState }
  | { type: "CANCELLED"; generationId: string };

export interface ReviewPreparationController {
  cancel(): void;
  run(onEvent: (event: ReviewPreparationEvent) => void): Promise<void>;
}

/**
 * Build the Host-owned route snapshot without giving narration permission to
 * replace the compiled plan. Missing narration is an explicit deterministic
 * PENDING, so the Session will wait at the natural boundary until the
 * deterministic or provider-owned bundle is explicitly merged.
 */
export function buildInitialCoachingRouteState(
  plan: ReviewPlan,
  prepared: PreparedNarrationState = {}
): CoachingRouteState {
  const hasMatchingBundle = (cue: ReviewPlan["cues"][number]): boolean => {
    const bundle = prepared.narrationByCue?.[cue.id];
    return Boolean(
      bundle &&
      cue.candidate_id &&
      cue.primary_focus_code &&
      bundle.cueId === cue.id &&
      bundle.candidateId === cue.candidate_id &&
      bundle.primaryFocusCode === cue.primary_focus_code
    );
  };
  const readiness: Record<string, CueReadiness> = Object.fromEntries(
    plan.cues.map((cue) => [
      cue.id,
      hasMatchingBundle(cue)
        ? (prepared.readiness?.[cue.id] ?? "READY")
        : "PENDING"
    ])
  );
  for (const cue of plan.cues) {
    const requested = prepared.readiness?.[cue.id];
    if ((requested === "READY" || requested === "FALLBACK") && !hasMatchingBundle(cue)) {
      readiness[cue.id] = "PENDING";
    }
  }
  const routeComplete = Boolean(plan.candidate_set_id && plan.compiler_provenance?.route_fingerprint);
  return buildCoachingRouteState(plan, routeComplete ? "COMPLETE" : "BUILDING", readiness);
}

function buildRoutePreparationFailureState(
  plan: ReviewPlan,
  prepared: PreparedNarrationState
): CoachingRouteState {
  const state = buildInitialCoachingRouteState(plan, prepared);
  return {
    ...state,
    routeFrozen: false,
    routeFingerprint: "",
    startable: false
  };
}

export function routeSnapshot(plan: ReviewPlan): RouteSnapshot {
  return {
    routeFingerprint: plan.compiler_provenance?.route_fingerprint ?? "",
    cueOrder: plan.cues.map((cue) => cue.id),
    cueBindings: Object.fromEntries(
      plan.cues
        .filter((cue): cue is typeof cue & { candidate_id: string; primary_focus_code: string } => Boolean(cue.candidate_id && cue.primary_focus_code))
        .map((cue) => [cue.id, { candidateId: cue.candidate_id, primaryFocusCode: cue.primary_focus_code }])
    ),
    segmentShape: plan.segments.map((segment) => ({ id: segment.id, start_tick: segment.start_tick, end_tick: segment.end_tick, mode: segment.mode }))
  };
}

/** Merge only per-cue readiness/bundle identity; route order and timing stay frozen. */
export function acceptNarrationUpdate(
  state: CoachingRouteState,
  update: NarrationMergeUpdate
): { accepted: true; reason?: string; state: CoachingRouteState } | { accepted: false; reason: string; state: CoachingRouteState } {
  return mergeNarration(state, update);
}

/**
 * Generation-scoped preparation seam. It owns ordering/cancellation only;
 * Director/Narrator implementations stay injected and receive no Replay.
 */
export function createReviewPreparationOrchestrator(
  generationId: string,
  plan: ReviewPlan,
  prepared: PreparedNarrationState = {},
  dependencies: ReviewPreparationDependencies
): ReviewPreparationController {
  const controller = new AbortController();
  let active = true;
  let compiledPlan: ReviewPlan | undefined;
  let routeState: CoachingRouteState | undefined;

  const resultIssue = (cue: ReviewPlan["cues"][number], result: PreparedNarrationResult): string | undefined => {
    if (result.narration.cueId !== cue.id || result.narration.candidateId !== cue.candidate_id || result.narration.primaryFocusCode !== cue.primary_focus_code) {
      return "NARRATION_IDENTITY_CHANGED";
    }
    if (result.readiness === "READY" && result.manifest.status !== "SUCCEEDED") return "NARRATION_MANIFEST_STATUS_MISMATCH";
    if (result.readiness === "FALLBACK" && result.manifest.status !== "FALLBACK" && result.manifest.status !== "DISABLED") return "NARRATION_MANIFEST_STATUS_MISMATCH";
    return undefined;
  };

  const emitIfActive = (onEvent: (event: ReviewPreparationEvent) => void, event: ReviewPreparationEvent): boolean => {
    if (!active || controller.signal.aborted) return false;
    onEvent(event);
    return true;
  };

  const prepareOne = async (cueId: string, onEvent: (event: ReviewPreparationEvent) => void): Promise<void> => {
    if (!active || controller.signal.aborted || !routeState || !compiledPlan || routeState.readiness[cueId] !== "PENDING") return;
    const requestRouteState = routeState;
    const cue = compiledPlan.cues.find((candidate) => candidate.id === cueId);
    if (!cue || !cue.candidate_id || !cue.primary_focus_code) return;
    const request: NarrationPreparationRequest = {
      generationId,
      cueId: cue.id,
      candidateId: cue.candidate_id,
      primaryFocusCode: cue.primary_focus_code,
      routeFingerprint: routeState.routeFingerprint,
      cue,
      signal: controller.signal
    };
    try {
      let result: PreparedNarrationResult;
      try {
        result = await dependencies.prepareNarration(request);
      } catch (error) {
        const cause = error instanceof Error ? error.message : "NARRATION_PROVIDER_ERROR";
        if (!dependencies.fallbackNarration) throw new Error(`NARRATION_PREPARATION_FAILED:${cause}`);
        result = await dependencies.fallbackNarration(request, cause);
      }
      if (!active || controller.signal.aborted) return;
      // First-window preparations resolve concurrently.  Read the latest
      // immutable route snapshot at merge time so cue B cannot overwrite cue
      // A's readiness with the stale initial map.
      const currentRouteState = routeState;
      if (!currentRouteState) return;
      const issue = resultIssue(cue, result);
      if (issue) {
        emitIfActive(onEvent, { type: "NARRATION_REJECTED", generationId, cueId: cue.id, reason: issue, routeState: currentRouteState });
        return;
      }
      const merged = acceptNarrationUpdate(currentRouteState, {
        cueId: cue.id,
        candidateId: cue.candidate_id,
        primaryFocusCode: cue.primary_focus_code,
        routeFingerprint: requestRouteState.routeFingerprint,
        readiness: result.readiness,
        narration: result.narration
      });
      if (!merged.accepted) {
        emitIfActive(onEvent, { type: "NARRATION_REJECTED", generationId, cueId: cue.id, reason: merged.reason, routeState: currentRouteState });
        return;
      }
      routeState = merged.state;
      emitIfActive(onEvent, { type: "NARRATION_UPDATE", generationId, cueId: cue.id, result, routeState });
    } catch (error) {
      if (!active || controller.signal.aborted) return;
      emitIfActive(onEvent, {
        type: "NARRATION_REJECTED",
        generationId,
        cueId,
        reason: error instanceof Error ? error.message : "NARRATION_PROVIDER_ERROR",
        routeState: routeState ?? buildInitialCoachingRouteState(plan, prepared)
      });
    }
  };

  return {
    cancel() {
      active = false;
      controller.abort();
    },
    async run(onEvent) {
      try {
        compiledPlan = await dependencies.prepareRoute({ generationId, inputPlan: plan, signal: controller.signal });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "ROUTE_PREPARATION_FAILED";
        emitIfActive(onEvent, {
          type: "NARRATION_REJECTED",
          generationId,
          cueId: "",
          reason,
          routeState: buildRoutePreparationFailureState(plan, prepared)
        });
        return;
      }
      if (!active || controller.signal.aborted || !compiledPlan) {
        emitIfActive(onEvent, { type: "CANCELLED", generationId });
        return;
      }
      routeState = buildInitialCoachingRouteState(compiledPlan, prepared);
      if (!routeState.routeFrozen) {
        emitIfActive(onEvent, { type: "NARRATION_REJECTED", generationId, cueId: "", reason: "ROUTE_NOT_FROZEN", routeState });
        return;
      }
      emitIfActive(onEvent, { type: "ROUTE_FROZEN", generationId, plan: compiledPlan, routeState });
      const firstWindow = routeState.cueOrder.slice(0, Math.min(2, routeState.selectedCueCount));
      await Promise.all(firstWindow.map((cueId) => prepareOne(cueId, onEvent)));
      if (!active || controller.signal.aborted) {
        emitIfActive(onEvent, { type: "CANCELLED", generationId });
        return;
      }
      if (routeState.startable) emitIfActive(onEvent, { type: "READY_TO_START", generationId, plan: compiledPlan, routeState });
      for (const cueId of routeState.cueOrder.slice(2)) {
        await prepareOne(cueId, onEvent);
        if (!active || controller.signal.aborted) {
          emitIfActive(onEvent, { type: "CANCELLED", generationId });
          return;
        }
      }
    }
  };
}
