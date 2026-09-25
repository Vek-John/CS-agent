import { captureRecoveryBoundaryOwner, dispatchHostRecoveryBoundary, recoveryBoundaryFailureResult, type RecoveryBoundaryOwner } from "./host-recovery-boundary";
import { describe, expect, it, vi } from "vitest";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import type { IDBFactory } from "fake-indexeddb";
import {
  SessionRecoveryRecordSchema,
  type SessionRecoveryRecord,
} from "@cs-coach/coach-agent/client";
import {
  HOST_RECOVERY_DB_VERSION,
  HOST_RECOVERY_OBJECT_STORE,
  HOST_RECOVERY_TTL_MS,
} from "./host-recovery-store";
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

function putRawRecord(name: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = fakeIndexedDB.open(name, HOST_RECOVERY_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(HOST_RECOVERY_OBJECT_STORE)) {
        database.createObjectStore(HOST_RECOVERY_OBJECT_STORE, { keyPath: "recoveryId" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(HOST_RECOVERY_OBJECT_STORE, "readwrite");
      transaction.objectStore(HOST_RECOVERY_OBJECT_STORE).put(value);
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
    };
  });
}

function readRawRecord(name: string, recoveryId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = fakeIndexedDB.open(name, HOST_RECOVERY_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(HOST_RECOVERY_OBJECT_STORE, "readonly");
      const read = transaction.objectStore(HOST_RECOVERY_OBJECT_STORE).get(recoveryId);
      read.onerror = () => {
        database.close();
        reject(read.error);
      };
      read.onsuccess = () => {
        database.close();
        resolve(read.result);
      };
    };
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

  it("drops malformed persisted records while retaining a valid recovery", async () => {
    const databaseName = `recovery-test-${Date.now()}-malformed`;
    const now = HOST_RECOVERY_TTL_MS * 20;
    const runtime = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => now });
    await runtime.dispatch(event("SESSION_STARTED", "start-valid", record("valid", now + 1)));
    await putRawRecord(databaseName, {
      recoveryId: "malformed",
      schemaVersion: "session-recovery-record.v1",
      status: "INCOMPLETE",
    });

    const rebuilt = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => now + 2 });
    const boot = await rebuilt.dispatch(event("BOOT", "boot-malformed"));

    expect(boot.status).toBe("DORMANT");
    expect(boot.recoveryId).toBe("valid");
    expect(await readRawRecord(databaseName, "malformed")).toBeUndefined();

    await deleteDatabase(databaseName);
  });
});


describe("Host boundary publication with delayed production runtime", () => {
  it.each(["SESSION_COMPLETED", "STABLE_BOUNDARY_REACHED"] as const)("ignores an old %s response after switching reviews", async type => {
    const databaseName = `host-boundary-${type}`;
    const runtime = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => 1000 });
    const a = record("a", 1000); const b = record("b", 1000);
    await runtime.dispatch({ type: "SESSION_STARTED", eventId: "start-a", record: a });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let current = true;
    const host = { record: a as SessionRecoveryRecord | undefined, identity: a.sessionId as string | undefined, checkpoint: a.agentCheckpointId };
    const onCompleted = vi.fn(() => { host.identity = undefined; host.checkpoint = null; });
    const accept = vi.fn((result: import("@cs-coach/coach-agent/client").SessionRecoveryResult) => { host.record = result.record ?? undefined; });
    const pending = dispatchHostRecoveryBoundary({ runtime: { dispatch: async event => { const result = await runtime.dispatch(event); await gate; return result; } },
      event: type === "SESSION_COMPLETED" ? { type, eventId: "complete-a", recoveryId: a.recoveryId }
        : { type, eventId: "stable-a", recoveryId: a.recoveryId, boundary: a.boundary, cueProgress: a.cueProgress, routeReadiness: a.routeReadiness, narrationArtifacts: a.narrationArtifacts, agentCheckpointId: "checkpoint-new-a", updatedAt: 1001 },
      record: a, isCurrent: () => current, onCompleted, accept, onFailure: vi.fn() });
    current = false;
    host.record = b; host.identity = b.sessionId; host.checkpoint = b.agentCheckpointId;
    release(); await pending;
    try {
      expect(host).toEqual({ record: b, identity: b.sessionId, checkpoint: b.agentCheckpointId });
      expect(onCompleted).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled();
    } finally { await deleteDatabase(databaseName); }
  });
});

