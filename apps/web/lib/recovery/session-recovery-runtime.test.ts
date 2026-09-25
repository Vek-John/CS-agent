import { focusRecoveryDemoPicker } from "./recovery-demo-picker";
import { dispatchDiscardableLandingTimeout, HostRecoveryDiscard, type RecoveryDiscardOwner } from "./host-recovery-discard";
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


describe("Host discard with the production recovery runtime", () => {
  it.each(["STALE_SUCCESS", "REJECTED", "DEGRADED"] as const)("does not falsely clear recovery for %s", async scenario => {
    const databaseName = `host-discard-${scenario}`;
    const runtime = createSessionRecoveryRuntime({ indexedDB: scenario === "DEGRADED" ? undefined : fakeIndexedDB, databaseName, now: () => 1000 });
    const a = record("discard-a", 1000); const b = record("discard-b", 1000);
    await runtime.dispatch({ type: "SESSION_STARTED", eventId: "start", record: a });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed = { dispatch: async (event: import("@cs-coach/coach-agent/client").SessionRecoveryEvent) => {
      const result = await runtime.dispatch(scenario === "REJECTED" && event.type === "DISCARD_RECOVERY" ? { ...event, recoveryId: "not-stored" } : event);
      await gate; return result;
    } };
    const owner: RecoveryDiscardOwner = { generation: 1, historyEpoch: 1, runtime: delayed, record: a };
    const host = { record: a as SessionRecoveryRecord | undefined, identity: a.sessionId as string | undefined, checkpoint: a.agentCheckpointId };
    const onDiscarded = vi.fn(() => { host.identity = undefined; host.checkpoint = null; });
    const accept = vi.fn((result: import("@cs-coach/coach-agent/client").SessionRecoveryResult) => { host.record = result.record ?? undefined; });
    const onFailure = vi.fn();
    const pending = new HostRecoveryDiscard().discard({ runtime: delayed, record: a, eventId: "discard", readOwner: () => owner, onStart: vi.fn(), onDiscarded, accept, onFailure });
    if (scenario === "STALE_SUCCESS") { owner.historyEpoch++; owner.record = b; host.record = b; host.identity = b.sessionId; host.checkpoint = b.agentCheckpointId; }
    release(); await pending;
    try {
      const expected = scenario === "STALE_SUCCESS" ? b : a;
      expect(host).toEqual({ record: expected, identity: expected.sessionId, checkpoint: expected.agentCheckpointId });
      expect(onDiscarded).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledTimes(scenario === "STALE_SUCCESS" ? 0 : 1);
    } finally { if (scenario !== "DEGRADED") await deleteDatabase(databaseName); }
  });
});

it("discards a DORMANT record without live session/identity and coalesces repeated clicks", async () => {
  const databaseName = "host-discard-dormant";
  const runtime = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => 1000 });
  const a = record("dormant", 1000);
  await runtime.dispatch({ type: "SESSION_STARTED", eventId: "start", record: a });
  expect((await runtime.dispatch({ type: "BOOT", eventId: "boot" })).status).toBe("DORMANT");
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const delayed = { dispatch: vi.fn(async (event: import("@cs-coach/coach-agent/client").SessionRecoveryEvent) => { const result = await runtime.dispatch(event); await gate; return result; }) };
  const owner: RecoveryDiscardOwner = { generation: 1, historyEpoch: 1, runtime: delayed, record: a };
  const onDiscarded = vi.fn(() => { owner.historyEpoch++; owner.record = undefined; });
  const accept = vi.fn(); const onFailure = vi.fn(); const onStart = vi.fn();
  const input = { runtime: delayed, record: a, eventId: "discard", readOwner: () => owner, onStart, onDiscarded, accept, onFailure };
  const controller = new HostRecoveryDiscard();
  const first = controller.discard(input);
  owner.record = { ...a };
  const second = controller.discard({ ...input, eventId: "repeat" });
  expect(second).toBe(first);
  expect(onDiscarded).not.toHaveBeenCalled(); expect(owner.record).toEqual(a);
  release(); await first;
  try {
    expect(delayed.dispatch).toHaveBeenCalledOnce(); expect(onStart).toHaveBeenCalledOnce();
    expect(onDiscarded).toHaveBeenCalledOnce(); expect(onFailure).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ status: "READY", recoveryId: null, record: null }));
    expect((await runtime.dispatch({ type: "BOOT", eventId: "after-delete" })).record).toBeNull();
  } finally { await deleteDatabase(databaseName); }
});

