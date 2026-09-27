import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import * as analysisAdapter from "@cs-coach/cs2d-analysis-adapter";
import * as planner from "@cs-coach/review-planner";
import { createCoachAgentRuntime } from "@cs-coach/coach-agent";
import { checkpointThreadIdForSession, SessionRecoveryRecordSchema, type CoachAgentEvent, type CoachAgentResult } from "@cs-coach/coach-agent/client";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import type { CoachingSessionState, NarrationBundle, ReviewPlan } from "@cs-coach/contracts";
import { SqliteDatabaseOwner, SqliteCheckpointSaver } from "@cs-coach/memory-sqlite/server";
import { DesktopReviewLibrary, installDesktopReviewLibrary, type AppendArtifactInput, type CommitRuntimeHeadInput, type ReviewRuntimeHead } from "@cs-coach/review-library/server";
import { twoCueViewerReplay, twoCueViewerPlayer } from "../../../../tools/cs2d-host/viewer-two-cue-fixture";
import { GET } from "../../app/api/review-history/[id]/route";
import { POST } from "../../app/api/review-history/[id]/artifacts/route";
import { PUT } from "../../app/api/review-history/[id]/runtime-head/route";
import { DESKTOP_APP_ORIGIN_HEADER } from "../desktop/request-origin";
import { buildInitialCoachingRouteState, createReviewPreparationOrchestrator } from "../coaching/cs2d-route-integration";
import { guidedPlaybackDirective } from "../coaching/cs2d-guided-session";
import { CoachAgentStage3Controller } from "../coaching/coach-agent-stage3-controller";
import { CoachAgentStage3HostAdapter, type Stage3IdentityInput } from "../coaching/coach-agent-stage3-host-adapter";
import { buildCheckpointedRecoveryRecord, buildReconnectReplayEvent, createRecoverySessionIdentity, createRecoveryReviewPreparationDependencies,
  normalizeRecoveryAnalysis, restoreRecoveryArtifacts, validateStoredReviewArtifacts } from "../recovery/cs2d-session-recovery";
import { HistoryRestoreController, type ReviewHistoryDetail } from "./history-restore-controller";

