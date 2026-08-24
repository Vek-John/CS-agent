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
  type AgentToolRequest,
  type CoachAgentEvent,
  type CoachAgentIdentity,
  type CoachAgentResult,
  type CoachAgentState,
  type FallbackReason,
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
    schemaVersion: "coach-agent-state.v2",
    graphVersion: "coach-agent-graph.v2",
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
    routeCursor: -1,
    currentSegmentMode: null,
    activeFocus: null,
    activeNarrationPolicySummary: null,
    activeAllowedEvidenceSummary: [],
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
    schemaVersion: "coach-agent-state.v2",
    graphVersion: "coach-agent-graph.v2",
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
    routeCursor: event.routeSegmentIndex ?? base.routeCursor,
    currentSegmentMode: event.segmentMode ?? base.currentSegmentMode,
    activeFocus: event.focus,
    activeNarrationPolicySummary: "fields" in event.narrationSummary
      ? event.narrationSummary
      : null,
    activeAllowedEvidenceSummary: event.allowedEvidenceSummary,
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

function dormantState(
  identity: CoachAgentIdentity,
  reason: FallbackReason,
): CoachAgentState {
  return CoachAgentStateSchema.parse({
    ...emptyState(identity),
    schemaVersion: "coach-agent-state.v2",
    graphVersion: "coach-agent-graph.v2",
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
  if (!value || typeof value !== "object") return { incompatible: false };
  const parsed = CoachAgentStateSchema.safeParse(value);
  if (parsed.success) return { state: parsed.data, incompatible: false };
  return { incompatible: true };
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
): CoachAgentResult {
  const result = {
    version: "coach-agent-result.v1" as const,
    // Preserve the Stage 2 response status for existing Host adapters; the
    // v2 state carries the distinct CUE_COMPLETED vs session COMPLETED status.
    status: state.runStatus === "CUE_COMPLETED" ? "COMPLETED" : state.runStatus,
    identity: identityFromState(state),
    state,
    effects: state.pendingToolCall ? [state.pendingToolCall] : [],
    trace: state.trace,
    checkpoint: {
      backend: backend.kind,
      recoverableAfterRefresh: backend.recoverableAfterRefresh,
      ...(backend.fallbackReason ? { fallbackReason: backend.fallbackReason } : {}),
    },
    restored,
  };
  return CoachAgentResultSchema.parse(result) as CoachAgentResult;
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

  private async checkpointState(identity: CoachAgentIdentity): Promise<CheckpointRead> {
    const tuple = await this.backend.saver.getTuple({
      configurable: {
        thread_id: threadIdForIdentity(identity),
        checkpoint_ns: "",
      },
    });
    return stateFromCheckpoint(tuple?.checkpoint.channel_values.agent);
  }

  private async invokeState(
    state: CoachAgentState,
    event: CoachAgentEvent,
    config: { configurable: { thread_id: string; checkpoint_ns: string } },
    restored: CoachAgentResult["restored"],
  ): Promise<CoachAgentResult> {
    const output = await this.graph.invoke({ agent: state, event }, config);
    const nextState = graphStateFromOutput(output) ?? (await this.checkpointState(event.identity)).state;
    if (!nextState) throw new Error("coach-agent graph returned no state");
    return resultForState(nextState, this.backend, restored);
  }

  private async dispatchWithBackend(event: CoachAgentEvent): Promise<CoachAgentResult> {
    const threadId = threadIdForIdentity(event.identity);
    const config = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
      },
    };

    if (event.type === "RESET") {
      await this.backend.saver.deleteThread(threadId);
      return resultForState(dormantState(event.identity, "RESET"), this.backend, "FRESH");
    }

    const read = await this.checkpointState(event.identity);
    let saved = read.state;
    if (read.incompatible) {
      if (event.type === "RESUME_TOOL") {
        return resultForState(dormantState(event.identity, "CHECKPOINT_VERSION_MISMATCH"), this.backend, "DORMANT_MISSING");
      }
      await this.backend.saver.deleteThread(threadId);
      saved = undefined;
    }

    if (saved && !sameIdentity(identityFromState(saved), event.identity)) {
      const reason = saved.routeHash === event.identity.routeHash ? "IDENTITY_MISMATCH" : "ROUTE_HASH_MISMATCH";
      if (event.type === "RESUME_TOOL") {
        return resultForState(dormantState(event.identity, reason), this.backend, "DORMANT_IDENTITY_MISMATCH");
      }
      await this.backend.saver.deleteThread(threadId);
      saved = undefined;
    }

    if (event.type === "RESUME_TOOL") {
      if (!saved) return resultForState(dormantState(event.identity, "STALE_RESUME"), this.backend, "DORMANT_MISSING");
      if (saved.sessionStatus === "CANCELLED" || saved.sessionStatus === "COMPLETED" || saved.runStatus === "USER_TAKEOVER") {
        return resultForState(saved, this.backend, "MATCHED");
      }
      if (saved.processedEventIds.includes(event.eventId)) return resultForState(saved, this.backend, "MATCHED");
      if (saved.runStatus !== "WAITING_TOOL" || !saved.pendingToolCall) return resultForState(saved, this.backend, "MATCHED");
      if (saved.pendingToolCall.callId !== event.result.callId) {
        return resultForState({
          ...saved,
          fallbackReasons: addFallbackReason(saved.fallbackReasons, "EXPIRED_EVENT"),
        }, this.backend, "MATCHED");
      }
      const output = await this.graph.invoke(new Command({ resume: event.result }), config);
      const nextState = graphStateFromOutput(output) ?? (await this.checkpointState(event.identity)).state;
      if (!nextState) throw new Error("coach-agent graph returned no state after resume");
      return resultForState(nextState, this.backend, "MATCHED");
    }

    if (saved?.processedEventIds.includes(event.eventId)) return resultForState(saved, this.backend, "MATCHED");

    if (event.type === "USER_TAKEOVER") {
      if (!saved || saved.sessionStatus === "CANCELLED" || saved.sessionStatus === "COMPLETED") {
        return resultForState(saved ?? dormantState(event.identity, "STALE_RESUME"), this.backend, "DORMANT_MISSING");
      }
      return this.invokeState(saved, event, config, "MATCHED");
    }

    if (event.type === "CANCEL_RUN") {
      if (!saved) return resultForState(dormantState(event.identity, "STALE_RESUME"), this.backend, "DORMANT_MISSING");
      return this.invokeState(saved, event, config, "MATCHED");
    }

    if (event.type === "OBSERVE_SEGMENT") {
      if (saved?.sessionStatus === "CANCELLED" || saved?.sessionStatus === "COMPLETED" || saved?.runStatus === "WAITING_TOOL" || saved?.runStatus === "USER_TAKEOVER") {
        return resultForState(saved!, this.backend, "MATCHED");
      }
      return this.invokeState(saved ?? emptyState(event.identity), event, config, saved ? "MATCHED" : "FRESH");
    }

    if (event.type === "COMPLETE_SESSION") {
      if (!saved || saved.sessionStatus === "CANCELLED" || saved.runStatus === "WAITING_TOOL" || saved.runStatus === "USER_TAKEOVER") {
        return resultForState(saved ?? dormantState(event.identity, "STALE_RESUME"), this.backend, "DORMANT_MISSING");
      }
      if (saved.sessionStatus === "COMPLETED") return resultForState(saved, this.backend, "MATCHED");
      return this.invokeState(saved, event, config, "MATCHED");
    }

    // START_CUE is the sole cue preparation event. A takeover requires a new
    // host-provided cue marker; old READY/continue events remain inert.
    if (saved?.sessionStatus === "CANCELLED" || saved?.sessionStatus === "COMPLETED") {
      return resultForState(saved, this.backend, "MATCHED");
    }
    if (saved?.runStatus === "USER_TAKEOVER" && !event.resumeFromTakeover) {
      return resultForState(saved, this.backend, "MATCHED");
    }
    if (saved?.runStatus === "WAITING_TOOL") return resultForState(saved, this.backend, "MATCHED");
    if (
      saved?.runStatus === "USER_TAKEOVER" &&
      event.resumeFromTakeover &&
      saved.completedCueIds.includes(event.cueId)
    ) {
      // The graph lifecycle branch persists the state before returning; it
      // also guarantees zero Policy calls and zero new TeachingMove.
      return this.invokeState(saved, event, config, "MATCHED");
    }
    if (saved && saved.completedCueIds.includes(event.cueId)) return resultForState(saved, this.backend, "MATCHED");
    if (!routeOrderMatches(saved, event)) {
      return resultForState({
        ...(saved ?? emptyState(event.identity)),
        fallbackReasons: addFallbackReason((saved ?? emptyState(event.identity)).fallbackReasons, "ROUTE_ORDER_MISMATCH"),
      }, this.backend, "MATCHED");
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
