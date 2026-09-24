import type { ObservationClaimType, UserTacticalContext } from "./observation";
import type { DecisionObservationSemantics } from "./decision-observation";
/** Restricted decision inference. Teaching value remains owned by the Director. */
export const DECISION_ASSESSMENT_VERSIONS = {
  projection: "decision-assessment-projection.v1", projectionWithUserContext: "decision-assessment-projection.v2", projectionWithReturnAndFire: "decision-assessment-projection.v3", questionsReturnAndFire: "return-and-fire-questions.v1", questions: "recontact-questions.v1",
  projectionWithObservationSemantics: "decision-assessment-projection.v4", questionsWithWitnesses: "decision-evidence-questions.v2",
  acceptance: "recontact-acceptance.v1", artifact: "decision-assessment.v1", model: "jev-1.13.0"
} as const;
export type DecisionAssessmentMode = "RULE_BASELINE" | "JEV_SHADOW" | "JEV_EXPERIMENT";
export type DecisionAssessmentCheckCode = "objectiveAllowsDelay" | "tradeWindow" | "safeReachableCover";
export interface DecisionAssessmentPacket {
  projectionVersion: typeof DECISION_ASSESSMENT_VERSIONS.projection | typeof DECISION_ASSESSMENT_VERSIONS.projectionWithUserContext | typeof DECISION_ASSESSMENT_VERSIONS.projectionWithReturnAndFire | typeof DECISION_ASSESSMENT_VERSIONS.projectionWithObservationSemantics;
  questionVersion: typeof DECISION_ASSESSMENT_VERSIONS.questions | typeof DECISION_ASSESSMENT_VERSIONS.questionsReturnAndFire | typeof DECISION_ASSESSMENT_VERSIONS.questionsWithWitnesses;
  scenario: "RECONTACT_AFTER_ADVANTAGE" | "RETURN_AND_FIRE_AFTER_ADVANTAGE";
  map: "de_mirage";
  state: {
    allies: number; enemies: number; advantage: number;
    checks: readonly { code: DecisionAssessmentCheckCode; value: "YES" | "NO" | "UNKNOWN"; refs: readonly string[] }[];
    observations: readonly { alias: string; kind: ObservationClaimType; source: "DEMO_OBSERVER" | "USER_PROVIDED"; confidence: number; ageSeconds: number; shared: boolean; reportedContext?: UserTacticalContext; semantic?: DecisionObservationSemantics }[];
  };
  action: { kind: "RECONTACT" | "REPEEK"; durationSeconds: number; sincePriorContactSeconds: number; refs: readonly string[] } | { kind: "RETURN_AND_FIRE"; durationSeconds: number; sincePriorShotSeconds: number; contactStatus: "UNVERIFIED"; refs: readonly string[] };
  evidence: readonly { alias: string; role: "PUBLIC_COUNTS" | "ACTION" | "OBSERVATION" | DecisionAssessmentCheckCode; confidence: number }[];
}
/** Local-only binding; never serialized into a model request. */
export interface DecisionAssessmentBinding {
  /** New preparations persist the projection. Absent means legacy auto-selection on restore. */
  projectionVersion?: DecisionAssessmentPacket["projectionVersion"];
  candidateId: string; playerId: string; mapName: string; tickRate: number;
  packetFingerprint: string; aliases: Readonly<Record<string, readonly string[]>>;
  inputProvenance: "SYNTHETIC_REGRESSION" | "REPLAY_GEOMETRY_V1" | "SELF_MOVEMENT_FIRE_V1";
}
export interface DecisionAssessmentAtom<C extends string> {
  choice: C; confidence: number; probabilities: Readonly<Record<C, number>>; refs: readonly string[];
}
export interface DecisionAssessmentResult {
  model: string;
  questionVersion: string;
  riskWarranted: DecisionAssessmentAtom<"WARRANTED" | "UNWARRANTED" | "UNKNOWN">;
  alternativePreferable: DecisionAssessmentAtom<"PREFERABLE" | "NOT_ESTABLISHED" | "UNKNOWN">;
  contextSufficient: DecisionAssessmentAtom<"SUFFICIENT" | "INSUFFICIENT">;
  /** Independent model selections of explicit joint evidence; never inferred from the labels. */
  witnesses?: Record<"riskWarranted" | "alternativePreferable" | "contextSufficient", {
    choice: string; confidence: number; probabilities: Readonly<Record<string, number>>;
  }>;
  limitationCodes: readonly ("MISSING_CONTEXT" | "USER_CONTEXT_UNVERIFIED" | "MULTIPLE_REASONABLE_ACTIONS" | "PRINCIPLE_UNVALIDATED")[];
}
export interface DecisionAssessmentArtifact {
  version: typeof DECISION_ASSESSMENT_VERSIONS.artifact;
  mode: DecisionAssessmentMode;
  provider: "RULE" | "JEV" | "GENERATION_MODEL";
  acceptancePolicyVersion: typeof DECISION_ASSESSMENT_VERSIONS.acceptance;
  acceptance: "DISABLED" | "TEST_ONLY";
  status: "ACCEPTED" | "SHADOW" | "REJECTED" | "FALLBACK";
  binding: DecisionAssessmentBinding;
  result?: DecisionAssessmentResult;
  modelConfidence: number | null;
  evidenceConfidence: number;
  rejectionReasons: readonly string[];
  latencyMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}