it.each(["generation", "history", "runtime", "record", "session", "run", "unmount"] as const)("ignores discard success and failure after %s changes", async change => {
  for (const rejected of [false, true]) {
    const a = record("owner-discard", 1000);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const runtime = { dispatch: async () => { await gate; if (rejected) throw new Error("private failure"); return { schemaVersion: "session-recovery-runtime.v1" as const, status: "READY" as const, recoveryId: null, record: null, effects: [], reason: null }; } };
    const owner: RecoveryDiscardOwner = { generation: 1, historyEpoch: 1, runtime, record: a };
    const onDiscarded = vi.fn(); const accept = vi.fn(); const onFailure = vi.fn();
    const pending = new HostRecoveryDiscard().discard({ runtime, record: a, eventId: "discard", readOwner: () => owner, onStart: vi.fn(), onDiscarded, accept, onFailure });
    if (change === "generation") owner.generation++;
    if (change === "history") owner.historyEpoch++;
    if (change === "runtime") owner.runtime = { dispatch: vi.fn() };
    if (change === "record") owner.record = record("other", 1000);
    if (change === "session") owner.record = { ...a, sessionId: "other-session" };
    if (change === "run") owner.record = { ...a, runId: "other-run" };
    if (change === "unmount") owner.runtime = undefined;
    release(); await expect(pending).resolves.toBeUndefined();
    expect(onDiscarded).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled(); expect(onFailure).not.toHaveBeenCalled();
  }
});

it("keeps failed discard retryable and never publishes exception text", async () => {
  const { recoveryDiscardFailureResult } = await import("./host-recovery-discard");
  const a = record("retry-discard", 1000);
  const runtime = { dispatch: vi.fn().mockRejectedValueOnce(new Error("private failure details")).mockResolvedValue({ schemaVersion: "session-recovery-runtime.v1", status: "READY", recoveryId: null, record: null, effects: [], reason: null }) };
  const owner: RecoveryDiscardOwner = { generation: 1, historyEpoch: 1, runtime, record: a };
  const onDiscarded = vi.fn(); const accept = vi.fn(); const onFailure = vi.fn();
  const input = { runtime, record: a, eventId: "discard", readOwner: () => owner, onStart: vi.fn(), onDiscarded, accept, onFailure };
  const controller = new HostRecoveryDiscard();
  await controller.discard(input);
  expect(onFailure).toHaveBeenCalledWith(); expect(onDiscarded).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled();
  const shown = recoveryDiscardFailureResult(a);
  expect(shown).toMatchObject({ record: a, recoveryId: a.recoveryId, status: "DEGRADED" });
  expect(shown.reason).toContain("尚未确认放弃成功"); expect(JSON.stringify(shown)).not.toContain("private");
  await controller.discard({ ...input, eventId: "retry" });
  expect(runtime.dispatch).toHaveBeenCalledTimes(2); expect(onDiscarded).toHaveBeenCalledOnce();
});

it("only accepts confirmed deletion and preserves the current record in the failure presentation", async () => {
  const { recoveryDiscardFailureResult } = await import("./host-recovery-discard");
  const a = record("not-deleted", 1000);
  const result = { schemaVersion: "session-recovery-runtime.v1" as const, status: "READY" as const, recoveryId: a.recoveryId, record: a, effects: [], reason: "success-like text" };
  const runtime = { dispatch: vi.fn().mockResolvedValue(result) };
  const owner: RecoveryDiscardOwner = { generation: 1, historyEpoch: 1, runtime, record: a };
  const onDiscarded = vi.fn(); const accept = vi.fn(); const onFailure = vi.fn();
  await new HostRecoveryDiscard().discard({ runtime, record: a, eventId: "discard", readOwner: () => owner, onStart: vi.fn(), onDiscarded, accept, onFailure });
  expect(onDiscarded).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledWith(result);
  expect(recoveryDiscardFailureResult(a, result)).toMatchObject({ record: a, status: "DEGRADED", reason: expect.stringContaining("尚未确认放弃成功") });
});

it("shows the bounded discard failure in the actual status panel without exposing arbitrary runtime reasons", async () => {
  const { hostRecoveryStatusDetail, recoveryDiscardFailureResult } = await import("./host-recovery-discard");
  const { SessionRecoveryStatus } = await import("../../components/playback/session-recovery-status");
  const { createElement } = await import("react"); const { renderToStaticMarkup } = await import("react-dom/server");
  const result = recoveryDiscardFailureResult(record("panel", 1000));
  const html = renderToStaticMarkup(createElement(SessionRecoveryStatus, { status: "DEGRADED", detail: hostRecoveryStatusDetail(result), onChooseDemo: () => {}, onDiscard: () => {} }));
  expect(html).toContain("尚未确认放弃成功"); expect(html).toContain("已保留恢复资料");
  expect(html).toContain("到回放区选择 Demo");
  expect(hostRecoveryStatusDetail({ ...result, reason: "private runtime error" })).toBe("恢复过程暂未完成，请按下方操作继续。");
});

