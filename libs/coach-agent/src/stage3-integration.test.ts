import { describe, expect, it } from "vitest";
import {
  AgentToolRequestSchema,
  CoachAgentEventSchema,
  TeachingCapabilitySchema,
  type CoachAgentEvent,
  type CoachAgentIdentity,
  type TeachingCapability,
} from "./types";
import { FakePolicyAdapter } from "./adapters";
import { compactCompletedCoachRunState } from "./checkpoint-compaction";
import { DurableObjectCheckpointSaver, type DurableObjectStorageLike } from "./durable-object-checkpoint";
import { createCoachAgentRuntime } from "./runtime";
import { threadIdForIdentity } from "./identity";
import { fixtureIdentity, mapFocusCapability, resumeEvent, slowReplayCapability, startCueEvent } from "./test-fixtures";

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

const identity: CoachAgentIdentity = {
  ...fixtureIdentity,
  runId: "stage3-run",
  sessionId: "stage3-session",
  routeId: "stage3-route",
  routeHash: "sha256-stage3-route",
};

function slowForCue(cueId: string) {
  return TeachingCapabilitySchema.parse({
    ...slowReplayCapability,
    capabilityId: `cap-${cueId}-slow`,
    boundArgs: { ...slowReplayCapability.boundArgs, cueId },
  });
}

function mapForCue(cueId: string) {
  return TeachingCapabilitySchema.parse({
    ...mapFocusCapability,
    capabilityId: `cap-${cueId}-map`,
    boundArgs: { ...mapFocusCapability.boundArgs, cueId },
  });
}

function cueEvent(
  index: number,
  overrides: Partial<{
    eventId: string;
    cueId: string;
    segmentId: string;
    capabilities: TeachingCapability[];
    outcomeGateStatus: "LOCKED" | "COMPLETE" | "NOT_APPLICABLE";
    narrationReadiness: "NOT_REQUIRED" | "PENDING" | "READY" | "FALLBACK";
    resumeFromTakeover: boolean;
  }> = {},
): Extract<CoachAgentEvent, { type: "START_CUE" }> {
  const cueId = overrides.cueId ?? `cue-${index}`;
  const base = startCueEvent({
    identity,
    eventId: overrides.eventId ?? `stage3-cue-${index}-start`,
    cueId,
    segmentId: overrides.segmentId ?? `segment-${index}`,
    capabilities: overrides.capabilities ?? [slowForCue(cueId)],
    outcomeGateStatus: overrides.outcomeGateStatus,
    narrationReadiness: overrides.narrationReadiness,
  });
  return CoachAgentEventSchema.parse({
    ...base,
    version: "coach-agent-event.v2",
    routeSegmentIndex: index,
    segmentMode: "DEEP_DIVE",
    ...(overrides.resumeFromTakeover ? { resumeFromTakeover: true } : {}),
  }) as Extract<CoachAgentEvent, { type: "START_CUE" }>;
}

function observeEvent(eventId: string, segmentId: string, segmentIndex: number, mode: "SKIP" | "FREEZE" | "BRIEF") {
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: "OBSERVE_SEGMENT",
    eventId,
    identity,
    segmentId,
    segmentIndex,
    mode,
    currentSessionPhase: "PLAYING",
  });
}

function takeoverEvent(eventId: string) {
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: "USER_TAKEOVER",
    eventId,
    identity,
    cueId: "cue-takeover",
    reason: "USER_PAUSED_MANUAL_CONTROL",
  });
}

function cancelEvent(eventId: string) {
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: "CANCEL_RUN",
    eventId,
    identity,
    reason: "USER_CANCELLED",
  });
}

function completeEvent(eventId: string) {
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: "COMPLETE_SESSION",
    eventId,
    identity,
  });
}

