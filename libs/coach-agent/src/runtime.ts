import {
  Command,
  MemorySaver,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import {
  AgentToolRequestSchema,
  CoachAgentEventSchema,
  CoachAgentResultSchema,
  CoachAgentStateSchema,
  COACH_AGENT_GRAPH_VERSION,
  COACH_AGENT_RECOVERY_VERSION,
  COACH_AGENT_SESSION_VERSION,
  COACH_AGENT_STATE_VERSION,
  type AgentToolRequest,
  type CoachAgentEvent,
  type CoachAgentIdentity,
  type CoachAgentResult,
  type CoachAgentState,
  type FallbackReason,
  type ReconnectReplayEvent,
} from "./types";
import { DeterministicPolicyAdapter, type PolicyAdapter } from "./adapters";
import { createCueGraph } from "./graph";
import { IndexedDbCheckpointSaver } from "./indexeddb-checkpoint";
import { threadIdForIdentity } from "./identity";

export interface CoachAgentRuntime {
  dispatch(event: CoachAgentEvent): Promise<CoachAgentResult>;
}

export interface CoachAgentRuntimeOptions {
  policy?: PolicyAdapter;
  checkpointer?: BaseCheckpointSaver;
  checkpoint?: "memory" | "indexeddb" | "durable_object";
  checkpointBackend?: "MEMORY" | "INDEXEDDB" | "DURABLE_OBJECT";
  indexedDB?: IDBFactory;
  databaseName?: string;
  retention?: number;
}

interface RuntimeBackend {
  saver: BaseCheckpointSaver;
  kind: "MEMORY" | "INDEXEDDB" | "DURABLE_OBJECT";
  recoverableAfterRefresh: boolean;
  fallbackReason?: "CHECKPOINT_UNAVAILABLE" | "IDB_FALLBACK";
  close?: () => Promise<void>;
}

interface CheckpointRead {
  state?: CoachAgentState;
  incompatible: boolean;
  checkpointId: string | null;
}

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

function addFallbackReason(
  reasons: FallbackReason[],
  reason: FallbackReason,
): FallbackReason[] {
  return [...new Set([...reasons, reason])].slice(-8);
}

function policyBudget(): CoachAgentState["policyBudget"] {
  return {
    policyCalls: 0,
    maxPolicyCalls: 1,
    alternativeAttempts: 0,
    maxAlternativeAttempts: 1,
  };
}

function emptyTraceSummary(): CoachAgentState["traceSummary"] {
  return {
    entryCount: 0,
    lastNode: null,
    lastInputHash: null,
    lastFinalStatus: null,
  };
}

function emptyState(identity: CoachAgentIdentity): CoachAgentState {
  return CoachAgentStateSchema.parse({
    schemaVersion: "coach-agent-state.v3",
    graphVersion: "coach-agent-graph.v3",
    runId: identity.runId,
    sessionId: identity.sessionId,
    demoId: identity.demoId,
    demoContentHash: identity.demoContentHash,
    selectedPlayerId: identity.selectedPlayerId,
    routeId: identity.routeId,
    routeHash: identity.routeHash,
    sessionStatus: "ACTIVE",
    runStatus: "RUNNING",
    activeSegmentId: null,
    activeCueId: null,
    activeCueSource: null,
    activeManualVisitId: null,
    activeTargetSegmentIndex: null,
    routeCursor: -1,
    currentSegmentMode: null,
    activeFocus: null,
    activeNarrationPolicySummary: null,
    activeAllowedEvidenceSummary: [],
    activePresentableCueSummary: null,
    observedSegmentIds: [],
    currentSessionPhase: "INTRO",
    outcomeGateStatus: "NOT_APPLICABLE",
    narrationReadiness: "NOT_REQUIRED",
    availableCapabilities: [],
    selectedTeachingMove: null,
    pendingToolCall: null,
    toolHistory: [],
    completedCueIds: [],
    completedCueSummaries: [],
    presentedCueBindings: [],
    sessionThemes: [],
    summaryThemes: [],
    sessionSummaryInput: null,
    sessionSummaryFallback: null,
    policyBudget: policyBudget(),
    fallbackReasons: [],
    lastStableCheckpoint: { checkpointId: null, sequence: 0 },
    traceSummary: emptyTraceSummary(),
    processedEventIds: [],
    trace: [],
    lastToolResult: null,
  });
}

function initialState(
  event: Extract<CoachAgentEvent, { type: "START_CUE" }>,
  previous: CoachAgentState | undefined,
  backendFallback?: FallbackReason,
): CoachAgentState {
  const base = previous ?? emptyState(event.identity);
  const fallbackReasons = backendFallback
    ? addFallbackReason(base.fallbackReasons, backendFallback)
    : base.fallbackReasons;
  return CoachAgentStateSchema.parse({
    ...base,
    schemaVersion: "coach-agent-state.v3",
    graphVersion: "coach-agent-graph.v3",
    runId: event.identity.runId,
    sessionId: event.identity.sessionId,
    demoId: event.identity.demoId,
    demoContentHash: event.identity.demoContentHash,
    selectedPlayerId: event.identity.selectedPlayerId,
    routeId: event.identity.routeId,
    routeHash: event.identity.routeHash,
    sessionStatus: "ACTIVE",
    runStatus: "RUNNING",
    activeSegmentId: event.segmentId,
    activeCueId: event.cueId,
    activeCueSource: "DEFAULT",
    activeManualVisitId: null,
    activeTargetSegmentIndex: event.routeSegmentIndex ?? null,
    routeCursor: event.routeSegmentIndex ?? base.routeCursor,
    currentSegmentMode: event.segmentMode ?? base.currentSegmentMode,
    activeFocus: event.focus,
    activeNarrationPolicySummary: "fields" in event.narrationSummary
      ? event.narrationSummary
      : null,
    activeAllowedEvidenceSummary: event.allowedEvidenceSummary,
    activePresentableCueSummary: event.presentableSummary ?? null,
    currentSessionPhase: event.currentSessionPhase,
    outcomeGateStatus: event.outcomeGateStatus,
    narrationReadiness: event.narrationReadiness,
    availableCapabilities: event.capabilities,
    selectedTeachingMove: null,
    pendingToolCall: null,
    policyBudget: policyBudget(),
    fallbackReasons,
    lastToolResult: null,
    processedEventIds: [...base.processedEventIds, event.eventId].slice(-64),
    // Host-provided sessionThemes are not authoritative; Graph derives them
    // only from a strict presentable summary after the cue finishes.
    sessionThemes: base.sessionThemes,
  });
}

function initialManualVisitState(
  event: Extract<CoachAgentEvent, { type: "START_MANUAL_CUE_VISIT" }>,
  previous: CoachAgentState,
): CoachAgentState {
  return CoachAgentStateSchema.parse({
    ...previous,
    runStatus: "RUNNING",
    sessionStatus: "TAKEN_OVER",
    activeSegmentId: event.segmentId,
    activeCueId: event.cueId,
    activeCueSource: "MANUAL",
    activeManualVisitId: event.visitId,
    activeTargetSegmentIndex: event.targetSegmentIndex,
    currentSegmentMode: event.segmentMode ?? previous.currentSegmentMode,
    activeFocus: event.focus,
    activeNarrationPolicySummary: "fields" in event.narrationSummary ? event.narrationSummary : null,
    activeAllowedEvidenceSummary: event.allowedEvidenceSummary,
    activePresentableCueSummary: event.presentableSummary ?? null,
    currentSessionPhase: event.currentSessionPhase,
    outcomeGateStatus: event.outcomeGateStatus,
    narrationReadiness: event.narrationReadiness,
    availableCapabilities: event.capabilities,
    selectedTeachingMove: null,
    pendingToolCall: null,
    policyBudget: policyBudget(),
    lastToolResult: null,
    processedEventIds: [...previous.processedEventIds, event.eventId].slice(-64),
  });
}

function dormantState(
  identity: CoachAgentIdentity,
  reason: FallbackReason,
): CoachAgentState {
  return CoachAgentStateSchema.parse({
    ...emptyState(identity),
    schemaVersion: "coach-agent-state.v3",
    graphVersion: "coach-agent-graph.v3",
    runStatus: "DORMANT",
    sessionStatus: "ACTIVE",
    activeSegmentId: null,
    activeCueId: null,
    currentSessionPhase: "DORMANT",
    outcomeGateStatus: "NOT_APPLICABLE",
    narrationReadiness: "NOT_REQUIRED",
    availableCapabilities: [],
    fallbackReasons: [reason],
  });
}

function stateFromCheckpoint(value: unknown): CheckpointRead {
  if (!value || typeof value !== "object") return { incompatible: false, checkpointId: null };
  const parsed = CoachAgentStateSchema.safeParse(value);
  if (parsed.success) return { state: parsed.data, incompatible: false, checkpointId: null };
  return { incompatible: true, checkpointId: null };
}

function graphStateFromOutput(value: unknown): CoachAgentState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const agent = (value as { agent?: unknown }).agent;
  return stateFromCheckpoint(agent).state;
}

