import { randomUUID } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import type { CoachingSessionState } from "@cs-coach/contracts";
import type { SessionRecoveryResult } from "@cs-coach/coach-agent/client";
import * as adapter from "@cs-coach/cs2d-analysis-adapter";
import * as planner from "@cs-coach/review-planner";
import { createCoachingSession } from "@cs-coach/session";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { createReviewHistoryApi } from "../review-history/api";
import { HistoryPersistenceController } from "../review-history/history-persistence-controller";
import { persistPreparedReviewStart } from "../review-history/prepared-start-persistence";
import { activatePreparedCoachingSession, buildInitialCoachingRouteState, settlePreparedCoachingStart } from "../coaching/cs2d-route-integration";
import { buildSessionRecoveryRecord, createRecoverySessionIdentity, restoreRecoveryArtifacts } from "./cs2d-session-recovery";
import { createSessionRecoveryRuntime } from "./session-recovery-runtime";

const hash = "a".repeat(64);
afterEach(() => { vi.restoreAllMocks(); });
function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Isolated recovery database cleanup blocked"));
  });
}

async function startAfterLibraryFailure(indexedDB: IDBFactory | null, databaseName: string) {
  // Synthetic Replay timings; the real Adapter/compiler generates this single-cue route.
  const generateAnalysis = vi.spyOn(adapter, "buildCs2dAnalysisBundle");
  const generateNarration = vi.spyOn(planner, "deterministicNarrationBundle");
  const analysis = adapter.buildCs2dAnalysisBundle({ replay: fireReplay("DEATH", []), selectedSteamId: self, demoId: "failed-start-fixture", demoContentHash: hash });
  const plan = analysis.review_plan, cue = plan.cues[0];
  expect(plan.cues).toHaveLength(1);
  const narration = planner.deterministicNarrationBundle(planner.buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), planner.buildOutcomePackage(cue, analysis.candidate_set));
  const narrationByCue = { [cue.id]: narration };
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue });
  expect(routeState.startable).toBe(true);
  const identity = createRecoverySessionIdentity();
  const initialSession = createCoachingSession(plan, identity.sessionId, routeState);
  const record = buildSessionRecoveryRecord({ identity, analysis, plan, routeState, session: initialSession, narrationByCue,
    boundaryKind: "ROUTE_START", agentCheckpointId: null, demoContentHash: hash, selectedPlayerId: self });
  const attempted: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/revisions")) return Response.json({ revisionId: "revision" }, { status: 201 });
    const type = JSON.parse(String(init?.body)).artifactType as string;
    attempted.push(type);
    return type === "NARRATION_BUNDLE" ? Response.json({ code: "ARTIFACT_FAILED" }, { status: 500 }) : Response.json({ saved: true });
  });
  const api = createReviewHistoryApi(fetcher as typeof fetch);
  const head = vi.fn(api.commitRuntimeHead);
  const history = new HistoryPersistenceController({ createReview: api.create, startRevision: api.startRevision, appendArtifact: api.appendArtifact, commitRuntimeHead: head, markFailed: vi.fn() });
  history.adopt("review", undefined, "demo");
  const runtime = createSessionRecoveryRuntime({ indexedDB, databaseName });
  let accepted: SessionRecoveryResult | undefined;
  const mount = vi.fn((_session: CoachingSessionState) => {});
  const saved = vi.fn(), unconfirmed = vi.fn();
  const activate = vi.fn(() => activatePreparedCoachingSession({ plan, initialSession, isCurrent: () => true,
    latestRouteState: () => routeState,
    persistStart: () => runtime.dispatch({ type: "SESSION_STARTED", eventId: "failed-library-local-start", record }),
    acceptPersistedStart: result => { accepted = result; }, mountSession: mount,
  }));
  const started = await settlePreparedCoachingStart({ durability: persistPreparedReviewStart({ history, plan, routeState, record, analysis, narrationByCue,
    readRawAnalysis: () => analysis, isCurrent: () => true }), isCurrent: () => true, saved, unconfirmed, activate });
  expect(started).toBe(true); expect(unconfirmed).toHaveBeenCalledOnce(); expect(saved).not.toHaveBeenCalled();
  expect(activate).toHaveBeenCalledOnce(); expect(mount).toHaveBeenCalledOnce();
  expect(mount.mock.calls[0][0].phase).not.toBe("INTRO");
  expect(attempted).toEqual(["ANALYSIS_BUNDLE", "CANDIDATE_SET", "REVIEW_PLAN", "NARRATION_BUNDLE"]);
  expect(head).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(5);
  return { plan, cue, narration, record, identity, runtime, accepted: accepted!, mount, fetcher, head, generateAnalysis, generateNarration };
}

