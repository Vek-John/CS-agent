import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import {
  DurableObjectCheckpointSaver,
  type DurableObjectStorageLike,
} from "./durable-object-checkpoint";
import { createCoachAgentRuntime } from "./runtime";
import { fixtureIdentity, resumeEvent, startCueEvent } from "./test-fixtures";

class FakeDurableObjectStorage implements DurableObjectStorageLike {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const prefix = options.prefix ?? "";
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, value as T]),
    );
  }
}

function checkpoint(id: string) {
  return {
    v: 4,
    id,
    ts: `2026-08-24T00:00:0${id}Z`,
    channel_values: { agent: { id, compact: true } },
    channel_versions: { agent: id },
    versions_seen: {},
  };
}

const metadata = { source: "loop" as const, step: 1, parents: {} };

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("DurableObjectCheckpointSaver", () => {
  it("uses LangGraph typed serializer, retains per namespace, and deletes a thread", async () => {
    const storage = new FakeDurableObjectStorage();
    const saver = new DurableObjectCheckpointSaver({ storage, retention: 2 });
    const config = { configurable: { thread_id: "thread-do", checkpoint_ns: "cue" } };
    for (const id of ["0001", "0002", "0003"]) {
      const saved = await saver.put(config, checkpoint(id), metadata, { agent: id });
      await saver.putWrites(saved, [["tool", { id, nested: true }]], `task-${id}`);
    }

    const listed = await collect(saver.list(config));
    expect(listed.map((item) => item.checkpoint.id)).toEqual(["0003", "0002"]);
    expect(await saver.getTuple({ configurable: { ...config.configurable, checkpoint_id: "0001" } })).toBeUndefined();
    expect((await saver.getTuple(config))?.pendingWrites).toEqual([
      ["task-0003", "tool", { id: "0003", nested: true }],
    ]);
    expect(JSON.stringify([...storage.values.values()])).not.toContain("frames");
    expect(JSON.stringify([...storage.values.values()])).not.toContain("prompt");

    await saver.deleteThread("thread-do");
    expect(await saver.getTuple(config)).toBeUndefined();
    expect((await saver.list(config).next()).done).toBe(true);
  });

  it("rebuilds runtime A/B over the same storage and executes one resume side effect", async () => {
    const storage = new FakeDurableObjectStorage();
    const runtimeA = createCoachAgentRuntime({
      checkpointer: new DurableObjectCheckpointSaver({ storage }),
      checkpointBackend: "DURABLE_OBJECT",
    });
    const started = await runtimeA.dispatch(startCueEvent());
    expect(started.checkpoint).toMatchObject({ backend: "DURABLE_OBJECT", recoverableAfterRefresh: true });

    const runtimeB = createCoachAgentRuntime({
      checkpointer: new DurableObjectCheckpointSaver({ storage }),
      checkpointBackend: "DURABLE_OBJECT",
    });
    let sideEffects = 0;
    const request = started.effects[0];
    sideEffects += 1;
    const resume = resumeEvent(request, { eventId: "do-resume-1" });
    const completed = await runtimeB.dispatch(resume);
    const duplicate = await runtimeB.dispatch(resume);

    expect(completed.status).toBe("COMPLETED");
    expect(completed.checkpoint.backend).toBe("DURABLE_OBJECT");
    expect(completed.checkpoint.recoverableAfterRefresh).toBe(true);
    expect(completed.state.activeCueId).toBe("cue-17");
    expect(completed.state.currentSessionPhase).toBe("PAUSED_FOR_COACHING");
    expect(completed.effects).toEqual([]);
    expect(duplicate.effects).toEqual([]);
    expect(sideEffects).toBe(1);
  });

  it("rejects a route-hash-mismatched resume instead of restoring the old run", async () => {
    const storage = new FakeDurableObjectStorage();
    const runtime = createCoachAgentRuntime({
      checkpointer: new DurableObjectCheckpointSaver({ storage }),
      checkpointBackend: "DURABLE_OBJECT",
    });
    const started = await runtime.dispatch(startCueEvent());
    const changedIdentity = { ...fixtureIdentity, routeId: "route-do-2", routeHash: "hash-do-2" };
    await runtime.dispatch(startCueEvent({ identity: changedIdentity, eventId: "do-start-2" }));
    const stale = await runtime.dispatch(
      resumeEvent(started.effects[0], { identity: fixtureIdentity, eventId: "do-stale-resume" }),
    );
    expect(stale.status).toBe("DORMANT");
    expect(stale.restored).toBe("DORMANT_IDENTITY_MISMATCH");
    expect(stale.checkpoint.backend).toBe("DURABLE_OBJECT");
    expect(stale.state.fallbackReasons).toContain("ROUTE_HASH_MISMATCH");
  });

  it("keeps the runtime interface dispatch-only when using a DO saver", () => {
    const runtime = createCoachAgentRuntime({
      checkpointer: new MemorySaver(),
      checkpointBackend: "DURABLE_OBJECT",
    });
    expect(Object.keys(runtime)).toEqual(["dispatch"]);
  });
});
