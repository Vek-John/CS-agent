import {
  AgentToolRequestSchema,
  AgentToolResultSchema,
  CoachAgentEventSchema,
  CoachAgentIdentitySchema,
  TeachingCapabilitySchema,
  buildTeachingCapabilities,
  createRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchResponse,
  serializeRemoteCoachAgentDispatchEnvelope,
  type AgentToolRequest,
  type AgentToolResult,
  type CoachAgentEvent,
  type CoachAgentIdentity,
  type CoachAgentResult,
  type TeachingCapability,
} from "@cs-coach/coach-agent/client";
import type {
  Annotation,
  CoachCue,
  CoachingRouteState,
  CoachingSessionPhase,
  NarrationBundle,
  OutcomeCompletionState,
  PlaybackCommand,
  ReviewPlan,
  TeachingToolAckEvent,
} from "@cs-coach/contracts";

/** The only Stage2 visual capability. Keep the surface closed until later stages. */
export const STAGE2_TOOL = "FOCUS_MAP_EVIDENCE" as const;
export const STAGE2_EVENT_VERSION = "coach-agent-event.v1" as const;
export const STAGE2_COMMAND_SCHEMA_VERSION = "cs2d-teaching-tool-command.v1" as const;
export const STAGE2_ACK_TIMEOUT_MS = 10_000 as const;

export interface Stage2AnalysisIdentity {
  readonly demo_id: string;
  readonly selected_steam_id: string;
  readonly metadata?: { readonly demo_content_hash?: string };
}

export interface CoachAgentHostAdapterInput {
  /** Immutable route returned by the Director → PlanCompiler seam. */
  readonly plan: ReviewPlan;
  /** Session-owned route state; route membership is never inferred from cue text. */
  readonly routeState: CoachingRouteState;
  /** Cue currently being presented after its outcome gate. */
  readonly cue: CoachCue;
  /** Presentable, reference-bound narration. Its text never crosses to Agent. */
  readonly narration: NarrationBundle;
  readonly outcomeGate: OutcomeCompletionState;
  readonly currentSessionPhase: "PAUSED_FOR_COACHING";
  /** Allowlisted analysis identity; raw Replay/frames are intentionally absent. */
  readonly analysis: Stage2AnalysisIdentity;
  /** SHA-256 returned by the parser Worker for this exact raw .dem. */
  readonly demoContentHash: string;
  readonly selectedPlayerId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly generation: number;
}

export interface Stage2ToolContext {
  readonly generation: number;
  readonly currentSessionPhase: CoachingSessionPhase;
  readonly outcomeGate: OutcomeCompletionState;
}

interface CapabilityBinding {
  readonly capability: TeachingCapability;
  readonly cueId: string;
  readonly identity: CoachAgentIdentity;
  readonly generation: number;
  readonly gate: OutcomeCompletionState;
  readonly annotations: ReadonlyMap<string, WorldPointAnnotation>;
}

type WorldPointAnnotation = Extract<Annotation, { type: "POINT"; coordinate_space: "WORLD" }>;

export interface Stage2PreparedStart {
  readonly event: Extract<CoachAgentEvent, { type: "START_CUE" }>;
  readonly capabilities: readonly TeachingCapability[];
}

