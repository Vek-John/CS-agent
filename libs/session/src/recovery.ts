import type {
  CoachingRouteState,
  CoachingSessionState,
  OutcomeCompletionState,
  ReviewPlan,
} from "@cs-coach/contracts";
import {
  canPresentOutcome,
  completeOutcomeGate,
  createCoachingSession,
  createOutcomeCompletionGate,
} from "./index";

/** The only stable points a browser session is allowed to persist. */
export const SESSION_RECOVERY_SNAPSHOT_VERSION = "session-recovery-session.v1" as const;
export type SessionRecoveryBoundaryKind = "ROUTE_START" | "CUE_PAUSED" | "WRAP_UP";

export type SessionRecoveryBoundary =
  | { readonly kind: "ROUTE_START"; readonly segmentIndex: 0 }
  | {
      readonly kind: "CUE_PAUSED";
      readonly segmentId: string;
      readonly segmentIndex: number;
      readonly cueId: string;
    }
  | { readonly kind: "WRAP_UP"; readonly segmentIndex: number };

/**
 * This is deliberately a session-owned snapshot, not a browser/Host DTO.
 * Canonical ticks and outcome_end_tick are absent: rehydrate derives them
 * from the frozen plan so a caller cannot smuggle an arbitrary playback tick
 * into the session state.
 */