describe("Stage 3 Coach Agent integration seam", () => {
  it("advances three cues on one frozen identity and deduplicates START/RESUME side effects", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("policy must not run for one capability") });
    const runtime = createCoachAgentRuntime({ policy });
    const completedCueIds: string[] = [];

    for (let index = 0; index < 3; index += 1) {
      const event = cueEvent(index);
      const started = await runtime.dispatch(event);
      expect(started.state.routeHash).toBe(identity.routeHash);
      expect(started.state.routeCursor).toBe(index);
      expect(started.effects).toHaveLength(1);

      const request = AgentToolRequestSchema.parse(started.effects[0]);
      const compactRequest = JSON.stringify(request);
      expect(compactRequest).not.toMatch(/boundArgs|tick|coordinate|player|frames|prompt/i);
      const completed = await runtime.dispatch(resumeEvent(request, { identity, eventId: `stage3-cue-${index}-resume` }));
      expect(completed.state.runStatus).toBe("CUE_COMPLETED");
      completedCueIds.push(event.cueId);

      const duplicateStart = await runtime.dispatch(event);
      expect(duplicateStart.effects).toEqual([]);
      const duplicateResume = await runtime.dispatch(resumeEvent(request, { identity, eventId: `stage3-cue-${index}-resume-duplicate` }));
      expect(duplicateResume.effects).toEqual([]);
    }

    expect(policy.calls).toHaveLength(0);
    const finished = await runtime.dispatch(completeEvent("stage3-session-complete"));
    expect(finished.status).toBe("COMPLETED");
    expect(finished.state.completedCueIds).toEqual(completedCueIds);
    expect(finished.state.summaryThemes).toHaveLength(1);
    expect(finished.state.summaryThemes[0]?.cueRefs).toEqual(completedCueIds);
  });

  it("keeps ordinary SKIP/FREEZE/BRIEF and a locked gate out of Policy, while preserving route cursor", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("ordinary route must not call Policy") });
    const runtime = createCoachAgentRuntime({ policy });

    const freeze = await runtime.dispatch(observeEvent("stage3-freeze", "segment-freeze", 0, "FREEZE"));
    const skip = await runtime.dispatch(observeEvent("stage3-skip", "segment-skip", 1, "SKIP"));
    const brief = await runtime.dispatch(observeEvent("stage3-brief", "segment-brief", 2, "BRIEF"));
    const duplicate = await runtime.dispatch(observeEvent("stage3-brief-duplicate", "segment-brief", 2, "BRIEF"));
    const locked = await runtime.dispatch(cueEvent(3, {
      capabilities: [slowForCue("cue-locked"), mapForCue("cue-locked")],
      cueId: "cue-locked",
      segmentId: "segment-locked",
      outcomeGateStatus: "LOCKED",
      narrationReadiness: "PENDING",
    }));

    expect(freeze.state.routeCursor).toBe(0);
    expect(skip.state.routeCursor).toBe(1);
    expect(brief.state.routeCursor).toBe(2);
    expect(duplicate.state.routeCursor).toBe(2);
    expect(locked.effects).toEqual([]);
    expect(policy.calls).toHaveLength(0);
  });

  it("completes a provider-all-failure run and allows at most one rule alternative on cue two", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("provider unavailable") });
    const runtime = createCoachAgentRuntime({ policy });

    const first = await runtime.dispatch(cueEvent(0, {
      cueId: "cue-provider-one",
      capabilities: [slowForCue("cue-provider-one"), mapForCue("cue-provider-one")],
    }));
    expect(first.state.selectedTeachingMove?.source).toBe("FALLBACK");
    const firstDone = await runtime.dispatch(resumeEvent(first.effects[0]!, { identity, eventId: "provider-one-done" }));
    expect(firstDone.state.toolHistory).toHaveLength(1);

    const second = await runtime.dispatch(cueEvent(1, {
      cueId: "cue-provider-two",
      capabilities: [slowForCue("cue-provider-two"), mapForCue("cue-provider-two")],
    }));
    const secondFailed = await runtime.dispatch(resumeEvent(second.effects[0]!, { identity, eventId: "provider-two-first-failed", status: "FAILED" }));
    expect(secondFailed.state.policyBudget.alternativeAttempts).toBe(1);
    expect(secondFailed.effects).toHaveLength(1);
    const secondDone = await runtime.dispatch(resumeEvent(secondFailed.effects[0]!, { identity, eventId: "provider-two-alternative-done" }));
    expect(secondDone.state.toolHistory.filter((item) => item.cueId === "cue-provider-two")).toHaveLength(2);
    expect(secondDone.state.completedCueIds).toContain("cue-provider-two");

    const third = await runtime.dispatch(cueEvent(2, { cueId: "cue-provider-three" }));
    const thirdDone = await runtime.dispatch(resumeEvent(third.effects[0]!, { identity, eventId: "provider-three-done" }));
    const finished = await runtime.dispatch(completeEvent("provider-all-failed-session-complete"));

    expect(policy.calls).toHaveLength(2);
    expect(thirdDone.state.completedCueIds).toHaveLength(3);
    expect(finished.state.sessionStatus).toBe("COMPLETED");
    expect(finished.state.summaryThemes[0]?.occurrence).toBe(3);
    expect(finished.state.sessionSummaryInput?.themes[0]?.adviceRefs).toContain("advice-a1");
  });

  it("blocks stale takeover/cancel results and requires a new lifecycle event to resume", async () => {
    const takeoverRuntime = createCoachAgentRuntime();
    const started = await takeoverRuntime.dispatch(cueEvent(0, { cueId: "cue-takeover", eventId: "takeover-start" }));
    const takenOver = await takeoverRuntime.dispatch(takeoverEvent("takeover-event"));
    const staleResult = await takeoverRuntime.dispatch(resumeEvent(started.effects[0]!, { identity, eventId: "takeover-stale-result" }));
    const staleSegment = await takeoverRuntime.dispatch(observeEvent("takeover-stale-segment", "segment-stale", 1, "BRIEF"));
    const staleComplete = await takeoverRuntime.dispatch(completeEvent("takeover-stale-complete"));
    const restoredEvent = cueEvent(0, { cueId: "cue-takeover", eventId: "takeover-restored", resumeFromTakeover: true });
    const restored = await takeoverRuntime.dispatch(restoredEvent);

    expect(takenOver.status).toBe("USER_TAKEOVER");
    expect(staleResult.status).toBe("USER_TAKEOVER");
    expect(staleSegment.status).toBe("USER_TAKEOVER");
    expect(staleComplete.status).toBe("USER_TAKEOVER");
    expect(restoredEvent.eventId).not.toBe(started.state.processedEventIds[0]);
    expect(restored.state.runStatus).toBe("WAITING_TOOL");

    const cancelRuntime = createCoachAgentRuntime();
    const cancelStarted = await cancelRuntime.dispatch(cueEvent(0, { cueId: "cue-cancel", eventId: "cancel-start" }));
    const cancelled = await cancelRuntime.dispatch(cancelEvent("cancel-event"));
    const expired = await cancelRuntime.dispatch(resumeEvent(cancelStarted.effects[0]!, { identity, eventId: "cancel-expired-result" }));
    expect(cancelled.status).toBe("CANCELLED");
    expect(expired.status).toBe("CANCELLED");
    expect(expired.effects).toEqual([]);
  });
});

