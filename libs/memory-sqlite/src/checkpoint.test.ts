import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteCheckpointSaver } from "./checkpoint";
import { SqliteDatabaseOwner } from "./database";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function checkpoint(id: string) {
  return {
    v: 4 as const,
    id,
    ts: `2026-08-30T00:00:${id}Z`,
    channel_values: {
      agent: { id, memoryBrief: { limitations: ["must-not-persist"] } },
      typed: new Uint8Array([1, 2, 3]),
    },
    channel_versions: { agent: id },
    versions_seen: {},
  };
}
const metadata = { source: "loop" as const, step: 1, parents: {} };
async function collect<T>(iterable: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
describe("SqliteCheckpointSaver", () => {
  it("round-trips typed values and pending writes, strips briefs, retains 20/3, and preserves identity across saver restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cs-agent-checkpoint-"));
    cleanup.push(directory);
    const owner = new SqliteDatabaseOwner({
      path: join(directory, "db.sqlite3"),
    });
    const saver = new SqliteCheckpointSaver({
      owner,
      retention: 2,
      completedRetention: 1,
    });
    const config = {
      configurable: { thread_id: "thread-a", checkpoint_ns: "cue" },
    };
    for (const id of ["01", "02", "03"]) {
      const saved = await saver.put(config, checkpoint(id), metadata, {
        agent: id,
      });
      await saver.putWrites(
        saved,
        [["tool", { id, bytes: new Uint8Array([4, 5]) }]],
        `task-${id}`,
      );
      await saver.putWrites(saved, [["tool", { id: "ignored" }]], `task-${id}`);
    }
    const listed = await collect(saver.list(config));
    expect(listed.map((tuple) => tuple.checkpoint.id)).toEqual(["03", "02"]);
    const latest = await saver.getTuple(config);
    expect(
      (latest?.checkpoint.channel_values.agent as Record<string, unknown>)
        .memoryBrief,
    ).toBeUndefined();
    expect(latest?.checkpoint.channel_values.typed).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(latest?.pendingWrites).toEqual([
      ["task-03", "tool", { id: "03", bytes: new Uint8Array([4, 5]) }],
    ]);
    const restarted = new SqliteCheckpointSaver({ owner });
    expect((await restarted.getTuple(config))?.checkpoint.id).toBe("03");
    await restarted.deleteThread("thread-a");
    expect(await restarted.getTuple(config)).toBeUndefined();
    await owner.close();
  });
});
