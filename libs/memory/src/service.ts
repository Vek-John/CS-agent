import {
  MEMORY_EVENT_VERSION,
  MEMORY_PROPOSAL_VERSION,
  type MemoryAuthorization,
  type MemoryEvent,
  type MemoryEventType,
  type MemoryIngestResult,
  type MemoryPreference,
  type MemoryProfile,
  type MemoryProposal,
  type MemoryRecord,
  type MemoryWriteDecision,
  type MemoryQuery,
  type MemoryCorrectionInput,
  type MemoryDeleteInput,
  type MemoryConfirmation,
} from "./domain";
import type {
  CacheProvider,
  EmbeddingProvider,
  MemoryAuthorizationStore,
  MemoryEmbeddingWrite,
  MemoryRepository,
} from "./ports";
import { NoopCacheProvider } from "./ports";
import { buildUserMemoryBrief } from "./brief";
import { MemoryReducer } from "./reducer";
import { MemoryWritePolicy } from "./policy";
import { stableMemoryToken } from "./proposal";
import {
  MemoryAuthorizationSchema,
  MemoryBriefSchema,
  MemoryConfirmationSchema,
  MemoryCorrectionInputSchema,
  MemoryDeleteInputSchema,
  MemoryCompletionMetadataSchema,
  MemoryEventSchema,
  MemoryPreferenceSchema,
  MemoryProfileSchema,
  MemoryProposalSchema,
  isManagementOperation,
  isManagementEventType,
  operationMatchesEventType,
  type ParsedMemoryEvent,
} from "./schemas";

export interface MemoryServiceOptions {
  repository: MemoryRepository;
  cache?: CacheProvider;
  embedding?: EmbeddingProvider;
  /** Defaults to false, matching ADR-0006's opt-in feature flag. */
  memoryEnabled?: boolean;
  featureFlag?: boolean;
  authorization?: MemoryAuthorization;
  authorizationStore?: MemoryAuthorizationStore;
  policy?: MemoryWritePolicy;
  reducer?: MemoryReducer;
  now?: () => string;
  /** Optional bounded diagnostic sink; payloads never contain memory text. */
  onDiagnostic?: (diagnostic: MemoryDiagnostic) => void;
  /** Host seam for invalidating per-session Durable Object outboxes after a
   * memory deletion. It receives IDs/provenance only, never memory content. */
  onMemoryDeleted?: (notice: {
    userId: string;
    /** `*` denotes a user-wide deletion broadcast. */
    memoryId: string;
    logicalKey: string;
    sessionIds: readonly string[];
  }) => Promise<void> | void;
  /** Maximum time spent deriving one optional vector before falling back. */
  embeddingTimeoutMs?: number;
}

export type MemoryServiceOverrides = Omit<MemoryServiceOptions, "repository">;

export interface MemoryBriefOptions {
  semanticText?: string;
  query?: MemoryQuery;
}

export const MEMORY_PREFERENCE_VALUES = {
  explanationDepth: ["BRIEF", "NORMAL", "DEEP"],
  preferredEvidence: ["MAP", "REPLAY", "TIMELINE", "NUMBERS"],
  reflectionFrequency: ["LOW", "NORMAL", "HIGH_AMBIGUITY_ONLY"],
} as const;

export type MemoryPreferenceKey = keyof typeof MEMORY_PREFERENCE_VALUES;
export type MemoryPreferenceValue = (typeof MEMORY_PREFERENCE_VALUES)[MemoryPreferenceKey][number];

export interface MemoryPreferenceInput {
  key: MemoryPreferenceKey;
  value: MemoryPreferenceValue;
  label?: string;
}

export interface MemoryDiagnostic {
  type:
    | "EMBEDDING_FAILED"
    | "SEMANTIC_RECALL_FALLBACK"
    | "MEMORY_EVENT_ACCEPTED"
    | "MEMORY_EVENT_IGNORED"
    | "MEMORY_EVENT_RETRIED"
    | "MEMORY_WRITE_DECISION"
    | "MEMORY_BRIEF_LOADED"
    | "MEMORY_USER_CONFIRMED"
    | "MEMORY_USER_CORRECTED"
    | "MEMORY_USER_DELETED";
  userId: string;
  memoryId?: string;
  eventId?: string;
  operation?: MemoryEvent["operation"];
  action?: MemoryWriteDecision["action"];
  accepted?: boolean;
  status?: MemoryRecord["status"];
  source?: "STRUCTURED" | "STRUCTURED_PLUS_SEMANTIC" | "EMPTY";
  reason?: string;
}