function resultForState(
  state: CoachAgentState,
  backend: RuntimeBackend,
  restored: CoachAgentResult["restored"],
  checkpointId: string | null = null,
  includeEffects = true,
): CoachAgentResult {
  const result = {
    version: "coach-agent-result.v1" as const,
    // Preserve the Stage 2 response status for existing Host adapters; the
    // v2 state carries the distinct CUE_COMPLETED vs session COMPLETED status.
    status: state.runStatus === "CUE_COMPLETED" ? "COMPLETED" : state.runStatus,
    identity: identityFromState(state),
    state,
    effects: includeEffects && state.pendingToolCall ? [state.pendingToolCall] : [],
    trace: state.trace,
    checkpoint: {
      backend: backend.kind,
      recoverableAfterRefresh: backend.recoverableAfterRefresh,
      checkpointId,
      ...(backend.fallbackReason ? { fallbackReason: backend.fallbackReason } : {}),
    },
    restored,
  };
  return CoachAgentResultSchema.parse(result) as CoachAgentResult;
}

function recoveryVersionsMatch(state: CoachAgentState, event: ReconnectReplayEvent): boolean {
  return event.versions.graph === COACH_AGENT_GRAPH_VERSION &&
    event.versions.state === COACH_AGENT_STATE_VERSION &&
    event.versions.session === COACH_AGENT_SESSION_VERSION &&
    event.versions.recovery === COACH_AGENT_RECOVERY_VERSION &&
    state.graphVersion === event.versions.graph &&
    state.schemaVersion === event.versions.state;
}