export interface Stage2RemoteFetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface Stage2TimeoutScheduler {
  setTimeout(callback: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultStage2TimeoutScheduler: Stage2TimeoutScheduler = {
  setTimeout: (callback, timeoutMs) => globalThis.setTimeout(callback, timeoutMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Small injectable watchdog seam so a lost iframe cannot lock basic playback. */
export class Stage2AckTimeoutController {
  private handle: unknown;

  constructor(private readonly scheduler: Stage2TimeoutScheduler = defaultStage2TimeoutScheduler) {}

  arm(generation: number, onTimeout: (generation: number) => void): void {
    this.clear();
    this.handle = this.scheduler.setTimeout(() => {
      this.handle = undefined;
      onTimeout(generation);
    }, STAGE2_ACK_TIMEOUT_MS);
  }

  clear(): void {
    if (this.handle === undefined) return;
    this.scheduler.clearTimeout(this.handle);
    this.handle = undefined;
  }
}

export async function dispatchCoachAgentEvent(
  event: CoachAgentEvent,
  fetcher: Stage2RemoteFetchLike = fetch,
): Promise<CoachAgentResult> {
  const envelope = createRemoteCoachAgentDispatchEnvelope(event);
  const response = await fetcher("/api/coaching/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serializeRemoteCoachAgentDispatchEnvelope(envelope),
  });
  if (!response.ok) throw new Error(`agent dispatch HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("agent dispatch returned invalid JSON");
  }
  return parseRemoteCoachAgentDispatchResponse(body);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty.`);
  return normalized;
}

function sha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("demoContentHash must be a 64-character SHA-256 digest.");
  }
  return normalized;
}

export function frozenRouteCueOrder(plan: ReviewPlan, routeState: CoachingRouteState): readonly string[] {
  if (routeState.frozenCueIds.length > 0) return routeState.frozenCueIds;
  if (routeState.cueOrder.length > 0) return routeState.cueOrder;
  return plan.segments.flatMap((segment) => segment.cue_ids);
}

function worldPointAnnotations(cue: CoachCue): WorldPointAnnotation[] {
  return cue.annotations.filter((annotation): annotation is WorldPointAnnotation =>
    annotation.type === "POINT" &&
    annotation.coordinate_space === "WORLD" &&
    Number.isFinite(annotation.point.x) &&
    Number.isFinite(annotation.point.y),
  );
}

function stage2CapabilityInput(cue: CoachCue, annotations: readonly WorldPointAnnotation[]) {
  return {
    cueId: cue.id,
    primaryFocusCode: cue.primary_focus_code ?? "",
    decisionRefs: unique(cue.observable_fact_refs),
    actionRefs: unique(cue.action_fact_refs ?? []),
    outcomeRefs: unique(cue.outcome_fact_refs ?? []),
    evidenceRefs: unique(cue.evidence.map((evidence) => evidence.id)),
    annotationRefs: annotations.map((annotation) => annotation.id),
    actorRefs: [],
    calloutRefs: [],
    grenadeTrajectoryRefs: [],
    grenadeLandingRefs: [],
    outcomeGateStatus: "COMPLETE" as const,
    modelStatus: "UNAVAILABLE" as const,
    measurementRefs: [],
    negativeWinProbabilitySwingPercentagePoints: null,
    economyContext: {
      reliable: false,
      relevant: false,
      ref: null,
      economyClass: "UNKNOWN" as const,
    },
    limitations: cue.limitations.slice(0, 8),
  };
}

function allowedEvidenceSummary(cue: CoachCue, annotations: readonly WorldPointAnnotation[]) {
  const summaries = [
    { namespace: "DECISION" as const, refs: unique(cue.observable_fact_refs) },
    { namespace: "ACTION" as const, refs: unique(cue.action_fact_refs ?? []) },
    { namespace: "OUTCOME" as const, refs: unique(cue.outcome_fact_refs ?? []) },
    {
      namespace: "EVIDENCE" as const,
      refs: unique([
        ...cue.evidence.map((evidence) => evidence.id),
        ...annotations.map((annotation) => annotation.id),
      ]),
    },
    { namespace: "ADVICE" as const, refs: unique(cue.advice.map((advice) => advice.id)) },
  ];
  return summaries.filter((summary) => summary.refs.length > 0);
}

function eventIdFor(input: CoachAgentHostAdapterInput): string {
  const safeCue = input.cue.id.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 96) || "cue";
  return `stage2-start-${safeCue}-${input.generation}`.slice(0, 160);
}

function narrationReadiness(routeState: CoachingRouteState, cueId: string): "READY" | "FALLBACK" {
  const readiness = routeState.readiness[cueId];
  if (readiness !== "READY" && readiness !== "FALLBACK") {
    throw new Error("Stage2 narration is not presentable for the frozen cue.");
  }
  return readiness;
}