export interface SessionRecoverySnapshot {
  readonly schemaVersion: typeof SESSION_RECOVERY_SNAPSHOT_VERSION;
  readonly sessionId: string;
  readonly routeFingerprint: string;
  readonly frozenPlan: ReviewPlan;
  readonly boundary: SessionRecoveryBoundary;
  readonly consumedCueIds: readonly string[];
  readonly revealedCueIds: readonly string[];
  readonly expandedSegmentIds: readonly string[];
  readonly narrationReadiness?: Readonly<Record<string, "PENDING" | "READY" | "FALLBACK">>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function routeMaterial(plan: ReviewPlan): unknown {
  return {
    id: plan.id,
    demo_id: plan.demo_id,
    player_id: plan.player_id,
    match_timeline_version: plan.match_timeline_version,
    observation_version: plan.observation_version,
    signal_version: plan.signal_version,
    planner_version: plan.planner_version,
    segments: plan.segments.map((segment) => ({
      id: segment.id,
      start_tick: segment.start_tick,
      end_tick: segment.end_tick,
      mode: segment.mode,
      cue_ids: [...segment.cue_ids],
    })),
    cues: plan.cues.map((cue) => ({
      id: cue.id,
      segment_id: cue.segment_id,
      candidate_id: cue.candidate_id,
      primary_focus_code: cue.primary_focus_code,
      decision_tick: cue.decision_tick,
      reveal_tick: cue.reveal_tick,
      outcome_start_tick: cue.outcome_start_tick,
      outcome_end_tick: cue.outcome_end_tick,
    })),
  };
}

/** Prefer the compiler-owned fingerprint, otherwise derive a deterministic one. */
export function sessionRouteFingerprint(plan: ReviewPlan): string {
  const compilerFingerprint = plan.compiler_provenance?.route_fingerprint?.trim();
  return compilerFingerprint || `session-route-v1:${stableJson(routeMaterial(plan))}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    value.forEach((item) => freezeDeep(item));
  } else {
    Object.values(value as Record<string, unknown>).forEach((item) => freezeDeep(item));
  }
  return value;
}

function assertIdList(name: string, values: readonly string[], allowed: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!nonEmpty(value) || seen.has(value) || !allowed.has(value)) {
      throw new Error(`${name} contains an invalid or duplicate route id.`);
    }
    seen.add(value);
  }
}

function validateFrozenPlan(plan: ReviewPlan): void {
  if (!isRecord(plan) || plan.status !== "COMPLETE" || !nonEmpty(plan.id) || !nonEmpty(plan.demo_id) || !nonEmpty(plan.player_id)) {
    throw new Error("Recovery requires a COMPLETE frozen ReviewPlan.");
  }
  if (!Array.isArray(plan.segments) || !Array.isArray(plan.cues) || plan.segments.length > 512 || plan.cues.length > 50) {
    throw new Error("Frozen ReviewPlan exceeds the recovery route bounds.");
  }
  const segmentIds = new Set<string>();
  for (const segment of plan.segments) {
    if (!isRecord(segment) || !nonEmpty(segment.id) || segmentIds.has(segment.id) || !finite(segment.start_tick) || !finite(segment.end_tick) || segment.end_tick < segment.start_tick || !Array.isArray(segment.cue_ids)) {
      throw new Error("Frozen ReviewPlan contains an invalid segment.");
    }
    segmentIds.add(segment.id);
  }
  const cueIds = new Set<string>();
  for (const cue of plan.cues) {
    if (!isRecord(cue) || !nonEmpty(cue.id) || cueIds.has(cue.id) || !nonEmpty(cue.segment_id) || !segmentIds.has(cue.segment_id) ||
      !finite(cue.decision_tick) || !finite(cue.reveal_tick) || !finite(cue.outcome_start_tick) || !finite(cue.outcome_end_tick) ||
      cue.decision_tick > cue.outcome_end_tick || cue.outcome_start_tick > cue.outcome_end_tick) {
      throw new Error("Frozen ReviewPlan contains an invalid cue.");
    }
    cueIds.add(cue.id);
  }
  for (const segment of plan.segments) {
    assertIdList("segment cue_ids", segment.cue_ids, cueIds);
  }
  for (const cue of plan.cues) {
    const segment = plan.segments.find((candidate) => candidate.id === cue.segment_id);
    if (!segment?.cue_ids.includes(cue.id)) throw new Error("Frozen ReviewPlan cue/segment index is inconsistent.");
  }
}

function routeFingerprintForState(plan: ReviewPlan, state: CoachingSessionState): string {
  const planFingerprint = sessionRouteFingerprint(plan);
  if (state.route_fingerprint && state.route_fingerprint !== planFingerprint) {
    throw new Error("Session route fingerprint does not match the frozen plan.");
  }
  return state.route_fingerprint || planFingerprint;
}

function expectedSegmentIndex(plan: ReviewPlan, cueId: string): number {
  return plan.segments.findIndex((segment) => segment.cue_ids.includes(cueId));
}

function validateStateLists(plan: ReviewPlan, state: CoachingSessionState): void {
  const cueIds = new Set(plan.cues.map((cue) => cue.id));
  const segmentIds = new Set(plan.segments.map((segment) => segment.id));
  assertIdList("consumedCueIds", state.consumed_cue_ids, cueIds);
  assertIdList("revealedCueIds", state.revealed_cue_ids, cueIds);
  assertIdList("expandedSegmentIds", state.expanded_segment_ids, segmentIds);
  if (state.current_cue_id && !cueIds.has(state.current_cue_id)) throw new Error("Session current cue is not in the frozen plan.");
  if (!Number.isInteger(state.current_segment_index) || state.current_segment_index < 0 || state.current_segment_index > plan.segments.length) {
    throw new Error("Session current segment index is outside the frozen route.");
  }
}

function boundaryForState(
  plan: ReviewPlan,
  state: CoachingSessionState,
  kind: SessionRecoveryBoundaryKind,
): SessionRecoveryBoundary {
  validateFrozenPlan(plan);
  if (state.review_plan_id !== plan.id || !nonEmpty(state.id)) throw new Error("Session and frozen plan identity do not match.");
  validateStateLists(plan, state);
  const routeFingerprint = routeFingerprintForState(plan, state);
  if (!routeFingerprint) throw new Error("Recovery route fingerprint is missing.");

  if (kind === "ROUTE_START") {
    const first = plan.segments[0];
    if (state.phase !== "INTRO" || state.current_segment_index !== 0 || state.current_cue_id || state.consumed_cue_ids.length || state.revealed_cue_ids.length ||
      (first && state.current_tick !== first.start_tick)) {
      throw new Error("ROUTE_START must capture the untouched session boundary.");
    }
    return { kind, segmentIndex: 0 };
  }
  if (kind === "WRAP_UP") {
    const last = plan.segments.at(-1);
    if (state.phase !== "WRAP_UP" || state.current_segment_index !== plan.segments.length || state.current_cue_id ||
      (last && state.current_tick !== last.end_tick)) {
      throw new Error("WRAP_UP must capture the plan-derived end boundary.");
    }
    return { kind, segmentIndex: plan.segments.length };
  }

  const cueId = state.current_cue_id;
  const cue = cueId ? plan.cues.find((candidate) => candidate.id === cueId) : undefined;
  const segmentIndex = cueId ? expectedSegmentIndex(plan, cueId) : -1;
  const gate = state.outcome_completion;
  if (state.phase !== "PAUSED_FOR_COACHING" || !cue || segmentIndex < 0 || state.current_segment_index !== segmentIndex ||
    state.current_tick !== cue.decision_tick || !state.revealed_cue_ids.includes(cue.id) || !gate || gate.cueId !== cue.id ||
    gate.outcomeEndTick !== cue.outcome_end_tick || !canPresentOutcome(gate)) {
    throw new Error("CUE_PAUSED requires a completed outcome gate at the plan-derived decision tick.");
  }
  return { kind, segmentId: cue.segment_id, segmentIndex, cueId: cue.id };
}

function assertSnapshot(snapshot: SessionRecoverySnapshot): void {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== SESSION_RECOVERY_SNAPSHOT_VERSION || !nonEmpty(snapshot.sessionId) || !nonEmpty(snapshot.routeFingerprint)) {
    throw new Error("Recovery snapshot envelope is invalid.");
  }
  validateFrozenPlan(snapshot.frozenPlan);
  const cueIds = new Set(snapshot.frozenPlan.cues.map((cue) => cue.id));
  const segmentIds = new Set(snapshot.frozenPlan.segments.map((segment) => segment.id));
  assertIdList("consumedCueIds", snapshot.consumedCueIds, cueIds);
  assertIdList("revealedCueIds", snapshot.revealedCueIds, cueIds);
  assertIdList("expandedSegmentIds", snapshot.expandedSegmentIds, segmentIds);
  if (snapshot.routeFingerprint !== sessionRouteFingerprint(snapshot.frozenPlan)) {
    throw new Error("Recovery snapshot route fingerprint does not match the frozen plan.");
  }
  const boundary = snapshot.boundary;
  if (!isRecord(boundary) || !["ROUTE_START", "CUE_PAUSED", "WRAP_UP"].includes(String(boundary.kind))) {
    throw new Error("Recovery snapshot boundary kind is not supported.");
  }
  if (boundary.kind === "CUE_PAUSED") {
    const cue = snapshot.frozenPlan.cues.find((candidate) => candidate.id === boundary.cueId);
    if (!cue || cue.segment_id !== boundary.segmentId || expectedSegmentIndex(snapshot.frozenPlan, cue.id) !== boundary.segmentIndex) {
      throw new Error("Recovery snapshot cue boundary is not in the frozen route.");
    }
  }
  if (boundary.kind === "WRAP_UP" && boundary.segmentIndex !== snapshot.frozenPlan.segments.length) {
    throw new Error("Recovery snapshot wrap-up index is not plan-derived.");
  }
  if (snapshot.narrationReadiness) {
    for (const [cueId, readiness] of Object.entries(snapshot.narrationReadiness)) {
      if (!cueIds.has(cueId) || !["PENDING", "READY", "FALLBACK"].includes(readiness)) throw new Error("Recovery narration readiness is invalid.");
    }
  }
}

/** Capture one of the three legal session boundaries without accepting ticks. */
export function captureSessionRecovery(
  plan: ReviewPlan,
  state: CoachingSessionState,
  kind: SessionRecoveryBoundaryKind,
  routeState?: Pick<CoachingRouteState, "readiness">,
): SessionRecoverySnapshot {
  if (!["ROUTE_START", "CUE_PAUSED", "WRAP_UP"].includes(kind)) throw new Error("Unsupported recovery boundary.");
  const boundary = boundaryForState(plan, state, kind);
  const snapshot: SessionRecoverySnapshot = {
    schemaVersion: SESSION_RECOVERY_SNAPSHOT_VERSION,
    sessionId: state.id,
    routeFingerprint: sessionRouteFingerprint(plan),
    frozenPlan: freezeDeep(cloneJson(plan)),
    boundary,
    consumedCueIds: [...state.consumed_cue_ids],
    revealedCueIds: [...state.revealed_cue_ids],
    expandedSegmentIds: [...state.expanded_segment_ids],
    ...(routeState ? { narrationReadiness: { ...routeState.readiness } } : state.narration_readiness ? { narrationReadiness: { ...state.narration_readiness } } : {}),
  };
  assertSnapshot(snapshot);
  return freezeDeep(snapshot);
}

function routeStateReadiness(snapshot: SessionRecoverySnapshot): Readonly<Record<string, "PENDING" | "READY" | "FALLBACK">> {
  return snapshot.narrationReadiness ?? Object.fromEntries(snapshot.frozenPlan.cues.map((cue) => [cue.id, "READY" as const]));
}

/** Rebuild Session state from the frozen plan; all ticks are derived here. */
export function rehydrateSessionRecovery(
  snapshot: SessionRecoverySnapshot,
  expectedPlan?: ReviewPlan,
): CoachingSessionState {
  assertSnapshot(snapshot);
  if (expectedPlan) {
    validateFrozenPlan(expectedPlan);
    if (sessionRouteFingerprint(expectedPlan) !== snapshot.routeFingerprint || stableJson(routeMaterial(expectedPlan)) !== stableJson(routeMaterial(snapshot.frozenPlan))) {
      throw new Error("Recovery route hash or frozen plan does not match the current route.");
    }
  }
  const plan = snapshot.frozenPlan;
  const boundary = snapshot.boundary;
  const base = createCoachingSession(plan, snapshot.sessionId, {
    routeFingerprint: snapshot.routeFingerprint,
    readiness: routeStateReadiness(snapshot),
  });
  if (boundary.kind === "ROUTE_START") {
    return {
      ...base,
      current_segment_index: 0,
      current_cue_id: undefined,
      current_tick: plan.segments[0]?.start_tick ?? 0,
      phase: "INTRO",
      consumed_cue_ids: [...snapshot.consumedCueIds],
      revealed_cue_ids: [...snapshot.revealedCueIds],
      expanded_segment_ids: [...snapshot.expandedSegmentIds],
    };
  }
  if (boundary.kind === "WRAP_UP") {
    const last = plan.segments.at(-1);
    return {
      ...base,
      current_segment_index: plan.segments.length,
      current_cue_id: undefined,
      current_tick: last?.end_tick ?? 0,
      phase: "WRAP_UP",
      consumed_cue_ids: [...snapshot.consumedCueIds],
      revealed_cue_ids: [...snapshot.revealedCueIds],
      expanded_segment_ids: [...snapshot.expandedSegmentIds],
    };
  }
  const cue = plan.cues.find((candidate) => candidate.id === boundary.cueId);
  if (!cue) throw new Error("Recovery cue is missing from the frozen plan.");
  const gate: OutcomeCompletionState = completeOutcomeGate(createOutcomeCompletionGate(cue), cue.outcome_end_tick);
  return {
    ...base,
    current_segment_index: boundary.segmentIndex,
    current_cue_id: cue.id,
    current_tick: cue.decision_tick,
    phase: "PAUSED_FOR_COACHING",
    consumed_cue_ids: [...snapshot.consumedCueIds],
    revealed_cue_ids: [...snapshot.revealedCueIds],
    expanded_segment_ids: [...snapshot.expandedSegmentIds],
    outcome_completion: gate,
  };
}
