import type { LearningThread } from "@cs-coach/contracts";
import {
  MEMORY_EVENT_VERSION,
  MEMORY_PROPOSAL_VERSION,
  type MemoryAuthorization,
  type MemoryConfirmation,
  type MemoryCorrectionInput,
  type MemoryDeleteInput,
  type MemoryEvent,
  type MemoryRecord,
  type MemoryProposal,
  type MemoryQuery,
  type MemoryWriteDecision,
  type SemanticMemoryQuery,
  type LearningThreadQuery,
} from "./domain";
import type { MemoryEmbeddingWrite, MemoryRepository } from "./ports";
import { stableMemoryIdempotencyKey, stableMemoryLogicalKey, stableMemoryToken } from "./proposal";
import { MemoryReducer } from "./reducer";
import { MemoryWritePolicy } from "./policy";

function key(userId: string, value: string): string {
  return `${userId}\u0000${value}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asArray<T>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function matchesQuery(record: MemoryRecord, query: MemoryQuery | undefined): boolean {
  if (!query) return record.status !== "DELETED";
  const kinds = asArray(query.kind);
  const statuses = asArray(query.status);
  if (!query.includeDeleted && record.status === "DELETED") return false;
  if (query.activeOnly && (!record.active || ["DELETED", "DISPUTED", "SUPERSEDED", "ARCHIVED", "RESOLVED"].includes(record.status))) return false;
  if (kinds && !kinds.includes(record.kind)) return false;
  if (statuses && !statuses.includes(record.status)) return false;
  if (query.logicalKey && query.logicalKey !== record.logicalKey) return false;
  if (query.taxonomyCode && query.taxonomyCode !== record.thread?.hingeCode) return false;
  if (query.hingeCode && query.hingeCode !== record.thread?.hingeCode) return false;
  if (query.mapName && query.mapName !== record.scopeContext?.mapName) return false;
  if (query.side && query.side !== record.scopeContext?.side) return false;
  if (query.roleCode && query.roleCode !== record.scopeContext?.roleCode) return false;
  if (query.userGoal && !record.thread?.userModel.goal?.toLocaleLowerCase().includes(query.userGoal.toLocaleLowerCase())) return false;
  if (query.since && record.updatedAt < query.since) return false;
  if (query.minConfidence !== undefined) {
    const confidence = Math.max(
      record.thread?.diagnosis.confidence ?? 0,
      record.thread?.transferRule.confidence ?? 0,
      record.verdict?.confidence ?? 0,
    );
    if (confidence < query.minConfidence) return false;
  }
  return true;
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u).filter(Boolean));
}

function semanticScore(record: MemoryRecord, text: string): number {
  const haystack = [record.summary, record.content, record.thread?.diagnosis.summary, record.transferRule?.when, record.transferRule?.do]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const queryWords = words(text);
  if (queryWords.size === 0) return 0;
  const recordWords = words(haystack);
  let overlap = 0;
  for (const word of queryWords) if (recordWords.has(word)) overlap += 1;
  return overlap / queryWords.size;
}

function eventTypeFor(event: MemoryEvent): NonNullable<MemoryEvent["type"]> {
  return (event.type ?? event.eventType) as NonNullable<MemoryEvent["type"]>;
}

function redactedEvent(event: MemoryEvent): MemoryEvent {
  const type = eventTypeFor(event);
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    ...(event.type ? { type: event.type } : {}),
    ...(event.eventType ? { eventType: event.eventType } : {}),
    userId: event.userId,
    sessionId: event.sessionId,
    ...(event.demoContentHash ? { demoContentHash: event.demoContentHash } : {}),
    ...(event.proposalId ? { proposalId: event.proposalId } : {}),
    ...(event.targetMemoryId ? { targetMemoryId: event.targetMemoryId } : {}),
    ...(event.operation ? { operation: event.operation } : {}),
    idempotencyKey: event.idempotencyKey,
    producerVersion: event.producerVersion,
    payload: type === "SESSION_COMPLETED" ? { reason: "SESSION_COMPLETED" } : { reason: "MEMORY_DELETED" },
    createdAt: event.createdAt,
  };
}

/**
 * Small deterministic adapter used in unit tests and local integrations.  It
 * mirrors the atomic shape expected from the PostgreSQL adapter without
 * pulling a database or ORM into the Memory Domain.
 */
export class InMemoryMemoryRepository implements MemoryRepository {
  readonly calls: string[] = [];
  readonly events: MemoryEvent[] = [];
  readonly embeddings: Array<MemoryEmbeddingWrite & { userId: string; deletedAt?: string }> = [];
  readonly eventStatuses = new Map<string, "POSTED" | "CONSUMED" | "RETRY" | "DEAD_LETTER">();
  private readonly current = new Map<string, MemoryRecord>();
  private readonly revisions = new Map<string, MemoryRecord>();
  private readonly idempotency = new Map<string, MemoryRecord | undefined>();
  private readonly eventIdempotency = new Set<string>();
  private readonly eventIds = new Set<string>();
  private readonly reducer: MemoryReducer;
  private readonly policy: MemoryWritePolicy;
  private readonly clock: () => string;

  constructor(options?: { reducer?: MemoryReducer; policy?: MemoryWritePolicy; now?: () => string }) {
    this.reducer = options?.reducer ?? new MemoryReducer();
    this.policy = options?.policy ?? new MemoryWritePolicy();
    this.clock = options?.now ?? nowIso;
  }

  async getMemoryVersion(userId: string, _memoryId?: string): Promise<number> {
    this.calls.push("getMemoryVersion");
    return [...this.current.values()]
      .filter((record) => record.userId === userId)
      .reduce((version, record) => Math.max(version, record.revision), 0);
  }

  async getRecordVersion(userId: string, memoryId: string, revision?: number): Promise<MemoryRecord | undefined> {
    this.calls.push("getRecordVersion");
    if (revision !== undefined) return this.revisions.get(key(userId, `${memoryId}:r${revision}`));
    return this.current.get(key(userId, memoryId));
  }

  async getPreferences(userId: string): Promise<readonly MemoryRecord[]> {
    this.calls.push("getPreferences");
    return [...this.current.values()].filter((record) => record.userId === userId && (record.kind === "PREFERENCE" || record.kind === "COACHING_PREFERENCE") && record.status !== "DELETED");
  }

  async findByLogicalKey(userId: string, logicalKey: string): Promise<MemoryRecord | undefined> {
    this.calls.push("findByLogicalKey");
    // Logical-key lookup includes tombstones so policy can reject late
    // events instead of accidentally creating a replacement aggregate.
    return [...this.current.values()].find((record) => record.userId === userId && record.logicalKey === logicalKey);
  }

  async appendEvent(userId: string, event: MemoryEvent): Promise<MemoryEvent> {
    this.calls.push("appendEvent");
    if (event.userId !== userId) throw new Error("USER_MISMATCH");
    const managementOperation = event.operation === "CORRECT" || event.operation === "CONFIRM" || event.operation === "DELETE";
    if (managementOperation) {
      const targetId = event.targetMemoryId;
      if (!targetId) throw new Error("MEMORY_MANAGEMENT_TARGET_REQUIRED");
      const target = this.current.get(key(userId, targetId));
      if (!target) throw new Error("MEMORY_MANAGEMENT_TARGET_NOT_FOUND");
      if (target.status === "DELETED" && event.operation !== "DELETE") throw new Error("MEMORY_DELETED_TOMBSTONE");
    }
    const eventKey = key(userId, event.idempotencyKey);
    const eventIdKey = key(userId, event.eventId);
    if (this.eventIdempotency.has(eventKey) || this.eventIds.has(eventIdKey)) {
      return this.events.find((candidate) =>
        candidate.userId === userId &&
        (candidate.eventId === event.eventId || candidate.idempotencyKey === event.idempotencyKey),
      ) ?? event;
    }
    this.eventIdempotency.add(eventKey);
    this.eventIds.add(eventIdKey);
    this.events.push(event);
    this.eventStatuses.set(eventKey, "POSTED");
    return event;
  }

  async markEventConsumed(userId: string, eventId: string): Promise<void> {
    this.calls.push("markEventConsumed");
    const event = this.events.find((candidate) => candidate.userId === userId && candidate.eventId === eventId);
    if (event && this.eventStatuses.get(key(userId, event.idempotencyKey)) !== "DEAD_LETTER") {
      this.eventStatuses.set(key(userId, event.idempotencyKey), "CONSUMED");
    }
  }

  async markEventFailed(userId: string, eventId: string, options?: { terminal?: boolean }): Promise<void> {
    this.calls.push("markEventFailed");
    const event = this.events.find((candidate) => candidate.userId === userId && candidate.eventId === eventId);
    if (event) {
      const status = this.eventStatuses.get(key(userId, event.idempotencyKey));
      if (status !== "CONSUMED" && status !== "DEAD_LETTER") {
        this.eventStatuses.set(key(userId, event.idempotencyKey), options?.terminal ? "DEAD_LETTER" : "RETRY");
      }
    }
  }

  async applyWriteDecision(userId: string, decision: MemoryWriteDecision): Promise<MemoryRecord | undefined> {
    this.calls.push("applyWriteDecision");
    if (decision.userId !== userId || decision.proposal.userId !== userId) throw new Error("USER_MISMATCH");
    if (decision.targetMemoryId && decision.proposal.targetMemoryId && decision.targetMemoryId !== decision.proposal.targetMemoryId) throw new Error("MEMORY_TARGET_MISMATCH");
    const idemKey = key(userId, decision.idempotencyKey);
    const current = decision.targetMemoryId
      ? this.current.get(key(userId, decision.targetMemoryId))
      : [...this.current.values()].find((record) => record.userId === userId && record.logicalKey === decision.logicalKey);
    if (current && current.logicalKey !== decision.logicalKey) throw new Error("MEMORY_TARGET_LOGICAL_KEY_MISMATCH");
    if (decision.targetMemoryId && !current) return undefined;
    if (this.idempotency.has(idemKey)) {
      // A tombstone supersedes even an older idempotency result; returning the
      // old candidate here would make a replay look resurrected to callers.
      if (current?.status === "DELETED") return current;
      return this.idempotency.get(idemKey);
    }
    if (!decision.accepted) {
      const unchanged = current;
      this.idempotency.set(idemKey, unchanged);
      return unchanged;
    }
    // Recompute against the repository's current projection instead of
    // trusting a service-side snapshot. This keeps the local adapter's
    // concurrent behavior aligned with PostgreSQL's transactional reducer and
    // prevents one Demo from overwriting another Demo's evidence.
    const effectiveDecision = this.policy.decide({
      proposal: decision.proposal,
      current,
      eventType: decision.proposal.eventType,
    });
    if (!effectiveDecision.accepted) {
      this.idempotency.set(idemKey, current);
      return current;
    }
    const record = this.reducer.reduce({
      userId,
      proposal: decision.proposal,
      decision: {
        ...effectiveDecision,
        targetMemoryId: current?.memoryId ?? effectiveDecision.targetMemoryId ?? decision.targetMemoryId,
      },
      current,
      now: this.clock(),
    });
    if (!record) {
      this.idempotency.set(idemKey, current);
      return current;
    }
    const recordKey = key(userId, record.memoryId);
    this.current.set(recordKey, record);
    this.revisions.set(key(userId, `${record.memoryId}:r${record.revision}`), record);
    this.idempotency.set(idemKey, record);
    return record;
  }

  async retrieveStructured(userId: string, query?: MemoryQuery): Promise<readonly MemoryRecord[]> {
    this.calls.push("retrieveStructured");
    const limit = query?.limit ?? 100;
    return [...this.current.values()].filter((record) => record.userId === userId && matchesQuery(record, query)).slice(0, limit);
  }

  async retrieveSemantic(userId: string, query: SemanticMemoryQuery): Promise<readonly MemoryRecord[]> {
    this.calls.push("retrieveSemantic");
    const minScore = query.minScore ?? 0;
    return [...this.current.values()]
      .filter((record) => record.userId === userId && matchesQuery(record, query))
      .map((record) => ({ record, score: semanticScore(record, query.text) }))
      .filter(({ score }) => score >= minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, query.limit ?? 100)
      .map(({ record }) => record);
  }

  async getLearningThreads(userId: string, query?: LearningThreadQuery): Promise<readonly LearningThread[]> {
    this.calls.push("getLearningThreads");
    return [...this.current.values()]
      .filter((record) => record.userId === userId && record.thread && matchesQuery(record, query) && (query?.includeCandidates || record.active))
      .filter((record) => query?.includeDeleted || !["DELETED", "DISPUTED", "SUPERSEDED", "ARCHIVED", "RESOLVED"].includes(record.status))
      .filter((record) => !query?.hingeCode || record.thread?.hingeCode === query.hingeCode)
      .filter((record) => !query?.diagnosisType || record.thread?.diagnosis.type === query.diagnosisType)
      .map((record) => record.thread as LearningThread)
      .slice(0, query?.limit ?? 100);
  }

  async correctMemory(userId: string, memoryId: string, correction: MemoryCorrectionInput): Promise<MemoryRecord | undefined> {
    this.calls.push("correctMemory");
    const current = this.current.get(key(userId, memoryId));
    if (!current || current.status === "DELETED") return current;
    const createdAt = this.clock();
    const proposal: MemoryProposal = {
      schemaVersion: MEMORY_PROPOSAL_VERSION,
      proposalId: correction.correctionId ?? `correction-${stableMemoryToken(`${memoryId}|${createdAt}|${correction.content}`)}`,
      userId,
      operation: "CORRECT",
      eventType: "USER_CORRECTED_COACH",
      targetMemoryId: memoryId,
      requestedScope: "CROSS_DEMO",
      kind: current.kind,
      logicalKey: current.logicalKey,
      ...(current.thread ? { thread: current.thread } : {}),
      claims: current.claims,
      ...(current.verdict ? { verdict: current.verdict } : {}),
      ...(current.transferRule ? { transferRule: current.transferRule } : {}),
      ...(current.preference ? { preference: current.preference } : {}),
      origin: {
        sessionId: current.sourceRefs[0]?.sessionId ?? "memory-management",
        demoContentHash: current.demoContentHashes[0] ?? "memory-management",
        cueId: current.sourceRefs[0]?.cueId ?? "memory-management",
        caseId: current.sourceRefs[0]?.caseId,
        sourceThreadId: current.thread?.threadId,
        typedSourceRefs: correction.refs?.length
          ? correction.refs
          : [{
              namespace: "USER_CLAIM" as const,
              refId: correction.correctionId ?? `correction-${stableMemoryToken(`${memoryId}|${correction.content}`)}`,
              demoContentHash: current.demoContentHashes[0] ?? "memory-management",
              sessionId: "memory-management",
              cueId: "memory-management",
              ...(current.thread?.threadId ? { threadId: current.thread.threadId } : {}),
              label: "user correction",
            }],
      },
      lifecycle: current.status,
      consentState: "GRANTED",
      producerVersion: "memory-domain.v1",
      idempotencyKey: `correction-idem-${stableMemoryToken(`${userId}|${memoryId}|${correction.correctionId ?? correction.content}`)}`,
      createdAt,
      correction: {
        correctionId: correction.correctionId ?? `correction-${stableMemoryToken(`${memoryId}|${correction.content}`)}`,
        content: correction.content,
        source: "USER",
      },
    };
    const decision = this.policy.decide({ proposal, current, eventType: "USER_CORRECTED_COACH" });
    const record = this.reducer.reduce({ userId, proposal, decision, current, now: createdAt });
    return this.applyWriteDecision(userId, { ...decision, record });
  }

  async deleteMemory(userId: string, memoryId: string, input?: MemoryDeleteInput): Promise<MemoryRecord | undefined> {
    this.calls.push("deleteMemory");
    const current = this.current.get(key(userId, memoryId));
    if (!current) return undefined;
    const createdAt = input?.deletedAt ?? this.clock();
    const source = current?.sourceRefs[0];
    const proposal: MemoryProposal = {
      schemaVersion: MEMORY_PROPOSAL_VERSION,
      proposalId: `delete-${stableMemoryToken(`${userId}|${memoryId}|${createdAt}`)}`,
      userId,
      operation: "DELETE",
      eventType: "MEMORY_DELETED",
      targetMemoryId: memoryId,
      requestedScope: "CROSS_DEMO",
      kind: current?.kind ?? "LEARNING_THREAD",
      logicalKey: current?.logicalKey ?? `deleted-${memoryId}`,
      claims: current?.claims ?? [],
      origin: {
        sessionId: source?.sessionId ?? "memory-management",
        demoContentHash: source?.demoContentHash ?? "memory-management",
        cueId: source?.cueId ?? "memory-management",
        caseId: source?.caseId,
        sourceThreadId: current?.thread?.threadId,
        typedSourceRefs: current?.sourceRefs ?? [
          {
            namespace: "SESSION",
            refId: memoryId,
            demoContentHash: "memory-management",
            sessionId: "memory-management",
            cueId: "memory-management",
          },
        ],
      },
      lifecycle: "DELETED",
      consentState: "GRANTED",
      producerVersion: "memory-domain.v1",
      idempotencyKey: `delete-idem-${stableMemoryToken(`${userId}|${memoryId}`)}`,
      createdAt,
      ...(input?.reason ? { deleteReason: input.reason } : {}),
    };
    const decision = this.policy.decide({ proposal, current, eventType: "MEMORY_DELETED" });
    const record = this.reducer.reduce({ userId, proposal, decision, current, now: createdAt });
    return this.applyWriteDecision(userId, { ...decision, record });
  }

  async invalidatePendingMemory(userId: string, memoryId: string, logicalKey?: string): Promise<readonly string[]> {
    this.calls.push("invalidatePendingMemory");
    const sessions = new Set<string>();
    const target = String(memoryId ?? "").trim();
    const keyValue = typeof logicalKey === "string" ? logicalKey.trim() : "";
    const matches = (value: unknown, seen = new Set<unknown>()): boolean => {
      if (!value || typeof value !== "object" || seen.has(value)) return false;
      seen.add(value);
      if (Array.isArray(value)) return value.some((item) => matches(item, seen));
      const object = value as Record<string, unknown>;
      if ((target && (object.memoryId === target || object.targetMemoryId === target)) ||
        (keyValue && object.logicalKey === keyValue)) return true;
      return Object.values(object).some((item) => matches(item, seen));
    };
    for (const event of this.events) {
      if (event.userId !== userId) continue;
      const status = this.eventStatuses.get(key(userId, event.idempotencyKey));
      if (status !== "POSTED" && status !== "RETRY" && status !== "CONSUMED" && status !== "DEAD_LETTER") continue;
      if (!matches(event)) continue;
      if (status === "POSTED" || status === "RETRY") {
        this.eventStatuses.set(key(userId, event.idempotencyKey), "DEAD_LETTER");
      }
      const index = this.events.indexOf(event);
      if (index >= 0) this.events[index] = redactedEvent(event);
      sessions.add(event.sessionId);
    }
    return [...sessions];
  }

  async purgeMemoryResidue(userId: string, memoryId: string): Promise<void> {
    this.calls.push("purgeMemoryResidue");
    // In-memory storage has no denormalized observation/vector tables; the
    // method exists so service and PostgreSQL adapters share one deletion
    // contract.
    void userId;
    void memoryId;
  }

  async purgeUserMemoryResidue(userId: string): Promise<readonly string[]> {
    this.calls.push("purgeUserMemoryResidue");
    // Keep the local adapter's delete-all seam semantically aligned with the
    // PostgreSQL implementation. In particular, a route that reaches its
    // opaque-ID count cap must still be able to close/tombstone every
    // remaining aggregate instead of returning a partial, writable erase.
    const records = [...this.current.values()].filter((record) => record.userId === userId && record.status !== "DELETED");
    for (const record of records) {
      await this.deleteMemory(userId, record.memoryId, { reason: "用户请求清除全部长期记忆" });
    }
    const sessions = new Set<string>();
    for (const event of this.events) {
      if (event.userId !== userId) continue;
      const eventKey = key(userId, event.idempotencyKey);
      const status = this.eventStatuses.get(eventKey);
      if (status !== "POSTED" && status !== "RETRY" && status !== "CONSUMED" && status !== "DEAD_LETTER") continue;
      if (status === "POSTED" || status === "RETRY") this.eventStatuses.set(eventKey, "DEAD_LETTER");
      const index = this.events.indexOf(event);
      if (index >= 0) this.events[index] = redactedEvent(event);
      if (event.sessionId && event.sessionId !== "memory-management" && event.sessionId !== "memory-preferences") sessions.add(event.sessionId);
    }
    for (const embedding of this.embeddings) {
      if (embedding.userId === userId) embedding.deletedAt = this.clock();
    }
    return [...sessions];
  }

  async listMemories(userId: string, query?: MemoryQuery): Promise<readonly MemoryRecord[]> {
    this.calls.push("listMemories");
    return this.retrieveStructured(userId, query);
  }

  async listMemoryIdsForDeletion(userId: string, limit = 100): Promise<readonly string[]> {
    this.calls.push("listMemoryIdsForDeletion");
    return [...this.current.values()]
      .filter((record) => record.userId === userId && record.status !== "DELETED")
      .slice(0, Math.max(0, Math.min(100, Math.floor(limit))))
      .map((record) => record.memoryId);
  }

  async listMemorySessionIds(userId: string): Promise<readonly string[]> {
    this.calls.push("listMemorySessionIds");
    return [...new Set(this.events
      .filter((event) => event.userId === userId && typeof event.sessionId === "string" && event.sessionId.length > 0 &&
        event.sessionId !== "memory-management" && event.sessionId !== "memory-preferences")
      .map((event) => event.sessionId))];
  }

  async confirmMemory(userId: string, memoryId: string, confirmation?: MemoryConfirmation): Promise<MemoryRecord | undefined> {
    this.calls.push("confirmMemory");
    const current = this.current.get(key(userId, memoryId));
    if (!current || current.status === "DELETED") return current;
    const createdAt = confirmation?.confirmedAt ?? this.clock();
    const source = current.sourceRefs[0] ?? {
      namespace: "SESSION" as const,
      refId: memoryId,
      demoContentHash: "memory-management",
      sessionId: "memory-management",
      cueId: "memory-management",
    };
    const proposal: MemoryProposal = {
      schemaVersion: MEMORY_PROPOSAL_VERSION,
      proposalId: confirmation?.confirmationId ?? `confirm-${stableMemoryToken(`${userId}|${memoryId}`)}`,
      userId,
      operation: "CONFIRM",
      eventType: "USER_CONFIRMED",
      targetMemoryId: memoryId,
      requestedScope: "CROSS_DEMO",
      kind: current.kind,
      logicalKey: current.logicalKey,
      ...(current.thread ? { thread: current.thread } : {}),
      claims: current.claims,
      ...(current.verdict ? { verdict: current.verdict } : {}),
      ...(current.transferRule ? { transferRule: current.transferRule } : {}),
      ...(current.preference ? { preference: current.preference } : {}),
      origin: {
        sessionId: source.sessionId,
        demoContentHash: source.demoContentHash,
        cueId: source.cueId,
        caseId: source.caseId,
        sourceThreadId: current.thread?.threadId,
        typedSourceRefs: current.sourceRefs.length ? current.sourceRefs : [source],
      },
      lifecycle: "STABLE",
      consentState: "GRANTED",
      producerVersion: "memory-domain.v1",
      idempotencyKey: `confirm-idem-${stableMemoryToken(`${userId}|${memoryId}`)}`,
      createdAt,
      ...(confirmation?.content ? { content: confirmation.content } : {}),
    };
    const decision = this.policy.decide({ proposal, current, eventType: "USER_CONFIRMED" });
    const record = this.reducer.reduce({ userId, proposal, decision, current, now: createdAt });
    return this.applyWriteDecision(userId, { ...decision, record });
  }

  async saveEmbedding(userId: string, input: MemoryEmbeddingWrite): Promise<void> {
    this.calls.push("saveEmbedding");
    const index = this.embeddings.findIndex((entry) => entry.userId === userId && entry.memoryId === input.memoryId);
    const value = { ...input, userId, deletedAt: undefined };
    if (index >= 0) this.embeddings[index] = value;
    else this.embeddings.push(value);
  }

  async deleteMemoryEmbedding(userId: string, memoryId: string, deletedAt = this.clock()): Promise<void> {
    this.calls.push("deleteMemoryEmbedding");
    const entry = this.embeddings.find((candidate) => candidate.userId === userId && candidate.memoryId === memoryId);
    if (entry) entry.deletedAt = deletedAt;
  }
}

export const InMemoryMemoryStore = InMemoryMemoryRepository;