export function validateStage2HostInput(input: CoachAgentHostAdapterInput): {
  hash: string;
  annotations: WorldPointAnnotation[];
  narrationReadiness: "READY" | "FALLBACK";
} {
  if (input.plan.status !== "COMPLETE") throw new Error("Stage2 requires a complete ReviewPlan.");
  if (!input.routeState.routeFrozen) throw new Error("Stage2 requires a frozen coaching route.");
  if (!frozenRouteCueOrder(input.plan, input.routeState).includes(input.cue.id)) {
    throw new Error("Stage2 cue is not part of the frozen route.");
  }
  if (input.outcomeGate.cueId !== input.cue.id || input.outcomeGate.status !== "COMPLETE") {
    throw new Error("Stage2 requires the current cue outcome gate to be COMPLETE.");
  }
  if (input.currentSessionPhase !== "PAUSED_FOR_COACHING") {
    throw new Error("Stage2 dispatch is only legal while the cue is paused for coaching.");
  }
  if (input.narration.cueId !== input.cue.id) throw new Error("Presentable narration cue identity mismatch.");
  if (!input.cue.primary_focus_code || input.narration.primaryFocusCode !== input.cue.primary_focus_code) {
    throw new Error("Stage2 cue focus identity mismatch.");
  }
  if (input.analysis.demo_id !== input.plan.demo_id) throw new Error("Analysis and ReviewPlan demo identity mismatch.");
  if (input.analysis.selected_steam_id !== input.selectedPlayerId || input.plan.player_id !== input.selectedPlayerId) {
    throw new Error("Analysis and ReviewPlan player identity mismatch.");
  }
  const hash = sha256(input.demoContentHash);
  if (input.analysis.metadata?.demo_content_hash && sha256(input.analysis.metadata.demo_content_hash) !== hash) {
    throw new Error("Analysis metadata hash does not match the parser hash.");
  }
  nonEmpty(input.plan.id, "routeId");
  nonEmpty(input.routeState.routeFingerprint, "routeHash");
  nonEmpty(input.sessionId, "sessionId");
  nonEmpty(input.runId, "runId");
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error("generation must be a non-negative integer.");
  return {
    hash,
    annotations: worldPointAnnotations(input.cue),
    narrationReadiness: narrationReadiness(input.routeState, input.cue.id),
  };
}

/**
 * Pure Stage2 input seam. It selects no graph node and never receives raw
 * Replay/frames; only route-owned references are allowed to reach the Agent.
 */
export function buildStage2StartCue(input: CoachAgentHostAdapterInput): Stage2PreparedStart {
  const checked = validateStage2HostInput(input);
  const capabilities = input.cue.primary_focus_code && checked.annotations.length > 0
    ? buildTeachingCapabilities(stage2CapabilityInput(input.cue, checked.annotations))
      .filter((capability) => capability.tool === STAGE2_TOOL)
      .map((capability) => TeachingCapabilitySchema.parse(capability))
    : [];
  const identity = CoachAgentIdentitySchema.parse({
    runId: input.runId,
    sessionId: input.sessionId,
    demoId: input.analysis.demo_id,
    demoContentHash: checked.hash,
    selectedPlayerId: input.selectedPlayerId,
    routeId: input.plan.id,
    routeHash: input.routeState.routeFingerprint,
  });
  const event = CoachAgentEventSchema.parse({
    version: STAGE2_EVENT_VERSION,
    type: "START_CUE",
    eventId: eventIdFor(input),
    identity,
    segmentId: input.cue.segment_id,
    cueId: input.cue.id,
    focus: input.cue.primary_focus_code ?? "STAGE2_FOCUS_UNAVAILABLE",
    currentSessionPhase: input.currentSessionPhase,
    outcomeGateStatus: "COMPLETE",
    narrationReadiness: checked.narrationReadiness,
    narrationSummary: {
      primaryFocusCode: input.narration.primaryFocusCode,
      readiness: checked.narrationReadiness,
      limitationCount: Math.min(8, input.cue.limitations.length),
    },
    allowedEvidenceSummary: allowedEvidenceSummary(input.cue, checked.annotations),
    limitations: input.cue.limitations.slice(0, 8),
    sessionThemes: [],
    capabilities,
  });
  return { event: event as Extract<CoachAgentEvent, { type: "START_CUE" }>, capabilities };
}

