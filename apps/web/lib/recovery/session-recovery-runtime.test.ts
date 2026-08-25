import { describe, expect, it } from "vitest";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import type { IDBFactory } from "fake-indexeddb";
import {
  SessionRecoveryRecordSchema,
  type SessionRecoveryRecord,
} from "@cs-coach/coach-agent/client";
import { HOST_RECOVERY_TTL_MS } from "./host-recovery-store";
import { createSessionRecoveryRuntime } from "./session-recovery-runtime";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function record(id: string, updatedAt: number): SessionRecoveryRecord {
  return SessionRecoveryRecordSchema.parse({
    schemaVersion: "session-recovery-record.v2",
    status: "INCOMPLETE",
    createdAt: updatedAt,
    updatedAt,
    recoveryId: id,
    sessionId: `session-${id}`,
    runId: `run-${id}`,
    demoContentHash: HASH,
    selectedPlayerId: "player-1",
    routeId: "route-1",
    routeHash: "route-hash-1",
    versions: {
      parser: "parser.v1",
      analysisAdapter: "analysis.v1",
      candidateGenerator: "candidate.v1",
      director: "director.v1",
      planCompiler: "planner.v1",
      reviewPlanSchema: "review-plan.v1",
      sessionSchema: "session.v1",
      graph: "coach-agent-graph.v2",
      agentState: "coach-agent-state.v2",
    },
    frozenReviewPlan: {
      id: "route-1",
      demo_id: "demo-1",
      player_id: "player-1",
      status: "COMPLETE",
      match_timeline_version: "timeline.v1",
      observation_version: "observation.v1",
      signal_version: "signal.v1",
      planner_version: "planner.v1",
      estimated_duration_seconds: 120,
      available_until_round: 24,
      full_match_index_ready: true,
      global_aggregation_ready: true,
      segments: [{ id: "segment-1" }],
      cues: [{ id: "cue-1" }],
      habit_clusters: [],
      generation_manifest: { provider: "DETERMINISTIC_TEMPLATE" },
    },
    routeReadiness: { "cue-1": "READY" },
    boundary: {
      kind: "CUE_PAUSED",
      boundaryId: `boundary-${id}`,
      segmentId: "segment-1",
      segmentIndex: 0,
      cueId: "cue-1",
      sessionPhase: "PAUSED_FOR_COACHING",
      outcomeGateStatus: "COMPLETE",
    },
    cueProgress: { completedCueIds: [], consumedCueIds: [], revealedCueIds: [] },
    agentCheckpointId: `checkpoint-${id}`,
    toolLedger: [],
    narrationArtifacts: [],
  });
}

function event(type: "BOOT", eventId: string): { type: "BOOT"; eventId: string };
function event(type: "SESSION_STARTED", eventId: string, current: SessionRecoveryRecord): { type: "SESSION_STARTED"; eventId: string; record: SessionRecoveryRecord };
function event(type: "BOOT" | "SESSION_STARTED", eventId: string, current?: SessionRecoveryRecord) {
  return type === "BOOT" ? { type, eventId } : { type, eventId, record: current };
}

function replayReady(recoveryId: string, hash = HASH) {
  return {
    type: "REPLAY_READY" as const,
    eventId: `replay-${recoveryId}-${hash.slice(0, 4)}`,
    recoveryId,
    replayAvailability: "READY" as const,
    demoContentHash: hash,
    availablePlayerIds: ["player-1", "player-2"],
  };
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = fakeIndexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("database cleanup blocked"));
  });
}

