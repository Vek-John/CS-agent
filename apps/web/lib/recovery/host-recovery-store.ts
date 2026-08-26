import {
  SessionRecoveryRecordSchema,
  type SessionRecoveryRecord,
} from "@cs-coach/coach-agent/client";

export const HOST_RECOVERY_DB_NAME = "cs-coach-host-recovery";
export const HOST_RECOVERY_DB_VERSION = 1;
export const HOST_RECOVERY_OBJECT_STORE = "session-recovery-records";
export const HOST_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HOST_RECOVERY_MAX_RECORDS = 3;
export const HOST_RECOVERY_OPEN_TIMEOUT_MS = 1_500;

export interface HostRecoveryStoreOptions {
  readonly databaseName?: string;
  readonly indexedDB?: IDBFactory | null;
  readonly now?: () => number;
  readonly openTimeoutMs?: number;
}

export interface HostRecoveryStoreStatus {
  readonly persistence: "INDEXEDDB" | "MEMORY";
  readonly degraded: boolean;
  readonly reason: string | null;
}

type RecordUpdate = (record: SessionRecoveryRecord | undefined) => SessionRecoveryRecord | undefined;

interface RecordStoreBackend {
  get(recoveryId: string): Promise<SessionRecoveryRecord | undefined>;
  boot(now: number): Promise<SessionRecoveryRecord | undefined>;
  upsert(record: SessionRecoveryRecord, now: number): Promise<SessionRecoveryRecord>;
  update(recoveryId: string, update: RecordUpdate, now: number): Promise<SessionRecoveryRecord | undefined>;
  delete(recoveryId: string): Promise<void>;
}

function parseRecord(value: unknown): SessionRecoveryRecord {
  return SessionRecoveryRecordSchema.parse(value);
}

interface StoredRecordRow {
  readonly key?: string;
  readonly record?: SessionRecoveryRecord;
}

function storedRecoveryId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const recoveryId = (value as { recoveryId?: unknown }).recoveryId;
  return typeof recoveryId === "string" && recoveryId.length > 0 && recoveryId.length <= 160
    ? recoveryId
    : undefined;
}

/** Parse IDB values inside the request callback; never throw out of an event. */
function storedRecordRow(value: unknown): StoredRecordRow {
  const key = storedRecoveryId(value);
  try {
    return { key, record: parseRecord(value) };
  } catch {
    // The caller removes this key in the same read-write transaction. A
    // malformed key cannot be recovered safely, so it is simply ignored.
    return { key };
  }
}

function storedRecordRows(values: readonly unknown[]): StoredRecordRow[] {
  return values.map(storedRecordRow);
}

function sortAndLimit(records: readonly SessionRecoveryRecord[], now: number): SessionRecoveryRecord[] {
  const cutoff = now - HOST_RECOVERY_TTL_MS;
  return records
    .filter((record) => record.status === "INCOMPLETE" && record.updatedAt >= cutoff)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, HOST_RECOVERY_MAX_RECORDS);
}

function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : "IndexedDB 不可用";
}

class MemoryRecordStore implements RecordStoreBackend {
  private readonly records = new Map<string, SessionRecoveryRecord>();

  get(recoveryId: string): Promise<SessionRecoveryRecord | undefined> {
    return Promise.resolve(this.records.get(recoveryId));
  }

  boot(now: number): Promise<SessionRecoveryRecord | undefined> {
    const kept = sortAndLimit([...this.records.values()], now);
    this.records.clear();
    kept.forEach((record) => this.records.set(record.recoveryId, record));
    return Promise.resolve(kept[0]);
  }

  upsert(record: SessionRecoveryRecord, now: number): Promise<SessionRecoveryRecord> {
    this.records.set(record.recoveryId, record);
    const kept = sortAndLimit([...this.records.values()], now);
    this.records.clear();
    kept.forEach((entry) => this.records.set(entry.recoveryId, entry));
    return Promise.resolve(record);
  }

  update(recoveryId: string, update: RecordUpdate, now: number): Promise<SessionRecoveryRecord | undefined> {
    const next = update(this.records.get(recoveryId));
    if (next) this.records.set(recoveryId, next);
    else this.records.delete(recoveryId);
    const kept = sortAndLimit([...this.records.values()], now);
    this.records.clear();
    kept.forEach((entry) => this.records.set(entry.recoveryId, entry));
    return Promise.resolve(next);
  }

  delete(recoveryId: string): Promise<void> {
    this.records.delete(recoveryId);
    return Promise.resolve();
  }
}

