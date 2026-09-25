import type { Advice, TeamSide } from "./index";
import type { ObservableState } from "./observation";
import type { DecisionAssessmentArtifact } from "./decision-assessment";

export const MAX_DECISION_SNAPSHOT_BYTES = 16 * 1024;
export const MAX_DECISION_SNAPSHOT_PLAYERS = 10;
export const MAX_ANALYSIS_CANDIDATES = 512;
export const MAX_ANALYSIS_BUNDLE_BYTES = 16 * 1024 * 1024;
export type InformationBoundary = "GROUND_TRUTH" | "OBSERVABLE" | "OUTCOME" | "APPLICABILITY_ONLY";
export type ApplicabilityStatus = "APPLICABLE" | "INAPPLICABLE" | "UNVERIFIABLE";

/** Unknown values are null; absence must never be interpreted as false or zero. */
export interface DecisionValue<T> {
  value: T | null;
  boundary: InformationBoundary;
  evidenceRefs: readonly string[];
  limitations: readonly string[];
}
export interface DecisionPlayerSummary {
  playerId: string;
  side: TeamSide | null;
  alive: boolean | null;
  health: number | null;
  /** No world positions or hidden equipment cross the Replay owner boundary. */
  boundary: "APPLICABILITY_ONLY";
}
export interface DecisionCheck {
  code: string;
  status: ApplicabilityStatus;
  boundary: InformationBoundary;
  evidenceRefs: readonly string[];
  missingFields: readonly string[];
  reason: string;
}
export interface DecisionSnapshot {
  version: "decision-snapshot.v1";
  snapshotId: string;
  roundNumber: number;
  selectedPlayerId: string;
  decisionTick: number;
  sampledAtTick: number | null;
  /** Optional for immutable legacy records. Strictly before decisionTick; no attacker or damage amounts. */
  selfHurtEvents?: readonly { source: "DEMO_PLAYER_HURT"; sourceRef: string; tick: number }[];
  selectedPlayer: DecisionValue<{
    side: TeamSide | null; alive: boolean | null; health: number | null; armor: number | null;
    helmet: boolean | null; weapon: string | null; grenades: readonly string[] | null;
    money: number | null; equipmentValue: number | null; hasDefuseKit: boolean | null;
    callout: string | null;
  }>;
  aliveCounts: DecisionValue<{ allies: number; enemies: number; includesSelectedPlayer: true }>;
  players: readonly DecisionPlayerSummary[];
  score: DecisionValue<{ t: number; ct: number }>;
  clock: DecisionValue<{ phase: "FREEZE" | "LIVE" | "POST_ROUND" | "UNKNOWN"; elapsedSeconds: number | null; remainingSeconds: number | null }>;
  bomb: DecisionValue<{ state: "NOT_CARRIED" | "CARRIED" | "DROPPED" | "PLANTED" | "DEFUSED" | "EXPLODED" | "UNKNOWN"; carriedBySelectedPlayer: boolean | null; remainingSeconds: number | null }>;
  /** Full world state may veto; only observable evidence may approve these checks. */
  supportChecks: readonly DecisionCheck[];
  pressureChecks: readonly DecisionCheck[];
  spatialChecks: readonly DecisionCheck[];
  missingFields: readonly string[];
  limitations: readonly string[];
}

/** Only observer-scoped, fresh pre-decision claims; never copy global enemy states. */
export interface ObservableDecisionContext {
  version: "observable-decision-context.v1";
  boundary: "OBSERVABLE";
  state: ObservableState;
  snapshotId: string;
  source: "DEMO_OBSERVER_EVIDENCE";
  publicFacts: readonly string[];
  freshness: { sampledAtTick: number | null; ageTicks: number | null };
  confidence: number;
  missingFields: readonly string[];
  limitations: readonly string[];
}
export interface BehaviorHypothesis {
  hypothesisId: string;
  kind: string;
  supportingEvidenceRefs: readonly string[];
  counterEvidenceRefs: readonly string[];
  confidence: number;
  missingFields: readonly string[];
  limitations: readonly string[];
  allowedAsTeachingJudgment: boolean;
  reflectionOnly: boolean;
}
export interface AdvicePrecondition {
  code: string;
  description: string;
  requiredEvidence: readonly string[];
}
/** Extension of the existing advice domain object, not a second advice model. */
export interface AdviceOption extends Advice {
  code: string;
  requiredPreconditions: readonly AdvicePrecondition[];
  disqualifiers: readonly AdvicePrecondition[];
  requiredEvidence: readonly string[];
  timingWindow: { startTick: number; endTick: number };
  confidence: number;
  fallbackWording: string;
  applicability?: AdviceApplicabilityResult;
}
export interface AdviceApplicabilityResult {
  adviceCode: string;
  status: ApplicabilityStatus;
  preconditions: readonly DecisionCheck[];
  evidenceRefs: readonly string[];
  rejectionReasons: readonly string[];
  missingFields: readonly string[];
  allowedIntoNarrator: boolean;
  fallbackWording: string;
}
export type TeachingAssessmentKind = "DECISION_ERROR" | "EXECUTION_ISSUE" | "POSITIVE_PROCESS" | "FORCED_CHOICE" | "INSUFFICIENT_EVIDENCE" | "NO_TEACHING_VALUE";
export interface TeachingAssessment {
  kind: TeachingAssessmentKind;
  confidence: number;
  supportingEvidenceRefs: readonly string[];
  counterEvidenceRefs: readonly string[];
  missingFields: readonly string[];
  limitations: readonly string[];
  explanation: string;
  hasEvaluableDecision: boolean;
}
/** Optional for saved-session compatibility; absent semantics are unverified. */
export interface TrustedDecisionSemantics {
  decisionAssessment?: DecisionAssessmentArtifact;
  decisionSnapshot?: DecisionSnapshot;
  observableContext?: ObservableDecisionContext;
  behaviorHypotheses?: readonly BehaviorHypothesis[];
  assessment?: TeachingAssessment;
  adviceOptions?: readonly AdviceOption[];
}