describe("Stage 3 Durable Object checkpoint integration", () => {
  it("restores the same cue/phase in runtime B, rejects route mismatch and keeps retention active at 20", async () => {
    const storage = new FakeStorage();
    const runtimeA = createCoachAgentRuntime({
      checkpointer: new DurableObjectCheckpointSaver({ storage, retention: 20 }),
      checkpointBackend: "DURABLE_OBJECT",
    });
    const started = await runtimeA.dispatch(cueEvent(0, { cueId: "cue-do", eventId: "do-start" }));
    const runtimeB = createCoachAgentRuntime({
      checkpointer: new DurableObjectCheckpointSaver({ storage, retention: 20 }),
      checkpointBackend: "DURABLE_OBJECT",
    });
    const resumed = await runtimeB.dispatch(resumeEvent(started.effects[0]!, { identity, eventId: "do-resume" }));
    const duplicate = await runtimeB.dispatch(resumeEvent(started.effects[0]!, { identity, eventId: "do-resume-duplicate" }));

    expect(resumed.checkpoint.recoverableAfterRefresh).toBe(true);
    expect(resumed.state.activeCueId).toBe("cue-do");
    expect(resumed.state.currentSessionPhase).toBe("PAUSED_FOR_COACHING");
    expect(resumed.effects).toEqual([]);
    expect(duplicate.effects).toEqual([]);

    const changedIdentity = { ...identity, routeId: "route-changed", routeHash: "sha256-route-changed" };
    const routeMismatch = await runtimeB.dispatch(resumeEvent(started.effects[0]!, { identity: changedIdentity, eventId: "do-route-mismatch" }));
    expect(routeMismatch.status).toBe("DORMANT");
    expect(routeMismatch.state.fallbackReasons).toContain("ROUTE_HASH_MISMATCH");

    const saver = new DurableObjectCheckpointSaver({ storage: new FakeStorage(), retention: 20 });
    const config = { configurable: { thread_id: "retention-thread", checkpoint_ns: "" } };
    for (let index = 1; index <= 21; index += 1) {
      await saver.put(config, {
        v: 4,
        id: String(index).padStart(4, "0"),
        ts: `2026-08-24T00:00:${String(index).padStart(2, "0")}Z`,
        channel_values: { agent: { compact: true, index } },
        channel_versions: { agent: String(index) },
        versions_seen: {},
      } as never, { source: "loop", step: index, parents: {} }, {});
    }
    const retained: unknown[] = [];
    for await (const item of saver.list(config)) retained.push(item);
    expect(retained).toHaveLength(20);
  });

  it("rejects v2 state for resume, starts a fresh v3 run, and exposes the completion compaction seam", async () => {
    const storage = new FakeStorage();
    const saver = new DurableObjectCheckpointSaver({ storage, retention: 20 });
    const legacyConfig = { configurable: { thread_id: threadIdForIdentity(identity), checkpoint_ns: "" } };
    await saver.put(legacyConfig, {
      v: 4,
      id: "legacy-0001",
      ts: "2026-08-24T00:00:00Z",
      channel_values: { agent: { schemaVersion: "coach-agent-state.v2", graphVersion: "coach-agent-graph.v2", runStatus: "WAITING_TOOL" } },
      channel_versions: { agent: "legacy" },
      versions_seen: {},
    } as never, { source: "input", step: 1, parents: {} }, {});

    const runtime = createCoachAgentRuntime({
      checkpointer: saver,
      checkpointBackend: "DURABLE_OBJECT",
    });
    const stale = await runtime.dispatch(resumeEvent({
      callId: "legacy-call",
      runId: identity.runId,
      cueId: "cue-legacy",
      capabilityId: slowForCue("cue-legacy").capabilityId,
      tool: "REPLAY_CUE_SLOW",
      evidenceRefs: [],
    }, { identity, eventId: "legacy-resume" }));
    expect(stale.status).toBe("DORMANT");
    expect(stale.state.fallbackReasons).toContain("CHECKPOINT_VERSION_MISMATCH");

    const fresh = await runtime.dispatch(cueEvent(0, { cueId: "cue-fresh", eventId: "fresh-start" }));
    expect(fresh.state.schemaVersion).toBe("coach-agent-state.v3");
    expect(fresh.state.runStatus).toBe("WAITING_TOOL");
    const compacted = compactCompletedCoachRunState(await runtime.dispatch(resumeEvent(fresh.effects[0]!, { identity, eventId: "fresh-resume" })).then((result) => ({
      ...result.state,
      sessionStatus: "COMPLETED" as const,
      runStatus: "COMPLETED" as const,
    })));
    expect(compacted.schemaVersion).toBe("coach-agent-state.v3");
    expect(compacted.trace.length).toBeLessThanOrEqual(8);
  });
});
