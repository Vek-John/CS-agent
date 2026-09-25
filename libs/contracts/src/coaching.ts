import type { TrustedDecisionSemantics, TeachingAssessment, BehaviorHypothesis } from "./decision-context";
import type {
  Advice,
  Annotation,
  Evidence,
  Fact,
  Inference,
  OutcomeImpact
} from "./index";
import type { ObservableState, ObservationClaim } from "./observation";
import type { WinProbabilityEconomyClass, WinProbabilityTimelineV1 } from "./win-probability";
import type { MatchTimeline } from "./index";

/** Candidate signals are parser/feature vocabulary, not coaching conclusions. */
export const CANDIDATE_SIGNAL_KINDS = [
  "DEATH",
  "KILL",
  "BOMB",
  "UTILITY",
  "HP_CHANGE",
  "WIN_RATE_DROP",
  "RETURN_AND_FIRE"
] as const;

export type CandidateSignalKind = (typeof CANDIDATE_SIGNAL_KINDS)[number];
export type CandidateSetStatus = "COMPLETE" | "FAILED";
export type DirectorStatus = "SUCCEEDED" | "FALLBACK" | "DISABLED";
export type DirectorProvider = "DETERMINISTIC" | "DEEPSEEK";

/** Hard route ceiling; the practical selector may choose fewer cues. */
export const MAX_TEACHING_CUES = 50;
/** Provider packet ceiling; it is independent from the final route ceiling. */
export const MAX_DIRECTOR_PACKET_CANDIDATES = 32;

export const DIRECTOR_FOCUS_CODES_BY_SIGNAL: Record<CandidateSignalKind, readonly string[]> = {
  DEATH: ["SURVIVE_THE_NEXT_CONTACT", "SURVIVE_CONTACT", "REVIEW_UNCERTAINTY", "VERIFIED_DECISION_REVIEW", "POSITIVE_PROCESS", "EXECUTION_REVIEW", "FORCED_CHOICE"],
  KILL: ["CONVERT_ADVANTAGE", "REVIEW_UNCERTAINTY", "VERIFIED_DECISION_REVIEW", "POSITIVE_PROCESS", "EXECUTION_REVIEW", "FORCED_CHOICE"],
  BOMB: ["OBJECTIVE_TIMING", "REVIEW_UNCERTAINTY", "VERIFIED_DECISION_REVIEW", "POSITIVE_PROCESS", "EXECUTION_REVIEW", "FORCED_CHOICE"],
  UTILITY: ["UTILITY_PURPOSE_AND_TEMPO", "REVIEW_UNCERTAINTY", "VERIFIED_DECISION_REVIEW", "POSITIVE_PROCESS", "EXECUTION_REVIEW", "FORCED_CHOICE"],
  HP_CHANGE: ["SURVIVE_CONTACT", "REVIEW_UNCERTAINTY", "VERIFIED_DECISION_REVIEW", "POSITIVE_PROCESS", "EXECUTION_REVIEW", "FORCED_CHOICE"],
  RETURN_AND_FIRE: ["REVIEW_UNCERTAINTY"],
  WIN_RATE_DROP: ["WIN_PROBABILITY_SWING_RESPONSE", "REVIEW_UNCERTAINTY", "VERIFIED_DECISION_REVIEW", "POSITIVE_PROCESS", "EXECUTION_REVIEW", "FORCED_CHOICE"]
};

export interface CandidateResultSummary {
  winProbabilityBefore?: number;
  winProbabilityAfter?: number;
  winProbabilityDelta?: number;
  winProbabilityPercentagePoints?: number;
  selectedPlayerDeath: boolean;
  economyClass: WinProbabilityEconomyClass;
  concurrentEvents: boolean;
  missingFields: readonly string[];
  limitations: readonly string[];
}

export type CanonicalFactKind = "DECISION_CONTEXT" | "PLAYER_ACTION" | "OUTCOME";

/** Parser-neutral fact DTO. Parser adapters can populate it without coaching conclusions. */
export interface CanonicalAnalysisFact {
  /** Supplemental occurrence only: excluded from nomination ranking and process judgments. */
  presentationOnly?: true;
  /** Optional action-producer output; must have an explicit actor and independent source refs. */
  actionActorPlayerId?: string;
  decisionAction?: PlayerActionFact["decisionAction"];
  id: string;
  kind: CanonicalFactKind;
  roundNumber: number;
  tick: number;
  text: string;
  sourceRefs: readonly string[];
  observedByPlayer: boolean;
  missingFields: readonly string[];
  limitations: readonly string[];
  outcomeKind?: OutcomeFact["outcomeKind"];
}