it.each(["SESSION_COMPLETED", "STABLE_BOUNDARY_REACHED"] as const)("publishes current %s from the real runtime and preserves completion summary eligibility", async type => {
  const databaseName = `host-current-${type}`;
  const runtime = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => 1000 });
  const a = record("current", 1000);
  await runtime.dispatch({ type: "SESSION_STARTED", eventId: "start", record: a });
  const onCompleted = vi.fn(); const accept = vi.fn(); const onFailure = vi.fn();
  const owner: RecoveryBoundaryOwner = { generation: 1, historyEpoch: 1, operationEpoch: 1, runtime, sessionId: a.sessionId, record: a, takenOver: false, recovering: false };
  const isCurrent = captureRecoveryBoundaryOwner(() => owner);
  owner.record = { ...a };
  try {
    await dispatchHostRecoveryBoundary({ runtime, record: a, isCurrent, onCompleted, accept, onFailure,
      event: type === "SESSION_COMPLETED" ? { type, eventId: "complete", recoveryId: a.recoveryId }
        : { type, eventId: "stable", recoveryId: a.recoveryId, boundary: a.boundary, cueProgress: a.cueProgress, routeReadiness: a.routeReadiness, narrationArtifacts: a.narrationArtifacts, agentCheckpointId: "new-checkpoint", updatedAt: 1001 } });
    expect(onFailure).not.toHaveBeenCalled(); expect(accept).toHaveBeenCalledOnce();
    if (type === "SESSION_COMPLETED") {
      expect(onCompleted).toHaveBeenCalledOnce();
      expect(accept.mock.calls[0][0]).toMatchObject({ status: "READY", recoveryId: null, record: null });
      const { isSessionWrapUpIdentityCurrent } = await import("../coaching/session-wrap-up-presentation");
      expect(isSessionWrapUpIdentityCurrent({ identity: { sessionId: a.sessionId, runId: a.runId } } as import("@cs-coach/coach-agent/client").CoachAgentResult,
        { id: a.sessionId, phase: "COMPLETED" }, undefined)).toBe(true);
    } else {
      expect(onCompleted).not.toHaveBeenCalled();
      expect(accept.mock.calls[0][0]).toMatchObject({ status: "READY", record: { recoveryId: a.recoveryId, agentCheckpointId: "new-checkpoint", updatedAt: 1001 } });
    }
  } finally { await deleteDatabase(databaseName); }
});

it.each(["REJECTED", "DEGRADED"] as const)("does not treat real runtime %s as successful completion deletion", async kind => {
  const databaseName = `host-failure-${kind}`;
  const runtime = createSessionRecoveryRuntime({ indexedDB: kind === "DEGRADED" ? undefined : fakeIndexedDB, databaseName, now: () => 1000 });
  const a = record("failed", 1000);
  await runtime.dispatch({ type: "SESSION_STARTED", eventId: "start", record: a });
  const onCompleted = vi.fn(); const accept = vi.fn(); const onFailure = vi.fn();
  try {
    await dispatchHostRecoveryBoundary({ runtime, record: a, isCurrent: () => true, onCompleted, accept, onFailure,
      event: { type: "SESSION_COMPLETED", eventId: "complete", recoveryId: kind === "REJECTED" ? "not-stored" : a.recoveryId } });
    expect(onCompleted).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ status: kind }));
    const shown = recoveryBoundaryFailureResult(a, onFailure.mock.calls[0][0]);
    expect(shown).toMatchObject({ status: kind, recoveryId: a.recoveryId, record: a, effects: [] });
    expect(shown.record?.agentCheckpointId).toBe(a.agentCheckpointId);
  } finally { if (kind !== "DEGRADED") await deleteDatabase(databaseName); }
});

