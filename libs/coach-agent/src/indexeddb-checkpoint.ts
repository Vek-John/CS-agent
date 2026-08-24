import {
  BaseCheckpointSaver,
  copyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";

type PendingWrite = [string, unknown];

const CHECKPOINT_STORE = "checkpoints";
const WRITE_STORE = "writes";
const DATABASE_VERSION = 1;

interface StoredCheckpoint {
  key: string;
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId?: string;
  checkpointType: string;
  checkpointData: Uint8Array;
  metadataType: string;
  metadataData: Uint8Array;
}

interface StoredWrite {
  key: string;
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  taskId: string;
  writeIndex: number;
  channel: string;
  valueType: string;
  valueData: Uint8Array;
}

export interface IndexedDbCheckpointSaverOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
  retention?: number;
}

function keyForCheckpoint(
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
): string {
  return JSON.stringify([threadId, checkpointNs, checkpointId]);
}

function keyForWrite(
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  writeIndex: number,
): string {
  return JSON.stringify([
    threadId,
    checkpointNs,
    checkpointId,
    taskId,
    writeIndex,
  ]);
}

function requireThreadId(config: RunnableConfig): string {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("IndexedDbCheckpointSaver requires configurable.thread_id");
  }
  return threadId;
}

function checkpointNamespace(config: RunnableConfig): string {
  const value = config.configurable?.checkpoint_ns;
  return typeof value === "string" ? value : "";
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function defaultIndexedDbFactory(): IDBFactory | undefined {
  if (typeof globalThis === "undefined") return undefined;
  return globalThis.indexedDB;
}

/**
 * Stage 0 experiment only; production recovery is the Cloudflare Durable
 * Object saver. It stores LangGraph typed bytes and is never selected by the
 * default runtime path.
 */
export class IndexedDbCheckpointSaver extends BaseCheckpointSaver {
  private readonly databaseName: string;
  private readonly retention: number;
  private readonly database: Promise<IDBDatabase>;

  constructor(options: IndexedDbCheckpointSaverOptions = {}) {
    super();
    const factory = options.indexedDB ?? defaultIndexedDbFactory();
    if (!factory) {
      throw new Error("IndexedDB is unavailable; use MemorySaver explicitly or fallback");
    }
    this.databaseName = options.databaseName ?? "cs-coach-coach-agent";
    this.retention = Math.max(1, Math.floor(options.retention ?? 20));
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(this.databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CHECKPOINT_STORE)) {
          database.createObjectStore(CHECKPOINT_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(WRITE_STORE)) {
          database.createObjectStore(WRITE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
  }

  async close(): Promise<void> {
    (await this.database).close();
  }

  private async allCheckpoints(): Promise<StoredCheckpoint[]> {
    const database = await this.database;
    const transaction = database.transaction(CHECKPOINT_STORE, "readonly");
    return requestResult(transaction.objectStore(CHECKPOINT_STORE).getAll());
  }

  private async allWrites(): Promise<StoredWrite[]> {
    const database = await this.database;
    const transaction = database.transaction(WRITE_STORE, "readonly");
    return requestResult(transaction.objectStore(WRITE_STORE).getAll());
  }

  private async putCheckpoint(record: StoredCheckpoint): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(CHECKPOINT_STORE, "readwrite");
    transaction.objectStore(CHECKPOINT_STORE).put(record);
    await transactionResult(transaction);
  }

  private async storeWrites(records: StoredWrite[]): Promise<void> {
    if (records.length === 0) return;
    const database = await this.database;
    const transaction = database.transaction(WRITE_STORE, "readwrite");
    const store = transaction.objectStore(WRITE_STORE);
    for (const record of records) store.put(record);
    await transactionResult(transaction);
  }

  private async prune(threadId: string, checkpointNs: string): Promise<void> {
    const records = (await this.allCheckpoints())
      .filter((record) => record.threadId === threadId && record.checkpointNs === checkpointNs)
      .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId));
    const expired = records.slice(this.retention);
    if (expired.length === 0) return;
    const expiredKeys = new Set(expired.map((record) => record.key));
    const database = await this.database;
    const transaction = database.transaction(
      [CHECKPOINT_STORE, WRITE_STORE],
      "readwrite",
    );
    const checkpoints = transaction.objectStore(CHECKPOINT_STORE);
    const writes = transaction.objectStore(WRITE_STORE);
    for (const record of expired) checkpoints.delete(record.key);
    const allWritesRequest = writes.getAll();
    const allWrites = await requestResult(allWritesRequest);
    for (const record of allWrites as StoredWrite[]) {
      if (expiredKeys.has(keyForCheckpoint(record.threadId, record.checkpointNs, record.checkpointId))) {
        writes.delete(record.key);
      }
    }
    await transactionResult(transaction);
  }

  private async tupleFromRecord(
    record: StoredCheckpoint,
    config: RunnableConfig,
  ): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(
      record.checkpointType,
      record.checkpointData,
    )) as Checkpoint;
    const metadata = await this.serde.loadsTyped(record.metadataType, record.metadataData);
    const pendingWrites = (await this.allWrites())
      .filter(
        (write) =>
          write.threadId === record.threadId &&
          write.checkpointNs === record.checkpointNs &&
          write.checkpointId === record.checkpointId,
      )
      .sort((left, right) =>
        left.taskId === right.taskId
          ? left.writeIndex - right.writeIndex
          : left.taskId.localeCompare(right.taskId),
      )
      .map(async (write) => [
        write.taskId,
        write.channel,
        await this.serde.loadsTyped(write.valueType, write.valueData),
      ] as [string, string, unknown]);
    const resolvedPendingWrites = await Promise.all(pendingWrites);
    const tuple: CheckpointTuple = {
      config,
      checkpoint,
      metadata,
      pendingWrites: resolvedPendingWrites,
    };
    if (record.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: record.threadId,
          checkpoint_ns: record.checkpointNs,
          checkpoint_id: record.parentCheckpointId,
        },
      };
    }
    return tuple;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = requireThreadId(config);
    const checkpointNs = checkpointNamespace(config);
    const requestedId = config.configurable?.checkpoint_id;
    const records = (await this.allCheckpoints())
      .filter(
        (record) =>
          record.threadId === threadId &&
          record.checkpointNs === checkpointNs &&
          (requestedId === undefined || record.checkpointId === requestedId),
      )
      .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId));
    const record = records[0];
    if (!record) return undefined;
    const resolvedConfig = requestedId
      ? config
      : {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: record.checkpointId,
          },
        };
    return this.tupleFromRecord(record, resolvedConfig);
  }

  async *list(
    config: RunnableConfig,
    options: { limit?: number; before?: RunnableConfig; filter?: Record<string, unknown> } = {},
  ): AsyncGenerator<CheckpointTuple> {
    if (options.limit !== undefined && options.limit <= 0) return;
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;
    const beforeId = options.before?.configurable?.checkpoint_id;
    let records = await this.allCheckpoints();
    records = records
      .filter(
        (record) =>
          (threadId === undefined || record.threadId === threadId) &&
          (checkpointNs === undefined || record.checkpointNs === checkpointNs),
      )
      .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId));
    if (beforeId) {
      records = records.filter((record) => record.checkpointId < beforeId);
    }
    let yielded = 0;
    for (const record of records) {
      const tuple = await this.tupleFromRecord(record, {
        configurable: {
          thread_id: record.threadId,
          checkpoint_ns: record.checkpointNs,
          checkpoint_id: record.checkpointId,
        },
      });
      if (
        options.filter &&
        !Object.entries(options.filter).every(
          ([key, value]) => (tuple.metadata as Record<string, unknown> | undefined)?.[key] === value,
        )
      ) {
        continue;
      }
      yield tuple;
      yielded += 1;
      if (options.limit !== undefined && yielded >= options.limit) return;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, number | string>,
  ): Promise<RunnableConfig> {
    const threadId = requireThreadId(config);
    const checkpointNs = checkpointNamespace(config);
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [checkpointType, checkpointData] = await this.serde.dumpsTyped(preparedCheckpoint);
    const [metadataType, metadataData] = await this.serde.dumpsTyped(metadata);
    await this.putCheckpoint({
      key: keyForCheckpoint(threadId, checkpointNs, checkpoint.id),
      threadId,
      checkpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId: config.configurable?.checkpoint_id,
      checkpointType,
      checkpointData,
      metadataType,
      metadataData,
    });
    await this.prune(threadId, checkpointNs);
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = requireThreadId(config);
    const checkpointNs = checkpointNamespace(config);
    const checkpointId = config.configurable?.checkpoint_id;
    if (typeof checkpointId !== "string" || checkpointId.length === 0) {
      throw new Error("IndexedDbCheckpointSaver.putWrites requires checkpoint_id");
    }
    const records: StoredWrite[] = [];
    for (const [index, [channel, value]] of writes.entries()) {
      const [valueType, valueData] = await this.serde.dumpsTyped(value);
      records.push({
        key: keyForWrite(threadId, checkpointNs, checkpointId, taskId, index),
        threadId,
        checkpointNs,
        checkpointId,
        taskId,
        writeIndex: index,
        channel,
        valueType,
        valueData,
      });
    }
    await this.storeWrites(records);
  }

  async deleteThread(threadId: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(
      [CHECKPOINT_STORE, WRITE_STORE],
      "readwrite",
    );
    const checkpoints = transaction.objectStore(CHECKPOINT_STORE);
    const writes = transaction.objectStore(WRITE_STORE);
    const checkpointRequest = checkpoints.getAll();
    const writeRequest = writes.getAll();
    const [checkpointRecords, writeRecords] = await Promise.all([
      requestResult(checkpointRequest),
      requestResult(writeRequest),
    ]) as [StoredCheckpoint[], StoredWrite[]];
    for (const record of checkpointRecords) {
      if (record.threadId === threadId) checkpoints.delete(record.key);
    }
    for (const record of writeRecords) {
      if (record.threadId === threadId) writes.delete(record.key);
    }
    await transactionResult(transaction);
  }
}