/** Select exactly the first eligible cue in the already frozen route. */
export function selectFirstStage2Cue(plan: ReviewPlan, routeState: CoachingRouteState): CoachCue | undefined {
  if (!routeState.routeFrozen || plan.status !== "COMPLETE") return undefined;
  const byId = new Map(plan.cues.map((cue) => [cue.id, cue]));
  for (const cueId of frozenRouteCueOrder(plan, routeState)) {
    const cue = byId.get(cueId);
    if (!cue || !cue.primary_focus_code) continue;
    if (worldPointAnnotations(cue).length === 0) continue;
    return cue;
  }
  return undefined;
}

export function stage2WorldPoint(cue: CoachCue, annotationRef: string): WorldPointAnnotation | undefined {
  return worldPointAnnotations(cue).find((annotation) => annotation.id === annotationRef);
}

/**
 * Host-owned capability registry. Agent requests select a capability ID; all
 * bound coordinates remain in this registry and are never accepted from the
 * request payload.
 */
export class CoachAgentHostAdapter {
  private readonly registry = new Map<string, CapabilityBinding>();
  private readonly postedCallIds = new Set<string>();
  private readonly acknowledgedCallIds = new Set<string>();
  private readonly resumedCallIds = new Set<string>();
  private activeGeneration = -1;
  private activeIdentity: CoachAgentIdentity | undefined;

  prepareStart(input: CoachAgentHostAdapterInput): Stage2PreparedStart {
    const prepared = buildStage2StartCue(input);
    this.registry.clear();
    this.postedCallIds.clear();
    this.acknowledgedCallIds.clear();
    this.resumedCallIds.clear();
    this.activeGeneration = input.generation;
    this.activeIdentity = prepared.event.identity;
    const annotations = new Map<string, WorldPointAnnotation>();
    for (const annotation of worldPointAnnotations(input.cue)) {
      annotations.set(annotation.id, { ...annotation, point: { ...annotation.point } });
    }
    for (const capability of prepared.capabilities) {
      this.registry.set(capability.capabilityId, {
        capability,
        cueId: input.cue.id,
        identity: prepared.event.identity,
        generation: input.generation,
        gate: input.outcomeGate,
        annotations,
      });
    }
    return prepared;
  }

  get capabilityCount(): number {
    return this.registry.size;
  }

  private bindingFor(request: AgentToolRequest, context: Stage2ToolContext): CapabilityBinding {
    const checked = AgentToolRequestSchema.parse(request);
    const binding = this.registry.get(checked.capabilityId);
    if (!binding) throw new Error("Agent capability is not registered by the Host.");
    if (
      checked.tool !== binding.capability.tool ||
      checked.runId !== binding.identity.runId ||
      checked.cueId !== binding.cueId
    ) {
      throw new Error("Agent tool request identity does not match the Host registry.");
    }
    if (context.generation !== binding.generation || context.currentSessionPhase !== "PAUSED_FOR_COACHING") {
      throw new Error("Agent tool request belongs to a stale generation or phase.");
    }
    if (context.generation !== this.activeGeneration) {
      throw new Error("Agent tool request belongs to a cancelled generation.");
    }
    if (
      context.outcomeGate.cueId !== binding.cueId ||
      context.outcomeGate.status !== "COMPLETE" ||
      context.outcomeGate.outcomeEndTick !== binding.gate.outcomeEndTick
    ) {
      throw new Error("Agent tool request is outside the completed outcome gate.");
    }
    const allowed = new Set(binding.capability.evidenceRefs);
    if (checked.evidenceRefs.some((ref) => !allowed.has(ref))) {
      throw new Error("Agent tool request contains evidence outside the registered capability.");
    }
    return binding;
  }

