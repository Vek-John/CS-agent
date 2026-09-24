import type { DirectionSector, WorldPoint } from "./geometry";

export const OBSERVATION_SOURCE_TYPES = [
  "DIRECT_VISION",
  "SPOTTED",
  "FOOTSTEP",
  "GUNSHOT",
  "DAMAGE_DIRECTION",
  "UTILITY",
  "BOMB",
  "LAST_KNOWN",
  "TEAM_SHARED",
  "USER_CONTEXT"
] as const;

export type ObservationSourceType = (typeof OBSERVATION_SOURCE_TYPES)[number];

export type ObservationKnowledgeKind = "OBSERVED" | "INFERRED" | "USER_ASSERTED";

export type ObservationSubjectResolution =
  | "EXACT_PLAYER"
  | "TEAM_ONLY"
  | "UNKNOWN_ACTOR";

export type ObservationSharingScope =
  | "SELF"
  | "VERIFIED_TEAM_SHARED"
  | "USER_CONTEXT_ONLY";

export type ObservationClaimType =
  | "PLAYER_POSITION"
  | "PLAYER_PRESENCE"
  | "SOUND_SOURCE"
  | "DAMAGE_DIRECTION"
  | "UTILITY_STATE"
  | "BOMB_STATE"
  | "LAST_KNOWN_POSITION"
  | "TEAM_REPORT"
  | "USER_CONTEXT";

export type AudibilityAssessmentResult =
  | "POSSIBLY_AUDIBLE"
  | "NOT_AUDIBLE"
  | "UNDETERMINED";

/**
 * Observer-specific assessment. A parser's global sound emission is not this
 * type and must not be passed to the Observation builder.
 */
export interface AudibilityAssessment {
  result: AudibilityAssessmentResult;
  assessed_by: string;
  evidence_refs: readonly string[];
  limitations: readonly string[];
  /** Optional coarse estimate supplied by the observer-specific assessment. */
  spatial_estimate?: ObservationSpatialEstimate;
  /** Optional audibility-gate diagnostics; these are not player knowledge. */
  distance_world_units?: number;
  threshold_world_units?: number;
  emission_origin_source?: "ACTOR_PLAYER_STATE_JOIN" | "EVENT_WORLD_ORIGIN" | "UNKNOWN";
}

export type ObservationSpatialEstimate =
  | {
      type: "EXACT_POINT";
      point: WorldPoint;
    }
  | {
      type: "UNCERTAIN_POINT";
      center: WorldPoint;
      radius: number;
    }
  | ({ type: "DIRECTION_SECTOR" } & DirectionSector)
  | {
      type: "AREA";
      center: WorldPoint;
      radius: number;
    }
  | {
      type: "LAST_KNOWN_POINT";
      point: WorldPoint;
      radius: number;
      age_ticks: number;
    }
  | {
      type: "NONE";
    };

/** Explicit pre-decision user statement, never a parsed Demo fact or verified tactic. */
export interface UserTacticalContext {
  version: "user-tactical-context.v1";
  enemyArea: "A_SITE" | "B_SITE" | "MID" | "UNKNOWN";
  enemyCount: number | null;
  plan: "TRADE" | "TAKE_SPACE" | "HOLD" | "RETREAT" | "EXECUTE" | "UNKNOWN";
}

/** A closed vocabulary keeps identities, results and injected instructions out. */
export function parseUserTacticalContext(value: unknown): UserTacticalContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_USER_TACTICAL_CONTEXT");
  const input = value as Record<string, unknown>;
  const keys = ["version", "enemyArea", "enemyCount", "plan"];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))
    || input.version !== "user-tactical-context.v1"
    || typeof input.enemyArea !== "string" || !["A_SITE", "B_SITE", "MID", "UNKNOWN"].includes(input.enemyArea)
    || typeof input.plan !== "string" || !["TRADE", "TAKE_SPACE", "HOLD", "RETREAT", "EXECUTE", "UNKNOWN"].includes(input.plan)
    || input.enemyCount !== null && (typeof input.enemyCount !== "number" || !Number.isInteger(input.enemyCount) || input.enemyCount < 0 || input.enemyCount > 5)) throw new Error("INVALID_USER_TACTICAL_CONTEXT");
  return { version: "user-tactical-context.v1", enemyArea: input.enemyArea as UserTacticalContext["enemyArea"], enemyCount: input.enemyCount as number | null, plan: input.plan as UserTacticalContext["plan"] };
}

export interface ObservationClaim {
  /** Allowed only with USER_CONTEXT / USER_ASSERTED / USER_CONTEXT_ONLY provenance. */
  user_tactical_context?: UserTacticalContext;
  id: string;
  claim_type: ObservationClaimType;
  knowledge_kind: ObservationKnowledgeKind;
  source_type: ObservationSourceType;
  subject_ref?: string;
  context_ref?: string;
  subject_resolution: ObservationSubjectResolution;
  /** First tick at which the observer may use this claim; can be later than evidence_tick. */
  available_from_tick: number;
  /** Tick at which the underlying observer-scoped evidence occurred. */
  evidence_tick: number;
  /** Exclusive first tick at which this claim is no longer available. */
  expires_at_tick?: number;
  spatial_estimate: ObservationSpatialEstimate;
  confidence: number;
  sharing_scope: ObservationSharingScope;
  evidence_refs: readonly string[];
  audibility_assessment?: AudibilityAssessment;
  derived_by: string;
  limitations: readonly string[];
}

export interface ObservableState {
  id: string;
  demo_id: string;
  timeline_version: string;
  observer_player_id: string;
  at_tick: number;
  observation_version: string;
  claims: readonly ObservationClaim[];
  limitations: readonly string[];
}
