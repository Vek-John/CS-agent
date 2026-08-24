import { describe, expect, it } from "vitest";
import { compactCompletedCoachRunState } from "./checkpoint-compaction";
import {
  DurableObjectCheckpointSaver,
  type DurableObjectStorageLike,
} from "./durable-object-checkpoint";
import { createCoachAgentRuntime } from "./runtime";
import { fixtureIdentity, resumeEvent, startCueEvent } from "./test-fixtures";

class FakeStorage implements DurableObjectStorageLike {
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

function checkpoint(id: string, agent: unknown, event: unknown = { type: "ACTIVE_EVENT" }) {
  return {
    v: 4,
    id,
    ts: `2026-08-24T00:00:${id.slice(-2)}Z`,
    channel_values: { agent, event },
    channel_versions: { agent: id, event: id },
    versions_seen: {},
  } as never;
}

function completeEvent() {
  return {
    version: "coach-agent-event.v2" as const,
    type: "COMPLETE_SESSION" as const,
    eventId: "completion-compaction-session-complete",
    identity: fixtureIdentity,
  };
}

describe("DurableObjectCheckpointSaver completion compaction", () => {
  it("keeps an active interrupt and its pending writes under the 20-checkpoint retention", async () => {
    const storage = new FakeStorage();
    const saver = new DurableObjectCheckpointSaver({ storage, completedRetention: 3 });
    const runtime = createCoachAgentRuntime({ checkpointer: saver, checkpointBackend: "DURABLE_OBJECT" });
    const started = await runtime.dispatch(startCueEvent());
    expect(started.status).toBe("WAITING_TOOL");

    const config = { configurable: { thread_id: "active-thread", checkpoint_ns: "active" } };
    for (let index = 1; index <= 21; index += 1) {
      const saved = await saver.put(
        config,
        checkpoint(String(index).padStart(4, "0"), { schemaVersion: "running-state", runStatus: "WAITING_TOOL" }),
        { source: "input", step: index, parents: {} },
        {},
      );
      await saver.putWrites(saved, [["pending_tool", { callId: `active-${index}` }]], `active-task-${String(index).padStart(4, "0")}`);
    }
    const retained = [];
    for await (const item of saver.list(config)) retained.push(item);
    expect(retained).toHaveLength(20);
    expect([...storage.values.keys()].some((key) => key.includes("active-task-0001"))).toBe(false);

    const activeTuple = await saver.getTuple({ configurable: { thread_id: "active-thread", checkpoint_ns: "active" } });
    expect(activeTuple?.pendingWrites).toEqual([
      ["active-task-0021", "pending_tool", { callId: "active-21" }],
    ]);

    const other = { configurable: { thread_id: "other-thread", checkpoint_ns: "other" } };
    const otherSaved = await saver.put(other, checkpoint("0001", { schemaVersion: "other-state" }), { source: "input", step: 1, parents: {} }, {});
    await saver.putWrites(otherSaved, [["other", { retained: true }]], "other-task");
    expect((await saver.getTuple(other))?.checkpoint.id).toBe("0001");
  });

  it("does not apply completed retention to RUNNING, WAITING_TOOL, USER_TAKEOVER or CANCELLED states", async () => {
    const sourceRuntime = createCoachAgentRuntime();
    const waiting = (await sourceRuntime.dispatch(startCueEvent())).state;
    const states = [
      { ...waiting, runStatus: "RUNNING" as const },
      waiting,
      { ...waiting, sessionStatus: "TAKEN_OVER" as const, runStatus: "USER_TAKEOVER" as const },
      { ...waiting, sessionStatus: "CANCELLED" as const, runStatus: "CANCELLED" as const },
    ];
    const saver = new DurableObjectCheckpointSaver({ storage: new FakeStorage(), retention: 20, completedRetention: 1 });
    const config = { configurable: { thread_id: "non-completed-thread", checkpoint_ns: "input" } };
    for (const [index, state] of states.entries()) {
      await saver.put(config, checkpoint(String(index + 1).padStart(4, "0"), state), { source: "input", step: index + 1, parents: {} }, {});
    }
    const retained = [];
    for await (const item of saver.list(config)) retained.push(item);
    expect(retained).toHaveLength(4);
  });

  it("compacts completed state, replaces the event channel, prunes to three and deletes writes with expired checkpoints", async () => {
    const sourceRuntime = createCoachAgentRuntime();
    const started = await sourceRuntime.dispatch(startCueEvent());
    const cueCompleted = await sourceRuntime.dispatch(resumeEvent(started.effects[0]!, { eventId: "compaction-source-resume" }));
    const completed = await sourceRuntime.dispatch(completeEvent());
    expect(completed.state.sessionStatus).toBe("COMPLETED");

    const storage = new FakeStorage();
    const saver = new DurableObjectCheckpointSaver({ storage, retention: 20 });
    const config = { configurable: { thread_id: "completed-thread", checkpoint_ns: "completed" } };
    for (let index = 1; index <= 21; index += 1) {
      const saved = await saver.put(
        config,
        checkpoint(String(index).padStart(4, "0"), cueCompleted.state, { type: "START_CUE", prompt: "old prompt" }),
        { source: "input", step: index, parents: {} },
        {},
      );
      await saver.putWrites(saved, [["old_write", { index }]], `completed-task-${String(index).padStart(4, "0")}`);
    }

    await saver.put(
      config,
      checkpoint("0022", completed.state, {
        type: "START_CUE",
        prompt: "must not survive compaction",
        rawReplay: { frames: ["must not survive"] },
        narration: "must not survive",
      }),
      { source: "input", step: 22, parents: {} },
      {},
    );

    const retained = [];
    for await (const item of saver.list(config)) retained.push(item);
    expect(retained).toHaveLength(3);
    const tuple = await saver.getTuple(config);
    expect(tuple?.checkpoint.id).toBe("0022");
    const agent = tuple?.checkpoint.channel_values.agent as typeof completed.state;
    expect(agent.sessionStatus).toBe("COMPLETED");
    expect(agent.runStatus).toBe("COMPLETED");
    expect(agent.routeHash).toBe(completed.state.routeHash);
    expect(agent.completedCueIds).toEqual(completed.state.completedCueIds);
    expect(agent.summaryThemes).toEqual(completed.state.summaryThemes);
    expect(agent.sessionSummaryInput).toEqual(completed.state.sessionSummaryInput);
    expect((tuple?.checkpoint.channel_values.event as { type?: string }).type).toBe("COMPLETE_SESSION");
    expect(JSON.stringify(tuple?.checkpoint.channel_values)).not.toContain("must not survive");
    expect([...storage.values.keys()].some((key) => key.includes("completed-task-0001"))).toBe(false);
    expect([...storage.values.keys()].some((key) => key.includes("completed-task-0019"))).toBe(false);
  });

  it("lets runtime B recover an interrupted cue and later read the compacted completed summary", async () => {
    const storage = new FakeStorage();
    const saverA = new DurableObjectCheckpointSaver({ storage, retention: 20, completedRetention: 3 });
    const runtimeA = createCoachAgentRuntime({ checkpointer: saverA, checkpointBackend: "DURABLE_OBJECT" });
    const started = await runtimeA.dispatch(startCueEvent());
    expect(started.checkpoint.recoverableAfterRefresh).toBe(true);

    const runtimeB = createCoachAgentRuntime({
      checkpointer: new DurableObjectCheckpointSaver({ storage, retention: 20, completedRetention: 3 }),
      checkpointBackend: "DURABLE_OBJECT",
    });
    const resumed = await runtimeB.dispatch(resumeEvent(started.effects[0]!, { eventId: "runtime-b-interrupt-resume" }));
    expect(resumed.status).toBe("COMPLETED");
    const completed = await runtimeB.dispatch(completeEvent());
    expect(completed.state.sessionStatus).toBe("COMPLETED");

    const runtimeC = createCoachAgentRuntime({
      checkpointer: new DurableObjectCheckpointSaver({ storage, retention: 20, completedRetention: 3 }),
      checkpointBackend: "DURABLE_OBJECT",
    });
    const restored = await runtimeC.dispatch(completeEvent());
    expect(restored.restored).toBe("MATCHED");
    expect(restored.state.sessionStatus).toBe("COMPLETED");
    expect(restored.state.sessionSummaryInput).toEqual(completed.state.sessionSummaryInput);
    expect(restored.state.completedCueIds).toEqual(completed.state.completedCueIds);
    expect(compactCompletedCoachRunState(restored.state).summaryThemes).toEqual(restored.state.summaryThemes);
  });
});