it("leaves a newer discard pending when an older switched-away request settles", async () => {
  const a = record("first", 1000); const b = record("second", 1000);
  const resolves: Array<(result: import("@cs-coach/coach-agent/client").SessionRecoveryResult) => void> = [];
  const runtime = { dispatch: vi.fn(() => new Promise<import("@cs-coach/coach-agent/client").SessionRecoveryResult>(resolve => resolves.push(resolve))) };
  const owner: RecoveryDiscardOwner = { generation: 1, historyEpoch: 1, runtime, record: a };
  const controller = new HostRecoveryDiscard(); const onStart = vi.fn(); const onDiscarded = vi.fn(); const accept = vi.fn(); const onFailure = vi.fn();
  const input = { runtime, record: a, eventId: "discard-a", readOwner: () => owner, onStart, onDiscarded, accept, onFailure };
  const first = controller.discard(input);
  owner.historyEpoch++; owner.record = b;
  const secondInput = { ...input, record: b, eventId: "discard-b" };
  const second = controller.discard(secondInput);
  const success = { schemaVersion: "session-recovery-runtime.v1" as const, status: "READY" as const, recoveryId: null, record: null, effects: [], reason: null };
  resolves[0](success); await first;
  expect(onDiscarded).not.toHaveBeenCalled();
  expect(controller.discard(secondInput)).toBe(second);
  resolves[1](success); await second;
  expect(runtime.dispatch).toHaveBeenCalledTimes(2); expect(onStart).toHaveBeenCalledTimes(2);
  expect(onDiscarded).toHaveBeenCalledOnce(); expect(accept).toHaveBeenCalledOnce(); expect(onFailure).not.toHaveBeenCalled();
});

it("invalidates pending boundary publication and cancels recovery landing only after confirmed discard", async () => {
  vi.useFakeTimers();
  const a = record("landing", 1000);
  let release!: (result: import("@cs-coach/coach-agent/client").SessionRecoveryResult) => void;
  const runtime = { dispatch: () => new Promise<import("@cs-coach/coach-agent/client").SessionRecoveryResult>(resolve => { release = resolve; }) };
  const owner: RecoveryDiscardOwner = { generation: 1, historyEpoch: 1, runtime, record: a };
  const boundaryOwner: RecoveryBoundaryOwner = { ...owner, operationEpoch: 1, sessionId: a.sessionId, takenOver: false, recovering: false };
  const boundaryIsCurrent = captureRecoveryBoundaryOwner(() => boundaryOwner);
  const state = { mode: true, landing: a.recoveryId as string | undefined, checkpoint: a.agentCheckpointId, identity: a.sessionId as string | undefined };
  const timeout = vi.fn(); const timer = setTimeout(timeout, 10000);
  const startingHistoryEpoch = owner.historyEpoch;
  const onDiscarded = vi.fn(() => { owner.historyEpoch++; state.mode = false; state.landing = undefined; clearTimeout(timer); state.checkpoint = null; state.identity = undefined; });
  try {
    const pending = new HostRecoveryDiscard().discard({ runtime, record: a, eventId: "discard", readOwner: () => owner,
      onStart: () => { boundaryOwner.operationEpoch++; }, onDiscarded, accept: vi.fn(), onFailure: vi.fn() });
    expect(boundaryIsCurrent()).toBe(false);
    expect(state.mode).toBe(true); expect(state.landing).toBe(a.recoveryId); expect(vi.getTimerCount()).toBe(1);
    release({ schemaVersion: "session-recovery-runtime.v1", status: "READY", recoveryId: null, record: null, effects: [], reason: null });
    await pending;
    expect(state).toEqual({ mode: false, landing: undefined, checkpoint: null, identity: undefined });
    expect(owner.historyEpoch).not.toBe(startingHistoryEpoch); expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10000); expect(timeout).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});


