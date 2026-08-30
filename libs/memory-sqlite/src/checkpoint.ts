import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import {
  CoachAgentStateSchema,
  compactCompletedCoachRunState,
} from "@cs-coach/coach-agent";
import {
  SqliteDatabaseOwner,
  getSqliteDatabaseOwner,
  type SqliteDatabaseOptions,
} from "./database";

type PendingWrite = [string, unknown];
interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint_type: string;
  checkpoint_data: Uint8Array;
  metadata_type: string;
  metadata_data: Uint8Array;
}
function thread(config: RunnableConfig): string {
  const value = config.configurable?.thread_id;
  if (typeof value !== "string" || !value)
    throw new Error("SqliteCheckpointSaver requires configurable.thread_id");
  return value;
}
function namespace(config: RunnableConfig): string {
  return typeof config.configurable?.checkpoint_ns === "string"
    ? config.configurable.checkpoint_ns
    : "";
}
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (Buffer.isBuffer(value)) return new Uint8Array(value).slice();
  throw new Error("SQLITE_INVALID_CHECKPOINT_BYTES");
}
function stripBrief(checkpoint: Checkpoint): Checkpoint {
  const prepared = copyCheckpoint(checkpoint);
  for (const channel of ["agent", "event"]) {
    const value = prepared.channel_values?.[channel];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const { memoryBrief: _brief, ...rest } = value as Record<string, unknown>;
      void _brief;
      prepared.channel_values = { ...prepared.channel_values, [channel]: rest };
    }
  }
  return prepared;
}
function compact(checkpoint: Checkpoint): {
  checkpoint: Checkpoint;
  completed: boolean;
} {
  const agent = checkpoint.channel_values?.agent;
  const parsed = CoachAgentStateSchema.safeParse(agent);
  if (
    !parsed.success ||
    parsed.data.sessionStatus !== "COMPLETED" ||
    parsed.data.runStatus !== "COMPLETED"
  )
    return { checkpoint, completed: false };
  const state = compactCompletedCoachRunState(parsed.data);
  return {
    completed: true,
    checkpoint: {
      ...checkpoint,
      channel_values: {
        ...checkpoint.channel_values,
        agent: state,
        event: {
          version: "coach-agent-event.v2",
          type: "COMPLETE_SESSION",
          eventId: `checkpoint-compacted-${state.runId}`.slice(0, 160),
          identity: {
            runId: state.runId,
            sessionId: state.sessionId,
            demoId: state.demoId,
            demoContentHash: state.demoContentHash,
            selectedPlayerId: state.selectedPlayerId,
            routeId: state.routeId,
            routeHash: state.routeHash,
          },
        },
      },
    },
  };
}