export interface CanonicalPlayerContext {
  playerSide: "T" | "CT";
  health?: number;
  armor?: number;
  helmet?: boolean;
  activeItemClass?: "UTILITY" | "KNIFE" | "BOMB" | "WEAPON" | "UNKNOWN";
  money?: number;
  equipmentValue?: number;
  utilityCount?: number;
  callout?: string;
  economyClass?: WinProbabilityEconomyClass;
}

/** Small parser-neutral signal/scene DTO consumed by CandidateGenerator. */
export interface CanonicalSignal extends TrustedDecisionSemantics {
  signalId: string;
  kind: CandidateSignalKind;
  roundNumber: number;
  sourceTick: number;
  decisionTick: number;
  revealTick: number;
  sourceRefs: readonly string[];
  factRefs: readonly string[];
  actionRefs: readonly string[];
  outcomeRefs: readonly string[];
  observableClaimRefs: readonly string[];
  evidenceRefs: readonly string[];
  playerSide: "T" | "CT";
  playerContext?: CanonicalPlayerContext;
  selectedPlayerDeath?: boolean;
  utilityKind?: string;
  bombEventType?: string;
  annotations?: readonly Annotation[];
  missingFields: readonly string[];
  limitations: readonly string[];
}

export interface CandidateGeneratorVersionManifest {
  timelineVersion: string;
  sceneIndexVersion: string;
  observationVersion: string;
  signalVersion: string;
  candidateGeneratorVersion: string;
}

export interface CandidateGeneratorInput {
  /** The Replay owner already nominated and snapshotted every independent model window. */
  independentSwingSignalsIncluded?: boolean;
  demoId: string;
  playerId: string;
  timeline: MatchTimeline;
  facts: readonly CanonicalAnalysisFact[];
  signals: readonly CanonicalSignal[];
  observableStates?: readonly ObservableState[];
  winProbabilityTimeline?: WinProbabilityTimelineV1;
  generationManifest: CandidateGeneratorVersionManifest;
  limitations?: readonly string[];
}

/**
 * The only object a Director may select. It deliberately contains references
 * and canonical windows, but no CoachCue, prose, or final teaching judgment.
 */
export interface TeachingCandidate extends TrustedDecisionSemantics {
  candidateId: string;
  roundNumber: number;
  source: {
    kind: CandidateSignalKind;
    refs: readonly string[];
  };
  preRollStart: number;
  decisionTick: number;
  revealTick: number;
  outcomeEnd: number;
  factRefs: readonly string[];
  observableClaimRefs: readonly string[];
  actionRefs: readonly string[];
  outcomeRefs: readonly string[];
  evidenceRefs: readonly string[];
  winRateSignalRefs: readonly string[];
  economySignalRefs: readonly string[];
  missingFields: readonly string[];
  limitations: readonly string[];
  deterministicScore: number;
  resultSummary: CandidateResultSummary;
}

/** Candidate material is still fact/evidence data; it is not a compiled cue. */
export interface CandidateMaterial extends TrustedDecisionSemantics {
  candidateId: string;
  decisionFacts: readonly Fact[];
  playerActionFacts: readonly PlayerActionFact[];
  outcomeFacts: readonly OutcomeFact[];
  inferences: readonly Inference[];
  advice: readonly Advice[];
  evidence: readonly Evidence[];
  observableStateId?: string;
  annotations?: readonly Annotation[];
  /** Stable rule context used by PlanCompiler, never sent to the Director. */
  contextCode?: string;
  callout?: string;
  economy?: WinProbabilityEconomyClass;
  limitations: readonly string[];
}

export interface CandidateSet {
  id: string;
  version: string;
  hash: string;
  demoId: string;
  playerId: string;
  status: CandidateSetStatus;
  failureReason?: string;
  generationManifest: {
    timelineVersion: string;
    sceneIndexVersion: string;
    observationVersion: string;
    signalVersion: string;
    candidateGeneratorVersion: string;
  };
  candidates: readonly TeachingCandidate[];
  materials: readonly CandidateMaterial[];
  limitations: readonly string[];
}

/** A verified player action is separate from an ObservableClaim. */
export interface PlayerActionFact {
  /** Supplemental occurrence only: excluded from nomination ranking and process judgments. */
  presentationOnly?: true;
  /** Strict action-only window; never inferred from free text or outcome events. */
  decisionAction?: {
    version: "decision-action.v1";
    kind: "RECONTACT" | "REPEEK";
    startTick: number;
    endTick: number;
    priorContactTick: number;
    source: "REPLAY_GEOMETRY_V1" | "SYNTHETIC_REGRESSION";
  } | {
    version: "decision-action.v1";
    /** Self movement and attributed shots only; does not establish renewed enemy contact. */
    kind: "RETURN_AND_FIRE";
    startTick: number;
    endTick: number;
    priorShotTick: number;
    source: "SELF_MOVEMENT_FIRE_V1";
  };
  id: string;
  text: string;
  actorPlayerId: string;
  availableAtTick: number;
  source: "DEMO";
  evidenceRefs: readonly string[];
  limitations: readonly string[];
}