function recoveryBoundaryMatches(state: CoachAgentState, boundary: ReconnectReplayEvent["boundary"]): boolean {
  if (boundary.kind === "ROUTE_START") return state.routeCursor === boundary.segmentIndex;
  if (boundary.kind === "CUE_PAUSED") {
    return state.activeSegmentId === boundary.segmentId &&
      state.routeCursor === boundary.segmentIndex &&
      state.activeCueId === boundary.cueId &&
      state.currentSessionPhase === boundary.sessionPhase &&
      state.outcomeGateStatus === boundary.outcomeGateStatus;
  }
  return state.routeCursor === boundary.segmentIndex &&
    state.sessionStatus === "COMPLETED" &&
    state.runStatus === "COMPLETED";
}

function routeOrderMatches(
  saved: CoachAgentState | undefined,
  event: Extract<CoachAgentEvent, { type: "START_CUE" }>,
): boolean {
  if (event.routeSegmentIndex === undefined) return true;
  const cursor = saved?.routeCursor ?? -1;
  return event.routeSegmentIndex === cursor || event.routeSegmentIndex === cursor + 1;
}

class CoachAgentRuntimeImpl implements CoachAgentRuntime {
  private readonly policy: PolicyAdapter;
  private backend: RuntimeBackend;
  private graph: ReturnType<typeof createCueGraph>;
  private dispatchTail: Promise<void> = Promise.resolve();

