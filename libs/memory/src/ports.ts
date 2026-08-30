import type {
  MemoryAuthorization,
  MemoryConfirmation,
  MemoryCorrectionInput,
  MemoryDeleteInput,
  MemoryEvent,
  MemoryQuery,
  MemoryRecord,
  MemoryWriteDecision,
  SemanticMemoryQuery,
  LearningThreadQuery,
} from "./domain";
import type { LearningThread } from "@cs-coach/contracts";

/**
 * Provider-neutral persistence seam.  `userId` is deliberately the first
 * argument on every operation so an adapter cannot accidentally scope a
 * query from an untrusted payload.
 */
export interface MemoryRepository {
  /** Current aggregate/version stamp for an explicitly scoped user. */
  getMemoryVersion(userId: string, _memoryId?: string): Promise<number>;
  /** Optional record-level history seam used by management/API adapters. */
  /** `allowRevokedForDeletion` is an internal privacy-erasure seam; normal
   * management/recall callers must leave it false. */
  getRecordVersion?(userId: string, memoryId: string, revision?: number, allowRevokedForDeletion?: boolean): Promise<MemoryRecord | undefined>;
  getPreferences(userId: string): Promise<readonly MemoryRecord[]>;
  findByLogicalKey(userId: string, logicalKey: string): Promise<MemoryRecord | undefined>;
  appendEvent(userId: string, event: MemoryEvent): Promise<MemoryEvent | void>;
  /** Optional consumer status hooks; projection truth remains the record. */
  markEventConsumed?(userId: string, eventId: string, consumedAt?: string): Promise<void>;
  markEventFailed?(userId: string, eventId: string, options?: { terminal?: boolean; nextAttemptAt?: string; errorCode?: string }): Promise<void>;
  applyWriteDecision(userId: string, decision: MemoryWriteDecision): Promise<MemoryRecord | undefined>;
  retrieveStructured(userId: string, query?: MemoryQuery): Promise<readonly MemoryRecord[]>;
  retrieveSemantic(userId: string, query: SemanticMemoryQuery): Promise<readonly MemoryRecord[]>;
  getLearningThreads(userId: string, query?: LearningThreadQuery): Promise<readonly LearningThread[]>;
  correctMemory(userId: string, memoryId: string, correction: MemoryCorrectionInput): Promise<MemoryRecord | undefined>;
  deleteMemory(userId: string, memoryId: string, input?: MemoryDeleteInput): Promise<MemoryRecord | undefined>;
  /** Mark queued/posted payloads for a deleted aggregate terminal before a
   * late consumer can deliver them. Returns affected Session IDs when known
   * so a host can invalidate per-session Durable Object outboxes. */
  invalidatePendingMemory?(userId: string, memoryId: string, logicalKey?: string): Promise<readonly string[]>;
  /** Remove orphaned side-table rows after a confirmed user deletion. */
  purgeMemoryResidue?(userId: string, memoryId: string, logicalKey?: string, sourceRefs?: readonly unknown[]): Promise<void>;
  purgeUserMemoryResidue?(userId: string): Promise<readonly string[]>;
  /** Optional privacy export capability. Adapters return domain rows scoped
   * to the explicit principal; HTTP hosts must still project these rows to a
   * public DTO and fail closed if an adapter crosses the user boundary. */
  exportUserData?(userId: string): Promise<MemoryUserDataExport>;
  /** Minimal privacy-erasure seam. It may enumerate opaque IDs after consent
   * revocation without returning memory content to recall/UI paths. */
  listMemoryIdsForDeletion?(userId: string, limit?: number): Promise<readonly string[]>;
  /** Known session owners for a wildcard consent/deletion invalidation. Only
   * opaque session IDs cross this seam; a DO not present here is still
   * protected by the durable authorization marker on its next send. */
  listMemorySessionIds?(userId: string): Promise<readonly string[]>;
  listMemories(userId: string, query?: MemoryQuery): Promise<readonly MemoryRecord[]>;
  confirmMemory(userId: string, memoryId: string, confirmation?: MemoryConfirmation): Promise<MemoryRecord | undefined>;
  /** Optional derived-index seam; absence means semantic recall remains disabled. */
  saveEmbedding?(userId: string, input: MemoryEmbeddingWrite): Promise<void>;
  deleteMemoryEmbedding?(userId: string, memoryId: string, deletedAt?: string): Promise<void>;
}

/** Provider-neutral payload behind the optional privacy-export seam. */
export interface MemoryUserDataExport {
  readonly schemaVersion: "memory-export.v1";
  readonly exportedAt: string;
  readonly authorization?: MemoryAuthorization;
  readonly records: readonly MemoryRecord[];
  readonly events: readonly MemoryEvent[];
}

/** Result returned by a host that can make delete-all one storage commit. */
export interface MemoryDeleteAllResult {
  readonly deletedMemoryIds: readonly string[];
  readonly sessionIds: readonly string[];
  /** True when the response ID list was bounded; storage was still purged. */
  readonly idListLimited: boolean;
}

/** A cache is an optimization only; failures must never affect memory truth. */
export interface CacheProvider {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Provider-neutral payload for the optional derived pgvector index. */
export interface MemoryEmbeddingWrite {
  readonly memoryId: string;
  readonly embedding: readonly number[];
  readonly contentHash: string;
  readonly model: string;
  readonly sourceRevision: number;
  readonly createdAt?: string;
}

/** Deliberately boring first implementation: no second source of truth. */
export class NoopCacheProvider implements CacheProvider {
  async get<T>(_key: string): Promise<T | undefined> {
    return undefined;
  }

  async set<T>(_key: string, _value: T, _ttlSeconds?: number): Promise<void> {
    // no-op by design
  }

  async delete(_key: string): Promise<void> {
    // no-op by design
  }

  async invalidate(_key: string): Promise<void> {
    // no-op alias for adapters that use cache invalidation terminology
  }

  async clear(): Promise<void> {
    // no-op by design
  }
}

export interface EmbeddingProvider {
  embed(text: string): Promise<readonly number[]>;
  embedMany?(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  /** Optional model label persisted beside a derived vector. */
  readonly model?: string;
  /** Optional deterministic content hash override for the derived vector. */
  readonly contentHash?: (text: string) => string;
}

/** Optional persistence hook for anonymous principal consent. */
export interface MemoryAuthorizationStore {
  getAuthorization(userId: string): Promise<MemoryAuthorization | undefined>;
  setAuthorization(userId: string, authorization: MemoryAuthorization): Promise<void>;
}