it.each(["generation", "history", "operation", "runtime", "session", "record", "run", "takeover", "recovering", "unmount"] as const)("does not publish a pending result after owner %s changes", async change => {
  const a = record("owner", 1000);
  let release!: (result: import("@cs-coach/coach-agent/client").SessionRecoveryResult) => void;
  const runtime = { dispatch: vi.fn(() => new Promise<import("@cs-coach/coach-agent/client").SessionRecoveryResult>(resolve => { release = resolve; })) };
  const owner: RecoveryBoundaryOwner = { generation: 1, historyEpoch: 1, operationEpoch: 1, runtime, sessionId: a.sessionId, record: a, takenOver: false, recovering: false };
  const isCurrent = captureRecoveryBoundaryOwner(() => owner);
  const onCompleted = vi.fn(); const accept = vi.fn(); const onFailure = vi.fn();
  const pending = dispatchHostRecoveryBoundary({ runtime, record: a, event: { type: "SESSION_COMPLETED", eventId: "complete", recoveryId: a.recoveryId }, isCurrent, onCompleted, accept, onFailure });
  if (change === "generation") owner.generation++;
  if (change === "history") owner.historyEpoch++;
  if (change === "operation") owner.operationEpoch++;
  if (change === "runtime") owner.runtime = { dispatch: vi.fn() };
  if (change === "session") owner.sessionId = "new-session";
  if (change === "record") owner.record = record("new", 1000);
  if (change === "run") owner.record = { ...a, runId: "new-run" };
  if (change === "takeover") owner.takenOver = true;
  if (change === "recovering") owner.recovering = true;
  if (change === "unmount") owner.runtime = undefined;
  release({ schemaVersion: "session-recovery-runtime.v1", status: "READY", recoveryId: null, record: null, effects: [], reason: null });
  await pending;
  expect(onCompleted).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled(); expect(onFailure).not.toHaveBeenCalled();
});

it.each([false, true])("catches a rejected dispatch without clearing recovery (stale=%s)", async stale => {
  const a = record("throw", 1000);
  let fail!: (error: Error) => void;
  const runtime = { dispatch: () => new Promise<import("@cs-coach/coach-agent/client").SessionRecoveryResult>((_, reject) => { fail = reject; }) };
  let current = true;
  const onCompleted = vi.fn(); const accept = vi.fn(); const onFailure = vi.fn();
  const pending = dispatchHostRecoveryBoundary({ runtime, record: a, event: { type: "SESSION_COMPLETED", eventId: "complete", recoveryId: a.recoveryId },
    isCurrent: () => current, onCompleted, accept, onFailure });
  current = !stale; fail(new Error("private store failure"));
  await expect(pending).resolves.toBeUndefined();
  expect(onCompleted).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledTimes(stale ? 0 : 1);
  if (!stale) expect(onFailure).toHaveBeenCalledWith();
});


it("allows a newer record snapshot of the same owner and rejects foreign stable results", async () => {
  const a = record("same", 1000); const other = record("foreign", 1000);
  const result = { schemaVersion: "session-recovery-runtime.v1" as const, status: "READY" as const, recoveryId: other.recoveryId, record: other, effects: [], reason: null };
  const runtime = { dispatch: vi.fn().mockResolvedValue(result) };
  const owner: RecoveryBoundaryOwner = { generation: 1, historyEpoch: 1, operationEpoch: 1, runtime, sessionId: a.sessionId, record: a, takenOver: false, recovering: false };
  const isCurrent = captureRecoveryBoundaryOwner(() => owner);
  owner.record = { ...a };
  expect(isCurrent()).toBe(true);
  const onCompleted = vi.fn(); const accept = vi.fn(); const onFailure = vi.fn();
  await dispatchHostRecoveryBoundary({ runtime, record: a, isCurrent, onCompleted, accept, onFailure,
    event: { type: "STABLE_BOUNDARY_REACHED", eventId: "stable", recoveryId: a.recoveryId, boundary: a.boundary, cueProgress: a.cueProgress, routeReadiness: a.routeReadiness, narrationArtifacts: a.narrationArtifacts, agentCheckpointId: a.agentCheckpointId, updatedAt: 1001 } });
  expect(accept).not.toHaveBeenCalled(); expect(onCompleted).not.toHaveBeenCalled();
  expect(onFailure).toHaveBeenCalledOnce();
  expect(recoveryBoundaryFailureResult(a, result)).toMatchObject({ status: "DEGRADED", record: a, recoveryId: a.recoveryId });
});