interface AuthorizationSnapshot {
  readonly consentVersion: number;
  readonly generation: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCodeFor(error: unknown): string {
  const candidate = error instanceof Error ? error.message : isRecord(error) && typeof error.code === "string" ? error.code : "REPOSITORY_ERROR";
  return /^[A-Z0-9_.:-]{1,80}$/u.test(candidate) ? candidate : "REPOSITORY_ERROR";
}

/**
 * Canonical JSON is used only to compare a repository's idempotent append
 * result with the event the service attempted to write.  Property ordering is
 * not semantic, while a changed payload/identity under an existing event ID or
 * idempotency key is a real conflict and must never be projected as a second
 * revision.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function normalizeProposalTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeProposalTimestamps);
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // `createdAt` inside a versioned proposal is producer-time metadata. The
    // proposal's immutable identity and payload fields still participate in
    // the comparison, while a rebuilt local event may legitimately be made
    // a few milliseconds later on retry.
    if (key === "createdAt" && value.schemaVersion === MEMORY_PROPOSAL_VERSION) continue;
    next[key] = key === "proposal" ? normalizeProposalTimestamps(child) : child;
  }
  return next;
}

function eventEquivalent(left: MemoryEvent, right: MemoryEvent): boolean {
  // attemptCount/nextAttemptAt are consumer retry metadata, not the event's
  // immutable identity or payload. Ignore those fields when an adapter returns
  // its canonical row; every other field remains part of the conflict check.
  const comparable = (event: MemoryEvent): Omit<MemoryEvent, "attemptCount" | "nextAttemptAt" | "createdAt"> => {
    // A retrying caller may rebuild the same idempotent envelope at a new
    // wall-clock instant.  `createdAt` is useful event telemetry, but it is
    // not payload/identity content and must not turn a harmless replay into
    // a second revision.  Event IDs, idempotency keys, operation, target and
    // the complete payload remain part of the conflict check.
    const { attemptCount: _attemptCount, nextAttemptAt: _nextAttemptAt, createdAt: _createdAt, ...rest } = event;
    void _attemptCount;
    void _nextAttemptAt;
    void _createdAt;
    return { ...rest, payload: normalizeProposalTimestamps(rest.payload) } as Omit<MemoryEvent, "attemptCount" | "nextAttemptAt" | "createdAt">;
  };
  return stableJson(comparable(left)) === stableJson(comparable(right));
}

function eventIdempotencyConflict(): Error {
  return Object.assign(new Error("MEMORY_EVENT_IDEMPOTENCY_CONFLICT"), {
    code: "MEMORY_EVENT_IDEMPOTENCY_CONFLICT",
  });
}

function isEventIdempotencyConflict(error: unknown): boolean {
  return isRecord(error) && error.code === "MEMORY_EVENT_IDEMPOTENCY_CONFLICT";
}

function eventType(event: MemoryEvent): MemoryEventType {
  return (event.type ?? event.eventType) as MemoryEventType;
}

function sessionCompletionMetadata(event: ParsedMemoryEvent): boolean {
  return event.type === "SESSION_COMPLETED" || event.eventType === "SESSION_COMPLETED"
    ? event.operation === undefined &&
        event.proposalId === undefined &&
        event.targetMemoryId === undefined &&
        event.payloadRef === undefined &&
        MemoryCompletionMetadataSchema.safeParse(event.payload).success
    : true;
}

function payloadProposal(payload: unknown): MemoryProposal | undefined {
  if (!isRecord(payload)) return undefined;
  const candidate = "proposal" in payload ? payload.proposal : payload;
  const parsed = MemoryProposalSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as unknown as MemoryProposal) : undefined;
}

function firstPreference(payload: unknown): MemoryPreference | undefined {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.preference)) return payload.preference as unknown as MemoryPreference;
  if (typeof payload.key !== "string" || (typeof payload.value !== "string" && typeof payload.value !== "number" && typeof payload.value !== "boolean")) return undefined;
  const refs = Array.isArray(payload.refs) ? (payload.refs as MemoryPreference["refs"]) : [];
  return {
    key: payload.key,
    value: payload.value,
    source: payload.source === "USER" ? "USER" : "USER_EXPLICIT",
    ...(typeof payload.label === "string" ? { label: payload.label } : {}),
    refs,
  };
}

function rejectedDecision(
  userId: string,
  proposal: MemoryProposal | undefined,
  reason: MemoryWriteDecision["reason"],
): MemoryWriteDecision {
  const fallback: MemoryProposal = proposal ?? {
    schemaVersion: MEMORY_PROPOSAL_VERSION,
    proposalId: "invalid-proposal",
    userId,
    operation: "CREATE",
    requestedScope: "CROSS_DEMO",
    kind: "LEARNING_THREAD",
    logicalKey: "invalid-proposal",
    claims: [],
    origin: {
      sessionId: "invalid-event",
      demoContentHash: "invalid-event",
      cueId: "invalid-event",
      typedSourceRefs: [
        {
          namespace: "SESSION",
          refId: "invalid-event",
          demoContentHash: "invalid-event",
          sessionId: "invalid-event",
          cueId: "invalid-event",
        },
      ],
    },
    lifecycle: "CANDIDATE",
    consentState: "UNKNOWN",
    producerVersion: "memory-domain.v1",
    idempotencyKey: "invalid-event",
    createdAt: "1970-01-01T00:00:00.000Z",
  };
  return {
    accepted: false,
    action: "NOOP",
    reason,
    proposalId: fallback.proposalId,
    userId,
    logicalKey: fallback.logicalKey,
    idempotencyKey: fallback.idempotencyKey,
    proposal: fallback,
  };
}

function directDecision(
  userId: string,
  event: ParsedMemoryEvent,
  action: MemoryWriteDecision["action"],
  record: MemoryRecord | undefined,
): MemoryWriteDecision {
  const base = rejectedDecision(userId, undefined, record ? "ACCEPTED" : "INVALID_PROPOSAL");
  return {
    ...base,
    accepted: Boolean(record),
    action: record ? action : "NOOP",
    proposalId: event.proposalId ?? event.eventId,
    userId,
    logicalKey: record?.logicalKey ?? base.logicalKey,
    idempotencyKey: event.idempotencyKey,
    targetMemoryId: record?.memoryId ?? event.targetMemoryId,
    status: record?.status,
    revision: record?.revision,
  };
}

function emptyBrief(reason?: string) {
  return buildUserMemoryBrief({
    records: [],
    threads: [],
    generatedAt: new Date().toISOString(),
    limitations: reason ? [reason] : [],
    structuredStatus: "EMPTY",
    semanticStatus: "OPTIONAL",
  });
}

function parsePreferenceInput(input: unknown): MemoryPreferenceInput | undefined {
  if (!isRecord(input) || typeof input.key !== "string" || typeof input.value !== "string") return undefined;
  const key = input.key as MemoryPreferenceKey;
  const allowed = MEMORY_PREFERENCE_VALUES[key];
  if (!allowed || !allowed.includes(input.value as never)) return undefined;
  if (input.label !== undefined && typeof input.label !== "string") return undefined;
  const label = typeof input.label === "string" ? input.label : undefined;
  const ref = {
    namespace: "USER_PREFERENCE" as const,
    refId: `preference-${key}`,
    demoContentHash: "memory-preferences",
    sessionId: "memory-preferences",
    cueId: "preference",
    label: "user preference",
  };
  const parsed = MemoryPreferenceSchema.safeParse({ key, value: input.value, source: "USER_EXPLICIT", ...(label ? { label } : {}), refs: [ref] });
  if (!parsed.success) return undefined;
  // Use the schema-normalized value rather than the raw request value. This
  // keeps direct service callers subject to the same trimming/bounds as the
  // HTTP route, while the allow-list above still constrains the three
  // supported preference dimensions.
  return {
    key: parsed.data.key as MemoryPreferenceKey,
    value: parsed.data.value as MemoryPreferenceValue,
    ...(parsed.data.label ? { label: parsed.data.label } : {}),
  };
}

const PROFILE_LOGICAL_KEY_PREFIX = "profile-";

function profileLogicalKey(userId: string): string {
  return `${PROFILE_LOGICAL_KEY_PREFIX}${stableMemoryToken(userId)}`;
}

function parseProfileInput(input: unknown): MemoryProfile | undefined {
  const candidate = isRecord(input) && "profile" in input
    ? Object.keys(input).length === 1 ? input.profile : undefined
    : input;
  const parsed = MemoryProfileSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return Object.fromEntries(Object.entries(parsed.data).sort(([left], [right]) => left.localeCompare(right))) as MemoryProfile;
}

function profileFromPayload(payload: unknown): MemoryProfile | undefined {
  if (!isRecord(payload) || !("profile" in payload)) return undefined;
  const parsed = MemoryProfileSchema.safeParse(payload.profile);
  return parsed.success ? parsed.data as MemoryProfile : undefined;
}

function managementEvent(
  userId: string,
  type: "USER_CONFIRMED" | "USER_CORRECTED_COACH" | "MEMORY_DELETED",
  memoryId: string,
  input: MemoryConfirmation | MemoryCorrectionInput | MemoryDeleteInput | undefined,
  createdAt: string,
): MemoryEvent {
  const correction = type === "USER_CORRECTED_COACH" ? input as MemoryCorrectionInput | undefined : undefined;
  const payload = type === "USER_CONFIRMED"
    ? { memoryId }
    : type === "MEMORY_DELETED"
      ? { memoryId, ...((input as MemoryDeleteInput | undefined)?.reason ? { reason: (input as MemoryDeleteInput).reason } : {}) }
      : {
          memoryId,
          correction: {
            correctionId: correction?.correctionId ?? `correction-${stableMemoryToken(`${memoryId}|${correction?.content ?? "user correction"}`)}`,
            content: correction?.content ?? "user correction",
            source: "USER" as const,
          },
        };
  const idempotencyKey = `memory-management-${stableMemoryToken(JSON.stringify({ userId, type, memoryId, payload }))}`;
  return MemoryEventSchema.parse({
    schemaVersion: MEMORY_EVENT_VERSION,
    eventId: `memory-management-event-${stableMemoryToken(idempotencyKey)}`,
    type,
    eventType: type,
    userId,
    sessionId: "memory-management",
    targetMemoryId: memoryId,
    operation: type === "USER_CONFIRMED" ? "CONFIRM" : type === "USER_CORRECTED_COACH" ? "CORRECT" : "DELETE",
    idempotencyKey,
    producerVersion: "memory-management.v1",
    payload,
    createdAt,
  }) as unknown as MemoryEvent;
}

function controlProposal(event: ParsedMemoryEvent, type: MemoryEventType): MemoryProposal | undefined {
  const payload = event.payload;
  const parsed = payloadProposal(payload);
  if (parsed) return parsed;
  const preference = firstPreference(payload);
  const profile = profileFromPayload(payload);
  const control = isRecord(payload) ? payload : {};
  const sourceRefs = preference?.refs ?? [];
  if (type === "USER_PREFERENCE_STATED" && preference) {
    const ref = sourceRefs[0] ?? {
      namespace: "USER_PREFERENCE" as const,
      refId: preference.key,
      demoContentHash: event.demoContentHash ?? "preference",
      sessionId: event.sessionId,
      cueId: "preference",
    };
    return {
      schemaVersion: MEMORY_PROPOSAL_VERSION,
      proposalId: event.proposalId ?? `preference-${event.eventId}`,
      userId: event.userId,
      operation: "CREATE",
      eventType: type,
      requestedScope: "CROSS_DEMO",
      kind: "PREFERENCE",
      logicalKey: `preference:${preference.key}`,
      claims: [],
      preference,
      origin: {
        sessionId: event.sessionId,
        demoContentHash: event.demoContentHash ?? ref.demoContentHash,
        cueId: ref.cueId,
        typedSourceRefs: sourceRefs.length ? sourceRefs : [ref],
      },
      lifecycle: "STABLE",
      consentState: "GRANTED",
      producerVersion: event.producerVersion,
      idempotencyKey: event.idempotencyKey,
      createdAt: event.createdAt,
    };
  }
  if (type === "USER_PROFILE_STATED" && profile) {
    const profileToken = stableMemoryToken(JSON.stringify(Object.entries(profile).sort(([left], [right]) => left.localeCompare(right))));
    const ref = sourceRefs[0] ?? {
      namespace: "USER_PROFILE" as const,
      refId: `profile-${profileToken}`,
      demoContentHash: event.demoContentHash ?? "user-profile",
      sessionId: event.sessionId,
      cueId: "profile",
    };
    return {
      schemaVersion: MEMORY_PROPOSAL_VERSION,
      proposalId: event.proposalId ?? `profile-proposal-${profileToken}`,
      userId: event.userId,
      operation: "CREATE",
      eventType: type,
      requestedScope: "CROSS_DEMO",
      kind: "PROFILE",
      logicalKey: profileLogicalKey(event.userId),
      claims: [],
      profile,
      origin: {
        sessionId: event.sessionId,
        demoContentHash: event.demoContentHash ?? ref.demoContentHash,
        cueId: ref.cueId,
        typedSourceRefs: sourceRefs.length ? sourceRefs : [ref],
      },
      lifecycle: "CONFIRMED",
      consentState: "GRANTED",
      producerVersion: event.producerVersion,
      idempotencyKey: event.idempotencyKey,
      createdAt: event.createdAt,
    };
  }
  if (type === "SESSION_COMPLETED") return undefined;
  return undefined;
}

function controlMemoryId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.memoryId === "string") return payload.memoryId;
  if (typeof payload.targetMemoryId === "string") return payload.targetMemoryId;
  if (isRecord(payload.proposal)) return controlMemoryId(payload.proposal);
  return undefined;
}

function controlCorrection(payload: unknown): MemoryCorrectionInput | undefined {
  if (!isRecord(payload)) return undefined;
  const correction = isRecord(payload.correction) ? payload.correction : payload;
  if (typeof correction.content !== "string") return undefined;
  return {
    content: correction.content,
    ...(typeof correction.correctionId === "string" ? { correctionId: correction.correctionId } : {}),
    source: "USER",
  };
}

function hasCompletedCueProof(proposal: MemoryProposal, type: MemoryEventType): boolean {
  // Management proposals must take the target-checked direct path. Treating
  // CORRECT/CONFIRM/DELETE as automatically proven here would let a cast or a
  // future control-payload branch turn them into cue writes.
  if (isManagementOperation(proposal.operation)) return false;
  if (!["CREATE", "UPDATE"].includes(proposal.operation)) return false;
  if (type === "USER_PREFERENCE_STATED" && proposal.preference &&
    (proposal.preference.source === "USER" || proposal.preference.source === "USER_EXPLICIT")) return true;
  if (type === "USER_PROFILE_STATED" && proposal.kind === "PROFILE" && proposal.profile) return true;
  if (!["CUE_DIAGNOSED", "TRANSFER_RULE_TAUGHT", "TRANSFER_RULE_APPLIED"].includes(type)) return false;
  return proposal.eventType === type &&
    proposal.outcomeGateStatus === "COMPLETE" &&
    Boolean(proposal.verdict && proposal.transferRule &&
      proposal.origin.caseId && proposal.origin.sourceThreadId &&
      proposal.origin.typedSourceRefs.length > 0);
}

/**
 * Application service for authorization, bounded proposal ingestion and
 * graceful fallback.  It intentionally has no database-specific behavior.
 */
export class MemoryService {
  private readonly repository: MemoryRepository;
  private readonly cache: CacheProvider;
  private readonly embedding?: EmbeddingProvider;
  private readonly featureEnabled: boolean;
  private readonly authorizations = new Map<string, MemoryAuthorization>();
  private readonly authorizationStore?: MemoryAuthorizationStore;
  private readonly policy: MemoryWritePolicy;
  private readonly reducer: MemoryReducer;
  private readonly clock: () => string;
  private readonly onDiagnostic?: (diagnostic: MemoryDiagnostic) => void;
  private readonly onMemoryDeleted?: MemoryServiceOptions["onMemoryDeleted"];
  private readonly embeddingTimeoutMs: number;
  private readonly briefCacheKeys = new Map<string, Set<string>>();
  private readonly briefGenerations = new Map<string, number>();