class IndexedDbRecordStore implements RecordStoreBackend {
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly factory: IDBFactory,
    private readonly databaseName: string,
    private readonly openTimeoutMs: number,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = this.factory.open(this.databaseName, HOST_RECOVERY_DB_VERSION);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const timer = setTimeout(() => finish(() => reject(new Error("IndexedDB open timed out"))), this.openTimeoutMs);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(HOST_RECOVERY_OBJECT_STORE)) {
          database.createObjectStore(HOST_RECOVERY_OBJECT_STORE, { keyPath: "recoveryId" });
        }
      };
      request.onblocked = () => {
        // A stale tab must never hold the current replay hostage. The timeout
        // above turns this into the normal memory/degraded path.
      };
      request.onerror = () => finish(() => {
        clearTimeout(timer);
        reject(request.error ?? new Error("IndexedDB open failed"));
      });
      request.onsuccess = () => finish(() => {
        clearTimeout(timer);
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      });
    });
    this.databasePromise = opening.catch((error: unknown) => {
      this.databasePromise = undefined;
      throw error;
    });
    return this.databasePromise;
  }

  private transaction<T>(
    mode: IDBTransactionMode,
    operation: (objectStore: IDBObjectStore, resolveValue: (value: T) => void) => void,
  ): Promise<T> {
    const work = this.open().then((database) => new Promise<T>((resolve, reject) => {
      let value: T | undefined;
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(HOST_RECOVERY_OBJECT_STORE, mode);
        const objectStore = transaction.objectStore(HOST_RECOVERY_OBJECT_STORE);
        operation(objectStore, (nextValue) => { value = nextValue; });
      } catch (error) {
        reject(error);
        return;
      }
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      transaction.onerror = () => finish(() => reject(transaction.error ?? new Error("IndexedDB transaction failed")));
      transaction.onabort = () => finish(() => reject(transaction.error ?? new Error("IndexedDB transaction aborted")));
      transaction.oncomplete = () => finish(() => resolve(value as T));
    }));
    return runWithTimeout(work, this.openTimeoutMs, "IndexedDB transaction");
  }

  get(recoveryId: string): Promise<SessionRecoveryRecord | undefined> {
    return this.transaction<SessionRecoveryRecord | undefined>("readwrite", (objectStore, resolveValue) => {
      const request = objectStore.get(recoveryId);
      request.onsuccess = () => {
        if (!request.result) {
          resolveValue(undefined);
          return;
        }
        const row = storedRecordRow(request.result);
        if (!row.record) objectStore.delete(recoveryId);
        resolveValue(row.record);
      };
      // Let the transaction-level handler reject the operation. Throwing from
      // an IDB request callback can escape the Promise boundary in browsers.
      request.onerror = () => undefined;
    });
  }

  boot(now: number): Promise<SessionRecoveryRecord | undefined> {
    return this.transaction<SessionRecoveryRecord | undefined>("readwrite", (objectStore, resolveValue) => {
      const request = objectStore.getAll();
      request.onsuccess = () => {
        const rows = storedRecordRows(request.result);
        const records = rows.flatMap((row) => row.record ? [row.record] : []);
        const kept = sortAndLimit(records, now);
        const keepIds = new Set(kept.map((record) => record.recoveryId));
        rows.forEach((row) => {
          if (row.key && (!row.record || !keepIds.has(row.key))) objectStore.delete(row.key);
        });
        resolveValue(kept[0]);
      };
      request.onerror = () => undefined;
    });
  }

  upsert(record: SessionRecoveryRecord, now: number): Promise<SessionRecoveryRecord> {
    return this.transaction<SessionRecoveryRecord>("readwrite", (objectStore, resolveValue) => {
      const request = objectStore.getAll();
      request.onsuccess = () => {
        const rows = storedRecordRows(request.result);
        const records = rows.flatMap((row) => row.record && row.record.recoveryId !== record.recoveryId ? [row.record] : []);
        records.push(record);
        const kept = sortAndLimit(records, now);
        const keepIds = new Set(kept.map((entry) => entry.recoveryId));
        rows.forEach((row) => {
          if (row.key && (!row.record || !keepIds.has(row.key))) objectStore.delete(row.key);
        });
        if (keepIds.has(record.recoveryId)) objectStore.put(record);
        resolveValue(record);
      };
      request.onerror = () => undefined;
    });
  }

  update(recoveryId: string, update: RecordUpdate, now: number): Promise<SessionRecoveryRecord | undefined> {
    return this.transaction<SessionRecoveryRecord | undefined>("readwrite", (objectStore, resolveValue) => {
      const request = objectStore.get(recoveryId);
      request.onsuccess = () => {
        const current = request.result ? storedRecordRow(request.result).record : undefined;
        if (request.result && !current) objectStore.delete(recoveryId);
        const next = update(current);
        if (next) {
          const allRequest = objectStore.getAll();
          allRequest.onsuccess = () => {
            const rows = storedRecordRows(allRequest.result);
            const records = rows.flatMap((row) => row.record && row.record.recoveryId !== recoveryId ? [row.record] : []);
            records.push(next);
            const kept = sortAndLimit(records, now);
            const keepIds = new Set(kept.map((entry) => entry.recoveryId));
            rows.forEach((row) => {
              if (row.key && (!row.record || !keepIds.has(row.key))) objectStore.delete(row.key);
            });
            if (keepIds.has(recoveryId)) objectStore.put(next);
            resolveValue(next);
          };
          allRequest.onerror = () => undefined;
        } else {
          objectStore.delete(recoveryId);
          resolveValue(undefined);
        }
      };
      request.onerror = () => undefined;
    });
  }

  delete(recoveryId: string): Promise<void> {
    return this.transaction<void>("readwrite", (objectStore, resolveValue) => {
      objectStore.delete(recoveryId);
      resolveValue(undefined);
    });
  }
}