it("does not revive a timeout notice already dispatched before discard succeeded", async () => {
  const a = record("expired-landing", 1000);
  let releaseTimeout!: (result: import("@cs-coach/coach-agent/client").SessionRecoveryResult) => void;
  const deleted = { schemaVersion: "session-recovery-runtime.v1" as const, status: "READY" as const, recoveryId: null, record: null, effects: [], reason: "已放弃这场未完成复盘。" };
  const runtime = { dispatch: (event: import("@cs-coach/coach-agent/client").SessionRecoveryEvent) => event.type === "DISCARD_RECOVERY" ? Promise.resolve(deleted)
    : new Promise<import("@cs-coach/coach-agent/client").SessionRecoveryResult>(resolve => { releaseTimeout = resolve; }) };
  const owner: RecoveryDiscardOwner = { generation: 1, historyEpoch: 1, runtime, record: a };
  const oldEpoch = owner.historyEpoch;
  const accept = vi.fn();
  const timeout = dispatchDiscardableLandingTimeout({ runtime, record: a, eventId: "timeout", isCurrent: () => owner.historyEpoch === oldEpoch, accept });
  await new HostRecoveryDiscard().discard({ runtime, record: a, eventId: "discard", readOwner: () => owner, onStart: () => {},
    onDiscarded: () => { owner.historyEpoch++; owner.record = undefined; }, accept, onFailure: vi.fn() });
  releaseTimeout({ schemaVersion: "session-recovery-runtime.v1", status: "REJECTED", recoveryId: a.recoveryId, record: null, effects: [], reason: "记录不存在" });
  await timeout;
  expect(accept).toHaveBeenCalledOnce(); expect(accept).toHaveBeenCalledWith(deleted);
});

it.each([false, true])("keeps current landing timeout failure bounded and ignores a stale thrown timeout (stale=%s)", async stale => {
  const a = record("timeout-error", 1000); let current = true;
  let reject!: (error: Error) => void;
  const runtime = { dispatch: vi.fn(() => new Promise<import("@cs-coach/coach-agent/client").SessionRecoveryResult>((_, fail) => { reject = fail; })) };
  const accept = vi.fn();
  const pending = dispatchDiscardableLandingTimeout({ runtime, record: a, eventId: "timeout", isCurrent: () => current, accept });
  current = !stale; reject(new Error("private timeout details")); await pending;
  expect(accept).toHaveBeenCalledTimes(stale ? 0 : 1);
  if (!stale) expect(accept).toHaveBeenCalledWith(expect.objectContaining({ status: "DEGRADED", record: a, reason: "PLAYBACK_LANDING_TIMEOUT" }));
});

it("does not send an already invalidated timeout", async () => {
  const runtime = { dispatch: vi.fn() }; const accept = vi.fn();
  await dispatchDiscardableLandingTimeout({ runtime, record: record("cancelled-timeout", 1000), eventId: "timeout", isCurrent: () => false, accept });
  expect(runtime.dispatch).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled();
});

it("still publishes a current landing timeout from the real runtime after a rejected discard", async () => {
  const databaseName = "discard-rejected-current-timeout";
  const runtime = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => 1000 });
  const a = record("still-recoverable", 1000);
  await runtime.dispatch({ type: "SESSION_STARTED", eventId: "start", record: a });
  const wrapper = { dispatch: (event: import("@cs-coach/coach-agent/client").SessionRecoveryEvent) => runtime.dispatch(event.type === "DISCARD_RECOVERY" ? { ...event, recoveryId: "not-stored" } : event) };
  const owner: RecoveryDiscardOwner = { generation: 1, historyEpoch: 1, runtime: wrapper, record: a };
  const onDiscarded = vi.fn(); const onFailure = vi.fn(); const accept = vi.fn();
  try {
    await new HostRecoveryDiscard().discard({ runtime: wrapper, record: a, eventId: "discard", readOwner: () => owner, onStart: () => {}, onDiscarded, accept, onFailure });
    expect(onDiscarded).not.toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledOnce();
    await dispatchDiscardableLandingTimeout({ runtime: wrapper, record: a, eventId: "timeout", isCurrent: () => owner.historyEpoch === 1, accept });
    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ status: "DEGRADED", recoveryId: a.recoveryId, record: a, reason: "PLAYBACK_LANDING_TIMEOUT" }));
  } finally { await deleteDatabase(databaseName); }
});