const origin = "http://127.0.0.1:43123";
const headers = { [DESKTOP_APP_ORIGIN_HEADER]: origin, "content-type": "application/json" };
afterEach(() => { installDesktopReviewLibrary(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function reachCue(plan: ReviewPlan, initial: CoachingSessionState, cueId: string): CoachingSessionState {
  let session = initial;
  for (let count = 0; count < plan.segments.length * 3; count++) {
    if (session.phase === "PAUSED_FOR_COACHING" && session.current_cue_id === cueId) return session;
    const cue = plan.cues.find(item => item.id === session.current_cue_id), segment = plan.segments[session.current_segment_index];
    if (!segment) throw Error("CUE_NOT_REACHED");
    const directive = guidedPlaybackDirective(plan, session);
    session = reduceCoachingSession(plan, session, directive.automaticAction ?? { type: "TICK", tick: cue?.outcome_end_tick ?? segment.end_tick });
  }
  throw Error("CUE_NOT_REACHED");
}
function diagnosisInput(identity: Stage3IdentityInput, session: CoachingSessionState, narration: NarrationBundle, analysis: analysisAdapter.Cs2dAnalysisBundle) {
  const cue = identity.plan.cues.find(item => item.id === session.current_cue_id);
  if (!cue || session.phase !== "PAUSED_FOR_COACHING" || !session.outcome_completion) throw Error("MISSING_REAL_OUTCOME_GATE");
  return { ...identity, cue, narration, generation: 1, tickRate: analysis.match_timeline.tick_rate, currentSessionPhase: session.phase,
    outcomeGate: session.outcome_completion, evidence: { candidate: analysis.candidate_set.candidates.find(item => item.candidateId === cue.candidate_id),
      material: analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id), winProbabilityTimeline: analysis.win_probability_timeline } };
}

it("cold-reopens an actual SQLite Graph checkpoint and continues after the consumed cue; rejected head preserves the exact checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ordinary-cold-start-")), path = join(directory, "history.sqlite3");
  let owner: SqliteDatabaseOwner | undefined;
  let runtime: ReturnType<typeof createCoachAgentRuntime> | undefined;
  let controller: CoachAgentStage3Controller | undefined;
  let history: HistoryRestoreController | undefined;
  let preparation: ReturnType<typeof createReviewPreparationOrchestrator> | undefined;
  try {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const fetcher = vi.fn(() => { throw Error("NETWORK_NOT_EXPECTED"); }); vi.stubGlobal("fetch", fetcher);
    owner = new SqliteDatabaseOwner({ path });
    let library = new DesktopReviewLibrary({ owner, dataRoot: directory }); await library.initialize(); installDesktopReviewLibrary(library);
    // Header-only bytes exercise managed ownership; no Parser or real Demo is used.
    const bytes = Buffer.from("PBDEMS2\0", "binary"), hash = createHash("sha256").update(bytes).digest("hex");
    const capability = library.issueImportCapability({ objectId: "cold-fixture", originalFilename: "synthetic.dem", expectedByteLength: bytes.length });
    const imported = await library.importDemo({ authorization: capability.authorization, objectId: "cold-fixture", stream: (async function* () { yield bytes; })() });
    await library.finalizeDemoImport({ authorization: imported.validationCapability!.authorization, demoId: imported.demo.demoId, valid: true, parserVersion: "synthetic-no-parser" });
    const analysis = analysisAdapter.buildCs2dAnalysisBundle({ replay: twoCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: imported.demo.demoId, demoContentHash: hash });
    const plan = analysis.review_plan; expect(plan.cues).toHaveLength(2);
    const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, planner.deterministicNarrationBundle(
      planner.buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), planner.buildOutcomePackage(cue, analysis.candidate_set))]));
    const routeState = buildInitialCoachingRouteState(plan, { narrationByCue }), recoveryIdentity = createRecoverySessionIdentity();
    const identity = { plan, routeState, analysis, demoContentHash: hash, selectedPlayerId: twoCueViewerPlayer, sessionId: recoveryIdentity.sessionId, runId: recoveryIdentity.runId };
    runtime = createCoachAgentRuntime({ checkpointer: new SqliteCheckpointSaver({ owner }), checkpoint: "sqlite", checkpointBackend: "SQLITE" });
    let latest: CoachAgentResult | undefined;
    controller = new CoachAgentStage3Controller({ adapter: new CoachAgentStage3HostAdapter(), dispatch: async event => { latest = await runtime!.dispatch(event); return latest; },
      post: () => { throw Error("VISUAL_TOOL_NOT_EXPECTED"); }, bridgeAvailable: () => true, isLive: () => true });
    let session = reachCue(plan, reduceCoachingSession(plan, createCoachingSession(plan, identity.sessionId, routeState), { type: "START" }), plan.cues[0].id);
    const first = await controller.synchronizeDiagnosis(diagnosisInput(identity, session, narrationByCue[plan.cues[0].id], analysis));
    expect(first?.state.completedCueIds).toEqual([plan.cues[0].id]);
    session = reduceCoachingSession(plan, session, { type: "CUE_PRESENTED", cueId: plan.cues[0].id });
    session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
    for (let count = 0; count < plan.segments.length; count++) {
      const segment = plan.segments[session.current_segment_index];
      controller.observeSegment(identity, segment.id, session.current_segment_index, segment.mode === "SKIP" ? "SKIP" : segment.mode === "BRIEF" ? "BRIEF" : "OBSERVE", session.phase === "SKIPPING" ? "SKIPPING" : "PLAYING");
      await vi.waitFor(() => expect(latest?.state.routeCursor).toBe(session.current_segment_index));
      if (session.phase === "PLAYING" && segment.cue_ids.length === 0) {
        session = reduceCoachingSession(plan, session, { type: "TICK", tick: segment.start_tick + 8 }); break;
      }
      const directive = guidedPlaybackDirective(plan, session);
      session = reduceCoachingSession(plan, session, directive.automaticAction ?? { type: "TICK", tick: segment.end_tick });
    }
    if (!latest?.checkpoint.checkpointId) throw Error("NO_SQLITE_CHECKPOINT");
    expect(latest.checkpoint.backend).toBe("SQLITE");
    const record = buildCheckpointedRecoveryRecord({ identity: recoveryIdentity, plan, routeState, analysis, narrationByCue, session,
      selectedPlayerId: twoCueViewerPlayer, demoContentHash: hash, agentCheckpointId: null, boundaryKind: "ORDINARY_SEGMENT" }, { ...latest.state, checkpointId: latest.checkpoint.checkpointId });
    if (!record || record.boundary.kind !== "ORDINARY_SEGMENT") throw Error("NO_ORDINARY_RECORD");
    const cursor = record.boundary.segmentIndex;
    expect(record.cueProgress.consumedCueIds).toEqual([plan.cues[0].id]);
    const review = await library.createReview({ demoId: imported.demo.demoId, selectedPlayerId: twoCueViewerPlayer, selectedPlayerName: "Synthetic", title: "Synthetic cold start" });
    const revision = await library.startRevision({ reviewId: review.reviewId, analysisVersion: analysis.metadata.adapter_version, graphVersion: latest.state.graphVersion,
      promptVersion: plan.generation_manifest.prompt_version, modelMetadata: {}, routeId: plan.id, routeHash: routeState.routeFingerprint });
    const context = { params: Promise.resolve({ id: review.reviewId }) };
    const append = async (artifactType: AppendArtifactInput["artifactType"], artifactKey: string, schemaVersion: string, payload: unknown) => {
      const response = await POST(new Request(`${origin}/api/review-history/${review.reviewId}/artifacts`, { method: "POST", headers,
        body: JSON.stringify({ revisionId: revision.reviewRevisionId, artifactType, artifactKey, artifactRevision: 1, schemaVersion, payload, idempotencyKey: `${artifactType}:${artifactKey}` }) }), context);
      expect(response.status).toBe(201);
    };
    await append("ANALYSIS_BUNDLE", "analysis", "cs2d-analysis-bundle.v1", analysis);
    await append("CANDIDATE_SET", analysis.candidate_set.id, "candidate-set.v1", analysis.candidate_set);
    await append("REVIEW_PLAN", plan.id, "review-plan.v1", plan);
    for (const [cueId, narration] of Object.entries(narrationByCue)) await append("NARRATION_BUNDLE", cueId, "narration-bundle.v1", narration);
    await append("SESSION_RECOVERY", "ordinary-confirmed", "session-recovery-record.v2", record);
    const head: CommitRuntimeHeadInput = { reviewId: review.reviewId, reviewRevisionId: revision.reviewRevisionId, expectedRecoveryArtifactId: null,
      recoveryArtifactKey: "ordinary-confirmed", recoveryArtifactRevision: 1, sessionId: record.sessionId, runId: record.runId,
      demoId: imported.demo.demoId, demoContentHash: hash, selectedPlayerId: twoCueViewerPlayer, routeId: plan.id, routeHash: record.routeHash,
      recoveryBoundary: "ORDINARY_SEGMENT", defaultRouteCursor: cursor, completedCueCount: 1, totalCueCount: 2,
      checkpointThreadId: checkpointThreadIdForSession(record.sessionId), checkpointNamespace: "", checkpointId: record.agentCheckpointId!, stableProgress: record.cueProgress };
    const putHead = (value: CommitRuntimeHeadInput) => PUT(new Request(`${origin}/api/review-history/${review.reviewId}/runtime-head`, { method: "PUT", headers, body: JSON.stringify(value) }), context);
    const saved = await putHead(head); expect(saved.status).toBe(200);
    const confirmed = await saved.json() as ReviewRuntimeHead;
    const checkpointConfig = { configurable: { thread_id: head.checkpointThreadId!, checkpoint_ns: "", checkpoint_id: head.checkpointId! } };
    expect((await new SqliteCheckpointSaver({ owner }).getTuple(checkpointConfig))?.checkpoint.id).toBe(head.checkpointId);
    const beforeClose = await library.loadReview(review.reviewId, { materializeExternalArtifacts: true });
    expect(beforeClose.runtimeHead).toEqual(confirmed);
    const rowsBeforeClose = Number(owner.db.prepare("SELECT COUNT(*) AS n FROM agent_checkpoints").get()!.n);
    controller.dispose(); controller = undefined; runtime = undefined; latest = undefined;
    installDesktopReviewLibrary(undefined); await owner.close(); owner = undefined;

    // Cold owner, saver, Runtime and Controller: no former in-memory Graph reused.
    owner = new SqliteDatabaseOwner({ path });
    library = new DesktopReviewLibrary({ owner, dataRoot: directory }); await library.initialize(); installDesktopReviewLibrary(library);
    const generateAnalysis = vi.spyOn(analysisAdapter, "buildCs2dAnalysisBundle"), generateNarration = vi.spyOn(planner, "deterministicNarrationBundle"), compile = vi.spyOn(planner, "compileReviewPlan");
    const requestViewerSource = vi.fn(), loadManagedDemo = vi.fn();
    history = new HistoryRestoreController({ loadDetail: async id => {
      const response = await GET(new Request(`${origin}/api/review-history/${id}`, { headers }), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(200); return await response.json() as ReviewHistoryDetail;
    }, requestViewerSource, loadManagedDemo });
    const opened = await history.open(review.reviewId); expect(opened.missingArtifacts).toEqual([]);
    const read = SessionRecoveryRecordSchema.parse(opened.recoverySnapshot);
    const validated = validateStoredReviewArtifacts({ ...opened, selectedPlayerId: twoCueViewerPlayer, demoContentHash: hash });
    const normalized = normalizeRecoveryAnalysis(validated.analysis, read), restored = restoreRecoveryArtifacts(read);
    expect(read.agentCheckpointId).toBe(head.checkpointId);
    expect(restored.session).toMatchObject({ phase: "PLAYING", current_segment_index: cursor, current_tick: plan.segments[cursor].start_tick });
    expect(restored.session.consumed_cue_ids).toEqual([plan.cues[0].id]);
    const deps = createRecoveryReviewPreparationDependencies(normalized, read), prepareRoute = vi.fn(deps.prepareRoute), prepareNarration = vi.fn(deps.prepareNarration);
    const savedNarration = { ...restored.narrationByCue, ...validated.narrationByCue };
    const loadedRoute = buildInitialCoachingRouteState(restored.plan, { narrationByCue: savedNarration });
    preparation = createReviewPreparationOrchestrator("ordinary-cold-reopen", restored.plan, { narrationByCue: savedNarration, readiness: loadedRoute.readiness }, { ...deps, prepareRoute, prepareNarration });
    const preparationEvents: string[] = []; await preparation.run(event => preparationEvents.push(event.type));
    expect(preparationEvents).toContain("READY_TO_START"); expect(preparationEvents).not.toContain("NARRATION_UPDATE");
    const coldSaver = new SqliteCheckpointSaver({ owner });
    expect((await coldSaver.getTuple(checkpointConfig))?.checkpoint.id).toBe(head.checkpointId);
    runtime = createCoachAgentRuntime({ checkpointer: coldSaver, checkpoint: "sqlite", checkpointBackend: "SQLITE" });
    const events: CoachAgentEvent[] = [], coldAdapter = new CoachAgentStage3HostAdapter();
    controller = new CoachAgentStage3Controller({ adapter: coldAdapter, dispatch: async event => { events.push(event); return runtime!.dispatch(event); },
      post: () => { throw Error("VISUAL_TOOL_NOT_EXPECTED"); }, bridgeAvailable: () => true, isLive: () => true });
    const reconnect = buildReconnectReplayEvent(read), result = await controller.reconnect(reconnect);
    expect(result.restored).toBe("MATCHED"); expect(result.checkpoint.backend).toBe("SQLITE");
    expect(controller.adoptRecoveredOrdinary(reconnect, result)).toBe(true);
    expect(coldAdapter.lifecycleCursor).toBe(cursor);
    const nextSession = reachCue(restored.plan, restored.session, plan.cues[1].id);
    const nextIdentity = { ...identity, plan: restored.plan, routeState: loadedRoute, analysis: normalized };
    const next = await controller.synchronizeDiagnosis(diagnosisInput(nextIdentity, nextSession, savedNarration[plan.cues[1].id], normalized));
    expect(next?.state.activeCueId).toBe(plan.cues[1].id); expect(coldAdapter.lifecycleDegraded).toBe(false);
    expect(events.filter(event => event.type === "START_CUE").map(event => event.cueId)).toEqual([plan.cues[1].id]);
    expect(events.filter(event => event.type === "OBSERVE_SEGMENT").every(event => event.segmentIndex > cursor)).toBe(true);
    expect(nextSession.presented_cue_ids).toEqual([plan.cues[0].id]);
    for (const operation of [generateAnalysis, generateNarration, compile, prepareNarration, requestViewerSource, loadManagedDemo, fetcher]) expect(operation).not.toHaveBeenCalled();
    expect(prepareRoute).toHaveBeenCalledOnce();
    const after = await library.loadReview(review.reviewId, { materializeExternalArtifacts: true });
    expect(after.artifacts).toEqual(beforeClose.artifacts); expect(after.runtimeHead).toEqual(confirmed);
    // The real Graph has advanced to cue 2. A subsequent proposal rejected by
    // the actual head CAS must preserve the old head and its exact saver tuple.
    expect(next?.checkpoint.checkpointId).not.toBe(head.checkpointId);
    await append("SESSION_RECOVERY", "ordinary-rejected-proposal", "session-recovery-record.v2", read);
    const rejected = await putHead({ ...head, recoveryArtifactKey: "ordinary-rejected-proposal", expectedRecoveryArtifactId: "stale-owner" });
    const rejectionCode = (await rejected.json() as { code?: string }).code;
    const retainedCheckpoint = (await coldSaver.getTuple(checkpointConfig))?.checkpoint.id;
    expect({ status: rejected.status, code: rejectionCode, exactCheckpointRetained: retainedCheckpoint === head.checkpointId })
      .toEqual({ status: 409, code: "RUNTIME_HEAD_CONFLICT", exactCheckpointRetained: true });
    expect((await library.loadReview(review.reviewId, { materializeExternalArtifacts: true })).runtimeHead).toEqual(confirmed);
    expect((await coldSaver.getTuple(checkpointConfig))?.checkpoint.id).toBe(head.checkpointId);
    const output = process.env.CS_COACH_ORDINARY_COLD_START_OUTPUT;
    if (output) writeFileSync(output, JSON.stringify({ synthetic: true, cues: 2, restoredConsumedCues: 1,
      restored: result.restored, checkpointBackend: result.checkpoint.backend, graphEventsAfterReopen: events.map(event => event.type),
      analysisCallsAfterReopen: generateAnalysis.mock.calls.length, narrationCallsAfterReopen: generateNarration.mock.calls.length,
      routeCompilationCallsAfterReopen: compile.mock.calls.length, externalRequests: fetcher.mock.calls.length,
      rejectedHeadStatus: rejected.status, rejectedHeadCode: rejectionCode, exactConfirmedCheckpointRetained: retainedCheckpoint === head.checkpointId,
      checkpointRowsBeforeClose: rowsBeforeClose, checkpointRowsAfterNextCue: Number(owner.db.prepare("SELECT COUNT(*) AS n FROM agent_checkpoints").get()!.n),
      limitations: ["Synthetic Replay and header-only managed bytes; Parser and Viewer omitted.", "Actual Graph/Saver/API handlers and temporary SQLite close/reopen; same Node test process.", "Next cue uses the normal local diagnosis synchronization path; no external model."] }, null, 2) + "\n", { flag: "wx" });

  } finally {
    preparation?.cancel(); history?.cancel(); controller?.dispose(); runtime = undefined; installDesktopReviewLibrary(undefined);
    if (owner) await owner.close(); await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
