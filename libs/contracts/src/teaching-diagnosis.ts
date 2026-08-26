import type { Fact, PlayerStateSample, CoachCue } from "./index";
import type { CandidateMaterial, OutcomeFact, PlayerActionFact } from "./coaching";

/**
 * Contracts for the adaptive teaching layer.  These values are deliberately
 * separate from parser facts and from the visual TeachingCapability contract:
 * a player's explanation is an assertion, never a Demo fact, and a
 * diagnostic capability is a question to answer, not a playback command.
 */

export const REFLECTION_GOALS = [
  "GET_INFO",
  "TAKE_SPACE",
  "TRADE",
  "DELAY",
  "ROTATE",
  "SAVE",
  "EXECUTE_PLAN",
  "MECHANICAL_ATTEMPT",
  "OTHER",
  "UNKNOWN",
] as const;
export type ReflectionGoal = (typeof REFLECTION_GOALS)[number];

export const REFLECTION_QUESTION_TYPES = [
  "GOAL",
  "INFORMATION_JUDGMENT",
  "TEAMMATE_EXPECTATION",
  "TIMING",
  "TACTICAL_CONTEXT",
  "RULE_UNDERSTANDING",
] as const;
export type ReflectionQuestionType = (typeof REFLECTION_QUESTION_TYPES)[number];

export const REFLECTION_RESPONSES = ["ANSWERED", "SKIPPED", "NOT_SURE"] as const;
export type ReflectionResponse = (typeof REFLECTION_RESPONSES)[number];

export interface UserReflection {
  cueId: string;
  rawText?: string;
  selectedGoal?: ReflectionGoal;
  /** Stable ID is optional on the wire for backwards-compatible callers. */
  reflectionId?: string;
  questionType?: ReflectionQuestionType;
  response?: ReflectionResponse;
  source: "USER";
  limitations: readonly string[];
}

export const USER_CLAIM_TYPES = [
  "GOAL",
  "ENEMY_BELIEF",
  "TEAMMATE_BELIEF",
  "TIME_BELIEF",
  "RESOURCE_BELIEF",
  "TACTICAL_CONTEXT",
  "EXECUTION_REPORT",
] as const;
export type UserClaimType = (typeof USER_CLAIM_TYPES)[number];

export const CLAIM_VERIFICATION_STATUSES = [
  "UNTESTED",
  "SUPPORTED",
  "CONTRADICTED",
  "PARTIALLY_SUPPORTED",
  "UNVERIFIABLE",
] as const;
export type ClaimVerificationStatus = (typeof CLAIM_VERIFICATION_STATUSES)[number];

export interface UserClaim {
  claimId: string;
  type: UserClaimType;
  content: string;
  source: "USER";
  verification: ClaimVerificationStatus;
  supportingRefs: readonly string[];
  contradictingRefs: readonly string[];
  limitations: readonly string[];
  cueId?: string;
  originReflectionId?: string;
}

export const HINGE_KINDS = [
  "TRADE",
  "INFORMATION",
  "RISK",
  "SYNC",
  "TIMING",
  "EXPOSURE",
  "OPTION",
  "EXECUTION",
] as const;
export type HingeKind = (typeof HINGE_KINDS)[number];

export interface HingeCondition {
  hingeId: string;
  cueId: string;
  kind: HingeKind;
  conditionCode: string;
  statement: string;
  claimRefs: readonly string[];
  evidenceRefs: readonly string[];
  verification: ClaimVerificationStatus;
  confidence: number;
  limitations: readonly string[];
}

export const DIAGNOSTIC_CAPABILITY_KINDS = [
  "VERIFY_TRADE_ASSUMPTION",
  "VERIFY_INFORMATION_ASSUMPTION",
  "VERIFY_RISK_BUDGET",
  "VERIFY_SYNC_ASSUMPTION",
  "VERIFY_EXPOSURE_ASSUMPTION",
  "COMPARE_TWO_OPTIONS",
] as const;
export type DiagnosticCapabilityKind = (typeof DIAGNOSTIC_CAPABILITY_KINDS)[number];
export type DiagnosticCapabilityId = DiagnosticCapabilityKind;

export interface PresentationRecipe {
  recipeId: string;
  title: string;
  /** Presentation sections are labels, not free-form player commands. */
  sections: readonly ("CLAIM" | "HINGE" | "EVIDENCE" | "VERDICT" | "TRANSFER")[];
  visualHint?: "RESOURCE_CHIPS" | "MAP_RELATION" | "TIMELINE_WINDOW" | "TEXT_ONLY";
}

export interface DiagnosticCapability {
  id: DiagnosticCapabilityId;
  /** Alias used by Agent events; it always equals id when present. */
  capabilityId: DiagnosticCapabilityId;
  kind: DiagnosticCapabilityKind;
  cueId: string;
  hingeId: string;
  claimTypes: readonly UserClaimType[];
  boundEvidenceRefs: readonly string[];
  presentationRecipe: PresentationRecipe;
  limitations: readonly string[];
}

export interface DiagnosticMeasurement {
  id: string;
  label: string;
  value: number | string;
  unit?: string;
  evidenceRefs: readonly string[];
}

export interface DiagnosticResult {
  resultId: string;
  capabilityId: DiagnosticCapabilityId;
  cueId: string;
  hingeId: string;
  status: ClaimVerificationStatus;
  evidenceRefs: readonly string[];
  measurements: readonly DiagnosticMeasurement[];
  explanation: string;
  limitations: readonly string[];
}

