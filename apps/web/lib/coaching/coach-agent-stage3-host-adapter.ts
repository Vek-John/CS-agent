import {
  AgentToolRequestSchema,
  AgentToolResultSchema,
  CoachAgentEventSchema,
  CoachAgentIdentitySchema,
  TeachingCapabilitySchema,
  buildTeachingCapabilities,
  type AgentToolRequest,
  type AgentToolResult,
  type CoachAgentEvent,
  type CoachAgentIdentity,
  type TeachingCapability,
} from "@cs-coach/coach-agent/client";
import type {
  Annotation,
  CandidateMaterial,
  CoachCue,
  CoachingRouteState,
  NarrationBundle,
  OutcomeCompletionState,
  OutcomeImpact,
  PlaybackCommand,
  ReviewPlan,
  TeachingToolAckEvent,
  TeachingToolCommandArgs,
  TeachingCandidate,
  WinProbabilityTimelineV1,
} from "@cs-coach/contracts";
import type { TeachingToolName } from "@cs-coach/coach-agent/client";
import {
  frozenRouteCueOrder,
  validateStage2HostInput,
  type CoachAgentHostAdapterInput,
  type Stage2AnalysisIdentity,
  type Stage2ToolContext,
} from "./coach-agent-host-adapter";

export const STAGE3_EVENT_VERSION = "coach-agent-event.v2" as const;
export const STAGE3_COMMAND_SCHEMA_VERSION = "cs2d-teaching-tool-command.v2" as const;
export const STAGE3_ACK_TIMEOUT_MS = 10_000 as const;
export const STAGE3_TOOLS = [
  "REPLAY_CUE_SLOW",
  "FOCUS_MAP_EVIDENCE",
  "SHOW_GRENADE_TRACE",
  "SHOW_WIN_RATE_IMPACT",
  "SHOW_ECONOMY_CONTEXT",
] as const satisfies readonly TeachingToolName[];

export interface Stage3AnalysisEvidence {
  readonly candidate?: TeachingCandidate;
  readonly material?: CandidateMaterial;
  readonly outcomeImpact?: OutcomeImpact;
  readonly winProbabilityTimeline?: WinProbabilityTimelineV1;
}

export interface Stage3HostAdapterInput extends CoachAgentHostAdapterInput {
  readonly analysis: Stage2AnalysisIdentity;
  readonly tickRate: number;
  readonly evidence: Stage3AnalysisEvidence;
  /** A takeover recovery is a new lifecycle event, not a replay of START_CUE. */
  readonly resumeFromTakeover?: boolean;
  /** Optional caller-owned event id for a restored lifecycle. */
  readonly lifecycleEventId?: string;
}

export interface Stage3IdentityInput {
  readonly plan: ReviewPlan;
  readonly routeState: CoachingRouteState;
  readonly analysis: Stage2AnalysisIdentity;
  readonly demoContentHash: string;
  readonly selectedPlayerId: string;
  readonly sessionId: string;
  readonly runId: string;
}

export interface Stage3NarrationFieldSummary {
  readonly text: string;
  readonly refs: readonly string[];
  readonly limitations: readonly string[];
}

/** Compact, route-owned narration projection; never includes prompt or CoT. */
export interface Stage3NarrationSummary {
  readonly primaryFocusCode: string;
  readonly readiness: "READY" | "FALLBACK";
  readonly limitationCount: number;
  readonly fields: {
    readonly currentSituation: Stage3NarrationFieldSummary;
    readonly playerAction: Stage3NarrationFieldSummary;
    readonly coreIssue: Stage3NarrationFieldSummary;
    readonly betterPlay: Stage3NarrationFieldSummary;
    readonly outcomeImpact: Stage3NarrationFieldSummary;
  };
}

export interface Stage3PreparedStart {
  readonly event: Extract<CoachAgentEvent, { type: "START_CUE" }>;
  readonly capabilities: readonly TeachingCapability[];
  readonly narrationSummary: Stage3NarrationSummary;
}

interface WorldPointAnnotation {
  readonly id: string;
  readonly point: { readonly x: number; readonly y: number };
  readonly label: string;
}

interface ToolBinding {
  readonly capability: TeachingCapability;
  readonly identity: CoachAgentIdentity;
  readonly cueId: string;
  /** Session/analysis generation; it never crosses the bridge. */
  readonly analysisGeneration: number;
  /** Monotonic Host effect epoch carried by command/ACK. */
  readonly effectGeneration: number;
  readonly ledgerKey: string;
  readonly gate: OutcomeCompletionState;
  readonly annotations: ReadonlyMap<string, WorldPointAnnotation>;
  readonly args: TeachingToolCommandArgs;
}

interface RunLedger {
  readonly postedCallIds: Set<string>;
  readonly acknowledgedCallIds: Set<string>;
  readonly resumedCallIds: Set<string>;
  readonly successfulCueIds: Set<string>;
  readonly results: Map<string, AgentToolResult>;
  readonly commandGenerations: Map<string, number>;
  readonly capabilityCallIds: Map<string, string>;
}

