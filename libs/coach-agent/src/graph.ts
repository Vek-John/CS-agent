import {
  Annotation,
  END,
  interrupt,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import {
  AgentToolRequestSchema,
  AgentToolResultSchema,
  CoachAgentEventSchema,
  normalizeNarrationSummary,
  PolicyInputSchema,
  PolicyOutputSchema,
  PresentableCueSummarySchema,
  SessionSummaryInputSchema,
  SessionSummaryThemeSchema,
  TeachingMoveSchema,
  type AgentToolResult,
  type CoachAgentEvent,
  type CoachAgentIdentity,
  type CoachAgentState,
  type FallbackReason,
  type ObserveSegmentEvent,
  type ObservePresentedCueEvent,
  type PolicyInput,
  type PresentableCueSummary,
  type StartCueEvent,
  type StartManualCueVisitEvent,
  type SubmitDisagreementEvent,
  type SubmitReflectionEvent,
  type TeachingCapability,
  type TeachingCapabilityId,
  type TraceEntry,
} from "./types";
import { z } from "zod";
import {
  CueCaseSchema,
  LearningThreadSchema,
  TeachingDiagnosisInputSchema,
  TeachingDiagnosisOutputSchema,
  UserReflectionSchema,
  diagnoseTeachingCue,
  reviseTeachingDiagnosis,
} from "./teaching-diagnosis";
import { aggregateSessionThemes } from "./session-theme-aggregator";
import type { PolicyAdapter, PolicyTraceMeta } from "./adapters";
import { moveId, playbackCallId, stableInputHash } from "./identity";
import { deterministicPolicyOutput } from "./deterministic-policy";

export const CoachAgentGraphState = Annotation.Root({
  agent: Annotation<CoachAgentState>(),
  event: Annotation<CoachAgentEvent>(),
});

export type CoachAgentGraphStateValue = typeof CoachAgentGraphState.State;
type CueStartEvent = StartCueEvent | StartManualCueVisitEvent;

function identityFromState(state: CoachAgentState): CoachAgentIdentity {
  return {
    runId: state.runId,
    sessionId: state.sessionId,
    demoId: state.demoId,
    demoContentHash: state.demoContentHash,
    selectedPlayerId: state.selectedPlayerId,
    routeId: state.routeId,
    routeHash: state.routeHash,
  };
}

function sameIdentity(left: CoachAgentIdentity, right: CoachAgentIdentity): boolean {
  return (
    left.runId === right.runId &&
    left.sessionId === right.sessionId &&
    left.demoId === right.demoId &&
    left.demoContentHash === right.demoContentHash &&
    left.selectedPlayerId === right.selectedPlayerId &&
    left.routeId === right.routeId &&
    left.routeHash === right.routeHash
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function addFallbackReason(
  reasons: FallbackReason[],
  reason: FallbackReason,
): FallbackReason[] {
  return [...new Set([...reasons, reason])].slice(-8);
}

function appendTrace(
  state: CoachAgentState,
  node: TraceEntry["node"],
  eventId: string,
  options: {
    input?: unknown;
    selectedCapabilityId?: TeachingCapabilityId | null;
    evidenceRefs?: string[];
    toolResultStatus?: TraceEntry["toolResultStatus"];
    finalStatus?: TraceEntry["finalStatus"];
    latencyMs?: number | null;
    tokenCount?: number | null;
    provider?: string | null;
    model?: string | null;
    traceMeta?: PolicyTraceMeta | null;
    checkpointId?: string | null;
  } = {},
): CoachAgentState {
  const traceEntry: TraceEntry = {
    runId: state.runId,
    graphVersion: "coach-agent-graph.v3",
    node,
    cueId: state.activeCueId,
    inputHash: stableInputHash(options.input ?? {
      eventId,
      node,
      cueId: state.activeCueId,
      routeCursor: state.routeCursor,
      runStatus: state.runStatus,
    }),
    selectedCapabilityId: options.selectedCapabilityId ?? null,
    evidenceRefs: options.evidenceRefs ?? [],
    toolResultStatus: options.toolResultStatus ?? null,
    fallbackReasons: state.fallbackReasons,
    latencyMs: options.latencyMs ?? options.traceMeta?.latencyMs ?? null,
    tokenCount: options.tokenCount ?? options.traceMeta?.tokenCount ?? null,
    provider: options.provider ?? options.traceMeta?.provider ?? null,
    model: options.model ?? options.traceMeta?.model ?? null,
    checkpointId: options.checkpointId ?? state.lastStableCheckpoint.checkpointId,
    finalStatus: options.finalStatus ?? state.runStatus,
  };
  const trace = [...state.trace, traceEntry].slice(-64);
  return {
    ...state,
    trace,
    traceSummary: {
      entryCount: trace.length,
      lastNode: traceEntry.node,
      lastInputHash: traceEntry.inputHash,
      lastFinalStatus: traceEntry.finalStatus,
    },
  };
}

function presentableCueSummaryFor(event: CueStartEvent): PresentableCueSummary | undefined {
  if (event.outcomeGateStatus !== "COMPLETE" || !["READY", "FALLBACK"].includes(event.narrationReadiness)) {
    return undefined;
  }
  if (!event.presentableSummary) return undefined;
  return PresentableCueSummarySchema.parse(event.presentableSummary);
}

function completeCueWithSummary(
  state: CoachAgentState,
  summary: PresentableCueSummary | null | undefined,
): CoachAgentState {
  const completedCueIds = state.activeCueId
    ? [...new Set([...state.completedCueIds, state.activeCueId])].slice(-64)
    : state.completedCueIds;
  const activeBinding = summary && state.activeCueId && state.activeSegmentId && state.activeTargetSegmentIndex !== null
    ? { cueId: state.activeCueId, segmentId: state.activeSegmentId, segmentIndex: state.activeTargetSegmentIndex }
    : null;
  const presentedCueBindings = activeBinding && !state.presentedCueBindings.some((item) => item.cueId === activeBinding.cueId)
    ? [...state.presentedCueBindings, activeBinding].slice(-64)
    : state.presentedCueBindings;
  if (!summary || state.completedCueSummaries.some((item) => item.cueId === summary.cueId)) {
    return {
      ...state,
      runStatus: "CUE_COMPLETED",
      sessionStatus: "ACTIVE",
      completedCueIds,
      presentedCueBindings,
    };
  }
  const completedCueSummaries = [...state.completedCueSummaries, summary].slice(-64);
  return {
    ...state,
    runStatus: "CUE_COMPLETED",
    sessionStatus: "ACTIVE",
    completedCueIds,
    completedCueSummaries,
    presentedCueBindings,
    sessionThemes: aggregateSessionThemes(completedCueSummaries),
  };
}

function completeCueState(state: CoachAgentState, event: CueStartEvent): CoachAgentState {
  const completed = completeCueWithSummary(state, presentableCueSummaryFor(event));
  if (event.type !== "START_MANUAL_CUE_VISIT") return completed;
  return {
    ...completed,
    sessionStatus: "TAKEN_OVER",
    runStatus: "USER_TAKEOVER",
    activeCueSource: null,
    activeManualVisitId: null,
    selectedTeachingMove: null,
    pendingToolCall: null,
  };
}

function withWaitingTool(
  state: CoachAgentState,
  eventId: string,
  capability: TeachingCapability,
  source: "RULE" | "MODEL" | "FALLBACK",
  fallbackReasons: FallbackReason[],
  policyCalls: number,
  alternativeAttempts: number,
  graphStep: "tool-1" | "tool-2" = "tool-1",
  input?: unknown,
  traceMeta?: PolicyTraceMeta | null,
): CoachAgentState {
  const identity = identityFromState(state);
  const cueId = state.activeCueId;
  if (!cueId) throw new Error("a teaching move requires activeCueId");
  const callId = playbackCallId(identity, cueId, capability.capabilityId, graphStep);
  const move = TeachingMoveSchema.parse({
    moveId: moveId(identity, cueId, capability.capabilityId, graphStep),
    capabilityId: capability.capabilityId,
    tool: capability.tool,
    boundArgs: capability.boundArgs,
    evidenceRefs: capability.evidenceRefs,
    estimatedDurationMs: capability.estimatedDurationMs,
    source,
  });
  const pendingToolCall = AgentToolRequestSchema.parse({
    callId,
    runId: state.runId,
    cueId,
    capabilityId: capability.capabilityId,
    tool: capability.tool,
    evidenceRefs: capability.evidenceRefs,
  });
  const waiting = {
    ...state,
    runStatus: "WAITING_TOOL" as const,
    selectedTeachingMove: move,
    pendingToolCall,
    fallbackReasons,
    policyBudget: {
      ...state.policyBudget,
      policyCalls,
      alternativeAttempts,
    },
  };
  return appendTrace(waiting, "POLICY", eventId, {
    input,
    selectedCapabilityId: capability.capabilityId,
    evidenceRefs: capability.evidenceRefs,
    finalStatus: "WAITING_TOOL",
    traceMeta,
  });
}

function finishWithoutTool(
  state: CoachAgentState,
  eventId: string,
  fallbackReasons: FallbackReason[],
  policyCalls: number,
  alternativeAttempts: number,
  evidenceRefs: string[] = [],
  event?: CueStartEvent,
  markCompleted = true,
  input?: unknown,
  traceMeta?: PolicyTraceMeta | null,
): CoachAgentState {
  let nextState: CoachAgentState = {
    ...state,
    runStatus: "CUE_COMPLETED",
    selectedTeachingMove: null,
    pendingToolCall: null,
    fallbackReasons,
    policyBudget: {
      ...state.policyBudget,
      policyCalls,
      alternativeAttempts,
    },
    processedEventIds: [...state.processedEventIds, eventId].slice(-64),
  };
  if (markCompleted && event) nextState = completeCueState(nextState, event);
  else if (event?.type === "START_MANUAL_CUE_VISIT") {
    nextState = {
      ...nextState,
      sessionStatus: "TAKEN_OVER",
      runStatus: "USER_TAKEOVER",
      activeCueSource: null,
      activeManualVisitId: null,
    };
  }
  return appendTrace(nextState, "POLICY", eventId, {
    input,
    evidenceRefs,
    finalStatus: nextState.runStatus,
    traceMeta,
  });
}

function clockNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function policyTraceMeta(
  policy: PolicyAdapter,
  startedAt: number,
): PolicyTraceMeta {
  const adapterMeta = policy.consumeLastTraceMeta?.() ?? null;
  return {
    provider: adapterMeta?.provider ?? null,
    model: adapterMeta?.model ?? null,
    tokenCount: adapterMeta?.tokenCount ?? null,
    latencyMs: adapterMeta?.latencyMs ?? Math.max(0, Math.round(clockNow() - startedAt)),
  };
}

function matchingEvidenceRefs(outputRefs: string[], capability: TeachingCapability): boolean {
  const allowed = new Set(capability.evidenceRefs);
  return outputRefs.every((reference) => allowed.has(reference));
}

function matchingAllowedEvidenceRefs(outputRefs: string[], input: PolicyInput): boolean {
  const allowed = new Set(input.allowedEvidenceSummary.flatMap((summary) => summary.refs));
  return outputRefs.every((reference) => allowed.has(reference));
}

function policyInputFor(
  event: CueStartEvent,
  state: CoachAgentState,
  capabilities = event.capabilities,
): PolicyInput {
  return PolicyInputSchema.parse({
    cueId: event.cueId,
    focus: event.focus,
    narrationSummary: normalizeNarrationSummary(event.narrationSummary),
    allowedEvidenceSummary: event.allowedEvidenceSummary,
    phase: event.currentSessionPhase,
    outcomeGateStatus: event.outcomeGateStatus,
    capabilities: capabilities.map(
      ({ capabilityId, tool, evidenceRefs, estimatedDurationMs }) => ({
        capabilityId,
        tool,
        evidenceRefs,
        estimatedDurationMs,
      }),
    ),
    toolObservations: state.toolHistory,
    themes: state.sessionThemes,
    ...(event.memoryBrief ? { memoryBrief: event.memoryBrief } : {}),
    limitations: event.limitations,
    budget: state.policyBudget,
    maxMoves: 1,
  });
}

function observePresentedCueState(
  state: CoachAgentState,
  event: ObservePresentedCueEvent,
): CoachAgentState {
  return appendTrace(
    {
      ...state,
      sessionStatus: "ACTIVE",
      runStatus: "CUE_COMPLETED",
      currentSessionPhase: event.currentSessionPhase,
      activeSegmentId: event.segmentId,
      activeCueId: event.cueId,
      activeCueSource: "DEFAULT",
      activeManualVisitId: null,
      activeTargetSegmentIndex: event.segmentIndex,
      routeCursor: event.segmentIndex,
      observedSegmentIds: [...new Set([...state.observedSegmentIds, event.segmentId])].slice(-128),
      selectedTeachingMove: null,
      pendingToolCall: null,
      processedEventIds: [...state.processedEventIds, event.eventId].slice(-64),
    },
    "ROUTE",
    event.eventId,
    { input: event, finalStatus: "CUE_COMPLETED" },
  );
}

function policyInputForState(
  state: CoachAgentState,
  capabilities: TeachingCapability[],
): PolicyInput | undefined {
  if (!state.activeCueId || !state.activeFocus || !state.activeNarrationPolicySummary) return undefined;
  return PolicyInputSchema.parse({
    cueId: state.activeCueId,
    focus: state.activeFocus,
    narrationSummary: state.activeNarrationPolicySummary,
    allowedEvidenceSummary: state.activeAllowedEvidenceSummary,
    phase: state.currentSessionPhase,
    outcomeGateStatus: state.outcomeGateStatus,
    capabilities: capabilities.map(({ capabilityId, tool, evidenceRefs, estimatedDurationMs }) => ({
      capabilityId,
      tool,
      evidenceRefs,
      estimatedDurationMs,
    })),
    toolObservations: state.toolHistory,
    themes: state.sessionThemes,
    ...(state.memoryBrief ? { memoryBrief: state.memoryBrief } : {}),
    limitations: [],
    budget: state.policyBudget,
    maxMoves: 1,
  });
}

function observeSegmentState(
  state: CoachAgentState,
  event: ObserveSegmentEvent,
): CoachAgentState {
  if (state.observedSegmentIds.includes(event.segmentId)) {
    return appendTrace(
      { ...state, processedEventIds: [...state.processedEventIds, event.eventId].slice(-64) },
      "ROUTE",
      event.eventId,
      { input: event, finalStatus: state.runStatus },
    );
  }
  if (event.segmentIndex !== state.routeCursor + 1) {
    const rejected = {
      ...state,
      fallbackReasons: addFallbackReason(state.fallbackReasons, "ROUTE_ORDER_MISMATCH"),
      processedEventIds: [...state.processedEventIds, event.eventId].slice(-64),
    };
    return appendTrace(rejected, "ROUTE", event.eventId, {
      input: event,
      finalStatus: state.runStatus,
    });
  }
  return appendTrace(
    {
      ...state,
      runStatus: "CUE_COMPLETED",
      currentSessionPhase: event.currentSessionPhase,
      activeSegmentId: event.segmentId,
      currentSegmentMode: event.mode,
      routeCursor: event.segmentIndex,
      observedSegmentIds: [...state.observedSegmentIds, event.segmentId].slice(-128),
      processedEventIds: [...state.processedEventIds, event.eventId].slice(-64),
    },
    "ROUTE",
    event.eventId,
    { input: event, finalStatus: "CUE_COMPLETED" },
  );
}

type DiagnosisSubmissionEvent = SubmitReflectionEvent | SubmitDisagreementEvent;

/**
 * Reflection can be the first event observed by the graph when the Host's
 * START_CUE checkpoint was lost or was never written.  Only the exact state
 * emitted by runtime.emptyState is eligible: no route progress, cue case,
 * tool, or playback metadata may be revived by this path.
 */
function isFreshDiagnosisState(
  state: CoachAgentState,
  event: SubmitReflectionEvent,
): boolean {
  if (!sameIdentity(identityFromState(state), event.identity)) return false;
  return (
    state.sessionStatus === "ACTIVE" &&
    state.runStatus === "RUNNING" &&
    state.activeSegmentId === null &&
    state.activeCueId === null &&
    state.activeCueSource === null &&
    state.activeManualVisitId === null &&
    state.activeTargetSegmentIndex === null &&
    state.routeCursor === -1 &&
    state.currentSegmentMode === null &&
    state.activeFocus === null &&
    state.activeNarrationPolicySummary === null &&
    state.activeAllowedEvidenceSummary.length === 0 &&
    state.activePresentableCueSummary == null &&
    state.observedSegmentIds.length === 0 &&
    state.currentSessionPhase === "INTRO" &&
    state.outcomeGateStatus === "NOT_APPLICABLE" &&
    state.narrationReadiness === "NOT_REQUIRED" &&
    state.availableCapabilities.length === 0 &&
    state.selectedTeachingMove === null &&
    state.pendingToolCall === null &&
    state.toolHistory.length === 0 &&
    state.completedCueIds.length === 0 &&
    state.completedCueSummaries.length === 0 &&
    state.presentedCueBindings.length === 0 &&
    Object.keys(state.cueCases).length === 0 &&
    state.learningThreads.length === 0 &&
    state.sessionThemes.length === 0 &&
    state.summaryThemes.length === 0 &&
    state.sessionSummaryInput === null &&
    state.sessionSummaryFallback === null &&
    state.policyBudget.policyCalls === 0 &&
    state.policyBudget.alternativeAttempts === 0 &&
    (state.fallbackReasons.length === 0 || state.fallbackReasons.every((reason) => reason === "IDB_FALLBACK")) &&
    state.lastStableCheckpoint.checkpointId === null &&
    state.lastStableCheckpoint.sequence === 0 &&
    state.traceSummary.entryCount === 0 &&
    state.traceSummary.lastNode === null &&
    state.traceSummary.lastInputHash === null &&
    state.traceSummary.lastFinalStatus === null &&
    state.processedEventIds.length === 0 &&
    state.trace.length === 0 &&
    state.lastToolResult === null
  );
}

function bootstrapDiagnosisState(
  state: CoachAgentState,
  event: DiagnosisSubmissionEvent,
): CoachAgentState {
  if (
    event.type !== "SUBMIT_REFLECTION" ||
    event.outcomeGateStatus !== "COMPLETE" ||
    event.input.cueId !== event.cueId ||
    event.reflection.cueId !== event.cueId ||
    ("reflection" in event.input && event.input.reflection.cueId !== event.cueId) ||
    !isFreshDiagnosisState(state, event)
  ) {
    return state;
  }
  return {
    ...state,
    // These are the only session fields a diagnosis submission may establish.
    // In particular, do not copy route indices, segment IDs, ticks, or visual
    // capabilities from the diagnosis packet.
    activeCueId: event.cueId,
    currentSessionPhase: "PAUSED_FOR_COACHING",
    outcomeGateStatus: "COMPLETE",
  };
}

/**
 * A Host may move directly from one completed diagnosis to the next one
 * without sending a visual START_CUE.  This is deliberately a narrow state
 * transition: only a fully completed, non-taken-over cue may be rebound, and
 * only the diagnosis-owned cue/phase fields are established.  Route position,
 * ticks, segments, players and playback capabilities remain Host-owned and
 * are never copied from the reflection packet.
 */
function transitionCompletedDiagnosisCue(
  state: CoachAgentState,
  event: DiagnosisSubmissionEvent,
): CoachAgentState {
  if (event.type !== "SUBMIT_REFLECTION") return state;
  if (
    state.sessionStatus !== "ACTIVE" ||
    state.runStatus !== "CUE_COMPLETED" ||
    state.pendingToolCall !== null ||
    state.outcomeGateStatus !== "COMPLETE" ||
    event.outcomeGateStatus !== "COMPLETE" ||
    !sameIdentity(identityFromState(state), event.identity) ||
    !state.activeCueId ||
    event.cueId === state.activeCueId ||
    state.completedCueIds.includes(event.cueId) ||
    Object.prototype.hasOwnProperty.call(state.cueCases, event.cueId) ||
    (event.input.cue !== undefined && event.input.cue.id !== event.cueId)
  ) {
    return state;
  }

  return {
    ...state,
    // Diagnosis does not own a route marker or playback position.  Clear all
    // visual cue-local fields before binding the next reflection cue.
    activeSegmentId: null,
    activeCueId: event.cueId,
    activeCueSource: null,
    activeManualVisitId: null,
    activeTargetSegmentIndex: null,
    currentSegmentMode: null,
    activeFocus: null,
    activeNarrationPolicySummary: null,
    activeAllowedEvidenceSummary: [],
    activePresentableCueSummary: null,
    currentSessionPhase: "PAUSED_FOR_COACHING",
    outcomeGateStatus: "COMPLETE",
    narrationReadiness: "NOT_REQUIRED",
    availableCapabilities: [],
    selectedTeachingMove: null,
    pendingToolCall: null,
    lastToolResult: null,
    policyBudget: {
      ...state.policyBudget,
      policyCalls: 0,
      alternativeAttempts: 0,
    },
  };
}

function storeCueCase(
  state: CoachAgentState,
  cueCase: CoachAgentState["cueCases"][string],
): CoachAgentState["cueCases"] {
  const entries = [
    ...Object.entries(state.cueCases).filter(([cueId]) => cueId !== cueCase.cueId),
    [cueCase.cueId, cueCase] as const,
  ].slice(-64);
  const next: CoachAgentState["cueCases"] = {};
  for (const [cueId, value] of entries) next[cueId] = value;
  return next;
}

function storeLearningThread(
  state: CoachAgentState,
  thread: CoachAgentState["learningThreads"][number],
): CoachAgentState["learningThreads"] {
  return [
    ...state.learningThreads.filter((item) => item.threadId !== thread.threadId),
    thread,
  ].slice(-16);
}

function markDiagnosisEvent(
  state: CoachAgentState,
  eventId: string,
): string[] {
  return [...state.processedEventIds, eventId].slice(-64);
}

/**
 * Convert the already-validated, identity-free Memory Brief into the only
 * teaching-mode hint memory is allowed to provide.  A user correction takes
 * precedence over a remembered thread so the next cue explicitly revisits
 * the disputed understanding; otherwise an active cross-Demo thread asks
 * for a fresh transfer check.  Empty/absent briefs leave the legacy
 * session-thread mode selection untouched.
 */
function memoryPedagogyModeFor(
  state: CoachAgentState,
): "CHECK_TRANSFER" | "REINFORCE" | undefined {
  const brief = state.memoryBrief;
  if (!brief) return undefined;
  if (brief.corrections.length > 0) return "REINFORCE";
  if (brief.activeThreads.length > 0) return "CHECK_TRANSFER";
  return undefined;
}

function diagnosisInputFor(
  event: DiagnosisSubmissionEvent,
  state: CoachAgentState,
  reflection: z.infer<typeof UserReflectionSchema>,
): Parameters<typeof diagnoseTeachingCue>[0] {
  // The session's bounded threads are authoritative.  Host-provided thread
  // snapshots are intentionally not trusted to replace checkpoint state.
  // Likewise, a browser/remote caller cannot choose the memory-derived mode;
  // it is recomputed from the server-validated brief below.
  const { memoryPedagogyMode: _clientMemoryMode, ...inputWithoutMemoryMode } = event.input;
  void _clientMemoryMode;
  const memoryPedagogyMode = memoryPedagogyModeFor(state);
  const parsed = TeachingDiagnosisInputSchema.parse({
    ...inputWithoutMemoryMode,
    reflection,
    existingThreads: state.learningThreads,
    ...(memoryPedagogyMode ? { memoryPedagogyMode } : {}),
  });
  // The schema intentionally accepts the identity-free DecisionResources
  // projection while the domain contract may carry additional observable
  // fields.  The parse above is the trust boundary; the pure module consumes
  // the parsed packet.
  return parsed as unknown as Parameters<typeof diagnoseTeachingCue>[0];
}

function diagnosisFallbackCase(
  state: CoachAgentState,
  event: DiagnosisSubmissionEvent,
  limitations: readonly string[],
): CoachAgentState["cueCases"][string] {
  const previous = state.cueCases[event.cueId];
  const attemptBudget = previous?.attemptBudget ?? {
    reflection: 0,
    diagnostic: 0,
    disagreement: 0,
    alternateDiagnostic: 0,
  };
  return CueCaseSchema.parse({
    ...(previous ?? {
      schemaVersion: "cue-case.v1",
      caseId: `case-${event.cueId}`.slice(0, 160),
      cueId: event.cueId,
      ...(event.input.candidateId ? { candidateId: event.input.candidateId } : {}),
      pedagogyMode: "DEFER",
      claims: [],
      capabilities: [],
      baselineNarrationAvailable: true,
    }),
    status: "FALLBACK",
    // Keep the latest USER input visible even when a diagnostic/revision
    // attempt fails; it remains a claim and is never promoted to a Demo fact.
    reflection: event.reflection,
    attemptBudget: {
      ...attemptBudget,
      ...(event.type === "SUBMIT_REFLECTION" ? { reflection: 1 } : { disagreement: 1 }),
    },
    limitations: unique([...((previous?.limitations ?? []) as readonly string[]), ...limitations]).slice(0, 12),
  });
}

function rejectDiagnosisSubmission(
  state: CoachAgentState,
  event: DiagnosisSubmissionEvent,
  reason: FallbackReason,
): CoachAgentState {
  return appendTrace(
    {
      ...state,
      fallbackReasons: addFallbackReason(state.fallbackReasons, reason),
      processedEventIds: markDiagnosisEvent(state, event.eventId),
    },
    "SESSION",
    event.eventId,
    { input: event, finalStatus: state.runStatus },
  );
}

function diagnosisState(
  state: CoachAgentState,
  event: DiagnosisSubmissionEvent,
): CoachAgentState {
  const bootstrapped = transitionCompletedDiagnosisCue(
    bootstrapDiagnosisState(state, event),
    event,
  );
  if (
    !sameIdentity(identityFromState(bootstrapped), event.identity) ||
    bootstrapped.activeCueId !== event.cueId ||
    bootstrapped.outcomeGateStatus !== "COMPLETE" ||
    bootstrapped.sessionStatus !== "ACTIVE" ||
    bootstrapped.runStatus === "WAITING_TOOL" ||
    bootstrapped.runStatus === "USER_TAKEOVER" ||
    bootstrapped.runStatus === "CANCELLED" ||
    bootstrapped.runStatus === "COMPLETED"
  ) {
    return rejectDiagnosisSubmission(bootstrapped, event, "DIAGNOSIS_GATE_LOCKED");
  }

  const previous = bootstrapped.cueCases[event.cueId];
  if (event.type === "SUBMIT_REFLECTION" && previous?.attemptBudget.reflection >= 1) {
    return rejectDiagnosisSubmission(bootstrapped, event, "DIAGNOSIS_ATTEMPT_EXHAUSTED");
  }
  if (event.type === "SUBMIT_DISAGREEMENT" &&
    (!previous || !previous.verdict || previous.attemptBudget.disagreement >= 1)) {
    return rejectDiagnosisSubmission(bootstrapped, event, "DIAGNOSIS_ATTEMPT_EXHAUSTED");
  }

  // Skip is a first-class baseline path.  It records the user's choice but
  // never invokes a diagnostic capability or turns baseline text into a
  // user-supported claim.
  if (event.reflection.response === "SKIPPED") {
    const cueCase = diagnosisFallbackCase(bootstrapped, event, [
      "用户跳过了反思；保留 Baseline 讲解，不生成自适应诊断。",
    ]);
    return appendTrace(
      {
        ...bootstrapped,
        runStatus: "CUE_COMPLETED",
        sessionStatus: "ACTIVE",
        cueCases: storeCueCase(bootstrapped, cueCase),
        selectedTeachingMove: null,
        pendingToolCall: null,
        processedEventIds: markDiagnosisEvent(bootstrapped, event.eventId),
      },
      "SESSION",
      event.eventId,
      { input: event, finalStatus: "CUE_COMPLETED" },
    );
  }

  try {
    if (event.type === "SUBMIT_REFLECTION") {
      const input = diagnosisInputFor(event, bootstrapped, event.reflection);
      const output = TeachingDiagnosisOutputSchema.parse(diagnoseTeachingCue(input));
      const cueCase = CueCaseSchema.parse(output.cueCase);
      const thread = LearningThreadSchema.parse(output.learningThread);
      const nextState: CoachAgentState = {
        ...bootstrapped,
        runStatus: "CUE_COMPLETED",
        sessionStatus: "ACTIVE",
        cueCases: storeCueCase(bootstrapped, cueCase),
        learningThreads: storeLearningThread(bootstrapped, thread),
        selectedTeachingMove: null,
        pendingToolCall: null,
        processedEventIds: markDiagnosisEvent(bootstrapped, event.eventId),
      };
      return appendTrace(nextState, "SESSION", event.eventId, {
        input: event,
        evidenceRefs: cueCase.verdict?.evidenceRefs ?? [],
        finalStatus: "CUE_COMPLETED",
      });
    }

    const priorThread = bootstrapped.learningThreads.find((thread) =>
      thread.evidenceCueIds.includes(event.cueId),
    );
    if (!previous || !priorThread || !previous.reflection) {
      return rejectDiagnosisSubmission(bootstrapped, event, "DIAGNOSIS_FAILED");
    }
    const input = diagnosisInputFor(event, bootstrapped, previous.reflection);
    const output = TeachingDiagnosisOutputSchema.parse(reviseTeachingDiagnosis({
      previous: { cueCase: previous, learningThread: priorThread },
      input,
      disagreement: UserReflectionSchema.parse(event.reflection),
    }));
    // A disagreement is a revision of one cue case, not a second case.  Keep
    // the case identity stable while allowing the pure module to update its
    // bounded claims, evidence, verdict and transfer rule.
    const cueCase = CueCaseSchema.parse({
      ...output.cueCase,
      caseId: previous.caseId,
    });
    const thread = LearningThreadSchema.parse(output.learningThread);
    const nextState: CoachAgentState = {
      ...bootstrapped,
      runStatus: "CUE_COMPLETED",
      sessionStatus: "ACTIVE",
      cueCases: storeCueCase(bootstrapped, cueCase),
      learningThreads: storeLearningThread(bootstrapped, thread),
      selectedTeachingMove: null,
      pendingToolCall: null,
      processedEventIds: markDiagnosisEvent(state, event.eventId),
    };
    return appendTrace(nextState, "SESSION", event.eventId, {
      input: event,
      evidenceRefs: cueCase.verdict?.evidenceRefs ?? [],
      finalStatus: "CUE_COMPLETED",
    });
  } catch {
    const cueCase = diagnosisFallbackCase(bootstrapped, event, [
      "教学诊断模块失败；回退到 Baseline 讲解。",
    ]);
    const nextState: CoachAgentState = {
      ...bootstrapped,
      runStatus: "CUE_COMPLETED",
      sessionStatus: "ACTIVE",
      cueCases: storeCueCase(bootstrapped, cueCase),
      selectedTeachingMove: null,
      pendingToolCall: null,
      fallbackReasons: addFallbackReason(bootstrapped.fallbackReasons, "DIAGNOSIS_FAILED"),
      processedEventIds: markDiagnosisEvent(bootstrapped, event.eventId),
    };
    return appendTrace(nextState, "SESSION", event.eventId, {
      input: event,
      finalStatus: "CUE_COMPLETED",
    });
  }
}

function completeSessionState(
  state: CoachAgentState,
  eventId: string,
  input: unknown,
): CoachAgentState {
  const repeatedThemes = state.sessionThemes
    .filter((theme) => theme.repeated)
    .sort((left, right) =>
      right.occurrence - left.occurrence ||
      Number(left.conflictEvidence) - Number(right.conflictEvidence) ||
      left.focus.localeCompare(right.focus),
    )
    .slice(0, 3);
  // Choose one representative from each selected theme. A global first-three
  // slice would let a frequent early theme consume all representatives and
  // leave later themes without their own advice refs.
  const representativeSummaries = repeatedThemes
    .map((theme) =>
      state.completedCueSummaries
        .map((summary, index) => ({ summary, index }))
        .filter(({ summary }) => theme.cueRefs.includes(summary.cueId))
        .sort((left, right) =>
          Number(right.summary.adviceRefs.length > 0) - Number(left.summary.adviceRefs.length > 0) ||
          left.index - right.index ||
          left.summary.cueId.localeCompare(right.summary.cueId),
        )[0]?.summary,
    )
    .filter((summary): summary is CoachAgentState["completedCueSummaries"][number] => Boolean(summary));
  const completedCues = representativeSummaries.map((summary) => ({
      cueId: summary.cueId,
      roundId: summary.roundId,
      focus: summary.focus,
      evidenceRefs: summary.evidenceRefs,
      adviceRefs: summary.adviceRefs,
    }));
  const summaryThemes = repeatedThemes.map((theme) => {
    const adviceRefs = unique(
      representativeSummaries
        .find((summary) => theme.cueRefs.includes(summary.cueId))
        ?.adviceRefs ?? [],
    ).slice(0, 8);
    return SessionSummaryThemeSchema.parse({
      ...theme,
      adviceRefs,
      limitations: [
        ...(theme.conflictEvidence ? ["CONFLICTING_EVIDENCE"] : []),
        ...(adviceRefs.length === 0 ? ["NO_VERIFIED_ADVICE"] : []),
      ],
    });
  });
  const sessionSummaryInput = SessionSummaryInputSchema.parse({
    schemaVersion: "coach-agent-session-summary.v1",
    themes: summaryThemes,
    completedCues,
    limitations: repeatedThemes.length === 0 ? ["NO_REPEATED_THEME"] : [],
  });
  return appendTrace(
    {
      ...state,
      sessionStatus: "COMPLETED",
      runStatus: "COMPLETED",
      selectedTeachingMove: null,
      pendingToolCall: null,
      summaryThemes: repeatedThemes,
      sessionSummaryInput,
      sessionSummaryFallback: repeatedThemes.length === 0 ? "无反复主题。" : null,
      processedEventIds: [...state.processedEventIds, eventId].slice(-64),
    },
    "SESSION",
    eventId,
    { input, finalStatus: "COMPLETED" },
  );
}

async function policyNode(
  state: CoachAgentGraphStateValue,
  policy: PolicyAdapter,
): Promise<Partial<CoachAgentGraphStateValue>> {
  const event = CoachAgentEventSchema.parse(state.event);
  if (event.type === "SUBMIT_REFLECTION" || event.type === "SUBMIT_DISAGREEMENT") {
    return { agent: diagnosisState(state.agent, event) };
  }
  if (event.type === "OBSERVE_SEGMENT") {
    return { agent: observeSegmentState(state.agent, event) };
  }
  if (event.type === "OBSERVE_PRESENTED_CUE") {
    return { agent: observePresentedCueState(state.agent, event) };
  }
  if (event.type === "COMPLETE_SESSION") {
    return { agent: completeSessionState(state.agent, event.eventId, event) };
  }
  if (event.type === "USER_TAKEOVER") {
    return {
      agent: appendTrace(
        {
          ...state.agent,
          sessionStatus: "TAKEN_OVER",
          runStatus: "USER_TAKEOVER",
          activeCueSource: null,
          activeManualVisitId: null,
          selectedTeachingMove: null,
          pendingToolCall: null,
          lastToolResult: null,
          processedEventIds: [...state.agent.processedEventIds, event.eventId].slice(-64),
        },
        "RUNTIME",
        event.eventId,
        { input: event, finalStatus: "USER_TAKEOVER" },
      ),
    };
  }
  if (event.type === "CANCEL_RUN") {
    return {
      agent: appendTrace(
        {
          ...state.agent,
          sessionStatus: "CANCELLED",
          runStatus: "CANCELLED",
          activeCueSource: null,
          activeManualVisitId: null,
          selectedTeachingMove: null,
          pendingToolCall: null,
          processedEventIds: [...state.agent.processedEventIds, event.eventId].slice(-64),
          fallbackReasons: addFallbackReason(state.agent.fallbackReasons, "EXPIRED_EVENT"),
        },
        "RUNTIME",
        event.eventId,
        { input: event, finalStatus: "CANCELLED" },
      ),
    };
  }
  if (event.type === "RECONNECT_REPLAY") {
    const processedEventIds = [...state.agent.processedEventIds, event.eventId].slice(-64);
    if (
      state.agent.runStatus === "USER_TAKEOVER" &&
      event.boundary.kind === "CUE_PAUSED" &&
      event.pendingToolDisposition.status === "NONE"
    ) {
      const completed = completeCueWithSummary(
        {
          ...state.agent,
          sessionStatus: "ACTIVE",
          selectedTeachingMove: null,
          pendingToolCall: null,
          processedEventIds,
        },
        state.agent.activePresentableCueSummary,
      );
      return {
        agent: appendTrace(completed, "RUNTIME", event.eventId, {
          input: event,
          finalStatus: "CUE_COMPLETED",
        }),
      };
    }
    if (event.pendingToolDisposition.status === "SUCCEEDED") {
      return {
        agent: appendTrace(
          { ...state.agent, processedEventIds },
          "RUNTIME",
          event.eventId,
          { input: event, finalStatus: state.agent.runStatus },
        ),
      };
    }
    if (state.agent.runStatus === "WAITING_TOOL" && state.agent.pendingToolCall) {
      const pending = state.agent.pendingToolCall;
      const cancelled = AgentToolResultSchema.parse({
        callId: pending.callId,
        status: "CANCELLED",
        observation: { code: "UNAVAILABLE", completed: false },
        limitations: ["RECOVERY_PENDING_TOOL_CANCELLED"],
      });
      const historyItem = {
        callId: pending.callId,
        cueId: pending.cueId,
        tool: pending.tool,
        capabilityId: pending.capabilityId,
        status: "CANCELLED" as const,
        observationCode: cancelled.observation.code,
        limitationCount: cancelled.limitations.length,
      };
      const next = completeCueWithSummary(
        {
          ...state.agent,
          runStatus: "CUE_COMPLETED" as const,
          selectedTeachingMove: null,
          pendingToolCall: null,
          lastToolResult: cancelled,
          toolHistory: [...state.agent.toolHistory, historyItem].slice(-16),
          fallbackReasons: addFallbackReason(state.agent.fallbackReasons, "RECOVERY_TOOL_CANCELLED"),
          processedEventIds,
        },
        state.agent.activePresentableCueSummary,
      );
      return {
        agent: appendTrace(next, "RUNTIME", event.eventId, {
          input: event,
          selectedCapabilityId: pending.capabilityId,
          evidenceRefs: pending.evidenceRefs,
          toolResultStatus: "CANCELLED",
          finalStatus: "CUE_COMPLETED",
        }),
      };
    }
    return {
      agent: appendTrace(
        { ...state.agent, processedEventIds },
        "RUNTIME",
        event.eventId,
        { input: event, finalStatus: state.agent.runStatus },
      ),
    };
  }
  if (event.type !== "START_CUE" && event.type !== "START_MANUAL_CUE_VISIT") {
    throw new Error("the coach graph requires a cue start or lifecycle event");
  }

  if (
    event.type === "START_CUE" && event.resumeFromTakeover &&
    state.agent.runStatus === "USER_TAKEOVER" &&
    state.agent.completedCueIds.includes(event.cueId)
  ) {
    const restored = {
      ...state.agent,
      sessionStatus: "ACTIVE" as const,
      runStatus: "CUE_COMPLETED" as const,
      activeSegmentId: event.segmentId,
      activeCueId: event.cueId,
      routeCursor: event.routeSegmentIndex ?? state.agent.routeCursor,
      currentSegmentMode: event.segmentMode ?? state.agent.currentSegmentMode,
      activeFocus: event.focus,
      activeNarrationPolicySummary: normalizeNarrationSummary(event.narrationSummary),
      activeAllowedEvidenceSummary: event.allowedEvidenceSummary,
      memoryBrief: "memoryBrief" in event ? event.memoryBrief ?? undefined : state.agent.memoryBrief ?? undefined,
      currentSessionPhase: event.currentSessionPhase,
      outcomeGateStatus: event.outcomeGateStatus,
      narrationReadiness: event.narrationReadiness,
      availableCapabilities: event.capabilities,
      selectedTeachingMove: null,
      pendingToolCall: null,
      lastToolResult: null,
      processedEventIds: [...state.agent.processedEventIds, event.eventId].slice(-64),
    };
    return {
      agent: appendTrace(restored, "RUNTIME", event.eventId, {
        input: event,
        finalStatus: "CUE_COMPLETED",
      }),
    };
  }

  const availableCapabilities = event.capabilities;
  const baseState: CoachAgentState = {
    ...state.agent,
    runStatus: "RUNNING",
    sessionStatus: event.type === "START_MANUAL_CUE_VISIT" ? "TAKEN_OVER" : "ACTIVE",
    runId: event.identity.runId,
    sessionId: event.identity.sessionId,
    demoId: event.identity.demoId,
    demoContentHash: event.identity.demoContentHash,
    selectedPlayerId: event.identity.selectedPlayerId,
    routeId: event.identity.routeId,
    routeHash: event.identity.routeHash,
    activeSegmentId: event.segmentId,
    activeCueId: event.cueId,
    activeCueSource: event.type === "START_MANUAL_CUE_VISIT" ? "MANUAL" : "DEFAULT",
    activeManualVisitId: event.type === "START_MANUAL_CUE_VISIT" ? event.visitId : null,
    activeTargetSegmentIndex: event.type === "START_MANUAL_CUE_VISIT"
      ? event.targetSegmentIndex
      : event.routeSegmentIndex ?? null,
    currentSegmentMode: event.segmentMode ?? state.agent.currentSegmentMode,
    activeFocus: event.focus,
    activeNarrationPolicySummary: normalizeNarrationSummary(event.narrationSummary),
    activeAllowedEvidenceSummary: event.allowedEvidenceSummary,
    activePresentableCueSummary: event.presentableSummary ?? null,
    memoryBrief: "memoryBrief" in event ? event.memoryBrief ?? undefined : state.agent.memoryBrief ?? undefined,
    routeCursor: event.type === "START_CUE"
      ? event.routeSegmentIndex ?? state.agent.routeCursor
      : state.agent.routeCursor,
    currentSessionPhase: event.currentSessionPhase,
    outcomeGateStatus: event.outcomeGateStatus,
    narrationReadiness: event.narrationReadiness,
    availableCapabilities,
    selectedTeachingMove: null,
    pendingToolCall: null,
    lastToolResult: null,
    processedEventIds: [...state.agent.processedEventIds, event.eventId].slice(-64),
  };

  if (
    event.outcomeGateStatus !== "COMPLETE" ||
    !["READY", "FALLBACK"].includes(event.narrationReadiness)
  ) {
    return { agent: finishWithoutTool(baseState, event.eventId, [], 0, 0, [], event, false, event) };
  }

  if (availableCapabilities.length === 0) {
    return { agent: finishWithoutTool(baseState, event.eventId, [], 0, 0, [], event, true, event) };
  }

  const input = policyInputFor(event, baseState);
  const deterministic = deterministicPolicyOutput(input);

  if (availableCapabilities.length === 1) {
    if (deterministic.action === "FINISH_CUE") {
      return { agent: finishWithoutTool(baseState, event.eventId, [], 0, 0, [], event, true, input) };
    }
    return {
      agent: withWaitingTool(
        baseState,
        event.eventId,
        availableCapabilities[0],
        "RULE",
        [],
        0,
        0,
        "tool-1",
        input,
      ),
    };
  }

  let selectedCapability = availableCapabilities.find(
    ({ capabilityId }) => capabilityId === (deterministic.action === "SELECT_CAPABILITY" ? deterministic.capabilityId : undefined),
  ) ?? availableCapabilities[0];
  let source: "MODEL" | "FALLBACK" = "MODEL";
  let fallbackReasons: FallbackReason[] = [];
  let alternativeAttempts = 0;
  const policyStartedAt = clockNow();
  let traceMeta: PolicyTraceMeta;
  try {
    const output = PolicyOutputSchema.safeParse(await policy.selectCapability(input));
    traceMeta = policyTraceMeta(policy, policyStartedAt);
    const parsedOutput = output.success ? output.data : null;
    if (!parsedOutput) {
      source = "FALLBACK";
      fallbackReasons = addFallbackReason(fallbackReasons, "POLICY_INVALID_OUTPUT");
    } else if (parsedOutput.action === "FINISH_CUE") {
      if (!matchingAllowedEvidenceRefs(parsedOutput.evidenceRefs, input)) {
        source = "FALLBACK";
        fallbackReasons = addFallbackReason(fallbackReasons, "POLICY_INVALID_OUTPUT");
      } else {
        return {
          agent: finishWithoutTool(baseState, event.eventId, [], 1, 0, parsedOutput.evidenceRefs, event, true, input, traceMeta),
        };
      }
    } else {
      const candidate = availableCapabilities.find(
        ({ capabilityId }) => capabilityId === parsedOutput.capabilityId,
      );
      if (!candidate || !matchingEvidenceRefs(parsedOutput.evidenceRefs, candidate) || !matchingAllowedEvidenceRefs(parsedOutput.evidenceRefs, input)) {
        source = "FALLBACK";
        fallbackReasons = addFallbackReason(fallbackReasons, "POLICY_INVALID_OUTPUT");
      } else {
        selectedCapability = candidate;
      }
    }
  } catch {
    traceMeta = policyTraceMeta(policy, policyStartedAt);
    source = "FALLBACK";
    fallbackReasons = addFallbackReason(fallbackReasons, "POLICY_FAILED");
  }

  if (source === "FALLBACK" && deterministic.action === "FINISH_CUE") {
    return {
      agent: finishWithoutTool(baseState, event.eventId, fallbackReasons, 1, 0, deterministic.evidenceRefs, event, true, input, traceMeta),
    };
  }

  if (source === "FALLBACK") {
    selectedCapability = availableCapabilities.find(
      ({ capabilityId }) => capabilityId === (deterministic.action === "SELECT_CAPABILITY" ? deterministic.capabilityId : undefined),
    ) ?? selectedCapability;
  }

  return {
    agent: withWaitingTool(
      baseState,
      event.eventId,
      selectedCapability,
      source,
      fallbackReasons,
      1,
      alternativeAttempts,
      "tool-1",
      input,
      traceMeta,
    ),
  };
}

function finishNode(
  state: CoachAgentGraphStateValue,
): Partial<CoachAgentGraphStateValue> {
  if (state.agent.trace.at(-1)?.node === "FINISH") return { agent: state.agent };
  return {
    agent: appendTrace(state.agent, "FINISH", state.event.eventId, {
      input: state.event,
      finalStatus: state.agent.runStatus,
    }),
  };
}

function playbackNode(
  state: CoachAgentGraphStateValue,
): Partial<CoachAgentGraphStateValue> {
  const request = state.agent.pendingToolCall;
  const event = state.event.type === "START_CUE" || state.event.type === "START_MANUAL_CUE_VISIT"
    ? state.event
    : undefined;
  if (!request) {
    const next = event
      ? completeCueState({
          ...state.agent,
          fallbackReasons: addFallbackReason(state.agent.fallbackReasons, "STALE_RESUME"),
        }, event)
      : {
          ...state.agent,
          runStatus: "CUE_COMPLETED" as const,
          fallbackReasons: addFallbackReason(state.agent.fallbackReasons, "STALE_RESUME"),
        };
    return { agent: appendTrace(next, "TOOL", state.event.eventId, { input: state.event, finalStatus: next.runStatus }) };
  }

  // The external playback side effect is impossible before this interrupt.
  // Resume uses the stable callId and the caller owns the actual tool action.
  const resumed = interrupt<unknown, unknown>(request);
  const parsed = AgentToolResultSchema.safeParse(resumed);
  if (!parsed.success || parsed.data.callId !== request.callId) {
    const next = event
      ? completeCueState({
          ...state.agent,
          pendingToolCall: null,
          fallbackReasons: addFallbackReason(state.agent.fallbackReasons, "STALE_RESUME"),
        }, event)
      : {
          ...state.agent,
          runStatus: "CUE_COMPLETED" as const,
          pendingToolCall: null,
          fallbackReasons: addFallbackReason(state.agent.fallbackReasons, "STALE_RESUME"),
        };
    return {
      agent: appendTrace(next, "TOOL", state.event.eventId, {
        input: { request, resumed },
        selectedCapabilityId: request.capabilityId,
        evidenceRefs: request.evidenceRefs,
        finalStatus: next.runStatus,
      }),
    };
  }

  const result: AgentToolResult = parsed.data;
  const resultFallback: FallbackReason | null =
    result.status === "SUCCEEDED"
      ? null
      : result.status === "REJECTED"
        ? "TOOL_REJECTED"
        : result.status === "CANCELLED"
          ? "TOOL_CANCELLED"
          : "TOOL_FAILED";
  const nextFallbackReasons = resultFallback
    ? addFallbackReason(state.agent.fallbackReasons, resultFallback)
    : state.agent.fallbackReasons;
  const historyItem = {
    callId: result.callId,
    cueId: request.cueId,
    tool: request.tool,
    capabilityId: request.capabilityId,
    status: result.status,
    observationCode: result.observation.code,
    limitationCount: result.limitations.length,
  } as const;
  const currentCueHistory = state.agent.toolHistory.filter((item) => item.cueId === request.cueId);
  const usedCapabilityIds = new Set([
    ...currentCueHistory.map((item) => item.capabilityId),
    request.capabilityId,
  ]);
  const remainingCapabilities = state.agent.availableCapabilities.filter(
    (capability) => !usedCapabilityIds.has(capability.capabilityId),
  );
  const alternativeInput = policyInputForState(state.agent, remainingCapabilities);
  const deterministicAlternative = alternativeInput
    ? deterministicPolicyOutput(alternativeInput)
    : { action: "FINISH_CUE" as const, evidenceRefs: [] as string[] };
  const retryCapability =
    currentCueHistory.length === 0 &&
    (result.status === "FAILED" || result.status === "REJECTED")
      && deterministicAlternative.action === "SELECT_CAPABILITY"
      ? remainingCapabilities.find(
          (capability) => capability.capabilityId === deterministicAlternative.capabilityId,
        )
      : undefined;
  if (retryCapability) {
    const retryReasons = resultFallback
      ? addFallbackReason(state.agent.fallbackReasons, resultFallback)
      : state.agent.fallbackReasons;
    return {
      agent: withWaitingTool(
        {
          ...state.agent,
          pendingToolCall: null,
          selectedTeachingMove: null,
          lastToolResult: result,
          toolHistory: [...state.agent.toolHistory, historyItem].slice(-16),
          fallbackReasons: retryReasons,
        },
        state.event.eventId,
        retryCapability,
        "FALLBACK",
        retryReasons,
        state.agent.policyBudget.policyCalls,
        1,
        "tool-2",
        alternativeInput ?? { request, result },
      ),
    };
  }
  let nextState: CoachAgentState = {
    ...state.agent,
    runStatus: "CUE_COMPLETED",
    pendingToolCall: null,
    lastToolResult: result,
    toolHistory: [...state.agent.toolHistory, historyItem].slice(-16),
    fallbackReasons: nextFallbackReasons,
    processedEventIds: [...state.agent.processedEventIds, state.event.eventId].slice(-64),
  };
  if (event) nextState = completeCueState(nextState, event);
  return {
    agent: appendTrace(nextState, "TOOL", state.event.eventId, {
      input: { request, result },
      selectedCapabilityId: request.capabilityId,
      evidenceRefs: request.evidenceRefs,
      toolResultStatus: result.status,
      finalStatus: nextState.runStatus,
    }),
  };
}

export function createCueGraph(options: {
  checkpointer: BaseCheckpointSaver;
  policy: PolicyAdapter;
}) {
  const builder = new StateGraph(CoachAgentGraphState)
    .addNode("policy", (state) => policyNode(state, options.policy))
    .addNode("tool", playbackNode)
    .addNode("finish", finishNode)
    .addEdge(START, "policy")
    .addConditionalEdges("policy", (state) =>
      state.agent.runStatus === "WAITING_TOOL" ? "tool" : "finish",
    )
    .addConditionalEdges("tool", (state) =>
      state.agent.runStatus === "WAITING_TOOL" ? "tool" : "finish",
    )
    .addEdge("finish", END);

  return builder.compile({ checkpointer: options.checkpointer });
}

export function validateToolResult(value: unknown): AgentToolResult {
  return AgentToolResultSchema.parse(value);
}