export const COACH_VERDICT_TYPES = [
  "GOAL_AND_ACTION_ALIGNED",
  "GOAL_VALID_CONDITION_FAILED",
  "BELIEF_INCORRECT",
  "ACTION_GOAL_MISMATCH",
  "EXECUTION_ONLY",
  "TEAM_EXECUTION",
  "INCONCLUSIVE",
] as const;
export type CoachVerdictType = (typeof COACH_VERDICT_TYPES)[number];

export interface CoachVerdict {
  type: CoachVerdictType;
  confidence: number;
  hingeId: string;
  diagnosticResultId?: string;
  claimIds: readonly string[];
  evidenceRefs: readonly string[];
  limitations: readonly string[];
  revision: number;
  explanation: string;
}

export interface TransferRule {
  ruleId: string;
  when: string;
  do: string;
  unless?: string;
  refs: readonly string[];
  confidence: number;
  limitations: readonly string[];
}

export const LEARNING_THREAD_DIAGNOSIS_TYPES = [
  "INFORMATION_MODEL",
  "TEAM_MODEL",
  "RISK_MODEL",
  "OPTION_MODEL",
  "TIMING",
  "EXECUTION",
  "UNVERIFIABLE",
] as const;
export type LearningThreadDiagnosisType = (typeof LEARNING_THREAD_DIAGNOSIS_TYPES)[number];

export const LEARNING_THREAD_STATUSES = [
  "OPEN",
  "TAUGHT",
  "UNDERSTOOD",
  "APPLIED_ONCE",
  "REPEATED",
  "STABLE",
] as const;
export type LearningThreadStatus = (typeof LEARNING_THREAD_STATUSES)[number];

export interface LearningThread {
  threadId: string;
  scope: "SESSION" | "CROSS_DEMO";
  hingeCode: string;
  trigger: {
    situation: string;
    conditions: readonly string[];
  };
  userModel: {
    goal?: string;
    belief?: string;
    expectedTeammateAction?: string;
  };
  diagnosis: {
    type: LearningThreadDiagnosisType;
    summary: string;
    confidence: number;
  };
  transferRule: TransferRule;
  evidenceCueIds: readonly string[];
  successfulCueIds: readonly string[];
  conflictingCueIds: readonly string[];
  status: LearningThreadStatus;
}

export const CUE_CASE_STATUSES = [
  "REFLECTION_PENDING",
  "REFLECTED",
  "HINGE_SELECTED",
  "DIAGNOSTIC_PENDING",
  "DIAGNOSTIC_WAITING",
  "VERDICT_READY",
  "AWAITING_CONFIRMATION",
  "DISAGREED",
  "COMPLETED",
  "FALLBACK",
] as const;
export type CueCaseStatus = (typeof CUE_CASE_STATUSES)[number];

export interface CueCase {
  schemaVersion: "cue-case.v1";
  caseId: string;
  cueId: string;
  candidateId?: string;
  pedagogyMode: PedagogyMode;
  status: CueCaseStatus;
  reflection?: UserReflection;
  claims: readonly UserClaim[];
  hinge?: HingeCondition;
  capabilities: readonly DiagnosticCapability[];
  selectedCapabilityId?: DiagnosticCapabilityId;
  diagnosticResult?: DiagnosticResult;
  verdict?: CoachVerdict;
  transferRule?: TransferRule;
  baselineNarrationAvailable: boolean;
  attemptBudget: {
    reflection: number;
    diagnostic: number;
    disagreement: number;
    alternateDiagnostic: number;
  };
  limitations: readonly string[];
}

export type PedagogyMode =
  | "INTRODUCE"
  | "CLARIFY"
  | "CONTRAST"
  | "CHECK_TRANSFER"
  | "REINFORCE"
  | "BRIEF_REPEAT"
  | "DEFER";

/**
 * Identity-free resource evidence for a remote diagnosis.
 *
 * This is a projection of the selected player's decision-time state, not a
 * Demo fact.  It deliberately carries no player identity, time, spatial or
 * view information; evidenceRefs must point back to facts already in the
 * bounded diagnosis packet.
 */
export interface DecisionResources {
  health: number;
  armor: number;
  hasHelmet: boolean;
  money?: number;
  equipmentValue?: number;
  inventoryCount?: number;
  evidenceRefs: readonly string[];
}

/** Compact evidence accepted by the diagnostic deep module. */
export interface TeachingDiagnosisInput {
  cueId: string;
  reflection: UserReflection;
  candidateId?: string;
  cue?: Pick<CoachCue, "id" | "primary_focus_code" | "limitations">;
  material?: Pick<CandidateMaterial, "candidateId" | "decisionFacts" | "playerActionFacts" | "outcomeFacts" | "advice" | "limitations" | "economy" | "contextCode">;
  decisionFacts: readonly Fact[];
  playerActionFacts: readonly PlayerActionFact[];
  outcomeFacts: readonly OutcomeFact[];
  decisionState?: PlayerStateSample;
  decisionResources?: DecisionResources;
  focusCode?: string;
  economyClass?: "PISTOL" | "ECO" | "FORCE" | "FULL" | "UNKNOWN";
  existingThreads?: readonly LearningThread[];
  limitations?: readonly string[];
}

export interface TeachingDiagnosisOutput {
  cueCase: CueCase;
  learningThread: LearningThread;
}