describe("SessionRecoveryRuntime browser store seam", () => {
  it("rebuilds from IndexedDB, bounds records/TTL, validates hash and emits only recovery effects", async () => {
    const databaseName = `recovery-test-${Date.now()}-persist`;
    const now = HOST_RECOVERY_TTL_MS * 20;
    const runtime = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => now });

    for (let index = 1; index <= 4; index += 1) {
      const current = record(`record-${index}`, now + index);
      const started = await runtime.dispatch(event("SESSION_STARTED", `start-${index}`, current));
      expect(started.status).toBe("READY");
    }

    const rebuilt = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => now + 10 });
    const dormant = await rebuilt.dispatch(event("BOOT", "boot-1"));
    expect(dormant.status).toBe("DORMANT");
    expect(dormant.recoveryId).toBe("record-4");

    const wrong = await rebuilt.dispatch(replayReady("record-4", "f".repeat(64)));
    expect(wrong.status).toBe("REJECTED");
    expect(wrong.record?.recoveryId).toBe("record-4");

    const ready = await rebuilt.dispatch(replayReady("record-4"));
    expect(ready.status).toBe("READY");
    expect(ready.effects).toEqual([{ type: "SELECT_PLAYER", recoveryId: "record-4", playerId: "player-1" }]);

    const analysis = await rebuilt.dispatch({
      type: "ANALYSIS_READY",
      eventId: "analysis-ready",
      recoveryId: "record-4",
      demoContentHash: HASH,
      selectedPlayerId: "player-1",
      routeId: "route-1",
      routeHash: "route-hash-1",
      versions: { parser: "parser.v1", analysisAdapter: "analysis.v1", planner: "planner.v1" },
    });
    expect(analysis.status).toBe("REBUILDING");
    expect(analysis.effects.map((effect) => effect.type)).toEqual([
      "REQUEST_SESSION_REHYDRATE",
      "SEEK_RECOVERY_BOUNDARY",
      "RECONNECT_AGENT",
    ]);

    const posted = await rebuilt.dispatch({
      type: "STABLE_BOUNDARY_REACHED",
      eventId: "stable-posted",
      recoveryId: "record-4",
      boundary: record("record-4", now).boundary,
      cueProgress: { completedCueIds: [], presentedCueIds: [], consumedCueIds: [], revealedCueIds: ["cue-1"] },
      routeReadiness: { "cue-1": "READY" },
      narrationArtifacts: [],
      toolLedgerEntry: {
        callId: "call-posted",
        cueId: "cue-1",
        capabilityId: "cap-cue1-slow-replay",
        status: "POSTED",
        observationCode: null,
        result: null,
      },
      agentCheckpointId: "checkpoint-posted",
      updatedAt: now + 11,
    });
    expect(posted.record).toMatchObject({
      agentCheckpointId: "checkpoint-posted",
      toolLedger: [{ callId: "call-posted", status: "POSTED", result: null }],
    });

    for (let index = 0; index < 3; index += 1) {
      const current = await rebuilt.dispatch({
        type: index === 0 ? "SESSION_COMPLETED" : "DISCARD_RECOVERY",
        eventId: `${index === 0 ? "complete" : "discard"}-${index}`,
        recoveryId: `record-${4 - index}`,
      });
      expect(current.status).toBe("READY");
    }
    const maxThree = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => now + 20 });
    const afterPrune = await maxThree.dispatch(event("BOOT", "boot-after-prune"));
    expect(afterPrune.recoveryId).toBeNull();

    const ttlDatabase = `${databaseName}-ttl`;
    const expiredRuntime = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName: ttlDatabase, now: () => now });
    await expiredRuntime.dispatch(event("SESSION_STARTED", "start-expired", record("expired", now - HOST_RECOVERY_TTL_MS - 1)));
    const expiredBoot = await createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName: ttlDatabase, now: () => now }).dispatch(event("BOOT", "boot-expired"));
    expect(expiredBoot.recoveryId).toBeNull();

    await deleteDatabase(databaseName);
    await deleteDatabase(ttlDatabase);
  });

  it("falls back to tab memory after IDB failure and makes refresh loss explicit", async () => {
    const brokenFactory = { open: () => { throw new Error("open failed"); } } as unknown as IDBFactory;
    const runtime = createSessionRecoveryRuntime({ indexedDB: brokenFactory, databaseName: "recovery-test-broken" });
    const boot = await runtime.dispatch(event("BOOT", "boot-broken"));
    expect(boot.status).toBe("DEGRADED");
    expect(boot.reason).toContain("刷新后不能恢复");

    const started = await runtime.dispatch(event("SESSION_STARTED", "start-broken", record("memory-only", Date.now())));
    expect(started.status).toBe("DEGRADED");
    expect(started.record?.recoveryId).toBe("memory-only");
  });
});
