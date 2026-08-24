import { IDBFactory as FakeIndexedDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbCheckpointSaver } from "./indexeddb-checkpoint";

function checkpoint(id: string) {
  return {
    v: 4,
    id,
    ts: `2026-08-24T00:00:0${id}Z`,
    channel_values: { agent: { id, nested: { serialized: true } } },
    channel_versions: { agent: id },
    versions_seen: {},
  };
}

const metadata = {
  source: "loop" as const,
  step: 1,
  parents: {},
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("IndexedDbCheckpointSaver", () => {
  it("reconstructs a v4 checkpoint and typed pending writes in a new saver instance", async () => {
    const indexedDB = new FakeIndexedDBFactory() as unknown as IDBFactory;
    const databaseName = "coach-agent-cross-runtime-1";
    const config = { configurable: { thread_id: "thread-1" } };
    const first = new IndexedDbCheckpointSaver({ indexedDB, databaseName });
    const savedConfig = await first.put(config, checkpoint("0001"), metadata, { agent: "0001" });
    await first.putWrites(savedConfig, [["tool-result", { status: "SUCCEEDED", nested: true }]], "task-1");
    await first.close();

    const second = new IndexedDbCheckpointSaver({ indexedDB, databaseName });
    const tuple = await second.getTuple(config);
    expect(tuple?.checkpoint.v).toBe(4);
    expect(tuple?.checkpoint.channel_values.agent).toEqual({
      id: "0001",
      nested: { serialized: true },
    });
    expect(tuple?.pendingWrites).toEqual([
      ["task-1", "tool-result", { status: "SUCCEEDED", nested: true }],
    ]);
    await second.close();
  });

  it("retains latest checkpoints with pending writes, orders list newest-first, and handles limit/delete", async () => {
    const indexedDB = new FakeIndexedDBFactory() as unknown as IDBFactory;
    const databaseName = "coach-agent-retention-1";
    const saver = new IndexedDbCheckpointSaver({ indexedDB, databaseName, retention: 2 });
    const config = { configurable: { thread_id: "thread-retention" } };

    for (const id of ["0001", "0002", "0003"]) {
      const savedConfig = await saver.put(config, checkpoint(id), metadata, { agent: id });
      await saver.putWrites(savedConfig, [["result", { id }]], `task-${id}`);
    }

    expect(await collect(saver.list(config, { limit: 0 }))).toEqual([]);
    const listed = await collect(saver.list(config));
    expect(listed.map((item) => item.checkpoint.id)).toEqual(["0003", "0002"]);
    expect(await saver.getTuple({ configurable: { thread_id: "thread-retention", checkpoint_id: "0001" } })).toBeUndefined();

    const latest = await saver.getTuple(config);
    expect(latest?.checkpoint.id).toBe("0003");
    expect(latest?.pendingWrites).toEqual([["task-0003", "result", { id: "0003" }]]);

    await saver.deleteThread("thread-retention");
    expect(await saver.getTuple(config)).toBeUndefined();
    await saver.close();
  });
});
