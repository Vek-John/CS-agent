import type {
  AudibilityAssessment,
  DirectionSector,
  ObservableState,
  ObservationClaim,
  ObservationClaimType,
  ObservationKnowledgeKind,
  ObservationSharingScope,
  ObservationSourceType,
  ObservationSpatialEstimate,
  ObservationSubjectResolution,
  WorldPoint
} from "@cs-coach/contracts";

export const OBSERVATION_VERSION = "observation/1.0.0";
export const OBSERVATION_DERIVER = "@cs-coach/observation/rules";

const SOUND_LIMITATIONS = [
  "Demo 只证明该处发生了发声事件，不证明观察者确实听到。",
  "未建模遮挡、同时噪声或听觉范围；空间结果只能作为方向、区域或不确定点。",
  "该 claim 不携带发声者的实时隐藏坐标。"
] as const;

export interface ObservationFactBase {
  id: string;
  tick: number;
  /** Every ObservationFact is already scoped to one observer. Raw/global
   * MatchEvent sound emissions are deliberately not assignable here. */
  observer_player_id: string;
  available_from_tick?: number;
  expires_at_tick?: number;
  confidence?: number;
  evidence_refs?: readonly string[];
}

export interface DirectVisionFact extends ObservationFactBase {
  source_type: "DIRECT_VISION" | "SPOTTED";
  observer_player_id: string;
  subject_player_id: string;
  world_position: WorldPoint;
}

export interface SoundObservationFact extends ObservationFactBase {
  source_type: "FOOTSTEP" | "GUNSHOT";
  audibility_assessment: AudibilityAssessment;
  world_origin?: WorldPoint;
  observer_position?: WorldPoint;
  direction?: DirectionSector;
  uncertainty_radius?: number;
}

export interface DamageDirectionFact extends ObservationFactBase {
  source_type: "DAMAGE_DIRECTION";
  direction: DirectionSector;
}

export interface UtilityObservationFact extends ObservationFactBase {
  source_type: "UTILITY";
  utility_kind?: string;
  subject_ref?: string;
  world_position?: WorldPoint;
  visible_to_observer: boolean;
  observable_evidence_basis?: ObservableEvidenceBasis;
  uncertainty_radius?: number;
}

export interface BombObservationFact extends ObservationFactBase {
  source_type: "BOMB";
  subject_ref?: string;
  world_position?: WorldPoint;
  visible_to_observer: boolean;
  observable_evidence_basis?: ObservableEvidenceBasis;
  uncertainty_radius?: number;
}

/**
 * A parser/global sound emission is a MatchEvent, never an ObservationFact.
 * An adapter must first produce one observer-bound SoundObservationFact with
 * an audibility assessment before the observation rules can consume it.
 */
export interface SoundEmissionFact {
  id: string;
  tick: number;
  source_type: "FOOTSTEP" | "GUNSHOT";
  actor_player_id?: string;
  world_origin?: WorldPoint;
  evidence_refs: readonly string[];
  source_parser_event: string;
}

export interface ObservableEvidenceBasis {
  spatial_estimate: ObservationSpatialEstimate;
  assessed_by: string;
  evidence_refs: readonly string[];
  limitations: readonly string[];
}

export interface TeamSharedObservationFact extends ObservationFactBase {
  source_type: "TEAM_SHARED";
  shared_to_observer: boolean;
  shared_at_tick?: number;
  source_claim: ObservationClaim;
}

export interface UserContextObservationFact extends ObservationFactBase {
  source_type: "USER_CONTEXT";
  context_ref: string;
  context_tick?: number;
}

export interface LastKnownObservationFact extends ObservationFactBase {
  source_type: "LAST_KNOWN";
  subject_player_id: string;
  last_confirmed_tick: number;
  last_confirmed_position: WorldPoint;
  subject_resolution?: ObservationSubjectResolution;
}

export type ObservationFact =
  | DirectVisionFact
  | SoundObservationFact
  | DamageDirectionFact
  | UtilityObservationFact
  | BombObservationFact
  | TeamSharedObservationFact
  | UserContextObservationFact
  | LastKnownObservationFact;

export interface ObservationBuildInput {
  id?: string;
  demo_id: string;
  timeline_version: string;
  observer_player_id: string;
  at_tick: number;
  observation_version?: string;
  observer_position?: WorldPoint;
  facts: readonly ObservationFact[];
  previous_claims?: readonly ObservationClaim[];
  limitations?: readonly string[];
}