  constructor(options: CoachAgentRuntimeOptions) {
    this.policy = options.policy ?? new DeterministicPolicyAdapter();
    this.backend = createBackend(options);
    this.graph = createCueGraph({ checkpointer: this.backend.saver, policy: this.policy });
  }

  private rebuildMemoryBackend(): void {
    const previous = this.backend;
    this.backend = {
      saver: new MemorySaver(),
      kind: "MEMORY",
      recoverableAfterRefresh: false,
      fallbackReason: "IDB_FALLBACK",
    };
    this.graph = createCueGraph({ checkpointer: this.backend.saver, policy: this.policy });
    void previous.close?.();
  }

  private async checkpointState(identity: CoachAgentIdentity, requestedCheckpointId?: string): Promise<CheckpointRead> {
    const tuple = await this.backend.saver.getTuple({
      configurable: {
        thread_id: threadIdForIdentity(identity),
        checkpoint_ns: "",
        ...(requestedCheckpointId ? { checkpoint_id: requestedCheckpointId } : {}),
      },
    });
    const read = stateFromCheckpoint(tuple?.checkpoint.channel_values.agent);
    const checkpointId = tuple?.config.configurable?.checkpoint_id;
    return {
      ...read,
      checkpointId: typeof checkpointId === "string" && checkpointId.length > 0 ? checkpointId : null,
    };
  }

  private async invokeState(
    state: CoachAgentState,
    event: CoachAgentEvent,
    config: { configurable: { thread_id: string; checkpoint_ns: string } },
    restored: CoachAgentResult["restored"],
  ): Promise<CoachAgentResult> {
    const output = await this.graph.invoke({ agent: state, event }, config);
    const checkpointRead = await this.checkpointState(event.identity);
    const nextState = graphStateFromOutput(output) ?? checkpointRead.state;
    if (!nextState) throw new Error("coach-agent graph returned no state");
    return resultForState(nextState, this.backend, restored, checkpointRead.checkpointId);
  }

