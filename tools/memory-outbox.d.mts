/** Type surface for the JavaScript Durable Object Outbox implementation. */
export interface MemoryOutboxStorage {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete?(key: string): Promise<boolean>;
  list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
}

export interface MemoryOutboxOptions {
  storage: MemoryOutboxStorage;
  sink?: (event: import("@cs-coach/memory").MemoryEvent, entry?: unknown) => unknown;
  now?: () => number | string | Date;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  batchSize?: number;
}

export class MemoryOutbox {
  constructor(options: MemoryOutboxOptions);
  enqueue(input: unknown): Promise<{ accepted: boolean; duplicate: boolean; entry: unknown; status: string }>;
  flush(options?: { force?: boolean; now?: number | string | Date; maxEntries?: number; beforeSend?: (entry: unknown) => unknown }): Promise<{
    attempted: number;
    delivered: number;
    retried: number;
    deadLettered: number;
    skipped: number;
    entries: readonly unknown[];
  }>;
  get(entryId: string): Promise<any>;
  invalidateMemory(memoryId: string, reason?: string, options?: { logicalKey?: string }): Promise<readonly unknown[]>;
}

export const MEMORY_OUTBOX_ENTRY_PREFIX: string;
export const MEMORY_OUTBOX_STATUS: Readonly<{
  PENDING: "PENDING";
  DELIVERED: "DELIVERED";
  RETRY: "RETRY";
  DEAD_LETTER: "DEAD_LETTER";
}>;