export interface LastKnownDecayPolicy {
  base_radius: number;
  radius_growth_per_tick: number;
  max_radius: number;
  confidence_half_life_ticks: number;
  max_age_ticks: number;
}

export const DEFAULT_LAST_KNOWN_DECAY_POLICY: LastKnownDecayPolicy = {
  base_radius: 32,
  radius_growth_per_tick: 0.75,
  max_radius: 640,
  confidence_half_life_ticks: 256,
  max_age_ticks: 2048
};

export class FutureObservationClaimError extends Error {
  readonly claim_ids: string[];

  constructor(claimIds: string[], atTick: number) {
    super(`Observation claims are not available at tick ${atTick}: ${claimIds.join(", ")}`);
    this.name = "FutureObservationClaimError";
    this.claim_ids = claimIds;
  }
}

export class ObservationClaimValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Observation claim validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ObservationClaimValidationError";
    this.issues = issues;
  }
}

export class ObservationFactValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Observation fact validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ObservationFactValidationError";
    this.issues = issues;
  }
}

function clampConfidence(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(0, Math.min(1, candidate));
}

function uniqueRefs(...refs: readonly (readonly string[])[]): string[] {
  return [...new Set(refs.flat())];
}

function factEvidenceRefs(fact: ObservationFactBase): string[] {
  return uniqueRefs([fact.id], fact.evidence_refs ?? []);
}

function availableFrom(fact: ObservationFactBase): number {
  return fact.available_from_tick ?? fact.tick;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteWorldPoint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [value.x, value.y, value.z].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate));
}

function collectSpatialEstimateIssues(value: unknown, label: string): string[] {
  if (!isRecord(value) || typeof value.type !== "string") {
    return [`${label} must contain a spatial estimate type.`];
  }
  switch (value.type) {
    case "EXACT_POINT":
      return isFiniteWorldPoint(value.point) ? [] : [`${label} EXACT_POINT must contain a finite point.`];
    case "UNCERTAIN_POINT":
    case "AREA":
      return isFiniteWorldPoint(value.center) &&
        typeof value.radius === "number" &&
        Number.isFinite(value.radius) &&
        value.radius >= 0
        ? []
        : [`${label} ${value.type} must contain a finite non-negative radius and point.`];
    case "DIRECTION_SECTOR":
      return typeof value.bearing_degrees === "number" &&
        Number.isFinite(value.bearing_degrees) &&
        typeof value.width_degrees === "number" &&
        Number.isFinite(value.width_degrees) &&
        value.width_degrees > 0 &&
        value.width_degrees <= 360
        ? []
        : [`${label} DIRECTION_SECTOR must contain finite bearing and width.`];
    case "LAST_KNOWN_POINT":
      return isFiniteWorldPoint(value.point) &&
        typeof value.radius === "number" &&
        Number.isFinite(value.radius) &&
        value.radius >= 0 &&
        typeof value.age_ticks === "number" &&
        Number.isFinite(value.age_ticks) &&
        value.age_ticks >= 0
        ? []
        : [`${label} LAST_KNOWN_POINT must contain finite point, radius and age.`];
    case "NONE":
      return [];
    default:
      return [`${label} uses an unsupported spatial estimate type ${value.type}.`];
  }
}

function collectObservableEvidenceBasisIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} is required when provided.`];
  const issues = collectSpatialEstimateIssues(value.spatial_estimate, `${label}.spatial_estimate`);
  if (typeof value.assessed_by !== "string" || !value.assessed_by.trim()) {
    issues.push(`${label}.assessed_by is required.`);
  }
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.length === 0) {
    issues.push(`${label}.evidence_refs must contain at least one reference.`);
  }
  if (!Array.isArray(value.limitations)) {
    issues.push(`${label}.limitations must be an array.`);
  }
  return issues;
}

export function collectObservationFactIssues(fact: ObservationFact): string[] {
  if (!isRecord(fact)) {
    return ["ObservationFact must be an object bound to one observer."];
  }
  const candidate = fact as unknown as Record<string, unknown>;
  const factId = typeof candidate.id === "string" && candidate.id ? candidate.id : "<unknown>";
  const sourceType = candidate.source_type;
  const issues: string[] = [];

  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    issues.push(`Fact ${factId} needs an id.`);
  }
  if (typeof candidate.tick !== "number" || !Number.isFinite(candidate.tick)) {
    issues.push(`Fact ${factId} needs a finite tick.`);
  }
  if (typeof candidate.observer_player_id !== "string" || !candidate.observer_player_id.trim()) {
    issues.push(
      `Fact ${factId} must be bound to observer_player_id; raw/global MatchEvent facts cannot be ObservationFacts.`
    );
  }

  switch (sourceType) {
    case "DIRECT_VISION":
    case "SPOTTED":
      if (typeof candidate.subject_player_id !== "string" || !candidate.subject_player_id.trim()) {
        issues.push(`Fact ${factId} ${sourceType} needs subject_player_id.`);
      }
      if (!isFiniteWorldPoint(candidate.world_position)) {
        issues.push(`Fact ${factId} ${sourceType} needs a finite world_position.`);
      }
      break;
    case "FOOTSTEP":
    case "GUNSHOT": {
      const assessment = candidate.audibility_assessment;
      if (!isRecord(assessment)) {
        issues.push(
          `Sound fact ${factId} requires an observer-specific audibility_assessment; raw/global sound emissions are rejected.`
        );
      } else {
        if (![
          "POSSIBLY_AUDIBLE",
          "NOT_AUDIBLE",
          "UNDETERMINED"
        ].includes(assessment.result as string)) {
          issues.push(`Sound fact ${factId} has an invalid audibility assessment result.`);
        }
        if (typeof assessment.assessed_by !== "string" || !assessment.assessed_by.trim()) {
          issues.push(`Sound fact ${factId} audibility_assessment.assessed_by is required.`);
        }
        if (!Array.isArray(assessment.evidence_refs) || assessment.evidence_refs.length === 0) {
          issues.push(`Sound fact ${factId} audibility_assessment.evidence_refs must be non-empty.`);
        }
        if (!Array.isArray(assessment.limitations)) {
          issues.push(`Sound fact ${factId} audibility_assessment.limitations must be an array.`);
        }
        if (assessment.spatial_estimate !== undefined) {
          issues.push(...collectSpatialEstimateIssues(
            assessment.spatial_estimate,
            `Sound fact ${factId} audibility_assessment.spatial_estimate`
          ));
          if (isRecord(assessment.spatial_estimate) && assessment.spatial_estimate.type === "EXACT_POINT") {
            issues.push(`Sound fact ${factId} audibility assessment cannot use an exact point.`);
          }
        }
      }
      break;
    }
    case "DAMAGE_DIRECTION":
      if (!isRecord(candidate.direction)) {
        issues.push(`Fact ${factId} DAMAGE_DIRECTION needs direction.`);
      } else {
        issues.push(...collectSpatialEstimateIssues(
          { type: "DIRECTION_SECTOR", ...candidate.direction },
          `Fact ${factId} direction`
        ));
      }
      break;
    case "UTILITY":
    case "BOMB":
      if (typeof candidate.visible_to_observer !== "boolean") {
        issues.push(`Fact ${factId} ${sourceType} needs visible_to_observer.`);
      }
      if (candidate.observable_evidence_basis !== undefined) {
        issues.push(...collectObservableEvidenceBasisIssues(
          candidate.observable_evidence_basis,
          `Fact ${factId} observable_evidence_basis`
        ));
      }
      break;
    case "TEAM_SHARED":
      if (typeof candidate.shared_to_observer !== "boolean") {
        issues.push(`Fact ${factId} TEAM_SHARED needs shared_to_observer.`);
      }
      if (candidate.shared_to_observer === true &&
        (typeof candidate.shared_at_tick !== "number" || !Number.isFinite(candidate.shared_at_tick))) {
        issues.push(`Fact ${factId} TEAM_SHARED needs a finite shared_at_tick when shared.`);
      }
      if (!isRecord(candidate.source_claim)) {
        issues.push(`Fact ${factId} TEAM_SHARED needs source_claim.`);
      } else {
        issues.push(...collectObservationClaimIssues(candidate.source_claim as unknown as ObservationClaim));
      }
      break;
    case "USER_CONTEXT":
      if (typeof candidate.context_ref !== "string" || !candidate.context_ref.trim()) {
        issues.push(`Fact ${factId} USER_CONTEXT needs context_ref.`);
      }
      break;
    case "LAST_KNOWN":
      if (typeof candidate.subject_player_id !== "string" || !candidate.subject_player_id.trim()) {
        issues.push(`Fact ${factId} LAST_KNOWN needs subject_player_id.`);
      }
      if (typeof candidate.last_confirmed_tick !== "number" || !Number.isFinite(candidate.last_confirmed_tick)) {
        issues.push(`Fact ${factId} LAST_KNOWN needs last_confirmed_tick.`);
      }
      if (!isFiniteWorldPoint(candidate.last_confirmed_position)) {
        issues.push(`Fact ${factId} LAST_KNOWN needs a finite last_confirmed_position.`);
      }
      break;
    default:
      issues.push(`Fact ${factId} has unsupported source_type ${String(sourceType)}.`);
  }
  return issues;
}

export function assertValidObservationFacts(facts: readonly ObservationFact[]): void {
  const issues = facts.flatMap((fact, index) =>
    collectObservationFactIssues(fact).map((issue) => `facts[${index}]: ${issue}`)
  );
  if (issues.length > 0) throw new ObservationFactValidationError(issues);
}

function isForObserver(fact: ObservationFact, observerPlayerId: string): boolean {
  return fact.observer_player_id === observerPlayerId;
}

function isFactAvailable(fact: ObservationFact, atTick: number): boolean {
  return fact.tick <= atTick && availableFrom(fact) <= atTick;
}

function makeClaimBase(
  fact: ObservationFactBase,
  sourceType: ObservationSourceType,
  claimType: ObservationClaimType,
  knowledgeKind: ObservationKnowledgeKind,
  subjectResolution: ObservationSubjectResolution,
  spatialEstimate: ObservationSpatialEstimate,
  sharingScope: ObservationSharingScope,
  limitations: readonly string[],
  subjectRef?: string,
  contextRef?: string,
  idSuffix = "claim"
): ObservationClaim {
  return {
    id: `${fact.id}:${idSuffix}`,
    claim_type: claimType,
    knowledge_kind: knowledgeKind,
    source_type: sourceType,
    subject_ref: subjectRef,
    context_ref: contextRef,
    subject_resolution: subjectResolution,
    available_from_tick: availableFrom(fact),
    evidence_tick: fact.tick,
    expires_at_tick: fact.expires_at_tick,
    spatial_estimate: spatialEstimate,
    confidence: clampConfidence(fact.confidence, 0.5),
    sharing_scope: sharingScope,
    evidence_refs: factEvidenceRefs(fact),
    derived_by: OBSERVATION_DERIVER,
    limitations
  };
}

function bearingDegrees(from: WorldPoint, to: WorldPoint): number {
  const radians = Math.atan2(to.y - from.y, to.x - from.x);
  return (radians * 180) / Math.PI < 0
    ? ((radians * 180) / Math.PI + 360) % 360
    : (radians * 180) / Math.PI;
}

function soundSpatialEstimate(
  fact: SoundObservationFact,
  observerPosition: WorldPoint | undefined
): ObservationSpatialEstimate {
  if (fact.audibility_assessment.spatial_estimate) {
    return fact.audibility_assessment.spatial_estimate;
  }
  const origin = fact.observer_position ?? observerPosition;
  if (fact.direction) {
    return {
      type: "DIRECTION_SECTOR",
      ...fact.direction,
      origin: fact.direction.origin ?? origin
    };
  }
  if (origin && fact.world_origin) {
    return {
      type: "DIRECTION_SECTOR",
      origin,
      bearing_degrees: bearingDegrees(origin, fact.world_origin),
      width_degrees: fact.source_type === "FOOTSTEP" ? 90 : 120
    };
  }
  // A parser-provided world origin is ground truth, not an observer estimate.
  // Without an observer-relative direction or explicit assessment estimate,
  // do not turn it into a fake uncertain point.
  return { type: "NONE" };
}

function directionSpatialEstimate(
  direction: DirectionSector,
  observerPosition: WorldPoint | undefined
): ObservationSpatialEstimate {
  return {
    type: "DIRECTION_SECTOR",
    ...direction,
    origin: direction.origin ?? observerPosition
  };
}

function buildClaimForFact(
  fact: ObservationFact,
  input: ObservationBuildInput
): ObservationClaim | undefined {
  switch (fact.source_type) {
    case "DIRECT_VISION":
    case "SPOTTED":
      return makeClaimBase(
        fact,
        fact.source_type,
        "PLAYER_POSITION",
        "OBSERVED",
        "EXACT_PLAYER",
        { type: "EXACT_POINT", point: fact.world_position },
        "SELF",
        [],
        fact.subject_player_id,
        undefined,
        fact.source_type.toLowerCase()
      );

    case "FOOTSTEP":
    case "GUNSHOT":
      if (fact.audibility_assessment.result !== "POSSIBLY_AUDIBLE") return undefined;
      return {
        ...makeClaimBase(
          fact,
          fact.source_type,
          "SOUND_SOURCE",
          "INFERRED",
          "UNKNOWN_ACTOR",
          soundSpatialEstimate(fact, input.observer_position),
          "SELF",
          SOUND_LIMITATIONS,
          undefined,
          undefined,
          "sound"
        ),
        confidence: clampConfidence(fact.confidence, 0.35),
        evidence_refs: uniqueRefs(
          factEvidenceRefs(fact),
          fact.audibility_assessment.evidence_refs
        ),
        audibility_assessment: fact.audibility_assessment,
        limitations: [
          ...SOUND_LIMITATIONS,
          ...fact.audibility_assessment.limitations
        ]
      };

    case "DAMAGE_DIRECTION":
      return {
        ...makeClaimBase(
          fact,
          fact.source_type,
          "DAMAGE_DIRECTION",
          "INFERRED",
          "UNKNOWN_ACTOR",
          directionSpatialEstimate(fact.direction, input.observer_position),
          "SELF",
          ["伤害方向只说明可能的来向，不包含攻击者实时坐标或身份。"],
          undefined,
          undefined,
          "direction"
        ),
        confidence: clampConfidence(fact.confidence, 0.5),
        limitations: ["伤害方向只说明可能的来向，不包含攻击者实时坐标或身份。"]
      };

    case "UTILITY": {
      const spatialEstimate: ObservationSpatialEstimate = fact.visible_to_observer && fact.world_position
        ? { type: "EXACT_POINT", point: fact.world_position }
        : fact.observable_evidence_basis?.spatial_estimate ?? { type: "NONE" };
      const claim = makeClaimBase(
        fact,
        fact.source_type,
        "UTILITY_STATE",
        fact.visible_to_observer ? "OBSERVED" : "INFERRED",
        fact.visible_to_observer && fact.subject_ref ? "EXACT_PLAYER" : "UNKNOWN_ACTOR",
        spatialEstimate,
        "SELF",
        [],
        fact.visible_to_observer ? fact.subject_ref : undefined,
        undefined,
        "utility"
      );
      return {
        ...claim,
        evidence_refs: uniqueRefs(
          factEvidenceRefs(fact),
          fact.observable_evidence_basis?.evidence_refs ?? []
        ),
        limitations: fact.visible_to_observer
          ? fact.observable_evidence_basis?.limitations ?? []
          : [
              "隐藏 utility 没有 observable evidence 时只保留 NONE，不使用 ground-truth world_position。",
              ...(fact.observable_evidence_basis?.limitations ?? [])
            ]
      };
    }

    case "BOMB": {
      const spatialEstimate: ObservationSpatialEstimate = fact.visible_to_observer && fact.world_position
        ? { type: "EXACT_POINT", point: fact.world_position }
        : fact.observable_evidence_basis?.spatial_estimate ?? { type: "NONE" };
      const claim = makeClaimBase(
        fact,
        fact.source_type,
        "BOMB_STATE",
        fact.visible_to_observer ? "OBSERVED" : "INFERRED",
        "TEAM_ONLY",
        spatialEstimate,
        "SELF",
        [],
        undefined,
        undefined,
        "bomb"
      );
      return {
        ...claim,
        evidence_refs: uniqueRefs(
          factEvidenceRefs(fact),
          fact.observable_evidence_basis?.evidence_refs ?? []
        ),
        limitations: fact.visible_to_observer
          ? fact.observable_evidence_basis?.limitations ?? []
          : [
              "隐藏 bomb 没有 observable evidence 时只保留 NONE，不使用 ground-truth world_position。",
              ...(fact.observable_evidence_basis?.limitations ?? [])
            ]
      };
    }

    case "TEAM_SHARED":
      if (!fact.shared_to_observer) return undefined;
      return {
        ...fact.source_claim,
        id: `${fact.id}:team-shared`,
        source_type: "TEAM_SHARED",
        claim_type: "TEAM_REPORT",
        knowledge_kind: fact.source_claim.knowledge_kind === "USER_ASSERTED" ? "USER_ASSERTED" : "INFERRED",
        available_from_tick: Math.max(
          fact.source_claim.available_from_tick,
          fact.shared_at_tick ?? fact.tick
        ),
        evidence_tick: Math.max(fact.source_claim.evidence_tick, fact.tick),
        sharing_scope: "VERIFIED_TEAM_SHARED",
        evidence_refs: uniqueRefs(fact.source_claim.evidence_refs, factEvidenceRefs(fact)),
        derived_by: OBSERVATION_DERIVER,
        limitations: uniqueRefs(
          fact.source_claim.limitations,
          ["该 claim 仅因存在可验证的队友共享证据进入所选玩家状态。"]
        )
      };

    case "USER_CONTEXT":
      return makeClaimBase(
        {
          ...fact,
          tick: fact.context_tick ?? fact.tick
        },
        fact.source_type,
        "USER_CONTEXT",
        "USER_ASSERTED",
        "UNKNOWN_ACTOR",
        { type: "NONE" },
        "USER_CONTEXT_ONLY",
        [],
        undefined,
        fact.context_ref,
        "context"
      );

    case "LAST_KNOWN": {
      const confirmation: ObservationClaim = makeClaimBase(
        {
          ...fact,
          tick: fact.last_confirmed_tick
        },
        "DIRECT_VISION",
        "PLAYER_POSITION",
        "OBSERVED",
        fact.subject_resolution ?? "EXACT_PLAYER",
        { type: "EXACT_POINT", point: fact.last_confirmed_position },
        "SELF",
        [],
        fact.subject_player_id,
        undefined,
        "confirmation"
      );
      return decayLastKnownClaim(confirmation, input.at_tick);
    }
  }
}

function isFreshExactConfirmation(claim: ObservationClaim): boolean {
  return (
    (claim.source_type === "DIRECT_VISION" || claim.source_type === "SPOTTED") &&
    claim.spatial_estimate.type === "EXACT_POINT"
  );
}

function claimSubjectKey(claim: ObservationClaim): string | undefined {
  return claim.subject_ref;
}

/**
 * Convert a confirmed point into a fixed last-known claim. The point is never
 * moved along a hidden player's later trajectory.
 */
export function decayLastKnownClaim(
  claim: ObservationClaim,
  atTick: number,
  policy: LastKnownDecayPolicy = DEFAULT_LAST_KNOWN_DECAY_POLICY
): ObservationClaim | undefined {
  if (atTick < claim.evidence_tick) return undefined;
  if (
    policy.base_radius < 0 ||
    policy.radius_growth_per_tick < 0 ||
    policy.max_radius <= 0 ||
    policy.confidence_half_life_ticks <= 0 ||
    policy.max_age_ticks < 0
  ) {
    throw new Error("Invalid last-known decay policy.");
  }
  const ageTicks = atTick - claim.evidence_tick;
  if (ageTicks > policy.max_age_ticks) return undefined;

  const confirmedPoint =
    claim.spatial_estimate.type === "EXACT_POINT"
      ? claim.spatial_estimate.point
      : claim.spatial_estimate.type === "LAST_KNOWN_POINT"
        ? claim.spatial_estimate.point
        : undefined;
  if (!confirmedPoint || !claim.subject_ref) return undefined;

  const radius = Math.min(
    policy.max_radius,
    policy.base_radius + policy.radius_growth_per_tick * ageTicks
  );
  const confidence = clampConfidence(
    claim.confidence * Math.pow(0.5, ageTicks / policy.confidence_half_life_ticks),
    0
  );
  const policyExpiry = claim.evidence_tick + policy.max_age_ticks + 1;
  const expiresAt =
    claim.expires_at_tick === undefined
      ? policyExpiry
      : Math.min(policyExpiry, claim.expires_at_tick);

  return {
    id: `${claim.id}:last-known:${atTick}`,
    claim_type: "LAST_KNOWN_POSITION",
    knowledge_kind: "INFERRED",
    source_type: "LAST_KNOWN",
    subject_ref: claim.subject_ref,
    subject_resolution: claim.subject_resolution,
    available_from_tick: claim.available_from_tick,
    evidence_tick: claim.evidence_tick,
    expires_at_tick: expiresAt,
    spatial_estimate: {
      type: "LAST_KNOWN_POINT",
      point: confirmedPoint,
      radius,
      age_ticks: ageTicks
    },
    confidence,
    sharing_scope: claim.sharing_scope,
    evidence_refs: uniqueRefs(claim.evidence_refs, [claim.id]),
    derived_by: OBSERVATION_DERIVER,
    limitations: uniqueRefs(
      claim.limitations,
      ["固定最后确认点；不跟随未观察到的真实轨迹。", "置信度随时间衰减，空间不确定范围随时间扩大。"]
    )
  };
}

export function filterObservationClaimsAtTick(
  claims: readonly ObservationClaim[],
  atTick: number,
  options: { rejectFuture?: boolean } = {}
): ObservationClaim[] {
  const futureClaims = claims.filter(
    (claim) => claim.available_from_tick > atTick || claim.evidence_tick > atTick
  );
  if (options.rejectFuture && futureClaims.length > 0) {
    throw new FutureObservationClaimError(
      futureClaims.map((claim) => claim.id),
      atTick
    );
  }
  return claims.filter(
    (claim) =>
      claim.available_from_tick <= atTick &&
      claim.evidence_tick <= atTick &&
      (claim.expires_at_tick === undefined || atTick < claim.expires_at_tick)
  );
}

export const filterClaimsAtTick = filterObservationClaimsAtTick;

export function assertNoFutureObservationClaims(
  claims: readonly ObservationClaim[],
  atTick: number
): void {
  filterObservationClaimsAtTick(claims, atTick, { rejectFuture: true });
}

export function collectObservationClaimIssues(
  claim: ObservationClaim,
  atTick?: number
): string[] {
  const issues: string[] = [];
  if (!Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1) {
    issues.push(`Claim ${claim.id} confidence is outside [0, 1].`);
  }
  if (claim.available_from_tick < claim.evidence_tick) {
    issues.push(`Claim ${claim.id} becomes available before its evidence tick.`);
  }
  if (
    claim.expires_at_tick !== undefined &&
    claim.expires_at_tick <= claim.available_from_tick
  ) {
    issues.push(`Claim ${claim.id} expires before it can be used.`);
  }

  if (
    (claim.source_type === "FOOTSTEP" || claim.source_type === "GUNSHOT") &&
    (claim.spatial_estimate.type === "EXACT_POINT" ||
      claim.subject_resolution === "EXACT_PLAYER")
  ) {
    issues.push(`Sound claim ${claim.id} cannot expose an exact hidden-player point or identity.`);
  }
  if (claim.source_type === "FOOTSTEP" || claim.source_type === "GUNSHOT") {
    const assessment = claim.audibility_assessment;
    if (!isRecord(assessment)) {
      issues.push(`Sound claim ${claim.id} requires an observer-specific audibility assessment.`);
    } else {
      if (assessment.result !== "POSSIBLY_AUDIBLE") {
        issues.push(`Sound claim ${claim.id} requires POSSIBLY_AUDIBLE assessment.`);
      }
      if (typeof assessment.assessed_by !== "string" || !assessment.assessed_by.trim()) {
        issues.push(`Sound claim ${claim.id} audibility assessment needs assessed_by.`);
      }
      if (!Array.isArray(assessment.evidence_refs) || assessment.evidence_refs.length === 0) {
        issues.push(`Sound claim ${claim.id} audibility assessment needs evidence_refs.`);
      }
      if (
        Array.isArray(assessment.evidence_refs) &&
        !assessment.evidence_refs.every((ref) => typeof ref === "string" && claim.evidence_refs.includes(ref))
      ) {
        issues.push(`Sound claim ${claim.id} must retain audibility assessment evidence refs.`);
      }
      if (!Array.isArray(assessment.limitations)) {
        issues.push(`Sound claim ${claim.id} audibility assessment needs limitations.`);
      }
      if (assessment.spatial_estimate !== undefined) {
        issues.push(...collectSpatialEstimateIssues(
          assessment.spatial_estimate,
          `Sound claim ${claim.id} audibility assessment spatial_estimate`
        ));
        if (isRecord(assessment.spatial_estimate) && assessment.spatial_estimate.type === "EXACT_POINT") {
          issues.push(`Sound claim ${claim.id} audibility assessment cannot use an exact point.`);
        }
      }
    }
    if (claim.knowledge_kind !== "INFERRED") {
      issues.push(`Sound claim ${claim.id} must remain INFERRED, not observed or user asserted.`);
    }
  }
  if (
    claim.source_type === "DAMAGE_DIRECTION" &&
    claim.spatial_estimate.type !== "DIRECTION_SECTOR"
  ) {
    issues.push(`Damage direction claim ${claim.id} must use a direction sector.`);
  }
  if (
    claim.source_type === "LAST_KNOWN" &&
    claim.spatial_estimate.type !== "LAST_KNOWN_POINT"
  ) {
    issues.push(`Last-known claim ${claim.id} must use a LAST_KNOWN_POINT estimate.`);
  }
  if (
    claim.source_type === "TEAM_SHARED" &&
    claim.sharing_scope !== "VERIFIED_TEAM_SHARED"
  ) {
    issues.push(`Team-shared claim ${claim.id} lacks VERIFIED_TEAM_SHARED scope.`);
  }
  if (
    claim.source_type === "USER_CONTEXT" &&
    (claim.knowledge_kind !== "USER_ASSERTED" || claim.sharing_scope !== "USER_CONTEXT_ONLY")
  ) {
    issues.push(`User-context claim ${claim.id} must remain USER_ASSERTED and isolated.`);
  }
  if (atTick !== undefined && (claim.available_from_tick > atTick || claim.evidence_tick > atTick)) {
    issues.push(`Claim ${claim.id} is from the future of tick ${atTick}.`);
  }
  return issues;
}

export function assertValidObservableState(state: ObservableState): ObservableState {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const claim of state.claims) {
    if (ids.has(claim.id)) issues.push(`Duplicate observation claim ID ${claim.id}.`);
    ids.add(claim.id);
    issues.push(...collectObservationClaimIssues(claim, state.at_tick));
  }
  if (issues.length > 0) throw new ObservationClaimValidationError(issues);
  return state;
}

export function buildObservableState(input: ObservationBuildInput): ObservableState {
  assertValidObservationFacts(input.facts);
  const rawClaims: ObservationClaim[] = [];
  const buildLimitations: string[] = [];
  for (const fact of input.facts) {
    if (!isForObserver(fact, input.observer_player_id)) continue;
    if (!isFactAvailable(fact, input.at_tick)) continue;
    if (
      (fact.source_type === "FOOTSTEP" || fact.source_type === "GUNSHOT") &&
      fact.audibility_assessment.result !== "POSSIBLY_AUDIBLE"
    ) {
      buildLimitations.push(
        `${fact.source_type} ${fact.id} 未进入观察状态：observer-specific audibility assessment 不是 POSSIBLY_AUDIBLE。`
      );
    }
    if (
      (fact.source_type === "UTILITY" || fact.source_type === "BOMB") &&
      !fact.visible_to_observer &&
      !fact.observable_evidence_basis
    ) {
      buildLimitations.push(
        `${fact.source_type} ${fact.id} 没有 observable evidence；ground-truth world_position 被丢弃。`
      );
    }
    const claim = buildClaimForFact(fact, input);
    if (claim) rawClaims.push(claim);
  }

  const freshSubjects = new Set(
    rawClaims.filter(isFreshExactConfirmation).map(claimSubjectKey).filter(Boolean)
  );
  for (const previousClaim of input.previous_claims ?? []) {
    const subject = claimSubjectKey(previousClaim);
    if (!subject || freshSubjects.has(subject)) continue;
    if (
      previousClaim.source_type !== "DIRECT_VISION" &&
      previousClaim.source_type !== "SPOTTED" &&
      previousClaim.source_type !== "TEAM_SHARED" &&
      previousClaim.source_type !== "LAST_KNOWN"
    ) {
      continue;
    }
    const lastKnown = decayLastKnownClaim(previousClaim, input.at_tick);
    if (lastKnown) rawClaims.push(lastKnown);
  }

  const claims = filterObservationClaimsAtTick(rawClaims, input.at_tick).sort(
    (left, right) => left.evidence_tick - right.evidence_tick || left.id.localeCompare(right.id)
  );
  const state: ObservableState = {
    id: input.id ?? `${input.demo_id}:${input.observer_player_id}:${input.at_tick}`,
    demo_id: input.demo_id,
    timeline_version: input.timeline_version,
    observer_player_id: input.observer_player_id,
    at_tick: input.at_tick,
    observation_version: input.observation_version ?? OBSERVATION_VERSION,
    claims,
    limitations: [
      "ObservableState 是指定观察者视角，不是全知回放状态。",
      ...buildLimitations,
      ...(input.limitations ?? [])
    ]
  };
  return assertValidObservableState(state);
}

export function directVisionFactFromSample(
  id: string,
  observerPlayerId: string,
  sample: { player_id: string; tick: number; world_position: WorldPoint },
  sourceType: "DIRECT_VISION" | "SPOTTED" = "DIRECT_VISION"
): DirectVisionFact {
  return {
    id,
    source_type: sourceType,
    observer_player_id: observerPlayerId,
    subject_player_id: sample.player_id,
    tick: sample.tick,
    world_position: sample.world_position,
    evidence_refs: [id]
  };
}