  /** Marks the call before the caller posts it, making retries side-effect free. */
  createFocusMapCommand(request: AgentToolRequest, context: Stage2ToolContext): PlaybackCommand | undefined {
    const binding = this.bindingFor(request, context);
    if (this.postedCallIds.has(request.callId)) return undefined;
    const annotationRef = binding.capability.boundArgs.tool === STAGE2_TOOL
      ? binding.capability.boundArgs.annotationRefs.find((ref) => binding.annotations.has(ref))
      : undefined;
    const annotation = annotationRef ? binding.annotations.get(annotationRef) : undefined;
    if (!annotation) throw new Error("FOCUS_MAP_EVIDENCE has no registered WORLD point.");
    this.postedCallIds.add(request.callId);
    return {
      type: "focusMapEvidence",
      schemaVersion: STAGE2_COMMAND_SCHEMA_VERSION,
      tool: STAGE2_TOOL,
      callId: request.callId,
      runId: binding.identity.runId,
      generation: binding.generation,
      cueId: binding.cueId,
      annotationRef: annotation.id,
      focusWorld: { x: annotation.point.x, y: annotation.point.y },
      label: annotation.label,
    };
  }

  acceptTeachingToolAck(
    request: AgentToolRequest,
    ack: TeachingToolAckEvent,
    context: Stage2ToolContext,
  ): AgentToolResult | undefined {
    const binding = this.bindingFor(request, context);
    if (
      ack.callId !== request.callId ||
      ack.runId !== binding.identity.runId ||
      ack.cueId !== binding.cueId ||
      ack.generation !== binding.generation ||
      ack.tool !== STAGE2_TOOL
    ) {
      throw new Error("Teaching tool ACK does not match the active Host request.");
    }
    if (this.acknowledgedCallIds.has(ack.callId)) return undefined;
    if (!ack.annotationRef || !binding.annotations.has(ack.annotationRef)) {
      throw new Error("Teaching tool ACK references an unregistered WORLD point.");
    }
    if (ack.status === "SUCCEEDED" && (ack.observationCode !== "EVIDENCE_SHOWN" || !ack.completed)) {
      throw new Error("Successful map focus ACK must report completed evidence.");
    }
    this.acknowledgedCallIds.add(ack.callId);
    return AgentToolResultSchema.parse({
      callId: ack.callId,
      status: ack.status,
      observation: { code: ack.observationCode, completed: ack.completed },
      limitations: ack.limitations.slice(0, 8),
    });
  }

  createResumeEvent(
    request: AgentToolRequest,
    result: AgentToolResult,
    context: Stage2ToolContext,
    eventId: string,
  ): Extract<CoachAgentEvent, { type: "RESUME_TOOL" }> | undefined {
    const binding = this.bindingFor(request, context);
    const checked = AgentToolResultSchema.parse(result);
    if (checked.callId !== request.callId) throw new Error("Tool result callId does not match the active request.");
    if (this.resumedCallIds.has(checked.callId)) return undefined;
    this.resumedCallIds.add(checked.callId);
    if (!this.activeIdentity) throw new Error("Stage2 has no active identity.");
    return CoachAgentEventSchema.parse({
      version: STAGE2_EVENT_VERSION,
      type: "RESUME_TOOL",
      eventId: nonEmpty(eventId, "eventId"),
      identity: this.activeIdentity,
      result: checked,
    }) as Extract<CoachAgentEvent, { type: "RESUME_TOOL" }>;
  }

  /** Invalidate all side effects from a cancelled user takeover/generation. */
  cancel(generation: number): void {
    if (generation !== this.activeGeneration) return;
    this.activeGeneration = generation + 1;
    this.registry.clear();
    this.activeIdentity = undefined;
    this.postedCallIds.clear();
    this.acknowledgedCallIds.clear();
    this.resumedCallIds.clear();
  }

  isCurrent(generation: number): boolean {
    return generation === this.activeGeneration;
  }
}
