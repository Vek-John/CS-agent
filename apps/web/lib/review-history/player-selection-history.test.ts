import { randomUUID } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachingSession } from "@cs-coach/session";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildInitialCoachingRouteState } from "../coaching/cs2d-route-integration";
import { buildSessionRecoveryRecord, createRecoverySessionIdentity } from "../recovery/cs2d-session-recovery";
import { createSessionRecoveryRuntime } from "../recovery/session-recovery-runtime";
import { HistoryPersistenceController } from "./history-persistence-controller";
import { selectPlayerHistory } from "./player-selection-history";

const replay = { sourceKind: "MANAGED_LIBRARY", demoId: "managed-demo", map: "de_mirage" };
const player = { playerId: self, displayName: "Synthetic" };
function historyFixture(create = vi.fn(async () => ({ reviewId: "created-review" }))) {
  const history = new HistoryPersistenceController({ createReview: create, startRevision: vi.fn(), appendArtifact: vi.fn(), commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
  return { history, create };
}
function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => { const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("cleanup blocked")); });
}

it("does not create managed history for the actual local recovery SELECT_PLAYER effect", async () => {
  const factory = new IDBFactory(), databaseName = `selection-${randomUUID()}`;
  try {
    // Synthetic source yields a real single-cue Adapter/compiler recovery record.
    const analysis = buildCs2dAnalysisBundle({ replay: fireReplay("DEATH", []), selectedSteamId: self, demoId: "selection-fixture", demoContentHash: "a".repeat(64) });
    const plan = analysis.review_plan, cue = plan.cues[0];
    const narrationByCue = { [cue.id]: deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set)) };
    const routeState = buildInitialCoachingRouteState(plan, { narrationByCue }), identity = createRecoverySessionIdentity();
    const record = buildSessionRecoveryRecord({ analysis, plan, routeState, identity, narrationByCue,
      session: createCoachingSession(plan, identity.sessionId, routeState), boundaryKind: "ROUTE_START", agentCheckpointId: null, demoContentHash: "a".repeat(64), selectedPlayerId: self });
    const original = createSessionRecoveryRuntime({ indexedDB: factory, databaseName });
    await original.dispatch({ type: "SESSION_STARTED", eventId: "start", record });
    const runtime = createSessionRecoveryRuntime({ indexedDB: factory, databaseName });
    const boot = await runtime.dispatch({ type: "BOOT", eventId: "boot" });
    expect(boot.status).toBe("DORMANT"); expect(boot.record).toEqual(record);
    const ready = await runtime.dispatch({ type: "REPLAY_READY", eventId: "replay-ready", recoveryId: record.recoveryId,
      replayAvailability: "READY", demoContentHash: "a".repeat(64), availablePlayerIds: [self] });
    const select = ready.effects.find(effect => effect.type === "SELECT_PLAYER");
    expect(select?.type).toBe("SELECT_PLAYER");
    if (select?.type !== "SELECT_PLAYER") throw new Error("Runtime did not select the original player");
    const f = historyFixture(), onCreated = vi.fn(), onError = vi.fn();
    await selectPlayerHistory({ history: f.history, replay, player: { ...player, playerId: select.playerId }, recoveryPending: true,
      useExistingReview: false, isCurrent: () => true, onCreated, onError });
    expect(f.create).not.toHaveBeenCalled(); expect(f.history.reviewId).toBeUndefined();
    expect(onCreated).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    const wrong = await runtime.dispatch({ type: "REPLAY_READY", eventId: "wrong-replay", recoveryId: record.recoveryId,
      replayAvailability: "READY", demoContentHash: "b".repeat(64), availablePlayerIds: [self] });
    expect(wrong.status).toBe("REJECTED"); expect(wrong.record).toEqual(record);
    // A manual selection while the recovery mismatch remains unresolved is not an exit action.
    await selectPlayerHistory({ history: f.history, replay, player: { playerId: "other", displayName: "Other" }, recoveryPending: true,
      useExistingReview: false, isCurrent: () => true, onCreated, onError });
    expect(f.create).not.toHaveBeenCalled();
  } finally { await deleteDatabase(factory, databaseName); }
});

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

