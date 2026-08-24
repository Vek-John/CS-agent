import {
  BaseCheckpointSaver,
  copyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { compactCompletedCoachRunState } from "./checkpoint-compaction";
import { CoachAgentStateSchema } from "./types";

type PendingWrite = [string, unknown];

/** The only persistence surface required from a Durable Object host. */
export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

interface StoredCheckpoint {
  kind: "CHECKPOINT";
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
  kind: "WRITE";
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  taskId: string;
  writeIndex: number;
  channel: string;
  valueType: string;
  valueData: Uint8Array;
}

export interface DurableObjectCheckpointSaverOptions {
  storage: DurableObjectStorageLike;
  retention?: number;
  /** Completed sessions keep only a small recovery tail after compaction. */
  completedRetention?: number;
}

const CHECKPOINT_ROOT = "coach-agent:checkpoint:";
const WRITE_ROOT = "coach-agent:write:";

function encode(value: string): string {
  return encodeURIComponent(value);
}

function checkpointThreadPrefix(threadId: string): string {
  return `${CHECKPOINT_ROOT}${encode(threadId)}:`;
}

function checkpointPrefix(threadId: string, checkpointNs: string): string {
  return `${checkpointThreadPrefix(threadId)}${encode(checkpointNs)}:`;
}

function checkpointKey(threadId: string, checkpointNs: string, checkpointId: string): string {
  return `${checkpointPrefix(threadId, checkpointNs)}${encode(checkpointId)}`;
}

function writeThreadPrefix(threadId: string): string {
  return `${WRITE_ROOT}${encode(threadId)}:`;
}

function writePrefix(threadId: string, checkpointNs: string, checkpointId?: string): string {
  const base = `${writeThreadPrefix(threadId)}${encode(checkpointNs)}:`;
  return checkpointId === undefined ? base : `${base}${encode(checkpointId)}:`;
}

function writeKey(
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  writeIndex: number,
): string {
  return `${writePrefix(threadId, checkpointNs, checkpointId)}${encode(taskId)}:${writeIndex}`;
}

function requireThreadId(config: RunnableConfig): string {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("DurableObjectCheckpointSaver requires configurable.thread_id");
  }
  return threadId;
}

