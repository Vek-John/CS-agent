import type {
  CoachVerdict,
  CueCase,
  LearningThread,
  TransferRule,
  UserClaim,
} from "@cs-coach/contracts";

/** Versioned envelopes owned by the Memory Domain. */
export const MEMORY_RECORD_VERSION = "memory-record.v1" as const;
export const MEMORY_EVENT_VERSION = "memory-event.v1" as const;
export const MEMORY_PROPOSAL_VERSION = "memory-proposal.v1" as const;
export const MEMORY_BRIEF_VERSION = "memory-brief.v1" as const;
export const MEMORY_AUTHORIZATION_VERSION = "memory-authorization.v1" as const;

export const MEMORY_KINDS = [
  "PREFERENCE",
  "PROFILE",
  "COACHING_PREFERENCE",
  "PLAYSTYLE",
  "HABIT",
  "DECISION_MODEL",
  "LEARNING_THREAD",
  "USER_CLAIM",
  "COACH_VERDICT",
  "TRANSFER_RULE",
  "CORRECTION",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SOURCES = [
  "USER",
  "USER_EXPLICIT",
  "USER_CONFIRMED",
  "USER_CORRECTION",
  "DEMO_OBSERVED",
  "AGENT_INFERRED",
  "COACH_RULE_DERIVED",
  "COACH",
  "DEMO",
  "SYSTEM",
  "IMPORT",
] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/**
 * The canonical lifecycle is the sequence accepted by ADR-0006.  EMERGING
 * and ACTIVE/CONFIRMED are retained as wire-compatible lifecycle labels for
 * API clients that use those names.
 */
export const MEMORY_STATUSES = [
  "CANDIDATE",
  "OBSERVED",
  "REPEATED",
  "IMPROVING",
  "STABLE",
  "RESOLVED",
  "ARCHIVED",
  "DELETED",
  "DISPUTED",
  "SUPERSEDED",
  "EMERGING",
  "ACTIVE",
  "CONFIRMED",
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SCOPES = ["SESSION", "CROSS_DEMO"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface MemoryScopeContext {
  mapName?: string;
  side?: "T" | "CT";
  roleCode?: string;
  teamId?: string;
}

export const MEMORY_EVENT_TYPES = [
  "USER_PREFERENCE_STATED",
  "USER_PROFILE_STATED",
  "USER_CONFIRMED",
  "USER_CORRECTED_COACH",
  "CUE_DIAGNOSED",
  "TRANSFER_RULE_TAUGHT",
  "TRANSFER_RULE_APPLIED",
  "SESSION_COMPLETED",
  "MEMORY_DELETED",
] as const;
export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];

export const MEMORY_OPERATIONS = ["CREATE", "UPDATE", "CORRECT", "DELETE", "CONFIRM"] as const;
export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

export const MEMORY_CONSENT_STATES = ["GRANTED", "REVOKED", "UNKNOWN"] as const;
export type MemoryConsentState = (typeof MEMORY_CONSENT_STATES)[number];

export const MEMORY_SOURCE_NAMESPACES = [
  "USER_CLAIM",
  "VERDICT",
  "TRANSFER_RULE",
  "DEMO_FACT",
  "OBSERVATION_CLAIM",
  "PRO_EVIDENCE",
  "SESSION",
  "USER_PREFERENCE",
  "USER_PROFILE",
] as const;
export type MemorySourceNamespace = (typeof MEMORY_SOURCE_NAMESPACES)[number];

/**
 * A provenance pointer, never a raw Demo/frames/ticks payload.  The three
 * required identifiers make an otherwise valid-looking bare cue reference
 * impossible to persist as cross-user memory.
 */
export interface MemorySourceRef {
  namespace: MemorySourceNamespace;
  refId: string;
  demoContentHash: string;
  sessionId: string;
  cueId: string;
  caseId?: string;
  threadId?: string;
  source?: MemorySource;
  label?: string;
}

export interface MemoryFactRef {
  ref: MemorySourceRef;
  kind?: "DEMO_FACT" | "OBSERVATION_CLAIM";
}

export interface MemoryInference {
  id: string;
  summary: string;
  confidence: number;
  refs: readonly MemorySourceRef[];
}

export interface MemoryAdvice {
  id: string;
  when: string;
  do: string;
  unless?: string;
  confidence: number;
  refs: readonly MemorySourceRef[];
}

export interface MemoryCorrection {
  correctionId: string;
  memoryId: string;
  content: string;
  source: "USER";
  createdAt: string;
  revision: number;
  refs: readonly MemorySourceRef[];
}

export interface MemoryPreference {
  key: string;
  value: string | number | boolean;
  label?: string;
  source: "USER" | "USER_EXPLICIT";
  refs: readonly MemorySourceRef[];
}

/** Explicit, user-authored profile fields. Values stay bounded and generic so
 * the product does not need a second account/identity model in this version. */
export type MemoryProfileValue = string | number | boolean;
export type MemoryProfile = Readonly<Record<string, MemoryProfileValue>>;

export interface MemoryRecord {
  schemaVersion: typeof MEMORY_RECORD_VERSION;
  memoryId: string;
  userId: string;
  kind: MemoryKind;
  source: MemorySource;
  scope: MemoryScope;
  /** Optional structured filters; absent fields remain unknown, never guessed. */
  scopeContext?: MemoryScopeContext;
  logicalKey: string;
  status: MemoryStatus;
  /** True when this record can be supplied to a cross-Demo teaching brief. */
  active: boolean;
  revision: number;
  content?: string;
  summary?: string;
  thread?: LearningThread;
  claims: readonly UserClaim[];
  verdict?: CoachVerdict;
  transferRule?: TransferRule;
  preference?: MemoryPreference;
  profile?: MemoryProfile;
  facts: readonly MemoryFactRef[];
  inferences: readonly MemoryInference[];
  advice: readonly MemoryAdvice[];
  evidence: readonly MemorySourceRef[];
  /** Evidence that contradicts the current projection; never treated as a Demo fact. */
  counterEvidenceRefs?: readonly MemorySourceRef[];
  sourceRefs: readonly MemorySourceRef[];
  demoContentHashes: readonly string[];
  corrections: readonly MemoryCorrection[];
  /** Bounded lifecycle counters, updated only by idempotent events. */
  occurrenceCount?: number;
  successfulApplicationCount?: number;
  conflictingApplicationCount?: number;
  previousRevisionId?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  deletedAt?: string;
  tombstone?: {
    deletedBy: "USER" | "SYSTEM";
    reason?: string;
  };
  limitations: readonly string[];
  producerVersion: string;
  lastIdempotencyKey: string;
}

export interface MemoryOrigin {
  sessionId: string;
  demoContentHash: string;
  cueId: string;
  caseId?: string;
  sourceThreadId?: string;
  typedSourceRefs: readonly MemorySourceRef[];
}

export interface MemoryProposal {
  schemaVersion: typeof MEMORY_PROPOSAL_VERSION;
  proposalId: string;
  userId: string;
  operation: MemoryOperation;
  eventType?: MemoryEventType;
  targetMemoryId?: string;
  requestedScope: "CROSS_DEMO";
  kind: MemoryKind;
  logicalKey: string;
  thread?: LearningThread;
  claims: readonly UserClaim[];
  verdict?: CoachVerdict;
  transferRule?: TransferRule;
  preference?: MemoryPreference;
  profile?: MemoryProfile;
  origin: MemoryOrigin;
  /** Host-issued structural proof that the cue's outcome window is closed. */
  outcomeGateStatus?: "COMPLETE";
  lifecycle: MemoryStatus;
  consentState: MemoryConsentState;
  producerVersion: string;
  idempotencyKey: string;
  createdAt: string;
  content?: string;
  correction?: {
    correctionId: string;
    content: string;
    source: "USER";
  };
  /** Optional deterministic result for a later transfer-rule application. */
  applicationOutcome?: "SUCCESS" | "CONFLICT";
  deleteReason?: string;
}

export interface MemoryEvent {
  schemaVersion: typeof MEMORY_EVENT_VERSION;
  eventId: string;
  /** `type` is canonical; `eventType` is an accepted compatibility alias. */
  type?: MemoryEventType;
  eventType?: MemoryEventType;
  userId: string;
  sessionId: string;
  demoContentHash?: string;
  proposalId?: string;
  targetMemoryId?: string;
  operation?: MemoryOperation;
  idempotencyKey: string;
  producerVersion: string;
  payload?: unknown;
  payloadRef?: MemorySourceRef;
  attemptCount?: number;
  nextAttemptAt?: string;
  createdAt: string;
}

export interface MemoryWriteDecision {
  accepted: boolean;
  action: "NOOP" | MemoryOperation | "PROMOTE";
  reason:
    | "ACCEPTED"
    | "CANDIDATE_ONLY"
    | "DUPLICATE_IDEMPOTENCY"
    | "DUPLICATE_SOURCE"
    | "DELETED_TOMBSTONE"
    | "USER_CORRECTION_PRECEDENCE"
    | "INVALID_SCOPE"
    | "USER_MISMATCH"
    | "CONSENT_REQUIRED"
    | "INVALID_PROPOSAL"
    | "REPOSITORY_ERROR";
  proposalId: string;
  userId: string;
  logicalKey: string;
  idempotencyKey: string;
  targetMemoryId?: string;
  status?: MemoryStatus;
  revision?: number;
  /** The validated proposal is kept for typed SQL adapters and audit/outbox. */
  proposal: MemoryProposal;
  /** Reducer output; adapters may persist this projection atomically. */
  record?: MemoryRecord;
}

export interface MemoryQuery {
  kind?: MemoryKind | readonly MemoryKind[];
  status?: MemoryStatus | readonly MemoryStatus[];
  logicalKey?: string;
  includeDeleted?: boolean;
  activeOnly?: boolean;
  limit?: number;
  cursor?: string;
  taxonomyCode?: string;
  mapName?: string;
  side?: "T" | "CT";
  roleCode?: string;
  hingeCode?: string;
  userGoal?: string;
  since?: string;
  minConfidence?: number;
}

export interface SemanticMemoryQuery extends MemoryQuery {
  text: string;
  embedding?: readonly number[];
  minScore?: number;
}

export interface LearningThreadQuery extends MemoryQuery {
  hingeCode?: string;
  diagnosisType?: LearningThread["diagnosis"]["type"];
  includeCandidates?: boolean;
}

export interface UserMemoryBrief {
  schemaVersion: typeof MEMORY_BRIEF_VERSION;
  generatedAt: string;
  /** Explicit teaching preferences are a small, non-identifying projection. */
  preferences?: Readonly<Record<string, string | number | boolean>>;
  activeThreads: readonly LearningThread[];
  memories: readonly MemoryRecord[];
  corrections: readonly MemoryCorrection[];
  limitations: readonly string[];
  source: "STRUCTURED" | "STRUCTURED_PLUS_SEMANTIC" | "EMPTY";
  structuredStatus?: "AVAILABLE" | "UNAVAILABLE" | "EMPTY";
  semanticStatus?: "OPTIONAL" | "UNAVAILABLE" | "USED";
}

export interface MemoryAuthorization {
  schemaVersion?: typeof MEMORY_AUTHORIZATION_VERSION;
  userId: string;
  memoryEnabled: boolean;
  consent: MemoryConsentState;
  /** Compatibility alias accepted at runtime; memoryEnabled remains canonical. */
  featureFlag?: boolean;
  consentGranted?: boolean;
  consentVersion?: number;
  updatedAt?: string;
}

export interface MemoryConfirmation {
  confirmationId?: string;
  source?: "USER";
  content?: string;
  confirmedAt?: string;
}

export interface MemoryCorrectionInput {
  correctionId?: string;
  content: string;
  source?: "USER";
  refs?: readonly MemorySourceRef[];
  correctedBy?: string;
}

export interface MemoryDeleteInput {
  reason?: string;
  deletedAt?: string;
}

export interface MemoryIngestResult {
  accepted: boolean;
  decision: MemoryWriteDecision;
  record?: MemoryRecord;
  errorCode?: "INVALID_EVENT" | "USER_MISMATCH" | "MEMORY_DISABLED" | "REPOSITORY_ERROR";
}

/** Narrow input used by the proposal builder; raw cue facts are intentionally absent. */
export interface MemoryProposalBuildInput {
  userId: string;
  sessionId: string;
  demoContentHash: string;
  cueCase: CueCase;
  learningThread: LearningThread;
  /** Only a completed OutcomeCompletionGate may produce a durable proposal. */
  outcomeGateStatus: "COMPLETE";
  /** Bounded provenance pointers supplied by the completed cue packet.  The
   * builder stores references only; it never persists raw facts or ticks. */
  provenanceRefs?: readonly {
    namespace: MemorySourceNamespace;
    refId: string;
    label?: string;
  }[];
  producerVersion?: string;
  createdAt?: string;
}