  constructor(options: MemoryServiceOptions);
  constructor(repository: MemoryRepository, overrides?: MemoryServiceOverrides);
  constructor(optionsOrRepository: MemoryServiceOptions | MemoryRepository, overrides?: MemoryServiceOverrides) {
    const options: MemoryServiceOptions = "repository" in optionsOrRepository
      ? optionsOrRepository
      : { repository: optionsOrRepository, ...(overrides ?? {}) };
    this.repository = options.repository;
    this.cache = options.cache ?? new NoopCacheProvider();
    this.embedding = options.embedding;
    this.featureEnabled = options.memoryEnabled ?? options.featureFlag ?? false;
    this.authorizationStore = options.authorizationStore;
    this.policy = options.policy ?? new MemoryWritePolicy();
    this.reducer = options.reducer ?? new MemoryReducer();
    this.clock = options.now ?? nowIso;
    this.onDiagnostic = options.onDiagnostic;
    this.onMemoryDeleted = options.onMemoryDeleted;
    this.embeddingTimeoutMs = Number.isFinite(options.embeddingTimeoutMs)
      ? Math.max(1, Math.min(10_000, Math.floor(options.embeddingTimeoutMs as number)))
      : 1_000;
    if (options.authorization) this.authorizations.set(options.authorization.userId, options.authorization);
  }

  private diagnostic(value: MemoryDiagnostic): void {
    try {
      this.onDiagnostic?.(value);
    } catch {
      // Diagnostics are strictly observational and can never affect writes.
    }
  }

