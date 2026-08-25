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
  type PolicyInput,
  type PresentableCueSummary,
  type StartCueEvent,
  type TeachingCapability,
  type TeachingCapabilityId,
  type TraceEntry,
} from "./types";
import { aggregateSessionThemes } from "./session-theme-aggregator";
import type { PolicyAdapter, PolicyTraceMeta } from "./adapters";
import { identityFingerprint, moveId, playbackCallId, stableInputHash } from "./identity";
import { deterministicPolicyOutput } from "./deterministic-policy";

export const CoachAgentGraphState = Annotation.Root({
  agent: Annotation<CoachAgentState>(),
  event: Annotation<CoachAgentEvent>(),
});

export type CoachAgentGraphStateValue = typeof CoachAgentGraphState.State;

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
    graphVersion: "coach-agent-graph.v2",
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

function presentableCueSummaryFor(event: StartCueEvent): PresentableCueSummary | undefined {
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
  if (!summary || state.completedCueSummaries.some((item) => item.cueId === summary.cueId)) {
    return {
      ...state,
      runStatus: "CUE_COMPLETED",
      sessionStatus: "ACTIVE",
      completedCueIds,
    };
  }
  const completedCueSummaries = [...state.completedCueSummaries, summary].slice(-64);
  return {
    ...state,
    runStatus: "CUE_COMPLETED",
    sessionStatus: "ACTIVE",
    completedCueIds,
    completedCueSummaries,
    sessionThemes: aggregateSessionThemes(completedCueSummaries),
  };
}

function completeCueState(state: CoachAgentState, event: StartCueEvent): CoachAgentState {
  return completeCueWithSummary(state, presentableCueSummaryFor(event));
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
  event?: StartCueEvent,
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
  event: StartCueEvent,
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
    limitations: event.limitations,
    budget: state.policyBudget,
    maxMoves: 1,
  });
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
  if (event.type === "OBSERVE_SEGMENT") {
    return { agent: observeSegmentState(state.agent, event) };
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
  if (event.type !== "START_CUE") {
    throw new Error("the coach graph starts with START_CUE, OBSERVE_SEGMENT, or COMPLETE_SESSION");
  }

  if (
    event.resumeFromTakeover &&
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
    sessionStatus: "ACTIVE",
    runId: event.identity.runId,
    sessionId: event.identity.sessionId,
    demoId: event.identity.demoId,
    demoContentHash: event.identity.demoContentHash,
    selectedPlayerId: event.identity.selectedPlayerId,
    routeId: event.identity.routeId,
    routeHash: event.identity.routeHash,
    activeSegmentId: event.segmentId,
    activeCueId: event.cueId,
    currentSegmentMode: event.segmentMode ?? state.agent.currentSegmentMode,
    activeFocus: event.focus,
    activeNarrationPolicySummary: normalizeNarrationSummary(event.narrationSummary),
    activeAllowedEvidenceSummary: event.allowedEvidenceSummary,
    activePresentableCueSummary: event.presentableSummary ?? null,
    routeCursor: event.routeSegmentIndex ?? state.agent.routeCursor,
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
  const event = state.event.type === "START_CUE" ? state.event : undefined;
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