  private async dispatchWithBackend(event: CoachAgentEvent): Promise<CoachAgentResult> {
    const threadId = threadIdForIdentity(event.identity);
    const latestConfig = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
      },
    };
    let config: {
      configurable: {
        thread_id: string;
        checkpoint_ns: string;
        checkpoint_id?: string;
      };
    } = latestConfig;

    if (event.type === "RESET") {
      await this.backend.saver.deleteThread(threadId);
      return resultForState(dormantState(event.identity, "RESET"), this.backend, "FRESH");
    }

    const latestRead = await this.checkpointState(event.identity);
    let read = latestRead;
    if (
      event.type === "RECONNECT_REPLAY" &&
      latestRead.state &&
      sameIdentity(identityFromState(latestRead.state), event.identity) &&
      latestRead.state.processedEventIds.includes(event.eventId)
    ) {
      return resultForState(latestRead.state, this.backend, "MATCHED", latestRead.checkpointId);
    }
    if (event.type === "RECONNECT_REPLAY") {
      const expectedRead = await this.checkpointState(event.identity, event.expectedCheckpointId);
      if (expectedRead.checkpointId !== event.expectedCheckpointId) {
        return resultForState(
          dormantState(event.identity, "RECOVERY_CHECKPOINT_MISMATCH"),
          this.backend,
          "DORMANT_RECOVERY_MISMATCH",
          latestRead.checkpointId,
        );
      }
      read = expectedRead;
      config = {
        configurable: {
          ...latestConfig.configurable,
          checkpoint_id: event.expectedCheckpointId,
        },
      };
    }
    let saved = read.state;
    if (read.incompatible) {
      if (event.type === "RESUME_TOOL" || event.type === "RECONNECT_REPLAY") {
        return resultForState(
          dormantState(event.identity, event.type === "RECONNECT_REPLAY" ? "RECOVERY_VERSION_MISMATCH" : "CHECKPOINT_VERSION_MISMATCH"),
          this.backend,
          event.type === "RECONNECT_REPLAY" ? "DORMANT_RECOVERY_MISMATCH" : "DORMANT_MISSING",
          event.type === "RECONNECT_REPLAY" ? latestRead.checkpointId : read.checkpointId,
        );
      }
      await this.backend.saver.deleteThread(threadId);
      saved = undefined;
    }

    if (saved && !sameIdentity(identityFromState(saved), event.identity)) {
      const reason = saved.routeHash === event.identity.routeHash ? "IDENTITY_MISMATCH" : "ROUTE_HASH_MISMATCH";
      if (event.type === "RESUME_TOOL" || event.type === "RECONNECT_REPLAY") {
        return resultForState(
          dormantState(event.identity, reason),
          this.backend,
          event.type === "RECONNECT_REPLAY" ? "DORMANT_RECOVERY_MISMATCH" : "DORMANT_IDENTITY_MISMATCH",
          event.type === "RECONNECT_REPLAY" ? latestRead.checkpointId : read.checkpointId,
        );
      }
      await this.backend.saver.deleteThread(threadId);
      saved = undefined;
    }

    if (event.type === "RECONNECT_REPLAY") {
      if (!saved) return resultForState(dormantState(event.identity, "STALE_RESUME"), this.backend, "DORMANT_MISSING", read.checkpointId);
      if (read.checkpointId !== event.expectedCheckpointId) {
        return resultForState(dormantState(event.identity, "RECOVERY_CHECKPOINT_MISMATCH"), this.backend, "DORMANT_RECOVERY_MISMATCH", latestRead.checkpointId);
      }
      if (!recoveryVersionsMatch(saved, event)) {
        return resultForState(dormantState(event.identity, "RECOVERY_VERSION_MISMATCH"), this.backend, "DORMANT_RECOVERY_MISMATCH", read.checkpointId);
      }
      if (!recoveryBoundaryMatches(saved, event.boundary)) {
        return resultForState(dormantState(event.identity, "RECOVERY_BOUNDARY_MISMATCH"), this.backend, "DORMANT_RECOVERY_MISMATCH", read.checkpointId);
      }
      const disposition = event.pendingToolDisposition;
      if (saved.runStatus === "WAITING_TOOL") {
        if (!saved.pendingToolCall || disposition.status === "NONE" || disposition.callId !== saved.pendingToolCall.callId) {
          return resultForState(dormantState(event.identity, "RECOVERY_TOOL_MISMATCH"), this.backend, "DORMANT_RECOVERY_MISMATCH", read.checkpointId);
        }
        if (disposition.status === "SUCCEEDED") {
          const output = await this.graph.invoke(new Command({ resume: disposition.result }), config);
          const resumedRead = await this.checkpointState(event.identity);
          const nextState = graphStateFromOutput(output) ?? resumedRead.state;
          if (!nextState) throw new Error("coach-agent graph returned no state after reconnect resume");
          return this.invokeState(nextState, event, latestConfig, "MATCHED");
        }
        return this.invokeState(saved, event, config, "MATCHED");
      }
      if (disposition.status !== "NONE") {
        return resultForState(dormantState(event.identity, "RECOVERY_TOOL_MISMATCH"), this.backend, "DORMANT_RECOVERY_MISMATCH", read.checkpointId);
      }
      return this.invokeState(saved, event, config, "MATCHED");
    }

    if (event.type === "RESUME_TOOL") {
      if (!saved) return resultForState(dormantState(event.identity, "STALE_RESUME"), this.backend, "DORMANT_MISSING", read.checkpointId);
      if (saved.sessionStatus === "CANCELLED" || saved.sessionStatus === "COMPLETED" || saved.runStatus === "USER_TAKEOVER") {
        return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
      }
      if (saved.processedEventIds.includes(event.eventId)) return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
      if (saved.runStatus !== "WAITING_TOOL" || !saved.pendingToolCall) return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
      if (saved.pendingToolCall.callId !== event.result.callId) {
        return resultForState({
          ...saved,
          fallbackReasons: addFallbackReason(saved.fallbackReasons, "EXPIRED_EVENT"),
        }, this.backend, "MATCHED", read.checkpointId, false);
      }
      const output = await this.graph.invoke(new Command({ resume: event.result }), config);
      const resumedRead = await this.checkpointState(event.identity);
      const nextState = graphStateFromOutput(output) ?? resumedRead.state;
      if (!nextState) throw new Error("coach-agent graph returned no state after resume");
      return resultForState(nextState, this.backend, "MATCHED", resumedRead.checkpointId);
    }

    if (saved?.processedEventIds.includes(event.eventId)) return resultForState(saved, this.backend, "MATCHED", read.checkpointId);

    if (event.type === "USER_TAKEOVER") {
      if (!saved) return this.invokeState(emptyState(event.identity), event, config, "FRESH");
      if (saved.sessionStatus === "CANCELLED" || saved.sessionStatus === "COMPLETED") {
        return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
      }
      return this.invokeState(saved, event, config, "MATCHED");
    }

    if (event.type === "CANCEL_RUN") {
      if (!saved) return resultForState(dormantState(event.identity, "STALE_RESUME"), this.backend, "DORMANT_MISSING", read.checkpointId);
      return this.invokeState(saved, event, config, "MATCHED");
    }

    if (event.type === "OBSERVE_SEGMENT") {
      if (saved?.sessionStatus === "CANCELLED" || saved?.sessionStatus === "COMPLETED" || saved?.runStatus === "WAITING_TOOL" || saved?.runStatus === "USER_TAKEOVER") {
        return resultForState(saved!, this.backend, "MATCHED", read.checkpointId);
      }
      return this.invokeState(saved ?? emptyState(event.identity), event, config, saved ? "MATCHED" : "FRESH");
    }

    if (event.type === "OBSERVE_PRESENTED_CUE") {
      if (!saved || saved.sessionStatus === "CANCELLED" || saved.sessionStatus === "COMPLETED" || saved.runStatus === "WAITING_TOOL") {
        return resultForState(saved ?? dormantState(event.identity, "STALE_RESUME"), this.backend, saved ? "MATCHED" : "DORMANT_MISSING", read.checkpointId);
      }
      const binding = saved.presentedCueBindings.find((item) => item.cueId === event.cueId);
      const isNext = event.segmentIndex === saved.routeCursor + 1;
      if (!binding || !isNext || binding.segmentId !== event.segmentId || binding.segmentIndex !== event.segmentIndex) {
        return resultForState({
          ...saved,
          fallbackReasons: addFallbackReason(saved.fallbackReasons, "ROUTE_ORDER_MISMATCH"),
        }, this.backend, "MATCHED", read.checkpointId);
      }
      return this.invokeState(saved, event, config, "MATCHED");
    }

    if (event.type === "COMPLETE_SESSION") {
      if (!saved || saved.sessionStatus === "CANCELLED" || saved.runStatus === "WAITING_TOOL" || saved.runStatus === "USER_TAKEOVER") {
        return resultForState(saved ?? dormantState(event.identity, "STALE_RESUME"), this.backend, "DORMANT_MISSING", read.checkpointId);
      }
      if (saved.sessionStatus === "COMPLETED") return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
      return this.invokeState(saved, event, config, "MATCHED");
    }


    if (event.type === "START_MANUAL_CUE_VISIT") {
      if (!saved || saved.sessionStatus === "CANCELLED" || saved.sessionStatus === "COMPLETED") {
        return resultForState(saved ?? dormantState(event.identity, "STALE_RESUME"), this.backend, saved ? "MATCHED" : "DORMANT_MISSING", read.checkpointId);
      }
      if (saved.runStatus !== "USER_TAKEOVER") return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
      if (saved.completedCueIds.includes(event.cueId)) return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
      return this.invokeState(initialManualVisitState(event, saved), event, config, "MATCHED");
    }

    // START_CUE is the sole cue preparation event. A takeover requires a new
    // host-provided cue marker; old READY/continue events remain inert.
    if (saved?.sessionStatus === "CANCELLED" || saved?.sessionStatus === "COMPLETED") {
      return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
    }
    if (saved?.runStatus === "USER_TAKEOVER" && !event.resumeFromTakeover) {
      return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
    }
    if (saved?.runStatus === "WAITING_TOOL") return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
    if (
      saved?.runStatus === "USER_TAKEOVER" &&
      event.resumeFromTakeover &&
      saved.completedCueIds.includes(event.cueId)
    ) {
      // The graph lifecycle branch persists the state before returning; it
      // also guarantees zero Policy calls and zero new TeachingMove.
      return this.invokeState(saved, event, config, "MATCHED");
    }
    if (saved && saved.completedCueIds.includes(event.cueId)) return resultForState(saved, this.backend, "MATCHED", read.checkpointId);
    if (!routeOrderMatches(saved, event)) {
      return resultForState({
        ...(saved ?? emptyState(event.identity)),
        fallbackReasons: addFallbackReason((saved ?? emptyState(event.identity)).fallbackReasons, "ROUTE_ORDER_MISMATCH"),
      }, this.backend, "MATCHED", read.checkpointId);
    }

    return this.invokeState(
      initialState(event, saved, this.backend.fallbackReason === "IDB_FALLBACK" ? "IDB_FALLBACK" : undefined),
      event,
      config,
      saved ? "MATCHED" : "FRESH",
    );
  }

  private async dispatchOne(event: CoachAgentEvent): Promise<CoachAgentResult> {
    const parsedEvent = CoachAgentEventSchema.parse(event);
    try {
      return await this.dispatchWithBackend(parsedEvent);
    } catch (error) {
      if (this.backend.kind !== "INDEXEDDB") throw error;
      this.rebuildMemoryBackend();
      return this.dispatchWithBackend(parsedEvent);
    }
  }

  dispatch(event: CoachAgentEvent): Promise<CoachAgentResult> {
    const parsedEvent = CoachAgentEventSchema.parse(event);
    const result = this.dispatchTail.then(() => this.dispatchOne(parsedEvent));
    this.dispatchTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function createBackend(options: CoachAgentRuntimeOptions): RuntimeBackend {
  if (options.checkpointer) {
    const kind = options.checkpointBackend ?? "MEMORY";
    return {
      saver: options.checkpointer,
      kind,
      recoverableAfterRefresh: kind !== "MEMORY",
    };
  }
  if (options.checkpoint === "durable_object") {
    throw new Error("Durable Object checkpoint requires an injected checkpointer");
  }
  if (options.checkpoint !== "indexeddb") {
    return { saver: new MemorySaver(), kind: "MEMORY", recoverableAfterRefresh: false };
  }
  try {
    const saver = new IndexedDbCheckpointSaver({
      indexedDB: options.indexedDB,
      databaseName: options.databaseName,
      retention: options.retention,
    });
    return { saver, kind: "INDEXEDDB", recoverableAfterRefresh: true, close: () => saver.close() };
  } catch {
    return { saver: new MemorySaver(), kind: "MEMORY", recoverableAfterRefresh: false, fallbackReason: "IDB_FALLBACK" };
  }
}

export function createCoachAgentRuntime(options: CoachAgentRuntimeOptions = {}): CoachAgentRuntime {
  const implementation = new CoachAgentRuntimeImpl(options);
  return Object.freeze({ dispatch: implementation.dispatch.bind(implementation) });
}

export function toolRequestForResult(value: unknown): AgentToolRequest {
  return AgentToolRequestSchema.parse(value);
}