/**
 * Storage implementation hidden behind SessionRecoveryRuntime. It mirrors the
 * latest record into memory so an IndexedDB failure never interrupts playback.
 */
export class HostRecoveryStore {
  private readonly memory = new MemoryRecordStore();
  private primary: RecordStoreBackend | undefined;
  private readonly now: () => number;
  private degradedReason: string | null = null;

  constructor(options: HostRecoveryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    const factory = options.indexedDB === undefined
      ? (typeof indexedDB === "undefined" ? undefined : indexedDB)
      : options.indexedDB ?? undefined;
    if (factory) {
      this.primary = new IndexedDbRecordStore(
        factory,
        options.databaseName ?? HOST_RECOVERY_DB_NAME,
        options.openTimeoutMs ?? HOST_RECOVERY_OPEN_TIMEOUT_MS,
      );
    } else {
      this.degradedReason = "本地恢复存储不可用；刷新后不能恢复。";
    }
  }

  get status(): HostRecoveryStoreStatus {
    return {
      persistence: this.primary ? "INDEXEDDB" : "MEMORY",
      degraded: this.degradedReason !== null,
      reason: this.degradedReason,
    };
  }

  private failover(error: unknown): void {
    this.primary = undefined;
    this.degradedReason = `本地恢复存储不可用；刷新后不能恢复。${errorMessage(error)}`.slice(0, 200);
  }

  private async run<T>(operation: (backend: RecordStoreBackend) => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (!this.primary) return fallback();
    try {
      return await operation(this.primary);
    } catch (error) {
      this.failover(error);
      return fallback();
    }
  }

  async get(recoveryId: string): Promise<SessionRecoveryRecord | undefined> {
    return this.run(
      (backend) => backend.get(recoveryId).then((record) => {
        if (record) void this.memory.upsert(record, this.now());
        return record;
      }),
      () => this.memory.get(recoveryId),
    );
  }

  async boot(): Promise<SessionRecoveryRecord | undefined> {
    return this.run(
      (backend) => backend.boot(this.now()).then((record) => {
        if (record) void this.memory.upsert(record, this.now());
        return record;
      }),
      () => this.memory.boot(this.now()),
    );
  }

  async upsert(record: SessionRecoveryRecord): Promise<SessionRecoveryRecord> {
    const parsed = parseRecord(record);
    return this.run(
      (backend) => backend.upsert(parsed, this.now()).then((saved) => {
        void this.memory.upsert(saved, this.now());
        return saved;
      }),
      () => this.memory.upsert(parsed, this.now()),
    );
  }

  async update(recoveryId: string, update: RecordUpdate): Promise<SessionRecoveryRecord | undefined> {
    return this.run(
      (backend) => backend.update(recoveryId, (record) => {
        const next = update(record);
        return next ? parseRecord(next) : undefined;
      }, this.now()).then((next) => {
        if (next) void this.memory.upsert(next, this.now());
        return next;
      }),
      () => this.memory.update(recoveryId, (record) => {
        const next = update(record);
        return next ? parseRecord(next) : undefined;
      }, this.now()),
    );
  }

  async delete(recoveryId: string): Promise<void> {
    return this.run(
      (backend) => backend.delete(recoveryId).then(() => this.memory.delete(recoveryId)),
      () => this.memory.delete(recoveryId),
    );
  }
}