it("creates exactly one ordinary managed selection and retains its identity after unrelated analysis work", async () => {
  const gate = deferred<{ reviewId: string }>(), f = historyFixture(vi.fn(() => gate.promise));
  const onCreated = vi.fn(), onError = vi.fn();
  const live = { replay, playerId: player.playerId, openEpoch: 1, analysisGeneration: 1 };
  const pending = selectPlayerHistory({ history: f.history, replay, player, recoveryPending: false, useExistingReview: false,
    isCurrent: () => live.replay === replay && live.playerId === player.playerId && live.openEpoch === 1, onCreated, onError });
  live.analysisGeneration++;
  gate.resolve({ reviewId: "new-review" }); await pending;
  expect(f.create).toHaveBeenCalledExactlyOnceWith({ demoId: replay.demoId, selectedPlayerId: self, selectedPlayerName: "Synthetic",
    title: "de_mirage · Synthetic", mapName: "de_mirage" });
  expect(onCreated).toHaveBeenCalledExactlyOnceWith("new-review"); expect(onError).not.toHaveBeenCalled(); expect(f.history.reviewId).toBe("new-review");
});

it.each(["local-file", "missing-demo", "existing-review", "stale-selection"])("does not create a history for %s", condition => {
  const f = historyFixture(), onCreated = vi.fn(), onError = vi.fn();
  f.history.adopt("existing", "revision", "managed-demo");
  return selectPlayerHistory({ history: f.history, replay: condition === "local-file" ? { ...replay, sourceKind: "LOCAL_FILE" }
    : condition === "missing-demo" ? { ...replay, demoId: undefined } : replay, player,
    recoveryPending: false, useExistingReview: condition === "existing-review", isCurrent: () => condition !== "stale-selection", onCreated, onError }).then(() => {
      expect(f.create).not.toHaveBeenCalled(); expect(f.history.reviewId).toBe("existing"); expect(f.history.revisionId).toBe("revision");
      expect(onCreated).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    });
});

it.each((["Demo", "player", "history"] as const).flatMap(change => [true, false].map(success => ({ change, success }))))("ignores late creation after $change change (success: $success)", async ({ change, success }) => {
  const gate = deferred<{ reviewId: string }>(), f = historyFixture(vi.fn(() => gate.promise));
  const onCreated = vi.fn(), onError = vi.fn(); let current = true;
  const pending = selectPlayerHistory({ history: f.history, replay, player, recoveryPending: false, useExistingReview: false,
    isCurrent: () => current, onCreated, onError });
  current = false;
  if (change === "history") f.history.adopt("different-review", "different-revision", "different-demo");
  else if (change === "player") {
    f.create.mockResolvedValueOnce({ reviewId: "different-player-review" });
    await f.history.createForPlayer({ demoId: replay.demoId, selectedPlayerId: "different-player", selectedPlayerName: "Other", title: "Other" });
  } else f.history.reset(); // Host resets the persistence owner when a different Replay is accepted.
  if (success) gate.resolve({ reviewId: "late-created" }); else gate.reject(new Error("late creation failure"));
  await pending;
  expect(onCreated).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
  expect(f.history.reviewId).toBe(change === "history" ? "different-review" : change === "player" ? "different-player-review" : undefined);
  expect(f.create).toHaveBeenCalledTimes(change === "player" ? 2 : 1);
});

it("rejects an older same-player completion even when selection identifiers return to the same values", async () => {
  const old = deferred<{ reviewId: string }>(), create = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce({ reviewId: "current" });
  const f = historyFixture(create), onCreated = vi.fn(), onError = vi.fn();
  const input = { history: f.history, replay, player, recoveryPending: false, useExistingReview: false, isCurrent: () => true, onCreated, onError };
  const first = selectPlayerHistory(input);
  await selectPlayerHistory(input);
  old.resolve({ reviewId: "old" }); await first;
  expect(f.history.reviewId).toBe("current"); expect(onCreated).toHaveBeenCalledExactlyOnceWith("current"); expect(onError).not.toHaveBeenCalled();
});

it("reports a creation failure only for the still-current ordinary selection", async () => {
  const f = historyFixture(vi.fn(async () => { throw new Error("create failed"); })), onCreated = vi.fn(), onError = vi.fn();
  await selectPlayerHistory({ history: f.history, replay, player, recoveryPending: false, useExistingReview: false, isCurrent: () => true, onCreated, onError });
  expect(onCreated).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledOnce(); expect(f.history.reviewId).toBeUndefined();
});