function namespaceOf(config: RunnableConfig): string {
  const value = config.configurable?.checkpoint_ns;
  return typeof value === "string" ? value : "";
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

/**
 * LangGraph checkpoint saver backed by a minimal Durable Object storage seam.
 * Only serialized graph/checkpoint values are persisted; raw Replay, frames,
 * prompts, model output, and secrets never enter this adapter.
 */
export class DurableObjectCheckpointSaver extends BaseCheckpointSaver {
  private readonly storage: DurableObjectStorageLike;
  private readonly retention: number;
  private readonly completedRetention: number;

  constructor(options: DurableObjectCheckpointSaverOptions) {
    super();
    this.storage = options.storage;
    this.retention = Math.max(1, Math.floor(options.retention ?? 20));
    this.completedRetention = Math.min(
      this.retention,
      Math.max(1, Math.floor(options.completedRetention ?? 3)),
    );
  }

  private async checkpoints(prefix: string): Promise<Map<string, StoredCheckpoint>> {
    return this.storage.list<StoredCheckpoint>({ prefix });
  }

  private async writes(prefix: string): Promise<Map<string, StoredWrite>> {
    return this.storage.list<StoredWrite>({ prefix });
  }

  private async prune(threadId: string, checkpointNs: string, retention: number): Promise<void> {
    const records = [...(await this.checkpoints(checkpointPrefix(threadId, checkpointNs))).entries()]
      .sort(([, left], [, right]) => right.checkpointId.localeCompare(left.checkpointId));
    const expired = records.slice(retention);
    await Promise.all(expired.map(async ([key, record]) => {
      await this.storage.delete(key);
      const storedWrites = await this.writes(
        writePrefix(threadId, checkpointNs, record.checkpointId),
      );
      await Promise.all([...storedWrites.keys()].map((writeKey) => this.storage.delete(writeKey)));
    }));
  }

  private compactCompletedCheckpoint(checkpoint: Checkpoint): {
    checkpoint: Checkpoint;
    completed: boolean;
  } {
    const agent = checkpoint.channel_values?.agent;
    const parsed = CoachAgentStateSchema.safeParse(agent);
    if (!parsed.success || parsed.data.sessionStatus !== "COMPLETED" || parsed.data.runStatus !== "COMPLETED") {
      return { checkpoint, completed: false };
    }

    const compacted = compactCompletedCoachRunState(parsed.data);
    const identity = {
      runId: compacted.runId,
      sessionId: compacted.sessionId,
      demoId: compacted.demoId,
      demoContentHash: compacted.demoContentHash,
      selectedPlayerId: compacted.selectedPlayerId,
      routeId: compacted.routeId,
      routeHash: compacted.routeHash,
    };
    const compactEvent = {
      version: "coach-agent-event.v2",
      type: "COMPLETE_SESSION",
      eventId: `checkpoint-compacted-${compacted.runId}`.slice(0, 160),
      identity,
    };
    return {
      completed: true,
      checkpoint: {
        ...checkpoint,
        channel_values: {
          ...checkpoint.channel_values,
          // Keep the event channel valid but replace any stale START_CUE
          // payload so prompts, narration and replay-shaped data cannot be
          // retained merely because LangGraph carried it in the last state.
          agent: compacted,
          event: compactEvent,
        },
      },
    };
  }

  private async tupleFromRecord(
    record: StoredCheckpoint,
    config: RunnableConfig,
  ): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(
      record.checkpointType,
      copyBytes(record.checkpointData),
    )) as Checkpoint;
    const metadata = await this.serde.loadsTyped(
      record.metadataType,
      copyBytes(record.metadataData),
    );
    const storedWrites = await this.writes(
      writePrefix(record.threadId, record.checkpointNs, record.checkpointId),
    );
    const pendingWrites = await Promise.all(
      [...storedWrites.values()]
        .sort((left, right) =>
          left.taskId === right.taskId
            ? left.writeIndex - right.writeIndex
            : left.taskId.localeCompare(right.taskId),
        )
        .map(async (write) => [
          write.taskId,
          write.channel,
          await this.serde.loadsTyped(write.valueType, copyBytes(write.valueData)),
        ] as [string, string, unknown]),
    );
    const tuple: CheckpointTuple = { config, checkpoint, metadata, pendingWrites };
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
    const checkpointNs = namespaceOf(config);
    const requestedId = config.configurable?.checkpoint_id;
    const records = requestedId
      ? new Map<string, StoredCheckpoint>([
          [
            checkpointKey(threadId, checkpointNs, requestedId),
            (await this.storage.get<StoredCheckpoint>(checkpointKey(threadId, checkpointNs, requestedId))) as StoredCheckpoint,
          ],
        ])
      : await this.checkpoints(checkpointPrefix(threadId, checkpointNs));
    const validRecords = [...records.entries()].filter(([, record]) => Boolean(record));
    validRecords.sort(([, left], [, right]) => right.checkpointId.localeCompare(left.checkpointId));
    const [key, record] = validRecords[0] ?? [];
    if (!key || !record) return undefined;
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
    const prefix =
      threadId === undefined
        ? CHECKPOINT_ROOT
        : checkpointNs === undefined
          ? checkpointThreadPrefix(threadId)
          : checkpointPrefix(threadId, checkpointNs);
    let records = [...(await this.checkpoints(prefix)).entries()]
      .sort(([, left], [, right]) => right.checkpointId.localeCompare(left.checkpointId));
    const beforeId = options.before?.configurable?.checkpoint_id;
    if (beforeId) records = records.filter(([, record]) => record.checkpointId < beforeId);
    let yielded = 0;
    for (const [key, record] of records) {
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
          ([name, value]) => (tuple.metadata as Record<string, unknown> | undefined)?.[name] === value,
        )
      ) continue;
      void key;
      yield tuple;
      yielded += 1;
      if (options.limit !== undefined && yielded >= options.limit) return;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, string | number>,
  ): Promise<RunnableConfig> {
    const threadId = requireThreadId(config);
    const checkpointNs = namespaceOf(config);
    const prepared = copyCheckpoint(checkpoint);
    const compacted = this.compactCompletedCheckpoint(prepared);
    const [checkpointType, checkpointData] = await this.serde.dumpsTyped(compacted.checkpoint);
    const [metadataType, metadataData] = await this.serde.dumpsTyped(metadata);
    await this.storage.put<StoredCheckpoint>(checkpointKey(threadId, checkpointNs, checkpoint.id), {
      kind: "CHECKPOINT",
      threadId,
      checkpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId: config.configurable?.checkpoint_id,
      checkpointType,
      checkpointData: copyBytes(checkpointData),
      metadataType,
      metadataData: copyBytes(metadataData),
    });
    await this.prune(threadId, checkpointNs, compacted.completed ? this.completedRetention : this.retention);
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = requireThreadId(config);
    const checkpointNs = namespaceOf(config);
    const checkpointId = config.configurable?.checkpoint_id;
    if (typeof checkpointId !== "string" || checkpointId.length === 0) throw new Error("DurableObjectCheckpointSaver.putWrites requires checkpoint_id");
    await Promise.all(
      writes.map(async ([channel, value], writeIndex) => {
        const key = writeKey(threadId, checkpointNs, checkpointId, taskId, writeIndex);
        if (await this.storage.get<StoredWrite>(key)) return;
        const [valueType, valueData] = await this.serde.dumpsTyped(value);
        await this.storage.put<StoredWrite>(key, {
          kind: "WRITE",
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          writeIndex,
          channel,
          valueType,
          valueData: copyBytes(valueData),
        });
      }),
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    const [checkpoints, writes] = await Promise.all([
      this.storage.list<StoredCheckpoint>({ prefix: checkpointThreadPrefix(threadId) }),
      this.storage.list<StoredWrite>({ prefix: writeThreadPrefix(threadId) }),
    ]);
    await Promise.all([
      ...[...checkpoints.keys()].map((key) => this.storage.delete(key)),
      ...[...writes.keys()].map((key) => this.storage.delete(key)),
    ]);
  }
}