export interface SqliteCheckpointSaverOptions extends SqliteDatabaseOptions {
  owner?: SqliteDatabaseOwner;
  retention?: number;
  completedRetention?: number;
}
export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  readonly owner: SqliteDatabaseOwner;
  private readonly retention: number;
  private readonly completedRetention: number;
  constructor(options: SqliteCheckpointSaverOptions = {}) {
    super();
    this.owner = options.owner ?? getSqliteDatabaseOwner(options);
    this.retention = Math.max(1, Math.floor(options.retention ?? 20));
    this.completedRetention = Math.min(
      this.retention,
      Math.max(1, Math.floor(options.completedRetention ?? 3)),
    );
  }
  private async tuple(
    row: CheckpointRow,
    config?: RunnableConfig,
  ): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(
      row.checkpoint_type,
      bytes(row.checkpoint_data),
    )) as Checkpoint;
    const metadata = await this.serde.loadsTyped(
      row.metadata_type,
      bytes(row.metadata_data),
    );
    const writes = this.owner.db
      .prepare(
        "SELECT task_id,channel,value_type,value_data FROM agent_checkpoint_writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? ORDER BY task_id,write_index",
      )
      .all(row.thread_id, row.checkpoint_ns, row.checkpoint_id) as Array<{
      task_id: string;
      channel: string;
      value_type: string;
      value_data: Uint8Array;
    }>;
    const pendingWrites = await Promise.all(
      writes.map(
        async (write) =>
          [
            write.task_id,
            write.channel,
            await this.serde.loadsTyped(
              write.value_type,
              bytes(write.value_data),
            ),
          ] as [string, string, unknown],
      ),
    );
    const resolved = config ?? {
      configurable: {
        thread_id: row.thread_id,
        checkpoint_ns: row.checkpoint_ns,
        checkpoint_id: row.checkpoint_id,
      },
    };
    return {
      config: resolved,
      checkpoint,
      metadata,
      pendingWrites,
      ...(row.parent_checkpoint_id
        ? {
            parentConfig: {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id,
              },
            },
          }
        : {}),
    };
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = thread(config),
      ns = namespace(config),
      id = config.configurable?.checkpoint_id;
    const row = (
      id
        ? this.owner.db
            .prepare(
              "SELECT * FROM agent_checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?",
            )
            .get(threadId, ns, id)
        : this.owner.db
            .prepare(
              "SELECT * FROM agent_checkpoints WHERE thread_id=? AND checkpoint_ns=? ORDER BY created_seq DESC LIMIT 1",
            )
            .get(threadId, ns)
    ) as CheckpointRow | undefined;
    return row ? this.tuple(row, id ? config : undefined) : undefined;
  }
  async *list(
    config: RunnableConfig,
    options: {
      limit?: number;
      before?: RunnableConfig;
      filter?: Record<string, unknown>;
    } = {},
  ): AsyncGenerator<CheckpointTuple> {
    if (options.limit !== undefined && options.limit <= 0) return;
    const values: Array<string | number> = [];
    const clauses: string[] = [];
    if (config.configurable?.thread_id) {
      clauses.push("thread_id=?");
      values.push(String(config.configurable.thread_id));
    }
    if (config.configurable?.checkpoint_ns !== undefined) {
      clauses.push("checkpoint_ns=?");
      values.push(String(config.configurable.checkpoint_ns));
    }
    if (options.before?.configurable?.checkpoint_id) {
      clauses.push("checkpoint_id<?");
      values.push(String(options.before.configurable.checkpoint_id));
    }
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 1000));
    values.push(limit);
    const rows = this.owner.db
      .prepare(
        `SELECT * FROM agent_checkpoints ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_seq DESC LIMIT ?`,
      )
      .all(...values) as unknown as CheckpointRow[];
    for (const row of rows) {
      const tuple = await this.tuple(row);
      if (
        options.filter &&
        !Object.entries(options.filter).every(
          ([key, value]) =>
            (tuple.metadata as Record<string, unknown> | undefined)?.[key] ===
            value,
        )
      )
        continue;
      yield tuple;
    }
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, string | number>,
  ): Promise<RunnableConfig> {
    const threadId = thread(config),
      ns = namespace(config);
    const prepared = compact(stripBrief(checkpoint));
    const [checkpointType, checkpointData] = await this.serde.dumpsTyped(
      prepared.checkpoint,
    );
    const [metadataType, metadataData] = await this.serde.dumpsTyped(metadata);
    await this.owner.enqueueWrite((db) => {
      db.prepare(
        "INSERT INTO agent_checkpoints(thread_id,checkpoint_ns,checkpoint_id,parent_checkpoint_id,checkpoint_type,checkpoint_data,metadata_type,metadata_data,completed) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,checkpoint_ns,checkpoint_id) DO UPDATE SET parent_checkpoint_id=excluded.parent_checkpoint_id,checkpoint_type=excluded.checkpoint_type,checkpoint_data=excluded.checkpoint_data,metadata_type=excluded.metadata_type,metadata_data=excluded.metadata_data,completed=excluded.completed",
      ).run(
        threadId,
        ns,
        checkpoint.id,
        config.configurable?.checkpoint_id ?? null,
        checkpointType,
        checkpointData,
        metadataType,
        metadataData,
        prepared.completed ? 1 : 0,
      );
      const keep = prepared.completed
        ? this.completedRetention
        : this.retention;
      db.prepare(
        "DELETE FROM agent_checkpoints WHERE thread_id=? AND checkpoint_ns=? AND created_seq NOT IN (SELECT created_seq FROM agent_checkpoints WHERE thread_id=? AND checkpoint_ns=? ORDER BY created_seq DESC LIMIT ?)",
      ).run(threadId, ns, threadId, ns, keep);
    });
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = thread(config),
      ns = namespace(config),
      checkpointId = config.configurable?.checkpoint_id;
    if (typeof checkpointId !== "string" || !checkpointId)
      throw new Error("SqliteCheckpointSaver.putWrites requires checkpoint_id");
    const serialized = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const [type, data] = await this.serde.dumpsTyped(value);
        return { channel, index, type, data };
      }),
    );
    await this.owner.enqueueWrite((db) => {
      for (const write of serialized)
        db.prepare(
          "INSERT OR IGNORE INTO agent_checkpoint_writes(thread_id,checkpoint_ns,checkpoint_id,task_id,write_index,channel,value_type,value_data) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          threadId,
          ns,
          checkpointId,
          taskId,
          write.index,
          write.channel,
          write.type,
          write.data,
        );
    });
  }
  async deleteThread(threadIdInput: string): Promise<void> {
    const threadId = String(threadIdInput).trim();
    if (!threadId) throw new Error("INVALID_THREAD_ID");
    await this.owner.enqueueWrite((db) => {
      db.prepare("DELETE FROM agent_checkpoints WHERE thread_id=?").run(
        threadId,
      );
    });
  }
}

const savers = new Map<string, SqliteCheckpointSaver>();
export function getSqliteCheckpointSaver(
  options: SqliteCheckpointSaverOptions = {},
): SqliteCheckpointSaver {
  const owner = options.owner ?? getSqliteDatabaseOwner(options);
  const existing = savers.get(owner.path);
  if (existing && !existing.owner.isClosed) return existing;
  if (existing?.owner.isClosed) savers.delete(owner.path);
  const saver = new SqliteCheckpointSaver({ ...options, owner });
  savers.set(owner.path, saver);
  return saver;
}