  private async markConsumed(userId: string, event: Pick<MemoryEvent, "eventId">): Promise<void> {
    try {
      await this.repository.markEventConsumed?.(userId, event.eventId, this.clock());
    } catch {
      // Projection truth is already committed; a status telemetry failure is
      // safe to retry and must not turn a successful coaching request into a
      // repository error.
      this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, reason: "EVENT_STATUS_UPDATE_FAILED" });
    }
  }

  private async markFailed(userId: string, event: Pick<MemoryEvent, "eventId">, errorCode = "REPOSITORY_ERROR"): Promise<void> {
    try {
      await this.repository.markEventFailed?.(userId, event.eventId, {
        terminal: false,
        errorCode: /^[A-Z0-9_.:-]{1,80}$/u.test(errorCode) ? errorCode : "REPOSITORY_ERROR",
        nextAttemptAt: new Date(Date.parse(this.clock()) + 1_000).toISOString(),
      });
      this.diagnostic({ type: "MEMORY_EVENT_RETRIED", userId, eventId: event.eventId, reason: errorCode });
    } catch {
      this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, reason: "EVENT_FAILURE_STATUS_UPDATE_FAILED" });
    }
  }

  /**
   * Repository adapters may return the already-posted canonical event when a
   * unique event/idempotency key collides.  Accept an equivalent replay, but
   * reject a caller that tries to reuse either key with a different payload;
   * otherwise the service could apply the new payload after the adapter had
   * correctly deduplicated it.
   */
  private async appendCanonicalEvent(userId: string, event: MemoryEvent): Promise<MemoryEvent> {
    const appended = await this.repository.appendEvent(userId, event);
    if (appended === undefined) return event;
    const parsed = MemoryEventSchema.safeParse(appended);
    if (!parsed.success || parsed.data.userId !== userId || !eventEquivalent(event, parsed.data as unknown as MemoryEvent)) {
      throw eventIdempotencyConflict();
    }
    return parsed.data as unknown as MemoryEvent;
  }

  private async removeEmbedding(userId: string, record: MemoryRecord | undefined, memoryId: string): Promise<void> {
    if (!record || record.status !== "DELETED" || !this.repository.deleteMemoryEmbedding) return;
    try {
      await this.repository.deleteMemoryEmbedding(userId, memoryId, record.deletedAt);
    } catch {
      this.diagnostic({ type: "EMBEDDING_FAILED", userId, memoryId, reason: "EMBEDDING_DELETE_FAILED" });
    }
  }

  private async notifyMemoryDeleted(
    userId: string,
    record: MemoryRecord | undefined,
    memoryId: string,
    deletionSourceRefs: readonly unknown[] = record?.sourceRefs ?? [],
  ): Promise<void> {
    if (!record || record.status !== "DELETED") return;
    let sessionIds: readonly string[] = [];
    try {
      sessionIds = await this.repository.invalidatePendingMemory?.(userId, memoryId, record.logicalKey) ?? [];
    } catch {
      this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, memoryId, reason: "OUTBOX_INVALIDATION_FAILED" });
      throw new Error("OUTBOX_INVALIDATION_FAILED");
    }
    // A first invalidation may have already redacted the PostgreSQL event row
    // before the host fan-out failed.  On a retry, matching by target/logical
    // key alone would then return no session IDs.  Include the bounded,
    // user-scoped session registry as a retry-safe fallback so a tombstone can
    // repair a partially delivered fan-out without exposing memory content.
    try {
      const knownSessions = await this.repository.listMemorySessionIds?.(userId) ?? [];
      const isCoachSession = (sessionId: unknown): sessionId is string =>
        typeof sessionId === "string" && sessionId.length > 0 &&
        sessionId !== "memory-management" && sessionId !== "memory-preferences";
      sessionIds = [...new Set([
        ...sessionIds.filter(isCoachSession),
        ...knownSessions.filter(isCoachSession),
      ])];
    } catch {
      this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, memoryId, reason: "OUTBOX_SESSION_ENUMERATION_FAILED" });
      throw new Error("OUTBOX_SESSION_ENUMERATION_FAILED");
    }
    try {
      await this.repository.purgeMemoryResidue?.(userId, memoryId, record.logicalKey, deletionSourceRefs);
    } catch {
      this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, memoryId, reason: "MEMORY_RESIDUE_PURGE_FAILED" });
      throw new Error("MEMORY_RESIDUE_PURGE_FAILED");
    }
    try {
      await this.onMemoryDeleted?.({ userId, memoryId, logicalKey: record.logicalKey, sessionIds });
    } catch {
      // A host notification failure cannot undo the committed tombstone, but
      // reporting success would hide an un-invalidated DO outbox. Return a
      // retryable failure while the durable tombstone remains in place.
      this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, memoryId, reason: "OUTBOX_HOST_INVALIDATION_FAILED" });
      throw new Error("OUTBOX_HOST_INVALIDATION_FAILED");
    }
  }

  /** Complete the user-wide privacy cleanup and broadcast it to known DOs. */
  async purgeUserMemoryResidue(userId: string): Promise<readonly string[]> {
    // A user-wide erase also closes the memory write channel. This global
    // REVOKED state is what stops a DO whose event has not reached PostgreSQL
    // yet; the user may explicitly opt in again after the erase completes.
    const currentAuthorization = await this.loadAuthorization(userId);
    if (currentAuthorization?.consent === "GRANTED") {
      const revoked: MemoryAuthorization = {
        ...currentAuthorization,
        consent: "REVOKED",
        consentVersion: (currentAuthorization.consentVersion ?? 0) + 1,
        updatedAt: this.clock(),
      };
      try {
        if (this.authorizationStore) await this.authorizationStore.setAuthorization(userId, revoked);
        this.authorizations.set(userId, revoked);
        await this.invalidateBriefCache(userId);
      } catch {
        this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, reason: "AUTHORIZATION_REVOKE_FAILED" });
        // Do not report a successful user-wide erase while an unmaterialized
        // DO event could still observe GRANTED and recreate a record.
        throw new Error("AUTHORIZATION_REVOKE_FAILED");
      }
    }
    const sessionIds = await this.repository.purgeUserMemoryResidue?.(userId) ?? [];
    try {
      await this.invalidateBriefCache(userId);
    } catch {
      // Cache is never authoritative, but a stale key must not turn a purge
      // failure into a user-visible write error.
    }
    try {
      await this.onMemoryDeleted?.({ userId, memoryId: "*", logicalKey: "*", sessionIds });
    } catch {
      this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, reason: "OUTBOX_HOST_INVALIDATION_FAILED" });
      throw new Error("OUTBOX_HOST_INVALIDATION_FAILED");
    }
    return sessionIds;
  }

  private async authorizationSnapshot(userId: string): Promise<AuthorizationSnapshot | undefined> {
    const authorization = await this.loadAuthorization(userId);
    if (!this.authorizationIsGranted(userId, authorization)) return undefined;
    return {
      consentVersion: authorization?.consentVersion ?? 0,
      generation: this.briefGeneration(userId),
    };
  }

  private async authorizationSnapshotStillGranted(userId: string, snapshot: AuthorizationSnapshot): Promise<boolean> {
    const authorization = await this.loadAuthorization(userId);
    return this.authorizationIsGranted(userId, authorization) &&
      (authorization?.consentVersion ?? 0) === snapshot.consentVersion &&
      this.briefGeneration(userId) === snapshot.generation;
  }

  private async indexRecord(userId: string, record: MemoryRecord, expectedSnapshot?: AuthorizationSnapshot): Promise<void> {
    const saveEmbedding = this.repository.saveEmbedding;
    if (!this.embedding || !saveEmbedding || !record.active || record.status === "DELETED" || record.status === "DISPUTED") return;
    const snapshot = expectedSnapshot ?? await this.authorizationSnapshot(userId);
    if (!snapshot || !(await this.authorizationSnapshotStillGranted(userId, snapshot))) return;
    const text = [
      record.summary,
      record.content,
      record.thread?.diagnosis.summary,
      record.transferRule?.when,
      record.transferRule?.do,
    ].filter((value): value is string => Boolean(value && value.trim())).join(" ").trim();
    if (!text) return;
    try {
      const embedding = await this.embedWithTimeout(text);
      if (!embedding) throw new Error("EMBEDDING_TIMEOUT");
      if (!Array.isArray(embedding) || embedding.length === 0 || embedding.length > 4_096 || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error("EMBEDDING_INVALID");
      }
      const write: MemoryEmbeddingWrite = {
        memoryId: record.memoryId,
        embedding,
        contentHash: this.embedding.contentHash?.(text) ?? `embedding-content-${stableMemoryToken(text)}`,
        model: this.embedding.model ?? "memory-embedding.v1",
        sourceRevision: record.revision,
        createdAt: record.updatedAt,
      };
      // The provider may be slow enough for consent to change while it is in
      // flight. Recheck the same authorization version immediately before the
      // optional write so a revoked or superseded projection never reaches the
      // derived index.
      if (!(await this.authorizationSnapshotStillGranted(userId, snapshot))) return;
      await saveEmbedding.call(this.repository, userId, write);
    } catch (error) {
      const rawReason = error instanceof Error ? error.message : "";
      const reason = /^[A-Z0-9_.:-]{1,80}$/u.test(rawReason) ? rawReason : "EMBEDDING_FAILED";
      this.diagnostic({
        type: "EMBEDDING_FAILED",
        userId,
        memoryId: record.memoryId,
        reason,
      });
    }
  }

  /**
   * Optional embedding providers are never allowed to hold a recall or write
   * path open indefinitely.  Promise.race gives us a bounded decision even
   * for providers that do not expose AbortSignal; a late result is ignored
   * and cannot become memory truth after the timeout.
   */
  private async embedWithTimeout(text: string): Promise<readonly number[] | undefined> {
    if (!this.embedding) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.embedding.embed(text),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.embeddingTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private authorizationFor(userId: string): MemoryAuthorization | undefined {
    return this.authorizations.get(userId);
  }

  private async loadAuthorization(userId: string): Promise<MemoryAuthorization | undefined> {
    let authorization: MemoryAuthorization | undefined;
    if (this.authorizationStore) {
      // Once a durable authorization store is configured, it is the source of
      // truth. Never let a process-local entry keep writes enabled during a
      // database outage or after consent was revoked elsewhere.
      try {
        authorization = await this.authorizationStore.getAuthorization(userId);
        if (authorization) this.authorizations.set(userId, authorization);
      } catch (error) {
        return undefined;
      }
    } else {
      authorization = this.authorizationFor(userId);
    }
    if (!authorization || authorization.userId !== userId) return undefined;
    return authorization;
  }

  private async isAuthorized(userId: string): Promise<boolean> {
    if (!this.featureEnabled) return false;
    const authorization = await this.loadAuthorization(userId);
    return this.authorizationIsGranted(userId, authorization);
  }

  private authorizationIsGranted(userId: string, authorization: MemoryAuthorization | undefined): boolean {
    if (!authorization || authorization.userId !== userId) return false;
    const enabled = authorization.memoryEnabled ?? authorization.featureFlag ?? false;
    return Boolean(enabled && authorization.consent === "GRANTED" && authorization.consentGranted !== false);
  }

  private briefCacheKey(userId: string, authorization: MemoryAuthorization): string {
    // Consent versions make a late cache write from a pre-revoke request
    // unreachable after a re-grant. The authorization check below remains the
    // final guard for cache providers that ignore deletes.
    const key = `memory-brief:v1:${userId}:consent-v${authorization.consentVersion ?? 0}`;
    const keys = this.briefCacheKeys.get(userId) ?? new Set<string>();
    keys.add(key);
    this.briefCacheKeys.set(userId, keys);
    return key;
  }

  private briefGeneration(userId: string): number {
    return this.briefGenerations.get(userId) ?? 0;
  }

  private async invalidateBriefCache(userId: string): Promise<void> {
    this.briefGenerations.set(userId, this.briefGeneration(userId) + 1);
    const keys = new Set([`memory-brief:v1:${userId}`]);
    const authorization = this.authorizationFor(userId);
    if (authorization) keys.add(this.briefCacheKey(userId, authorization));
    for (const key of this.briefCacheKeys.get(userId) ?? []) keys.add(key);
    this.briefCacheKeys.delete(userId);
    await Promise.all([...keys].map((key) => this.cache.delete(key).catch(() => undefined)));
  }

  /**
   * Privacy erasure remains available after consent is revoked. This does not
   * authorize recall, preference writes, proposals or embeddings; it only
   * lets the management route issue tombstones for the same signed principal.
   */
  async canDelete(userId: string): Promise<boolean> {
    const authorization = await this.loadAuthorization(userId);
    if (!authorization) return false;
    const enabled = authorization.memoryEnabled ?? authorization.featureFlag ?? false;
    // A REVOKED principal retains a deletion-only privacy channel even if a
    // deployment later reports the teaching flag disabled or the row's
    // compatibility `memoryEnabled` bit was cleared during shutdown.
    if (!this.featureEnabled && (authorization.consent === "GRANTED" || authorization.consent === "REVOKED")) return true;
    return authorization.consent === "REVOKED" ||
      (Boolean(enabled) && authorization.consent === "GRANTED" && authorization.consentGranted !== false);
  }

  async setAuthorization(userId: string, input: unknown): Promise<MemoryAuthorization | undefined> {
    // The deployment feature flag is a hard zero-side-effect boundary. A
    // direct domain caller must not write a consent row while memory is off.
    if (!this.featureEnabled) return undefined;
    const parsed = MemoryAuthorizationSchema.safeParse(input);
    if (!parsed.success || parsed.data.userId !== userId) return undefined;
    const authorization = parsed.data as unknown as MemoryAuthorization;
    this.authorizations.set(userId, authorization);
    if (this.authorizationStore) {
      try {
        await this.authorizationStore.setAuthorization(userId, authorization);
      } catch (error) {
        // Consent is not effective until the durable authorization row exists;
        // fail closed instead of reporting a local-only opt-in as success.
        this.authorizations.delete(userId);
        // Preserve the conflict signal so an API can tell a stale concurrent
        // consent update from a transient persistence outage.
        if (isRecord(error) && error.code === "MEMORY_AUTHORIZATION_CONFLICT") throw error;
        return undefined;
      }
    }
    if (!(authorization.memoryEnabled ?? authorization.featureFlag ?? false) || authorization.consent !== "GRANTED") {
      try {
        await this.invalidateBriefCache(userId);
      } catch {
        // cache is never authoritative
      }
    }
    if (authorization.consent === "REVOKED") {
      // Consent withdrawal is a live privacy boundary, not merely a
      // PostgreSQL row update. Fan out a wildcard invalidation to every known
      // session DO so cached briefs and pending outboxes are cleared promptly;
      // unknown/temporarily unreachable DOs remain protected by the durable
      // REVOKED authority on their next sink check.
      try {
        const sessionIds = await this.repository.listMemorySessionIds?.(userId) ?? [];
        await this.onMemoryDeleted?.({ userId, memoryId: "*", logicalKey: "*", sessionIds });
      } catch {
        this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, reason: "OUTBOX_HOST_INVALIDATION_FAILED" });
        // Keep the local authorization revoked, but make the API report a
        // retryable failure instead of claiming immediate zero-outbox
        // semantics when the fan-out could not be delivered.
        throw new Error("OUTBOX_HOST_INVALIDATION_FAILED");
      }
    }
    return authorization;
  }

  /** Read only explicit teaching preferences for an authorized principal. */
  async getPreferences(userId: string): Promise<readonly MemoryRecord[]> {
    if (!(await this.isAuthorized(userId))) return [];
    try {
      return await this.repository.getPreferences(userId);
    } catch {
      return [];
    }
  }

  /**
   * Persist a bounded user preference through the same event/policy/reducer
   * path as other memory writes. The deterministic idempotency key makes a
   * repeated same-value update a no-op rather than a new revision.
   */
  async setPreference(userId: string, input: unknown): Promise<MemoryIngestResult> {
    const fallback = rejectedDecision(userId, undefined, "INVALID_PROPOSAL");
    const preferenceInput = parsePreferenceInput(input);
    if (!(await this.isAuthorized(userId))) {
      return { accepted: false, decision: rejectedDecision(userId, undefined, "CONSENT_REQUIRED"), errorCode: "MEMORY_DISABLED" };
    }
    if (!preferenceInput) return { accepted: false, decision: fallback, errorCode: "INVALID_EVENT" };
    const createdAt = this.clock();
    const sourceRef = {
      namespace: "USER_PREFERENCE" as const,
      refId: `preference-${preferenceInput.key}`,
      demoContentHash: "memory-preferences",
      sessionId: "memory-preferences",
      cueId: "preference",
      label: "user preference",
    };
    const idempotencyKey = `memory-preference-${stableMemoryToken(JSON.stringify({ userId, ...preferenceInput }))}`;
    const event = MemoryEventSchema.parse({
      schemaVersion: MEMORY_EVENT_VERSION,
      eventId: `memory-preference-event-${stableMemoryToken(idempotencyKey)}`,
      type: "USER_PREFERENCE_STATED",
      eventType: "USER_PREFERENCE_STATED",
      userId,
      sessionId: "memory-preferences",
      demoContentHash: "memory-preferences",
      proposalId: `memory-preference-proposal-${stableMemoryToken(idempotencyKey)}`,
      operation: "CREATE",
      idempotencyKey,
      producerVersion: "memory-management.v1",
      payload: {
        key: preferenceInput.key,
        value: preferenceInput.value,
        ...(preferenceInput.label ? { label: preferenceInput.label } : {}),
        source: "USER_EXPLICIT",
        refs: [sourceRef],
      },
      createdAt,
    }) as unknown as MemoryEvent;
    return this.ingestEvent(userId, event);
  }

  /** Persist only explicitly supplied, bounded user profile fields. */
  async setProfile(userId: string, input: unknown): Promise<MemoryIngestResult> {
    const profile = parseProfileInput(input);
    if (!(await this.isAuthorized(userId))) {
      return { accepted: false, decision: rejectedDecision(userId, undefined, "CONSENT_REQUIRED"), errorCode: "MEMORY_DISABLED" };
    }
    if (!profile) return { accepted: false, decision: rejectedDecision(userId, undefined, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
    const createdAt = this.clock();
    const profileToken = stableMemoryToken(JSON.stringify(Object.entries(profile)));
    const sourceRef = {
      namespace: "USER_PROFILE" as const,
      refId: `profile-${profileToken}`,
      demoContentHash: "user-profile",
      sessionId: "user-profile",
      cueId: "profile",
      label: "explicit user profile",
    };
    const proposal = MemoryProposalSchema.parse({
      schemaVersion: MEMORY_PROPOSAL_VERSION,
      proposalId: `profile-proposal-${profileToken}`,
      userId,
      operation: "CREATE",
      eventType: "USER_PROFILE_STATED",
      requestedScope: "CROSS_DEMO",
      kind: "PROFILE",
      logicalKey: profileLogicalKey(userId),
      claims: [],
      profile,
      origin: {
        sessionId: "user-profile",
        demoContentHash: "user-profile",
        cueId: "profile",
        typedSourceRefs: [sourceRef],
      },
      lifecycle: "CONFIRMED",
      consentState: "GRANTED",
      producerVersion: "memory-management.v1",
      idempotencyKey: `memory-profile-${profileToken}`,
      createdAt,
    }) as unknown as MemoryProposal;
    const event = MemoryEventSchema.parse({
      schemaVersion: MEMORY_EVENT_VERSION,
      eventId: `memory-profile-event-${profileToken}`,
      type: "USER_PROFILE_STATED",
      eventType: "USER_PROFILE_STATED",
      userId,
      sessionId: "user-profile",
      demoContentHash: "user-profile",
      proposalId: proposal.proposalId,
      operation: "CREATE",
      idempotencyKey: proposal.idempotencyKey,
      producerVersion: proposal.producerVersion,
      payload: proposal,
      createdAt,
    }) as unknown as MemoryEvent;
    return this.ingestEvent(userId, event);
  }

  /** Return explicit profile fields only for the authorized principal. */
  async getProfile(userId: string): Promise<MemoryProfile | undefined> {
    if (!(await this.isAuthorized(userId))) return undefined;
    try {
      const record = await this.repository.findByLogicalKey(userId, profileLogicalKey(userId));
      if (!record || record.kind !== "PROFILE" || record.status === "DELETED" || !record.profile) return undefined;
      return record.profile;
    } catch {
      return undefined;
    }
  }

  async ingestEvent(input: unknown): Promise<MemoryIngestResult>;
  async ingestEvent(userId: string, input: unknown): Promise<MemoryIngestResult>;
  async ingestEvent(userIdOrInput: string | unknown, input?: unknown): Promise<MemoryIngestResult> {
    // The one-argument form is only a compatibility convenience for a
    // process that has exactly one server-established authorization.  We do
    // not trust an arbitrary payload userId to choose among multiple users.
    const implicitUserId = typeof userIdOrInput === "string" ? undefined : [...this.authorizations.keys()][0];
    const userId = typeof userIdOrInput === "string" ? userIdOrInput : implicitUserId ?? "";
    const rawInput = typeof userIdOrInput === "string" ? input : userIdOrInput;
    if (!userId) return { accepted: false, decision: rejectedDecision("", undefined, "USER_MISMATCH"), errorCode: "USER_MISMATCH" };
    let parsed: ParsedMemoryEvent;
    try {
      parsed = MemoryEventSchema.parse(rawInput) as ParsedMemoryEvent;
    } catch {
      return { accepted: false, decision: rejectedDecision(userId, undefined, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
    }
    if (parsed.userId !== userId) {
      return { accepted: false, decision: rejectedDecision(userId, undefined, "USER_MISMATCH"), errorCode: "USER_MISMATCH" };
    }
    const type = eventType(parsed);
    // Keep a second service-layer guard after schema parsing. This protects
    // callers that pass a structurally typed/cast event and keeps completion
    // metadata from becoming an implicit writable proposal in future schema
    // extensions.
    if (!sessionCompletionMetadata(parsed) ||
      (parsed.operation !== undefined && !operationMatchesEventType(parsed.operation, type)) ||
      (isManagementEventType(type) && (!parsed.targetMemoryId || parsed.operation === undefined || !operationMatchesEventType(parsed.operation, type)))) {
      return { accepted: false, decision: rejectedDecision(userId, undefined, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
    }
    // A deletion event is the one consumer/control path that remains valid
    // after consent withdrawal (and while the deployment flag is off). It is
    // still constrained by canDelete, an explicit target and the repository's
    // deletion-only authorization transaction; no recall, proposal or
    // non-delete write is opened by this branch.
    const authorized = type === "MEMORY_DELETED"
      ? await this.canDelete(userId)
      : await this.isAuthorized(userId);
    if (!authorized) {
      const proposal = payloadProposal(parsed.payload);
      return { accepted: false, decision: rejectedDecision(userId, proposal, "CONSENT_REQUIRED"), errorCode: "MEMORY_DISABLED" };
    }
    if (type === "SESSION_COMPLETED") {
      try {
        const canonical = await this.appendCanonicalEvent(userId, parsed as unknown as MemoryEvent);
        await this.markConsumed(userId, canonical);
        this.diagnostic({ type: "MEMORY_EVENT_ACCEPTED", userId });
      } catch (error) {
        if (isEventIdempotencyConflict(error)) {
          this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, reason: "MEMORY_EVENT_IDEMPOTENCY_CONFLICT" });
          return { accepted: false, decision: rejectedDecision(userId, undefined, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
        }
        await this.markFailed(userId, parsed, errorCodeFor(error));
        this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, reason: "REPOSITORY_ERROR" });
        return { accepted: false, decision: rejectedDecision(userId, undefined, "REPOSITORY_ERROR"), errorCode: "REPOSITORY_ERROR" };
      }
      return { accepted: true, decision: rejectedDecision(userId, undefined, "ACCEPTED") };
    }
    const directMemoryId = isManagementEventType(type)
      ? controlMemoryId(parsed.payload) ?? parsed.targetMemoryId
      : undefined;
    // Do not append a payload-bearing correction/confirmation for an already
    // deleted aggregate.  PostgreSQL repeats this check inside its append
    // transaction to close the delete-vs-delivery race; this early read keeps
    // the common path from creating an event at all.
    let deletedTarget: MemoryRecord | undefined;
    if (isManagementEventType(type)) {
      if (!directMemoryId || !this.repository.getRecordVersion) {
        return { accepted: false, decision: rejectedDecision(userId, undefined, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
      }
      try {
        deletedTarget = await this.repository.getRecordVersion(userId, directMemoryId, undefined, type === "MEMORY_DELETED");
      } catch {
        return { accepted: false, decision: rejectedDecision(userId, undefined, "REPOSITORY_ERROR"), errorCode: "REPOSITORY_ERROR" };
      }
      if (!deletedTarget) {
        return { accepted: false, decision: rejectedDecision(userId, undefined, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
      }
      if (deletedTarget.status === "DELETED" && type === "MEMORY_DELETED") {
        // A previous delete may have committed and redacted the canonical
        // PostgreSQL event before its host fan-out completed.  Do not append
        // the payload again (the redacted canonical row would correctly look
        // like a conflict); instead retry the bounded cache/Outbox cleanup
        // against the existing tombstone.
        try {
          await this.invalidateBriefCache(userId);
          await this.notifyMemoryDeleted(userId, deletedTarget, directMemoryId, deletedTarget.sourceRefs);
          this.diagnostic({ type: "MEMORY_USER_DELETED", userId, memoryId: deletedTarget.memoryId, status: deletedTarget.status, reason: "DELETE_CLEANUP_RETRY" });
          return {
            accepted: false,
            decision: directDecision(userId, parsed, "DELETE", deletedTarget),
            record: deletedTarget,
          };
        } catch {
          return {
            accepted: false,
            decision: directDecision(userId, parsed, "DELETE", deletedTarget),
            errorCode: "REPOSITORY_ERROR",
          };
        }
      }
      if (type !== "MEMORY_DELETED" && deletedTarget.status === "DELETED") {
        return { accepted: false, decision: rejectedDecision(userId, undefined, "DELETED_TOMBSTONE"), record: deletedTarget };
      }
    }
    if (directMemoryId && type === "USER_CONFIRMED") {
      try {
        const canonical = await this.appendCanonicalEvent(userId, parsed as unknown as MemoryEvent);
        const record = await this.repository.confirmMemory(userId, directMemoryId);
        await this.markConsumed(userId, canonical);
        if (record) await this.indexRecord(userId, record);
        await this.invalidateBriefCache(userId);
        if (record) this.diagnostic({ type: "MEMORY_USER_CONFIRMED", userId, memoryId: record.memoryId, status: record.status });
        return {
          accepted: Boolean(record),
          decision: directDecision(userId, parsed, "CONFIRM", record),
          ...(record ? { record } : {}),
        };
      } catch (error) {
        if (isEventIdempotencyConflict(error)) {
          this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, memoryId: directMemoryId, reason: "MEMORY_EVENT_IDEMPOTENCY_CONFLICT" });
          return { accepted: false, decision: rejectedDecision(userId, undefined, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
        }
        await this.markFailed(userId, parsed, errorCodeFor(error));
        return { accepted: false, decision: rejectedDecision(userId, undefined, "REPOSITORY_ERROR"), errorCode: "REPOSITORY_ERROR" };
      }
    }
    if (directMemoryId && type === "MEMORY_DELETED") {
      try {
        const canonical = await this.appendCanonicalEvent(userId, parsed as unknown as MemoryEvent);
        const deletePayload: unknown = parsed.payload;
        const payloadReason = isRecord(deletePayload) && typeof deletePayload.reason === "string" ? deletePayload.reason : undefined;
        const record = await this.repository.deleteMemory(userId, directMemoryId, payloadReason ? { reason: payloadReason } : undefined);
        await this.markConsumed(userId, canonical);
        // Keep the direct consumer/control-event path subject to the same
        // cache privacy boundary as the management API.  The tombstone is
        // committed before optional host invalidation, so bump the generation
        // before any cleanup that may fail.
        if (record?.status === "DELETED") await this.invalidateBriefCache(userId);
        await this.removeEmbedding(userId, record, directMemoryId);
        await this.notifyMemoryDeleted(userId, record, directMemoryId, deletedTarget?.sourceRefs ?? []);
        if (record) this.diagnostic({ type: "MEMORY_USER_DELETED", userId, memoryId: record.memoryId, status: record.status });
        return {
          accepted: Boolean(record),
          decision: directDecision(userId, parsed, "DELETE", record),
          ...(record ? { record } : {}),
        };
      } catch (error) {
        if (isEventIdempotencyConflict(error)) {
          this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, memoryId: directMemoryId, reason: "MEMORY_EVENT_IDEMPOTENCY_CONFLICT" });
          return { accepted: false, decision: rejectedDecision(userId, undefined, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
        }
        await this.markFailed(userId, parsed, errorCodeFor(error));
        return { accepted: false, decision: rejectedDecision(userId, undefined, "REPOSITORY_ERROR"), errorCode: "REPOSITORY_ERROR" };
      }
    }
    if (directMemoryId && type === "USER_CORRECTED_COACH") {
      const correction = controlCorrection(parsed.payload);
      if (correction) {
        try {
          const canonical = await this.appendCanonicalEvent(userId, parsed as unknown as MemoryEvent);
          const record = await this.repository.correctMemory(userId, directMemoryId, correction);
          await this.markConsumed(userId, canonical);
          if (record) await this.indexRecord(userId, record);
          await this.invalidateBriefCache(userId);
          if (record) this.diagnostic({ type: "MEMORY_USER_CORRECTED", userId, memoryId: record.memoryId, status: record.status });
          return {
            accepted: Boolean(record),
            decision: directDecision(userId, parsed, "CORRECT", record),
            ...(record ? { record } : {}),
          };
        } catch (error) {
          if (isEventIdempotencyConflict(error)) {
            this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, memoryId: directMemoryId, reason: "MEMORY_EVENT_IDEMPOTENCY_CONFLICT" });
            return { accepted: false, decision: rejectedDecision(userId, undefined, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
          }
          await this.markFailed(userId, parsed, errorCodeFor(error));
          return { accepted: false, decision: rejectedDecision(userId, undefined, "REPOSITORY_ERROR"), errorCode: "REPOSITORY_ERROR" };
        }
      }
    }
    const proposal = controlProposal(parsed, type);
    if (!proposal || proposal.userId !== userId) {
      return { accepted: false, decision: rejectedDecision(userId, proposal, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
    }
    const validatedProposal = MemoryProposalSchema.parse(proposal) as unknown as MemoryProposal;
    if (!hasCompletedCueProof(validatedProposal, type)) {
      return { accepted: false, decision: rejectedDecision(userId, validatedProposal, "INVALID_PROPOSAL"), errorCode: "INVALID_EVENT" };
    }
    let current: MemoryRecord | undefined;
    try {
      current = await this.repository.findByLogicalKey(userId, validatedProposal.logicalKey);
    } catch {
      return { accepted: false, decision: rejectedDecision(userId, validatedProposal, "REPOSITORY_ERROR"), errorCode: "REPOSITORY_ERROR" };
    }
    const decision = this.policy.decide({ proposal: validatedProposal, current, eventType: type });
    this.diagnostic({
      type: "MEMORY_WRITE_DECISION",
      userId,
      eventId: parsed.eventId,
      memoryId: current?.memoryId ?? validatedProposal.targetMemoryId,
      operation: validatedProposal.operation,
      action: decision.action,
      accepted: decision.accepted,
      status: decision.status,
      reason: decision.reason,
    });
    const record = this.reducer.reduce({ userId, proposal: validatedProposal, decision, current, now: this.clock() });
    const materialized = { ...decision, ...(record ? { record } : {}) };
    // A late event for a tombstoned key is rejected before appending its
    // potentially sensitive proposal payload to the event log. The tombstone
    // itself is the durable anti-resurrection record.
    if (decision.reason === "DELETED_TOMBSTONE") {
      this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, memoryId: current?.memoryId, reason: decision.reason });
      return { accepted: false, decision: materialized, ...(current ? { record: current } : {}) };
    }
    try {
      // Outbox/repository append precedes applying the projection, preserving
      // at-least-once delivery semantics for a PostgreSQL adapter.
      const canonical = await this.appendCanonicalEvent(userId, parsed as unknown as MemoryEvent);
      const saved = await this.repository.applyWriteDecision(userId, materialized);
      await this.markConsumed(userId, canonical);
      if (saved && decision.accepted) await this.indexRecord(userId, saved);
      if (saved && decision.accepted) await this.invalidateBriefCache(userId);
      this.diagnostic({
        type: decision.accepted ? "MEMORY_EVENT_ACCEPTED" : "MEMORY_EVENT_IGNORED",
        userId,
        ...(saved?.memoryId ? { memoryId: saved.memoryId } : {}),
        ...(!decision.accepted ? { reason: decision.reason } : {}),
      });
      return { accepted: decision.accepted && Boolean(saved), decision: materialized, ...(saved ? { record: saved } : {}) };
    } catch (error) {
      if (isEventIdempotencyConflict(error)) {
        this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, reason: "MEMORY_EVENT_IDEMPOTENCY_CONFLICT" });
        return { accepted: false, decision: { ...materialized, accepted: false, action: "NOOP", reason: "INVALID_PROPOSAL" }, errorCode: "INVALID_EVENT" };
      }
      await this.markFailed(userId, parsed, errorCodeFor(error));
      this.diagnostic({ type: "MEMORY_EVENT_IGNORED", userId, reason: "REPOSITORY_ERROR" });
      return { accepted: false, decision: { ...materialized, accepted: false, action: "NOOP", reason: "REPOSITORY_ERROR" }, errorCode: "REPOSITORY_ERROR" };
    }
  }

  async getBrief(userId: string, options?: MemoryBriefOptions): Promise<ReturnType<typeof buildUserMemoryBrief>> {
    if (!this.featureEnabled) {
      const brief = emptyBrief("Memory is disabled or consent has not been granted.");
      this.diagnostic({ type: "MEMORY_BRIEF_LOADED", userId, source: "EMPTY", reason: "MEMORY_DISABLED" });
      return brief;
    }
    const initialAuthorization = await this.loadAuthorization(userId);
    if (!this.authorizationIsGranted(userId, initialAuthorization)) {
      const brief = emptyBrief("Memory is disabled or consent has not been granted.");
      this.diagnostic({ type: "MEMORY_BRIEF_LOADED", userId, source: "EMPTY", reason: "CONSENT_REQUIRED" });
      return brief;
    }
    const authorizationVersion = initialAuthorization?.consentVersion ?? 0;
    const briefGeneration = this.briefGeneration(userId);
    // Over-fetch before the brief builder's terminal/status filtering. A
    // handful of newer DISPUTED/SUPERSEDED rows must not crowd older valid
    // cross-Demo memories out of a three-item teaching projection.
    const briefRecallLimit = Math.min(Math.max(options?.query?.limit ?? 3, 12), 100);
    const cacheKey = this.briefCacheKey(userId, initialAuthorization!);
    // A semantic/query-specific brief cannot reuse the general cached
    // projection: doing so would silently return memories for the wrong text
    // (and hide a vector fallback). Cache only the bounded default brief.
    const cacheable = !options?.semanticText && !options?.query;
    if (cacheable) {
      try {
        const cached = await this.cache.get<ReturnType<typeof buildUserMemoryBrief>>(cacheKey);
        if (cached) {
          const parsedCached = MemoryBriefSchema.safeParse(cached);
          if (parsedCached.success) {
            const currentAuthorization = await this.loadAuthorization(userId);
            if ((currentAuthorization?.consentVersion ?? 0) === authorizationVersion &&
              this.authorizationIsGranted(userId, currentAuthorization) &&
              this.briefGeneration(userId) === briefGeneration) {
              this.diagnostic({ type: "MEMORY_BRIEF_LOADED", userId, source: parsedCached.data.source, reason: "CACHE" });
              return parsedCached.data as unknown as ReturnType<typeof buildUserMemoryBrief>;
            }
            const fallback = emptyBrief("Memory consent changed while loading the brief.");
            this.diagnostic({ type: "MEMORY_BRIEF_LOADED", userId, source: "EMPTY", reason: "CONSENT_CHANGED_AFTER_CACHE_READ" });
            return fallback;
          }
        }
      } catch {
        // fall through to authoritative structured recall
      }
    }
    const limitations: string[] = [];
    let structured: readonly MemoryRecord[] = [];
    // A disputed aggregate is intentionally excluded from the active-memory
    // query, but its user correction is still a first-class teaching input.
    // Load that bounded channel separately; otherwise the PostgreSQL
    // `activeOnly` status predicate makes the correction disappear before the
    // brief builder can preserve it. The builder will continue to keep the
    // disputed record out of `memories` while copying its correction.
    let correctionRecords: readonly MemoryRecord[] = [];
    let semantic: readonly MemoryRecord[] = [];
    let structuredStatus: "AVAILABLE" | "UNAVAILABLE" | "EMPTY" = "EMPTY";
    let semanticStatus: "OPTIONAL" | "UNAVAILABLE" | "USED" = "OPTIONAL";
    let threads = [] as readonly import("@cs-coach/contracts").LearningThread[];
    let preferenceRecords: readonly MemoryRecord[] = [];
    try {
      structured = await this.repository.retrieveStructured(userId, {
        ...(options?.query ?? {}),
        activeOnly: true,
        includeDeleted: false,
        limit: briefRecallLimit,
      });
      structuredStatus = "AVAILABLE";
    } catch {
      limitations.push("Structured memory recall unavailable.");
      structuredStatus = "UNAVAILABLE";
      this.diagnostic({ type: "SEMANTIC_RECALL_FALLBACK", userId, reason: "STRUCTURED_RECALL_UNAVAILABLE" });
    }
    try {
      correctionRecords = await this.repository.retrieveStructured(userId, {
        status: "DISPUTED",
        includeDeleted: false,
        activeOnly: false,
        limit: 4,
      });
    } catch {
      // A correction is useful but must never make the whole brief fail. Keep
      // the limitation explicit so operators can distinguish an empty channel
      // from a repository that could not load it.
      limitations.push("User corrections unavailable.");
    }
    try {
      // Preferences have their own bounded query and must not be crowded out
      // by the three-record learning-memory brief limit.
      preferenceRecords = await this.repository.getPreferences(userId);
    } catch {
      limitations.push("Teaching preferences unavailable.");
    }
    if (options?.semanticText) {
      // Structured recall above may have yielded while consent changed. Do
      // not invoke the optional embedding provider until the same consent
      // version/generation still authorizes this semantic query.
      if (!(await this.authorizationSnapshotStillGranted(userId, {
        consentVersion: authorizationVersion,
        generation: briefGeneration,
      }))) {
        const fallback = emptyBrief("Memory consent changed before semantic recall.");
        this.diagnostic({ type: "MEMORY_BRIEF_LOADED", userId, source: "EMPTY", reason: "CONSENT_CHANGED_BEFORE_SEMANTIC" });
        return fallback;
      }
      let embedding: readonly number[] | undefined;
      if (this.embedding) {
        try {
          embedding = await this.embedWithTimeout(options.semanticText);
          if (!embedding) throw new Error("EMBEDDING_TIMEOUT");
        } catch {
          limitations.push("Semantic memory recall unavailable; using structured memory.");
          semanticStatus = "UNAVAILABLE";
          this.diagnostic({ type: "SEMANTIC_RECALL_FALLBACK", userId, reason: "EMBEDDING_UNAVAILABLE" });
        }
      }
      // An embedding provider is an in-flight boundary. If consent changed
      // while it ran, do not issue the subsequent semantic repository query;
      // the final check below remains necessary for revokes racing any
      // structured/semantic reads already in flight.
      if (!(await this.authorizationSnapshotStillGranted(userId, {
        consentVersion: authorizationVersion,
        generation: briefGeneration,
      }))) {
        const fallback = emptyBrief("Memory consent changed during semantic recall.");
        this.diagnostic({ type: "MEMORY_BRIEF_LOADED", userId, source: "EMPTY", reason: "CONSENT_CHANGED_DURING_SEMANTIC" });
        return fallback;
      }
      if (!this.embedding || embedding) {
        try {
          semantic = await this.repository.retrieveSemantic(userId, {
            ...(options.query ?? {}),
            text: options.semanticText,
            ...(embedding ? { embedding } : {}),
            activeOnly: true,
            includeDeleted: false,
            limit: briefRecallLimit,
          });
          semanticStatus = semantic.length ? "USED" : "OPTIONAL";
        } catch {
          limitations.push("Semantic memory recall unavailable; using structured memory.");
          semanticStatus = "UNAVAILABLE";
          this.diagnostic({ type: "SEMANTIC_RECALL_FALLBACK", userId, reason: "SEMANTIC_QUERY_UNAVAILABLE" });
        }
      }
    }
    try {
      threads = await this.repository.getLearningThreads(userId, { includeCandidates: false, activeOnly: true, limit: 2 });
    } catch {
      limitations.push("Learning-thread recall unavailable.");
    }
    let brief: ReturnType<typeof buildUserMemoryBrief>;
    try {
      brief = buildUserMemoryBrief({
        records: [...structured, ...correctionRecords],
        preferenceRecords,
        semanticRecords: semantic,
        threads,
        generatedAt: this.clock(),
        limitations,
        structuredStatus,
        semanticStatus,
      });
    } catch {
      const fallback = emptyBrief("Memory brief unavailable; continuing without long-term memory.");
      this.diagnostic({ type: "MEMORY_BRIEF_LOADED", userId, source: "EMPTY", reason: "BRIEF_BUILD_FAILED" });
      return fallback;
    }
    // A revoke can complete while structured/semantic reads are in flight.
    // Re-check both grant state and consent version before exposing or
    // caching the assembled projection.
    const finalAuthorization = await this.loadAuthorization(userId);
    if ((finalAuthorization?.consentVersion ?? 0) !== authorizationVersion ||
      !this.authorizationIsGranted(userId, finalAuthorization) ||
      this.briefGeneration(userId) !== briefGeneration) {
      const fallback = emptyBrief("Memory consent changed while loading the brief.");
      this.diagnostic({ type: "MEMORY_BRIEF_LOADED", userId, source: "EMPTY", reason: "CONSENT_CHANGED" });
      return fallback;
    }
    if (cacheable) {
      try {
        // A deletion can race the cache write itself. Recheck the generation
        // immediately before and after the provider call; a late pre-delete
        // response must not repopulate a key that invalidation just removed.
        if (this.briefGeneration(userId) === briefGeneration) {
          await this.cache.set(cacheKey, brief, 60);
          if (this.briefGeneration(userId) !== briefGeneration) {
            await this.cache.delete(cacheKey).catch(() => undefined);
          }
        }
      } catch {
        // cache is optional
      }
    }
    this.diagnostic({ type: "MEMORY_BRIEF_LOADED", userId, source: brief.source });
    return brief;
  }

  async confirm(userId: string, memoryId: string, confirmation?: unknown): Promise<MemoryRecord | undefined> {
    const authorizationSnapshot = await this.authorizationSnapshot(userId);
    if (!authorizationSnapshot) return undefined;
    if (this.repository.getRecordVersion) {
      const current = await this.repository.getRecordVersion(userId, memoryId);
      if (!current) return undefined;
      if (current?.status === "DELETED") return current;
    }
    const parsedConfirmation = confirmation === undefined ? undefined : MemoryConfirmationSchema.safeParse(confirmation);
    if (parsedConfirmation && !parsedConfirmation.success) return undefined;
    if (!(await this.authorizationSnapshotStillGranted(userId, authorizationSnapshot))) return undefined;
    let event: MemoryEvent | undefined;
    try {
      event = managementEvent(
        userId,
        "USER_CONFIRMED",
        memoryId,
        parsedConfirmation?.success ? (parsedConfirmation.data as unknown as MemoryConfirmation) : undefined,
        this.clock(),
      );
      const canonical = await this.appendCanonicalEvent(userId, event);
      const record = await this.repository.confirmMemory(userId, memoryId, parsedConfirmation?.success ? (parsedConfirmation.data as unknown as MemoryConfirmation) : undefined);
      await this.markConsumed(userId, canonical);
      if (record) await this.indexRecord(userId, record, authorizationSnapshot);
      await this.invalidateBriefCache(userId);
      return record;
    } catch (error) {
      if (isEventIdempotencyConflict(error)) return undefined;
      if (isRecord(error) && error.message === "MEMORY_DELETED_TOMBSTONE") {
        const deleted = this.repository.getRecordVersion
          ? await this.repository.getRecordVersion(userId, memoryId).catch(() => undefined)
          : undefined;
        return deleted;
      }
      if (event) await this.markFailed(userId, event, errorCodeFor(error));
      return undefined;
    }
  }

  async correct(userId: string, memoryId: string, correction: unknown): Promise<MemoryRecord | undefined> {
    const authorizationSnapshot = await this.authorizationSnapshot(userId);
    if (!authorizationSnapshot) return undefined;
    if (this.repository.getRecordVersion) {
      const current = await this.repository.getRecordVersion(userId, memoryId);
      if (!current) return undefined;
      if (current?.status === "DELETED") return current;
    }
    const parsedCorrection = MemoryCorrectionInputSchema.safeParse(correction);
    if (!parsedCorrection.success) return undefined;
    if (!(await this.authorizationSnapshotStillGranted(userId, authorizationSnapshot))) return undefined;
    let event: MemoryEvent | undefined;
    try {
      event = managementEvent(userId, "USER_CORRECTED_COACH", memoryId, parsedCorrection.data as unknown as MemoryCorrectionInput, this.clock());
      const canonical = await this.appendCanonicalEvent(userId, event);
      // The event envelope owns the deterministic correction identity. Pass
      // that exact ID into the repository as well; otherwise a PostgreSQL
      // adapter that derives IDs from the current revision would create a
      // second revision when the same HTTP request is retried.
      const eventPayload = event.payload;
      const eventCorrectionId = isRecord(eventPayload) && isRecord(eventPayload.correction) &&
        typeof eventPayload.correction.correctionId === "string"
        ? eventPayload.correction.correctionId
        : parsedCorrection.data.correctionId;
      const repositoryCorrection = {
        ...(parsedCorrection.data as unknown as MemoryCorrectionInput),
        ...(eventCorrectionId ? { correctionId: eventCorrectionId } : {}),
      };
      const record = await this.repository.correctMemory(userId, memoryId, repositoryCorrection);
      await this.markConsumed(userId, canonical);
      if (record) await this.indexRecord(userId, record, authorizationSnapshot);
      await this.invalidateBriefCache(userId);
      return record;
    } catch (error) {
      if (isEventIdempotencyConflict(error)) return undefined;
      if (isRecord(error) && error.message === "MEMORY_DELETED_TOMBSTONE") {
        const deleted = this.repository.getRecordVersion
          ? await this.repository.getRecordVersion(userId, memoryId).catch(() => undefined)
          : undefined;
        return deleted;
      }
      if (event) await this.markFailed(userId, event, errorCodeFor(error));
      return undefined;
    }
  }

  async delete(userId: string, memoryId: string, input?: unknown): Promise<MemoryRecord | undefined> {
    if (!(await this.canDelete(userId))) return undefined;
    const parsedInput = input === undefined ? undefined : MemoryDeleteInputSchema.safeParse(input);
    if (parsedInput && !parsedInput.success) return undefined;
    // Keep the pre-delete provenance in hand: the reducer intentionally
    // redacts sourceRefs on a tombstone, but PostgreSQL may need those refs to
    // erase orphan observations whose memory_id is NULL.
    let deletionSourceRefs: readonly unknown[] = [];
    if (this.repository.getRecordVersion) {
      try {
        // Deletion is the privacy exception, so the repository may return a
        // live/tombstoned target even after consent has been revoked.
        const current = await this.repository.getRecordVersion(userId, memoryId, undefined, true);
        if (!current) return undefined;
        if (current.status === "DELETED") {
          // A prior process may have committed this tombstone but failed
          // before invalidating a shared cache.  Repeated deletion is still a
          // safe privacy operation, so make the stale projection unreachable
          // before returning the canonical tombstone.
          await this.invalidateBriefCache(userId);
          // Retry the host cleanup as well.  The original tombstone may have
          // committed while a prior DO notification failed, and returning it
          // without another bounded fan-out would leave queued payloads alive.
          await this.notifyMemoryDeleted(userId, current, memoryId, current.sourceRefs);
          return current;
        }
        deletionSourceRefs = current.sourceRefs;
      } catch {
        return undefined;
      }
    }
    let event: MemoryEvent | undefined;
    try {
      event = managementEvent(
        userId,
        "MEMORY_DELETED",
        memoryId,
        parsedInput?.success ? (parsedInput.data as unknown as MemoryDeleteInput) : undefined,
        this.clock(),
      );
      const canonical = await this.appendCanonicalEvent(userId, event);
      const record = await this.repository.deleteMemory(userId, memoryId, parsedInput?.success ? (parsedInput.data as unknown as MemoryDeleteInput) : undefined);
      await this.markConsumed(userId, canonical);
      // The tombstone is the authoritative privacy boundary.  Invalidate the
      // local brief generation before any best-effort embedding/host cleanup,
      // so a failed notification cannot leave a pre-delete projection
      // readable from cache.
      if (record?.status === "DELETED") await this.invalidateBriefCache(userId);
      await this.removeEmbedding(userId, record, memoryId);
      await this.notifyMemoryDeleted(userId, record, memoryId, deletionSourceRefs);
      return record;
    } catch (error) {
      if (isEventIdempotencyConflict(error)) return undefined;
      if (event) await this.markFailed(userId, event, errorCodeFor(error));
      return undefined;
    }
  }
}

export const createMemoryService = (options: MemoryServiceOptions): MemoryService => new MemoryService(options);