it("preserves local recovery after failed library startup, without claiming a durable library head", async () => {
  const factory = new IDBFactory(), databaseName = `failed-start-${randomUUID()}`;
  try {
    const f = await startAfterLibraryFailure(factory, databaseName);
    expect(f.accepted.status).toBe("READY"); expect(f.accepted.record).toEqual(f.record);
    const reopened = createSessionRecoveryRuntime({ indexedDB: factory, databaseName });
    const boot = await reopened.dispatch({ type: "BOOT", eventId: "reopened-after-library-failure" });
    expect(boot.status).toBe("DORMANT"); expect(boot.effects).toEqual([]); expect(boot.record).toEqual(f.record);
    expect(boot.record?.agentCheckpointId).toBeNull();
    const recovered = restoreRecoveryArtifacts(boot.record!);
    expect(recovered.plan).toEqual(f.record.frozenReviewPlan);
    expect(recovered.session).toMatchObject({ id: f.identity.sessionId, phase: "INTRO", current_segment_index: 0,
      current_tick: f.plan.segments[0].start_tick, consumed_cue_ids: [], revealed_cue_ids: [] });
    expect(recovered.routeState.startable).toBe(true);
    expect(recovered.routeState.routeFingerprint).toBe(f.record.routeHash);
    const restoredNarration = recovered.narrationByCue[f.cue.id];
    expect(restoredNarration.cueId).toBe(f.cue.id);
    for (const field of ["currentSituation", "playerAction", "coreIssue", "betterPlay", "outcomeImpact"] as const) {
      expect(restoredNarration[field]).toEqual(f.record.narrationArtifacts[0].narrationSummary.fields[field]);
    }
    expect(restoredNarration.playerAction.text).toBe(f.narration.playerAction.text);
    const wrong = await reopened.dispatch({ type: "REPLAY_READY", eventId: "wrong-demo", recoveryId: f.record.recoveryId,
      replayAvailability: "READY", demoContentHash: "b".repeat(64), availablePlayerIds: [self] });
    expect(wrong.status).toBe("REJECTED"); expect(wrong.record).toEqual(f.record); expect(wrong.effects).toEqual([]);
    expect(f.generateAnalysis).toHaveBeenCalledOnce(); expect(f.generateNarration).toHaveBeenCalledOnce();
    expect(f.fetcher).toHaveBeenCalledTimes(5); expect(f.head).not.toHaveBeenCalled();
  } finally { await deleteDatabase(factory, databaseName); }
});

it("continues in memory when IndexedDB is unavailable but cannot recover in a new runtime", async () => {
  const f = await startAfterLibraryFailure(null, `memory-only-${randomUUID()}`);
  expect(f.accepted.status).toBe("DEGRADED"); expect(f.accepted.reason).toContain("刷新后不能恢复");
  expect(f.accepted.record).toEqual(f.record);
  const sameRuntime = await f.runtime.dispatch({ type: "BOOT", eventId: "same-memory-owner" });
  expect(sameRuntime.record).toEqual(f.record);
  const reopened = createSessionRecoveryRuntime({ indexedDB: null });
  const boot = await reopened.dispatch({ type: "BOOT", eventId: "new-memory-owner" });
  expect(boot.status).toBe("DEGRADED"); expect(boot.record).toBeNull(); expect(boot.recoveryId).toBeNull(); expect(boot.effects).toEqual([]);
  expect(boot.reason).toContain("刷新后不能恢复");
  expect(f.generateAnalysis).toHaveBeenCalledOnce(); expect(f.generateNarration).toHaveBeenCalledOnce();
  expect(f.fetcher).toHaveBeenCalledTimes(5); expect(f.head).not.toHaveBeenCalled();
});