it("does not claim to rebuild a DORMANT review when the Host only focuses the Demo picker", async () => {
  const databaseName = "recovery-picker-feedback";
  const runtime = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => 1000 });
  const a = record("picker-waiting", 1000);
  await runtime.dispatch({ type: "SESSION_STARTED", eventId: "start", record: a });
  let current = await runtime.dispatch({ type: "BOOT", eventId: "boot" });
  const before = JSON.stringify(current);
  const surface = { scrollIntoView: vi.fn(), focus: vi.fn() };
  const dispatch = vi.spyOn(runtime, "dispatch");
  try {
    focusRecoveryDemoPicker(surface);
    const { SessionRecoveryStatus } = await import("../../components/playback/session-recovery-status");
    const { createElement } = await import("react"); const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(createElement(SessionRecoveryStatus, { status: current.status === "READY" ? "REBUILDING" : current.status, onChooseDemo: () => {} }));
    expect(html).not.toContain("正在验证并重新解析");
    expect(html).toContain("到回放区选择 Demo");
    expect(JSON.stringify(current)).toBe(before); expect(dispatch).not.toHaveBeenCalled();
    expect(surface.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" }); expect(surface.focus).toHaveBeenCalledOnce();
  } finally { await deleteDatabase(databaseName); }
});

it.each(["DORMANT", "REJECTED", "DEGRADED"] as const)("keeps %s recoverable and actionable when no file is selected after repeated picker navigation", async status => {
  const databaseName = `picker-idle-${status}`;
  const runtime = createSessionRecoveryRuntime({ indexedDB: status === "DEGRADED" ? undefined : fakeIndexedDB, databaseName, now: () => 1000 });
  const a = record("waiting-picker", 1000);
  await runtime.dispatch({ type: "SESSION_STARTED", eventId: "start", record: a });
  const current = status === "REJECTED" ? await runtime.dispatch(replayReady(a.recoveryId, "f".repeat(64)))
    : await runtime.dispatch({ type: "BOOT", eventId: "boot" });
  const original = JSON.stringify(current);
  const dispatch = vi.spyOn(runtime, "dispatch");
  const surface = { scrollIntoView: vi.fn(), focus: vi.fn() };
  try {
    // No Viewer import event: represents waiting/non-selection, not a real browser cancel event.
    for (let click = 0; click < 3; click++) focusRecoveryDemoPicker(surface);
    focusRecoveryDemoPicker(null);
    await Promise.resolve();
    const { SessionRecoveryStatus } = await import("../../components/playback/session-recovery-status");
    const { createElement } = await import("react"); const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(createElement(SessionRecoveryStatus, { status, onChooseDemo: () => {} }));
    expect(html).toContain(`data-recovery-state="${status}"`); expect(html).toContain('aria-busy="false"');
    expect(html).toContain("选择文件后才会开始导入"); expect(html).toContain("到回放区选择 Demo");
    expect(html).not.toContain("正在验证并重新解析"); expect(html).not.toContain("复盘已恢复");
    expect(JSON.stringify(current)).toBe(original); expect(dispatch).not.toHaveBeenCalled();
    expect(surface.focus).toHaveBeenCalledTimes(3);
  } finally { if (status !== "DEGRADED") await deleteDatabase(databaseName); }
});

it("recovers through the real replay/hash/player/version handshake without the obsolete picker loading request", async () => {
  const databaseName = "recovery-no-picker-loading";
  const runtime = createSessionRecoveryRuntime({ indexedDB: fakeIndexedDB, databaseName, now: () => 1000 });
  const a = record("direct-replay", 1000);
  await runtime.dispatch({ type: "SESSION_STARTED", eventId: "start", record: a });
  await runtime.dispatch({ type: "BOOT", eventId: "boot" });
  try {
    focusRecoveryDemoPicker({ scrollIntoView: vi.fn(), focus: vi.fn() });
    const replay = await runtime.dispatch(replayReady(a.recoveryId));
    expect(replay.status).toBe("READY");
    expect(replay.effects).toEqual([{ type: "SELECT_PLAYER", recoveryId: a.recoveryId, playerId: a.selectedPlayerId }]);
    const analysis = await runtime.dispatch({ type: "ANALYSIS_READY", eventId: "analysis", recoveryId: a.recoveryId,
      demoContentHash: HASH, selectedPlayerId: a.selectedPlayerId, routeId: a.routeId, routeHash: a.routeHash,
      versions: { parser: a.versions.parser, analysisAdapter: a.versions.analysisAdapter, planner: a.versions.planCompiler } });
    expect(analysis.status).toBe("REBUILDING");
    expect(analysis.effects.map(effect => effect.type)).toEqual(["REQUEST_SESSION_REHYDRATE", "SEEK_RECOVERY_BOUNDARY", "RECONNECT_AGENT"]);
    const restored = await runtime.dispatch({ type: "RECOVERY_HANDSHAKE_COMPLETED", eventId: "restored", recoveryId: a.recoveryId });
    expect(restored).toMatchObject({ status: "RECOVERED", record: a });
  } finally { await deleteDatabase(databaseName); }
});