/** Outcome facts are independently gated and never enter decision context. */
export interface OutcomeFact {
  id: string;
  text: string;
  availableAtTick: number;
  source: "DEMO";
  outcomeKind: "DEATH" | "KILL" | "HP_CHANGE" | "BOMB" | "UTILITY" | "OTHER";
  evidenceRefs: readonly string[];
  limitations: readonly string[];
}

export interface DirectorDecision {
  candidateId: string;
  priority: number;
  primaryFocusCode: string;
  selectionReason: string;
  reasonRefs: readonly string[];
  evidenceRefs: readonly string[];
  confidence: number;
}

export interface DirectorManifest {
  status: DirectorStatus;
  provider: DirectorProvider;
  reason?: string;
  model?: string;
  promptVersion?: string;
  limitations: readonly string[];
}

export interface DirectorDecisionSet {
  candidateSetId: string;
  candidateSetVersion: string;
  candidateSetHash: string;
  selected: readonly DirectorDecision[];
  manifest: DirectorManifest;
}

export interface DirectorCandidateSummary {
  decisionSummary?: { facts: readonly string[]; observableInformation: readonly string[]; missingFields: readonly string[] };
  assessment?: TeachingAssessment;
  behaviorHypotheses?: readonly BehaviorHypothesis[];
  approvedAdvice?: readonly { id: string; code: string; text: string; status: "APPLICABLE" }[];
  candidateId: string;
  sourceKind: CandidateSignalKind;
  deterministicScore: number;
  missingFields: readonly string[];
  limitations: readonly string[];
  reasonRefs: readonly string[];
  evidenceRefs: readonly string[];
  resultSummary: CandidateResultSummary;
  allowedFocusCodes: readonly string[];
}

export interface DirectorRequest {
  candidateSetId: string;
  candidateSetVersion: string;
  candidateSetHash: string;
  candidates: readonly DirectorCandidateSummary[];
  maxSelected: number;
}

export interface CoachingPackage extends TrustedDecisionSemantics {
  cueId: string;
  candidateId: string;
  decisionContext: {
    facts: readonly Fact[];
    claims: readonly ObservationClaim[];
  };
  playerAction: readonly PlayerActionFact[];
  inferences: readonly Inference[];
  advice: readonly Advice[];
  evidence: readonly Evidence[];
  primaryFocusCode: string;
  allowedRefs: {
    decision: readonly string[];
    action: readonly string[];
    advice: readonly string[];
    evidence: readonly string[];
  };
  limitations: readonly string[];
}

export interface OutcomePackage {
  cueId: string;
  candidateId: string;
  outcomeFacts: readonly OutcomeFact[];
  deathKillHpRefs: readonly string[];
  winProbabilityImpact?: OutcomeImpact;
  measurementRefs: readonly string[];
  confounders: readonly string[];
  limitations: readonly string[];
}

/** Session-owned gate state; the gate implementation lives outside review-planner. */
export interface OutcomeCompletionState {
  cueId: string;
  outcomeEndTick: number;
  status: "LOCKED" | "COMPLETE";
  completedAtTick?: number;
}

export interface NarrationField {
  text: string;
  refs: readonly string[];
  confidence?: number;
  limitations?: readonly string[];
}

/** Strict, route-free narration artifact. Keep the exact field names stable. */
export interface NarrationBundle {
  cueId: string;
  candidateId: string;
  primaryFocusCode: string;
  currentSituation: NarrationField;
  playerAction: NarrationField;
  coreIssue: NarrationField;
  betterPlay: NarrationField;
  outcomeImpact: NarrationField;
}

export interface NarrationManifest {
  status: "SUCCEEDED" | "FALLBACK" | "DISABLED";
  provider: "DETERMINISTIC" | "DEEPSEEK";
  reason?: string;
  model?: string;
  promptVersion?: string;
  limitations: readonly string[];
}

export interface NarrationResult {
  status: "SUCCEEDED" | "FALLBACK" | "DISABLED";
  bundle: NarrationBundle;
  manifest: NarrationManifest;
}

export type CueReadiness = "PENDING" | "READY" | "FALLBACK";

export interface CoachingRouteState {
  routeFrozen: boolean;
  routeFingerprint: string;
  candidateSetId: string;
  candidateSetHash: string;
  selectedCueCount: number;
  readiness: Readonly<Record<string, CueReadiness>>;
  cueOrder: readonly string[];
  cueBindings: Readonly<Record<string, { candidateId: string; primaryFocusCode: string }>>;
  startable: boolean;
  consumedCueIds: readonly string[];
  frozenCueIds: readonly string[];
}