export interface Stage3HostAdapterStore {
  readonly runLedgers: Map<string, RunLedger>;
  activeIdentityKey?: string;
  effectEpoch: number;
  readonly lifecycleEventIds: Map<string, "PENDING" | "CONFIRMED">;
  lastSyncedCursor: number;
  queuedCursor: number;
  lifecycleDegraded: boolean;
}

export function createStage3HostAdapterStore(): Stage3HostAdapterStore {
  return { runLedgers: new Map(), effectEpoch: 0, lifecycleEventIds: new Map(), lastSyncedCursor: -1, queuedCursor: -1, lifecycleDegraded: false };
}

const MAX_RUN_LEDGERS = 4;
const MAX_CALL_LEDGER_ENTRIES = 512;
const MAX_SUCCESSFUL_CUES = 128;

function createRunLedger(): RunLedger {
  return {
    postedCallIds: new Set(),
    acknowledgedCallIds: new Set(),
    resumedCallIds: new Set(),
    successfulCueIds: new Set(),
    results: new Map(),
    commandGenerations: new Map(),
    capabilityCallIds: new Map(),
  };
}

function remember(set: Set<string>, value: string, limit: number): void {
  if (set.has(value)) return;
  set.add(value);
  while (set.size > limit) {
    const oldest = set.values().next().value as string | undefined;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function rememberMap<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function identityKey(identity: CoachAgentIdentity): string {
  return [
    identity.runId,
    identity.sessionId,
    identity.demoId,
    identity.demoContentHash,
    identity.selectedPlayerId,
    identity.routeId,
    identity.routeHash,
  ].join("|");
}

/** Stable short token over every identity dimension; never slice a semantic field. */
export function stableStage3IdentityToken(
  demoContentHash: string,
  routeId: string,
  routeHash: string,
  selectedPlayerId: string,
): string {
  const value = [demoContentHash, routeId, routeHash, selectedPlayerId].join("|");
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildStage3Identity(input: Stage3IdentityInput): CoachAgentIdentity {
  if (input.analysis.demo_id !== input.plan.demo_id) throw new Error("Stage3 lifecycle demo identity mismatch.");
  if (input.analysis.selected_steam_id !== input.selectedPlayerId || input.plan.player_id !== input.selectedPlayerId) {
    throw new Error("Stage3 lifecycle player identity mismatch.");
  }
  const hash = input.demoContentHash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Stage3 lifecycle requires a parser SHA-256 digest.");
  if (input.analysis.metadata?.demo_content_hash && input.analysis.metadata.demo_content_hash.trim().toLowerCase() !== hash) {
    throw new Error("Stage3 lifecycle analysis metadata hash mismatch.");
  }
  return CoachAgentIdentitySchema.parse({
    runId: input.runId,
    sessionId: input.sessionId,
    demoId: input.analysis.demo_id,
    demoContentHash: hash,
    selectedPlayerId: input.selectedPlayerId,
    routeId: input.plan.id,
    routeHash: input.routeState.routeFingerprint,
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function worldPoints(cue: CoachCue): WorldPointAnnotation[] {
  return cue.annotations
    .filter((annotation): annotation is Extract<Annotation, { type: "POINT"; coordinate_space: "WORLD" }> =>
      annotation.type === "POINT" && annotation.coordinate_space === "WORLD" &&
      Number.isFinite(annotation.point.x) && Number.isFinite(annotation.point.y))
    .map((annotation) => ({
      id: annotation.id,
      point: { x: annotation.point.x, y: annotation.point.y },
      label: annotation.label,
    }));
}

type EconomyClass = "PISTOL" | "ECO" | "FORCE" | "FULL" | "UNKNOWN";

/**
 * Economy context is a fact-backed risk lens, not a substring match on a
 * model label. Keep this allowlist aligned with the frozen Director focus
 * vocabulary; an unknown focus or economy class stays unavailable.
 */
const ECONOMY_FOCUS_CLASSES: Readonly<Record<string, readonly EconomyClass[]>> = {
  SURVIVE_THE_NEXT_CONTACT: ["PISTOL", "ECO", "FORCE"],
  SURVIVE_CONTACT: ["PISTOL", "ECO", "FORCE"],
  CONVERT_ADVANTAGE: ["ECO", "FORCE", "FULL"],
  OBJECTIVE_TIMING: ["PISTOL", "ECO", "FORCE"],
  UTILITY_PURPOSE_AND_TEMPO: ["PISTOL", "ECO", "FORCE"],
  WIN_PROBABILITY_SWING_RESPONSE: ["ECO", "FORCE", "FULL"],
  ECONOMY_CHANGES_RISK: ["PISTOL", "ECO", "FORCE", "FULL"],
};

function economyClassForFocus(focus: string, economyClass: EconomyClass): boolean {
  return ECONOMY_FOCUS_CLASSES[focus]?.includes(economyClass) ?? false;
}

function economyFocusLabel(focus: string, economyClass: EconomyClass): string {
  if (economyClass === "ECO" || economyClass === "FORCE" || economyClass === "PISTOL") {
    return "这次接触的可承受风险会随经济改变";
  }
  if (focus === "CONVERT_ADVANTAGE") return "优势转化的资源余量";
  if (focus === "UTILITY_PURPOSE_AND_TEMPO") return "道具进场的资源余量";
  return "当前处理的经济语境";
}

function utilityRefs(input: Stage3HostAdapterInput): string[] {
  const candidate = input.evidence.candidate;
  if (candidate?.source.kind !== "UTILITY") return [];
  const completedAtTick = input.outcomeGate.completedAtTick ?? input.outcomeGate.outcomeEndTick;
  return candidate.revealTick <= input.cue.reveal_tick && candidate.revealTick <= completedAtTick
    ? unique(candidate.source.refs)
    : [];
}

function measurementFor(input: Stage3HostAdapterInput): string | undefined {
  const candidate = input.evidence.candidate;
  const impact = input.evidence.outcomeImpact;
  const timeline = input.evidence.winProbabilityTimeline;
  if (!candidate || !impact || timeline?.status !== "AVAILABLE") return undefined;
  if (!Number.isFinite(impact.percentagePoints) || impact.percentagePoints > -1) return undefined;
  return candidate.winRateSignalRefs[0];
}

function economyFor(input: Stage3HostAdapterInput): {
  ref: string;
  economyClass: "PISTOL" | "ECO" | "FORCE" | "FULL" | "UNKNOWN";
} | undefined {
  const candidate = input.evidence.candidate;
  const material = input.evidence.material;
  if (!candidate || !material) return undefined;
  const economyClass: EconomyClass = material.economy ?? "UNKNOWN";
  const ref = candidate.economySignalRefs[0];
  if (!ref || economyClass === "UNKNOWN") return undefined;
  if (!economyClassForFocus(input.cue.primary_focus_code ?? "", economyClass)) return undefined;
  const missing = [...candidate.missingFields, ...material.limitations].join(" ").toLowerCase();
  if (/economy|money|equipment/.test(missing)) return undefined;
  return { ref, economyClass };
}

function narrationField(field: NarrationBundle[keyof Pick<NarrationBundle, "currentSituation" | "playerAction" | "coreIssue" | "betterPlay" | "outcomeImpact">]): Stage3NarrationFieldSummary {
  return {
    text: field.text.slice(0, 240),
    refs: unique(field.refs).slice(0, 8),
    limitations: unique(field.limitations ?? []).slice(0, 4),
  };
}

export function buildStage3NarrationSummary(
  narration: NarrationBundle,
  readiness: "READY" | "FALLBACK",
): Stage3NarrationSummary {
  return {
    primaryFocusCode: narration.primaryFocusCode,
    readiness,
    limitationCount: Math.min(8, [
      ...(narration.currentSituation.limitations ?? []),
      ...(narration.playerAction.limitations ?? []),
      ...(narration.coreIssue.limitations ?? []),
      ...(narration.betterPlay.limitations ?? []),
      ...(narration.outcomeImpact.limitations ?? []),
    ].length),
    fields: {
      currentSituation: narrationField(narration.currentSituation),
      playerAction: narrationField(narration.playerAction),
      coreIssue: narrationField(narration.coreIssue),
      betterPlay: narrationField(narration.betterPlay),
      outcomeImpact: narrationField(narration.outcomeImpact),
    },
  };
}

function startEventId(input: Stage3HostAdapterInput): string {
  const lifecycleEventId = input.lifecycleEventId?.trim();
  if (lifecycleEventId) return lifecycleEventId.slice(0, 160);
  const cue = input.cue.id.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 90) || "cue";
  return `stage3-start-${cue}-${input.generation}`.slice(0, 160);
}

function restoreEventId(input: Stage3HostAdapterInput, effectGeneration: number): string {
  const cue = input.cue.id.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "cue";
  return `stage3-restore-${cue}-${effectGeneration}`.slice(0, 160);
}

function stage3CapabilityInput(input: Stage3HostAdapterInput, points: readonly WorldPointAnnotation[]) {
  const measurementRef = measurementFor(input);
  const economy = economyFor(input);
  const trajectoryRefs = utilityRefs(input);
  return {
    cueId: input.cue.id,
    primaryFocusCode: input.cue.primary_focus_code ?? "",
    decisionRefs: unique(input.cue.observable_fact_refs),
    actionRefs: unique(input.cue.action_fact_refs ?? []),
    outcomeRefs: unique(input.cue.outcome_fact_refs ?? []),
    evidenceRefs: unique(input.cue.evidence.map((evidence) => evidence.id)),
    annotationRefs: points.map((point) => point.id),
    actorRefs: [],
    calloutRefs: [],
    grenadeTrajectoryRefs: trajectoryRefs,
    // The path ref is the existing deterministic source ref; the Viewer uses
    // its final observed point as landing evidence and never receives future frames.
    grenadeLandingRefs: trajectoryRefs,
    outcomeGateStatus: "COMPLETE" as const,
    modelStatus: input.evidence.winProbabilityTimeline?.status === "AVAILABLE" ? "AVAILABLE" as const : "UNAVAILABLE" as const,
    measurementRefs: measurementRef ? [measurementRef] : [],
    negativeWinProbabilitySwingPercentagePoints: input.evidence.outcomeImpact?.percentagePoints ?? null,
    economyContext: {
      reliable: Boolean(economy),
      relevant: Boolean(economy),
      ref: economy?.ref ?? null,
      economyClass: economy?.economyClass ?? "UNKNOWN" as const,
    },
    limitations: input.cue.limitations.slice(0, 8),
  };
}

function allowedEvidence(input: Stage3HostAdapterInput, points: readonly WorldPointAnnotation[]) {
  const candidate = input.evidence.candidate;
  const measurementRef = measurementFor(input);
  const economy = economyFor(input);
  const refs = [
    { namespace: "DECISION" as const, refs: unique(input.cue.observable_fact_refs) },
    { namespace: "ACTION" as const, refs: unique(input.cue.action_fact_refs ?? []) },
    { namespace: "OUTCOME" as const, refs: unique(input.cue.outcome_fact_refs ?? []) },
    { namespace: "EVIDENCE" as const, refs: unique([...input.cue.evidence.map((item) => item.id), ...points.map((point) => point.id), ...utilityRefs(input)]) },
    { namespace: "ADVICE" as const, refs: unique(input.cue.advice.map((item) => item.id)) },
    { namespace: "MEASUREMENT" as const, refs: unique([...(measurementRef ? [measurementRef] : []), ...(economy ? [economy.ref] : [])]) },
  ];
  return refs.filter((item) => item.refs.length > 0).slice(0, 6);
}

export function buildStage3StartCue(input: Stage3HostAdapterInput): Stage3PreparedStart {
  const checked = validateStage2HostInput(input);
  const points = worldPoints(input.cue);
  const segmentIndex = input.plan.segments.findIndex((segment) => segment.id === input.cue.segment_id);
  if (segmentIndex < 0) throw new Error("Stage3 cue segment is not present in the frozen plan.");
  const segment = input.plan.segments[segmentIndex];
  const economy = input.evidence.material?.economy ?? input.evidence.candidate?.resultSummary.economyClass ?? "UNKNOWN";
  const reliableEconomy = economy !== "UNKNOWN" &&
    Boolean(input.evidence.candidate?.economySignalRefs[0]) &&
    Boolean(input.evidence.material) &&
    input.evidence.candidate?.missingFields.length === 0 &&
    input.evidence.material?.limitations.length === 0;
  const allowedEvidenceSummary = allowedEvidence(input, points);
  const presentableEvidenceRefs = unique(allowedEvidenceSummary.flatMap((summary) => summary.refs)).slice(0, 16);
  const presentableAdviceRefs = unique(input.cue.advice.map((advice) => advice.id)).slice(0, 8);
  const conflictEvidence = Boolean(
    input.evidence.candidate?.resultSummary.concurrentEvents ||
    input.evidence.outcomeImpact?.attribution === "CONCURRENT_EVENTS",
  );
  const capabilities = input.cue.primary_focus_code && (
    points.length > 0 ||
    input.cue.action_fact_refs?.length ||
    utilityRefs(input).length ||
    measurementFor(input) ||
    economyFor(input)
  )
    ? buildTeachingCapabilities(stage3CapabilityInput(input, points))
      .filter((capability) => STAGE3_TOOLS.includes(capability.tool))
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
  const summary = buildStage3NarrationSummary(input.narration, checked.narrationReadiness);
  const event = CoachAgentEventSchema.parse({
    version: STAGE3_EVENT_VERSION,
    type: "START_CUE",
    eventId: startEventId(input),
    identity,
    segmentId: input.cue.segment_id,
    cueId: input.cue.id,
    focus: input.cue.primary_focus_code ?? "STAGE3_FOCUS_UNAVAILABLE",
    currentSessionPhase: input.currentSessionPhase,
    outcomeGateStatus: "COMPLETE",
    narrationReadiness: checked.narrationReadiness,
    narrationSummary: summary,
    allowedEvidenceSummary,
    limitations: input.cue.limitations.slice(0, 8),
    sessionThemes: [],
    capabilities,
    presentableSummary: {
      completionStatus: "COMPLETED",
      presentationStatus: "PRESENTABLE",
      cueId: input.cue.id,
      roundId: `round-${segment.round_number}`,
      focus: input.cue.primary_focus_code ?? "STAGE3_FOCUS_UNAVAILABLE",
      evidenceRefs: presentableEvidenceRefs,
      adviceRefs: presentableAdviceRefs,
      economyContext: reliableEconomy ? economy : "UNKNOWN",
      conflictEvidence,
    },
    segmentMode: segment.mode,
    routeSegmentIndex: segmentIndex,
    ...(input.resumeFromTakeover ? { resumeFromTakeover: true } : {}),
  });
  return { event: event as Extract<CoachAgentEvent, { type: "START_CUE" }>, capabilities, narrationSummary: summary };
}

export function stage3EligibleCueIds(plan: ReviewPlan, routeState: CoachingRouteState): readonly string[] {
  if (!routeState.routeFrozen || plan.status !== "COMPLETE") return [];
  const byId = new Map(plan.cues.map((cue) => [cue.id, cue]));
  return frozenRouteCueOrder(plan, routeState).filter((cueId) => {
    const cue = byId.get(cueId);
    return Boolean(cue?.primary_focus_code);
  });
}

export function stage3ToolStatusLabel(tool: TeachingToolName): string {
  switch (tool) {
    case "REPLAY_CUE_SLOW": return "正在慢放关键动作";
    case "FOCUS_MAP_EVIDENCE": return "正在标出地图证据";
    case "SHOW_GRENADE_TRACE": return "正在展示道具轨迹";
    case "SHOW_WIN_RATE_IMPACT": return "正在展示胜率影响";
    case "SHOW_ECONOMY_CONTEXT": return "正在展示经济语境";
  }
}

export interface Stage3ToolContext extends Stage2ToolContext {}

export class CoachAgentStage3HostAdapter {
  constructor(private readonly store: Stage3HostAdapterStore = createStage3HostAdapterStore()) {}

  private readonly registry = new Map<string, ToolBinding>();
  private readonly attemptedCapabilityIds = new Set<string>();
  private agentEffectGeneration = 0;
  private activeEffectGeneration: number | undefined;
  private activeAnalysisGeneration: number | undefined;
  private lastAnalysisGeneration: number | undefined;
  private activeIdentityKey: string | undefined;
  private activeCueId: string | undefined;
  private activeIdentity: CoachAgentIdentity | undefined;

  private allocateEffectGeneration(): number {
    this.store.effectEpoch += 1;
    this.agentEffectGeneration = this.store.effectEpoch;
    return this.agentEffectGeneration;
  }

  prepareStart(input: Stage3HostAdapterInput): Stage3PreparedStart {
    const basePrepared = buildStage3StartCue(input);
    const nextIdentityKey = identityKey(basePrepared.event.identity);
    const identityChanged = this.store.activeIdentityKey !== undefined && this.store.activeIdentityKey !== nextIdentityKey;
    const cueChanged = this.activeCueId !== input.cue.id;
    const analysisChanged = this.activeAnalysisGeneration !== input.generation;

    // A new demo/run identity gets a fresh bounded ledger. A new cue keeps the
    // same run ledger so React re-entry/checkpoint replay cannot repost a call.
    if (identityChanged) {
      this.store.runLedgers.clear();
      this.store.lifecycleEventIds.clear();
      this.store.lastSyncedCursor = -1;
      this.store.queuedCursor = -1;
      this.store.lifecycleDegraded = false;
      this.attemptedCapabilityIds.clear();
    }
    if (identityChanged || cueChanged || analysisChanged || this.activeEffectGeneration === undefined) {
      this.activeEffectGeneration = this.allocateEffectGeneration();
      this.attemptedCapabilityIds.clear();
    }

    // Capability IDs remain stable across Host reconstruction. Only the
    // command/ACK carries the monotonic effect epoch.
    const prepared = input.resumeFromTakeover && !input.lifecycleEventId
      ? buildStage3StartCue({ ...input, lifecycleEventId: restoreEventId(input, this.activeEffectGeneration) })
      : basePrepared;
    this.registry.clear();
    this.store.activeIdentityKey = nextIdentityKey;
    this.activeIdentityKey = nextIdentityKey;
    this.activeIdentity = prepared.event.identity;
    this.activeCueId = input.cue.id;
    this.activeAnalysisGeneration = input.generation;
    this.lastAnalysisGeneration = input.generation;
    this.ledgerFor(prepared.event.identity.runId);
    const effectGeneration = this.activeEffectGeneration;
    const points = new Map(worldPoints(input.cue).map((point) => [point.id, point] as const));
    const segment = input.plan.segments.find((item) => item.id === input.cue.segment_id);
    const startCanonicalTick = Math.max(segment?.start_tick ?? input.cue.decision_tick, input.cue.decision_tick - Math.round(input.tickRate));
    const measurementRef = measurementFor(input);
    const economy = economyFor(input);
    const trajectoryRefs = utilityRefs(input);
    for (const capability of prepared.capabilities) {
      let args: TeachingToolCommandArgs;
      switch (capability.tool) {
        case "REPLAY_CUE_SLOW":
          args = { tool: capability.tool, startCanonicalTick, decisionCanonicalTick: input.cue.decision_tick, outcomeEndCanonicalTick: input.cue.outcome_end_tick, speed: 0.5 };
          break;
        case "FOCUS_MAP_EVIDENCE": {
          const annotationRef = capability.boundArgs.annotationRefs.find((ref) => points.has(ref));
          const point = annotationRef ? points.get(annotationRef) : undefined;
          if (!point || !annotationRef) continue;
          args = { tool: capability.tool, annotationRef, focusWorld: point.point, label: point.label };
          break;
        }
        case "SHOW_GRENADE_TRACE":
          if (!trajectoryRefs.length) continue;
          args = { tool: capability.tool, trajectoryRefs: [...capability.boundArgs.trajectoryRefs], landingRefs: [...capability.boundArgs.landingRefs] };
          break;
        case "SHOW_WIN_RATE_IMPACT": {
          const impact = input.evidence.outcomeImpact;
          if (!measurementRef || !impact) continue;
          args = {
            tool: capability.tool,
            measurementRef,
            beforeProbability: impact.beforeProbability,
            afterProbability: impact.afterProbability,
            percentagePoints: impact.percentagePoints,
            economyClass: economy?.economyClass ?? "UNKNOWN",
            correlationText: "相关性信号，不等于单因果。",
          };
          break;
        }
        case "SHOW_ECONOMY_CONTEXT":
          if (!economy) continue;
          args = { tool: capability.tool, economyRef: economy.ref, economyClass: economy.economyClass, focusLabel: economyFocusLabel(input.cue.primary_focus_code ?? "", economy.economyClass) };
          break;
      }
      this.registry.set(capability.capabilityId, {
        capability,
        identity: prepared.event.identity,
        cueId: input.cue.id,
        analysisGeneration: input.generation,
        effectGeneration,
        ledgerKey: prepared.event.identity.runId,
        gate: input.outcomeGate,
        annotations: points,
        args,
      });
    }
    return prepared;
  }

  get capabilityCount(): number { return this.registry.size; }
  get successfulCueCount(): number {
    return this.activeIdentity ? this.ledgerFor(this.activeIdentity.runId).successfulCueIds.size : 0;
  }
  hasSuccessfulCue(cueId: string): boolean {
    return this.activeIdentity ? this.ledgerFor(this.activeIdentity.runId).successfulCueIds.has(cueId) : false;
  }

  callStatus(request: Pick<AgentToolRequest, "runId" | "callId">): "UNKNOWN" | "POSTED" | "RESULTED" | "RESUMED" {
    const ledger = this.store.runLedgers.get(request.runId);
    if (!ledger) return "UNKNOWN";
    if (ledger.resumedCallIds.has(request.callId)) return "RESUMED";
    if (ledger.results.has(request.callId)) return "RESULTED";
    if (ledger.postedCallIds.has(request.callId)) return "POSTED";
    return "UNKNOWN";
  }

  resultForCall(request: Pick<AgentToolRequest, "runId" | "callId">): AgentToolResult | undefined {
    return this.store.runLedgers.get(request.runId)?.results.get(request.callId);
  }

  commandGenerationFor(request: Pick<AgentToolRequest, "runId" | "callId">): number | undefined {
    return this.store.runLedgers.get(request.runId)?.commandGenerations.get(request.callId);
  }

  createTakeoverEvent(input: Stage3HostAdapterInput, eventId: string, reason: string): Extract<CoachAgentEvent, { type: "USER_TAKEOVER" }> {
    const prepared = buildStage3StartCue(input);
    return CoachAgentEventSchema.parse({
      version: "coach-agent-event.v2",
      type: "USER_TAKEOVER",
      eventId: eventId.slice(0, 160),
      identity: prepared.event.identity,
      cueId: input.cue.id,
      reason: reason.slice(0, 160),
    }) as Extract<CoachAgentEvent, { type: "USER_TAKEOVER" }>;
  }

  beginLifecycleEvent(eventId: string): "START" | "PENDING" | "CONFIRMED" {
    const status = this.store.lifecycleEventIds.get(eventId);
    if (status === "CONFIRMED") return "CONFIRMED";
    if (status === "PENDING") return "PENDING";
    this.store.lifecycleEventIds.set(eventId, "PENDING");
    while (this.store.lifecycleEventIds.size > MAX_CALL_LEDGER_ENTRIES) {
      const oldest = this.store.lifecycleEventIds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.lifecycleEventIds.delete(oldest);
    }
    return "START";
  }

  confirmLifecycleEvent(eventId: string): void { this.store.lifecycleEventIds.set(eventId, "CONFIRMED"); }
  releaseLifecycleEvent(eventId: string): void {
    if (this.store.lifecycleEventIds.get(eventId) === "PENDING") this.store.lifecycleEventIds.delete(eventId);
  }
  lifecycleEventStatus(eventId: string): "NONE" | "PENDING" | "CONFIRMED" {
    return this.store.lifecycleEventIds.get(eventId) ?? "NONE";
  }

  get lifecycleCursor(): number { return this.store.lastSyncedCursor; }
  get lifecycleQueueCursor(): number { return this.store.queuedCursor; }
  get lifecycleDegraded(): boolean { return this.store.lifecycleDegraded; }
  reserveLifecycleCursor(cursor: number): void { this.store.queuedCursor = Math.max(this.store.queuedCursor, cursor); }
  markLifecycleSynced(cursor: number): void {
    this.store.lastSyncedCursor = Math.max(this.store.lastSyncedCursor, cursor);
    this.store.queuedCursor = Math.max(this.store.queuedCursor, this.store.lastSyncedCursor);
  }
  markLifecycleDegraded(): void { this.store.lifecycleDegraded = true; }
  clearLifecycleDegraded(): void { this.store.lifecycleDegraded = false; }
  resetLifecycleQueue(): void { this.store.queuedCursor = this.store.lastSyncedCursor; }

  createObserveSegmentEvent(
    input: Stage3IdentityInput,
    segmentId: string,
    segmentIndex: number,
    mode: "SKIP" | "FREEZE" | "BRIEF" | "OBSERVE",
    currentSessionPhase: "PLAYING" | "SKIPPING" | "PAUSED_FOR_COACHING" | "REVEALING",
    eventId: string,
  ): Extract<CoachAgentEvent, { type: "OBSERVE_SEGMENT" }> {
    return CoachAgentEventSchema.parse({
      version: "coach-agent-event.v2",
      type: "OBSERVE_SEGMENT",
      eventId: eventId.slice(0, 160),
      identity: buildStage3Identity(input),
      segmentId,
      segmentIndex,
      mode,
      currentSessionPhase,
    }) as Extract<CoachAgentEvent, { type: "OBSERVE_SEGMENT" }>;
  }

  createCompleteSessionEvent(input: Stage3IdentityInput, eventId: string): Extract<CoachAgentEvent, { type: "COMPLETE_SESSION" }> {
    return CoachAgentEventSchema.parse({
      version: "coach-agent-event.v2",
      type: "COMPLETE_SESSION",
      eventId: eventId.slice(0, 160),
      identity: buildStage3Identity(input),
    }) as Extract<CoachAgentEvent, { type: "COMPLETE_SESSION" }>;
  }

  private ledgerFor(runId: string): RunLedger {
    const existing = this.store.runLedgers.get(runId);
    if (existing) return existing;
    while (this.store.runLedgers.size >= MAX_RUN_LEDGERS) {
      const oldest = this.store.runLedgers.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.runLedgers.delete(oldest);
    }
    const ledger = createRunLedger();
    this.store.runLedgers.set(runId, ledger);
    return ledger;
  }

  private bindingFor(
    request: AgentToolRequest,
    context: Stage3ToolContext,
    options: { allowSuccessful?: boolean } = {},
  ): ToolBinding {
    const checked = AgentToolRequestSchema.parse(request);
    const binding = this.registry.get(checked.capabilityId);
    if (!binding) throw new Error("Agent capability is not registered by the Host.");
    if (checked.tool !== binding.capability.tool || checked.runId !== binding.identity.runId || checked.cueId !== binding.cueId) {
      throw new Error("Agent tool request identity does not match the Host registry.");
    }
    if (
      context.generation !== binding.analysisGeneration ||
      context.generation !== this.activeAnalysisGeneration ||
      this.activeEffectGeneration !== binding.effectGeneration ||
      this.activeIdentityKey !== identityKey(binding.identity) ||
      context.currentSessionPhase !== "PAUSED_FOR_COACHING"
    ) {
      throw new Error("Agent tool request belongs to a stale generation or phase.");
    }
    if (context.outcomeGate.cueId !== binding.cueId || context.outcomeGate.status !== "COMPLETE" || context.outcomeGate.outcomeEndTick !== binding.gate.outcomeEndTick) {
      throw new Error("Agent tool request is outside the completed outcome gate.");
    }
    const ledger = this.store.runLedgers.get(binding.ledgerKey);
    if (!ledger) throw new Error("Agent run ledger is not active.");
    if (!options.allowSuccessful && ledger.successfulCueIds.has(binding.cueId)) {
      throw new Error("This cue already has a successful teaching tool.");
    }
    const allowed = new Set(binding.capability.evidenceRefs);
    if (checked.evidenceRefs.some((ref) => !allowed.has(ref))) throw new Error("Agent tool request contains evidence outside the registered capability.");
    return binding;
  }

  createTeachingToolCommand(request: AgentToolRequest, context: Stage3ToolContext): PlaybackCommand | undefined {
    const ledger = this.activeIdentity ? this.store.runLedgers.get(this.activeIdentity.runId) : undefined;
    if (ledger?.postedCallIds.has(request.callId)) return undefined;
    const binding = this.bindingFor(request, context);
    const capabilityKey = `${binding.cueId}|${request.capabilityId}`;
    const firstCallId = ledger?.capabilityCallIds.get(capabilityKey);
    if (firstCallId && firstCallId !== request.callId) {
      throw new Error("This capability is already bound to another callId for the cue.");
    }
    if (this.attemptedCapabilityIds.has(request.capabilityId)) throw new Error("This capability was already attempted for the cue.");
    this.attemptedCapabilityIds.add(request.capabilityId);
    const activeLedger = this.ledgerFor(binding.ledgerKey);
    if (!activeLedger.capabilityCallIds.has(capabilityKey)) {
      rememberMap(activeLedger.capabilityCallIds, capabilityKey, request.callId, MAX_CALL_LEDGER_ENTRIES);
    }
    remember(activeLedger.postedCallIds, request.callId, MAX_CALL_LEDGER_ENTRIES);
    rememberMap(activeLedger.commandGenerations, request.callId, binding.effectGeneration, MAX_CALL_LEDGER_ENTRIES);
    return {
      type: "teachingTool",
      schemaVersion: STAGE3_COMMAND_SCHEMA_VERSION,
      tool: binding.capability.tool,
      callId: request.callId,
      runId: binding.identity.runId,
      generation: binding.effectGeneration,
      cueId: binding.cueId,
      args: binding.args,
    };
  }

  acceptTeachingToolAck(request: AgentToolRequest, ack: TeachingToolAckEvent, context: Stage3ToolContext): AgentToolResult | undefined {
    const ledger = this.activeIdentity ? this.store.runLedgers.get(this.activeIdentity.runId) : undefined;
    if (ledger?.acknowledgedCallIds.has(ack.callId)) return undefined;
    const binding = this.bindingFor(request, context);
    if (ack.callId !== request.callId || ack.runId !== binding.identity.runId || ack.cueId !== binding.cueId || ack.generation !== binding.effectGeneration || ack.tool !== binding.capability.tool) {
      throw new Error("Teaching tool ACK does not match the active Host request.");
    }
    if (binding.capability.tool === "FOCUS_MAP_EVIDENCE" && (!ack.annotationRef || !binding.annotations.has(ack.annotationRef))) {
      throw new Error("Teaching tool ACK references an unregistered WORLD point.");
    }
    const expectedCode = binding.capability.tool === "REPLAY_CUE_SLOW" ? "CUE_PLAYED" : "EVIDENCE_SHOWN";
    if (ack.status === "SUCCEEDED" && (ack.observationCode !== expectedCode || !ack.completed)) throw new Error("Successful teaching ACK is incomplete.");
    const activeLedger = this.ledgerFor(binding.ledgerKey);
    const result = AgentToolResultSchema.parse({ callId: ack.callId, status: ack.status, observation: { code: ack.observationCode, completed: ack.completed }, limitations: ack.limitations.slice(0, 8) });
    remember(activeLedger.acknowledgedCallIds, ack.callId, MAX_CALL_LEDGER_ENTRIES);
    if (ack.status === "SUCCEEDED") remember(activeLedger.successfulCueIds, binding.cueId, MAX_SUCCESSFUL_CUES);
    rememberMap(activeLedger.results, ack.callId, result, MAX_CALL_LEDGER_ENTRIES);
    return result;
  }

  createResumeEvent(request: AgentToolRequest, result: AgentToolResult, context: Stage3ToolContext, eventId: string): Extract<CoachAgentEvent, { type: "RESUME_TOOL" }> | undefined {
    const checked = AgentToolResultSchema.parse(result);
    const ledger = this.activeIdentity ? this.store.runLedgers.get(this.activeIdentity.runId) : undefined;
    if (ledger?.resumedCallIds.has(checked.callId)) return undefined;
    const binding = this.bindingFor(request, context, { allowSuccessful: true });
    if (checked.callId !== request.callId) throw new Error("Tool result callId does not match the active request.");
    const activeLedger = this.ledgerFor(binding.ledgerKey);
    rememberMap(activeLedger.results, checked.callId, checked, MAX_CALL_LEDGER_ENTRIES);
    remember(activeLedger.resumedCallIds, checked.callId, MAX_CALL_LEDGER_ENTRIES);
    if (!this.activeIdentity) throw new Error("Stage3 has no active identity.");
    return CoachAgentEventSchema.parse({ version: STAGE3_EVENT_VERSION, type: "RESUME_TOOL", eventId, identity: this.activeIdentity, result: checked }) as Extract<CoachAgentEvent, { type: "RESUME_TOOL" }>;
  }

  cancel(generation: number): void {
    if (this.lastAnalysisGeneration !== undefined && generation !== this.lastAnalysisGeneration) return;
    // Takeover invalidates only the active effect. The run ledger and its
    // completion facts stay intact; a later cue in the same run may proceed.
    this.allocateEffectGeneration();
    this.activeEffectGeneration = undefined;
    this.registry.clear();
    this.activeCueId = undefined;
    this.activeAnalysisGeneration = undefined;
    this.attemptedCapabilityIds.clear();
  }

  /** Explicit reset for a new session/demo or a user-requested graph reset. */
  reset(): void {
    this.allocateEffectGeneration();
    this.activeEffectGeneration = undefined;
    this.registry.clear();
    this.store.runLedgers.clear();
    this.store.activeIdentityKey = undefined;
    this.store.lifecycleEventIds.clear();
    this.store.lastSyncedCursor = -1;
    this.store.queuedCursor = -1;
    this.store.lifecycleDegraded = false;
    this.attemptedCapabilityIds.clear();
    this.activeIdentity = undefined;
    this.activeIdentityKey = undefined;
    this.activeCueId = undefined;
    this.activeAnalysisGeneration = undefined;
    this.lastAnalysisGeneration = undefined;
  }

  isCurrent(generation: number): boolean {
    return generation === this.activeAnalysisGeneration && this.activeEffectGeneration !== undefined;
  }
}
