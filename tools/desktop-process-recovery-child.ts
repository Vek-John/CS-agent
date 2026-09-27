import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { POST as agentPost } from "../apps/web/app/api/coaching/agent/route";
import { createRemoteCoachAgentDispatchEnvelope, parseRemoteCoachAgentDispatchResponse, checkpointThreadIdForSession, SessionRecoveryRecordSchema, type CoachAgentEvent, type CoachAgentResult } from "../libs/coach-agent/src/remote-dispatch-client";
import { getSqliteDatabaseOwner, closeSqliteDatabaseOwnersForTests, getSqliteCheckpointSaver } from "../libs/memory-sqlite/src/server";

const directory = process.argv[3], phase = process.argv[2];
if (!directory || process.env.CS_AGENT_DESKTOP_DB_PATH !== join(resolve(directory), "history.sqlite3") || process.env.DEPLOY_TARGET !== "desktop" || process.env.MEMORY_ENABLED !== "false") throw Error("ISOLATED_ENV_REQUIRED");
const origin = "http://127.0.0.1:43123", headers = { "content-type": "application/json", "x-cs-agent-app-origin": origin };
let stage = "BOOT", externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; throw Error("EXTERNAL_FETCH_FORBIDDEN"); };
const dispatched: CoachAgentEvent[] = [];
async function dispatch(event: CoachAgentEvent): Promise<CoachAgentResult> {
  const response = await agentPost(new Request(`${origin}/api/coaching/agent`, { method: "POST", headers, body: JSON.stringify(createRemoteCoachAgentDispatchEnvelope(event)) }));
  assert.equal(response.status, 200, "PRODUCTION_AGENT_POST_FAILED");
  const result = parseRemoteCoachAgentDispatchResponse(await response.json());
  assert.equal(result.checkpoint.backend, "SQLITE"); assert.equal(result.checkpoint.recoverableAfterRefresh, true);
  dispatched.push(event); return result;
}
async function run() {
  if (phase === "probe") {
    const result = await dispatch({ version: "coach-agent-event.v2", type: "OBSERVE_SEGMENT", eventId: "probe-observe",
      identity: { sessionId: "probe-session", runId: "probe-run", demoId: "synthetic", demoContentHash: "a".repeat(64), selectedPlayerId: "synthetic", routeId: "probe-route", routeHash: "probe-hash" },
      segmentId: "probe-ordinary", segmentIndex: 0, mode: "BRIEF", currentSessionPhase: "PLAYING" });
    return { phase, pid: process.pid, backend: result.checkpoint.backend, recoverableAfterRefresh: result.checkpoint.recoverableAfterRefresh, externalCalls };
  }
  if (phase === "seed") return seed();
  if (phase === "resume") return resume();
  throw Error("PHASE_NOT_IMPLEMENTED");
}


import { buildCs2dAnalysisBundle } from "../libs/cs2d-analysis-adapter/src/index";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "../libs/review-planner/src/index";
import { createCoachingSession, reduceCoachingSession } from "../libs/session/src/index";
import type { CoachingSessionState, ReviewPlan, NarrationBundle } from "../libs/contracts/src/index";
import { twoCueViewerReplay, twoCueViewerPlayer } from "./cs2d-host/viewer-two-cue-fixture";
import { DesktopReviewLibrary, installDesktopReviewLibrary, type AppendArtifactInput, type CommitRuntimeHeadInput } from "../libs/review-library/src/server";
import { GET as historyGet } from "../apps/web/app/api/review-history/[id]/route";
import { POST as artifactPost } from "../apps/web/app/api/review-history/[id]/artifacts/route";
import { PUT as headPut } from "../apps/web/app/api/review-history/[id]/runtime-head/route";
import { HistoryRestoreController, type ReviewHistoryDetail } from "../apps/web/lib/review-history/history-restore-controller";
import { buildInitialCoachingRouteState, createReviewPreparationOrchestrator } from "../apps/web/lib/coaching/cs2d-route-integration";
import { CoachAgentStage3Controller } from "../apps/web/lib/coaching/coach-agent-stage3-controller";
import { CoachAgentStage3HostAdapter, type Stage3IdentityInput } from "../apps/web/lib/coaching/coach-agent-stage3-host-adapter";
import { guidedPlaybackDirective } from "../apps/web/lib/coaching/cs2d-guided-session";
import { createRecoverySessionIdentity, buildCheckpointedRecoveryRecord, buildReconnectReplayEvent, restoreRecoveryArtifacts, normalizeRecoveryAnalysis,
  validateStoredReviewArtifacts, createRecoveryReviewPreparationDependencies } from "../apps/web/lib/recovery/cs2d-session-recovery";
function reachCue(plan: ReviewPlan, initial: CoachingSessionState, cueId: string) {
  let session = initial;
  for (let n = 0; n < plan.segments.length * 3; n++) {
    if (session.phase === "PAUSED_FOR_COACHING" && session.current_cue_id === cueId) return session;
    const segment = plan.segments[session.current_segment_index], cue = plan.cues.find(item => item.id === session.current_cue_id);
    assert(segment, "CUE_NOT_REACHED");
    const directive = guidedPlaybackDirective(plan, session);
    session = reduceCoachingSession(plan, session, directive.automaticAction ?? { type: "TICK", tick: cue?.outcome_end_tick ?? segment.end_tick });
  }
  throw Error("CUE_NOT_REACHED");
}
function diagnosticInput(identity: Stage3IdentityInput, session: CoachingSessionState, narration: NarrationBundle) {
  const analysis = identity.analysis as ReturnType<typeof buildCs2dAnalysisBundle>;
  const cue = identity.plan.cues.find(item => item.id === session.current_cue_id);
  if (!cue || session.phase !== "PAUSED_FOR_COACHING" || !session.outcome_completion) throw Error("OUTCOME_GATE_MISSING");
  return { ...identity, cue, narration, generation: 1, tickRate: analysis.match_timeline.tick_rate, currentSessionPhase: session.phase, outcomeGate: session.outcome_completion,
    evidence: { candidate: analysis.candidate_set.candidates.find(item => item.candidateId === cue.candidate_id), material: analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id), winProbabilityTimeline: analysis.win_probability_timeline } };
}
async function waitUntil(predicate: () => boolean) {
  for (let n = 0; n < 1000; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw Error("OBSERVER_DEADLINE");
}
async function seed() {
  stage = "SEED_LIBRARY";
  const owner = getSqliteDatabaseOwner(), library = new DesktopReviewLibrary({ owner, dataRoot: directory }); await library.initialize(); installDesktopReviewLibrary(library);
  const bytes = Buffer.from("PBDEMS2\0", "binary"), hash = createHash("sha256").update(bytes).digest("hex");
  const cap = library.issueImportCapability({ objectId: "process-fixture", originalFilename: "synthetic.dem", expectedByteLength: bytes.length });
  const imported = await library.importDemo({ authorization: cap.authorization, objectId: "process-fixture", stream: (async function* () { yield bytes; })() });
  await library.finalizeDemoImport({ authorization: imported.validationCapability!.authorization, demoId: imported.demo.demoId, valid: true, parserVersion: "synthetic-no-parser" });
  const analysis = buildCs2dAnalysisBundle({ replay: twoCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: imported.demo.demoId, demoContentHash: hash }), plan = analysis.review_plan;
  assert.equal(plan.cues.length, 2);
  const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set))]));
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue }), recoveryIdentity = createRecoverySessionIdentity();
  const identity = { analysis, plan, routeState, demoContentHash: hash, selectedPlayerId: twoCueViewerPlayer, sessionId: recoveryIdentity.sessionId, runId: recoveryIdentity.runId };
  let latest: CoachAgentResult | undefined;
  const controller = new CoachAgentStage3Controller({ adapter: new CoachAgentStage3HostAdapter(), dispatch: async event => { latest = await dispatch(event); return latest; }, post: () => { throw Error("TOOL_NOT_EXPECTED"); }, bridgeAvailable: () => true, isLive: () => true });
  try {
    stage = "SEED_GRAPH";
    let session = reachCue(plan, reduceCoachingSession(plan, createCoachingSession(plan, identity.sessionId, routeState), { type: "START" }), plan.cues[0].id);
    await controller.synchronizeDiagnosis(diagnosticInput(identity, session, narrationByCue[plan.cues[0].id]));
    session = reduceCoachingSession(plan, session, { type: "CUE_PRESENTED", cueId: plan.cues[0].id });
    session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
    for (let n = 0; n < plan.segments.length; n++) {
      const segment = plan.segments[session.current_segment_index];
      controller.observeSegment(identity, segment.id, session.current_segment_index, segment.mode === "SKIP" ? "SKIP" : segment.mode === "BRIEF" ? "BRIEF" : "OBSERVE", session.phase === "SKIPPING" ? "SKIPPING" : "PLAYING");
      await waitUntil(() => latest?.state.routeCursor === session.current_segment_index);
      if (session.phase === "PLAYING" && segment.cue_ids.length === 0) break;
      const directive = guidedPlaybackDirective(plan, session);
      session = reduceCoachingSession(plan, session, directive.automaticAction ?? { type: "TICK", tick: segment.end_tick });
    }
    assert(latest?.checkpoint.checkpointId);
    const record = buildCheckpointedRecoveryRecord({ identity: recoveryIdentity, analysis, plan, routeState, narrationByCue, session, demoContentHash: hash, selectedPlayerId: twoCueViewerPlayer, agentCheckpointId: null, boundaryKind: "ORDINARY_SEGMENT" }, { ...latest.state, checkpointId: latest.checkpoint.checkpointId });
    assert(record?.boundary.kind === "ORDINARY_SEGMENT");
    stage = "SEED_ARTIFACTS";
    const review = await library.createReview({ demoId: imported.demo.demoId, selectedPlayerId: twoCueViewerPlayer, selectedPlayerName: "Synthetic", title: "Process recovery" });
    const revision = await library.startRevision({ reviewId: review.reviewId, analysisVersion: analysis.metadata.adapter_version, graphVersion: latest.state.graphVersion, promptVersion: plan.generation_manifest.prompt_version, modelMetadata: {}, routeId: plan.id, routeHash: routeState.routeFingerprint });
    const context = { params: Promise.resolve({ id: review.reviewId }) };
    const append = async (artifactType: AppendArtifactInput["artifactType"], artifactKey: string, schemaVersion: string, payload: unknown) => {
      const response = await artifactPost(new Request(`${origin}/api/review-history/${review.reviewId}/artifacts`, { method: "POST", headers, body: JSON.stringify({ revisionId: revision.reviewRevisionId, artifactType, artifactKey, artifactRevision: 1, schemaVersion, payload, idempotencyKey: `${artifactType}:${artifactKey}` }) }), context);
      assert.equal(response.status, 201, "ARTIFACT_SAVE_FAILED");
    };
    await append("ANALYSIS_BUNDLE", "analysis", "cs2d-analysis-bundle.v1", analysis);
    await append("CANDIDATE_SET", analysis.candidate_set.id, "candidate-set.v1", analysis.candidate_set);
    await append("REVIEW_PLAN", plan.id, "review-plan.v1", plan);
    for (const [cue, narration] of Object.entries(narrationByCue)) await append("NARRATION_BUNDLE", cue, "narration-bundle.v1", narration);
    await append("SESSION_RECOVERY", "ordinary", "session-recovery-record.v2", record);
    const head: CommitRuntimeHeadInput = { reviewId: review.reviewId, reviewRevisionId: revision.reviewRevisionId, expectedRecoveryArtifactId: null, recoveryArtifactKey: "ordinary", recoveryArtifactRevision: 1,
      sessionId: record.sessionId, runId: record.runId, demoId: imported.demo.demoId, demoContentHash: hash, selectedPlayerId: twoCueViewerPlayer, routeId: plan.id, routeHash: record.routeHash,
      recoveryBoundary: "ORDINARY_SEGMENT", defaultRouteCursor: record.boundary.segmentIndex, completedCueCount: 1, totalCueCount: 2,
      checkpointThreadId: checkpointThreadIdForSession(record.sessionId), checkpointNamespace: "", checkpointId: record.agentCheckpointId!, stableProgress: record.cueProgress };
    stage = "SEED_HEAD";
    assert.equal((await headPut(new Request(`${origin}/api/review-history/${review.reviewId}/runtime-head`, { method: "PUT", headers, body: JSON.stringify(head) }), context)).status, 200);
    await writeFile(join(directory, "control.json"), JSON.stringify({ reviewId: review.reviewId, seedPid: process.pid }), { flag: "wx" });
    return { phase, pid: process.pid, backend: latest.checkpoint.backend, recoverableAfterRefresh: latest.checkpoint.recoverableAfterRefresh, consumedCues: 1, graphEvents: dispatched.map(event => event.type), generatedAnalysis: 1, generatedNarration: 2, externalCalls };
  } finally { controller.dispose(); installDesktopReviewLibrary(undefined); }
}
async function resume() {
  stage = "RESUME_LIBRARY";
  const { reviewId, seedPid } = JSON.parse(await readFile(join(directory, "control.json"), "utf8")) as { reviewId: string; seedPid: number };
  assert.notEqual(seedPid, process.pid);
  const owner = getSqliteDatabaseOwner(), library = new DesktopReviewLibrary({ owner, dataRoot: directory }); await library.initialize(); installDesktopReviewLibrary(library);
  const before = await library.loadReview(reviewId, { materializeExternalArtifacts: true });
  let viewerCalls = 0;
  const history = new HistoryRestoreController({ loadDetail: async id => { const response = await historyGet(new Request(`${origin}/api/review-history/${id}`, { headers }), { params: Promise.resolve({ id }) }); assert.equal(response.status, 200); return await response.json() as ReviewHistoryDetail; }, requestViewerSource: async () => { viewerCalls++; throw Error("VIEWER_NOT_EXPECTED"); }, loadManagedDemo: () => { viewerCalls++; } });
  let controller: CoachAgentStage3Controller | undefined;
  let preparation: ReturnType<typeof createReviewPreparationOrchestrator> | undefined;
  try {
    stage = "RESUME_HISTORY";
    const opened = await history.open(reviewId), record = SessionRecoveryRecordSchema.parse(opened.recoverySnapshot);
    const validated = validateStoredReviewArtifacts({ ...opened, selectedPlayerId: record.selectedPlayerId, demoContentHash: record.demoContentHash });
    const analysis = normalizeRecoveryAnalysis(validated.analysis, record), restored = restoreRecoveryArtifacts(record), plan = restored.plan;
    assert.equal(record.boundary.kind, "ORDINARY_SEGMENT");
    const saved = { ...restored.narrationByCue, ...validated.narrationByCue }, routeState = buildInitialCoachingRouteState(plan, { narrationByCue: saved });
    const deps = createRecoveryReviewPreparationDependencies(analysis, record);
    let narrationRequests = 0, routeValidations = 0;
    preparation = createReviewPreparationOrchestrator("process-resume", plan, { narrationByCue: saved, readiness: routeState.readiness }, { prepareRoute: async input => { routeValidations++; return deps.prepareRoute(input); }, prepareNarration: async () => { narrationRequests++; throw Error("REGENERATION_FORBIDDEN"); } });
    const preparationEvents: string[] = []; await preparation.run(event => preparationEvents.push(event.type));
    assert(preparationEvents.includes("READY_TO_START")); assert.equal(narrationRequests, 0);
    const exact = await getSqliteCheckpointSaver().getTuple({ configurable: { thread_id: checkpointThreadIdForSession(record.sessionId), checkpoint_ns: "", checkpoint_id: record.agentCheckpointId! } });
    assert.equal(exact?.checkpoint.id, record.agentCheckpointId);
    const adapter = new CoachAgentStage3HostAdapter();
    controller = new CoachAgentStage3Controller({ adapter, dispatch, post: () => { throw Error("TOOL_NOT_EXPECTED"); }, bridgeAvailable: () => true, isLive: () => true });
    stage = "RESUME_RECONNECT";
    const event = buildReconnectReplayEvent(record), result = await controller.reconnect(event);
    assert.equal(result.restored, "MATCHED"); assert(controller.adoptRecoveredOrdinary(event, result));
    stage = "RESUME_NEXT_CUE";
    const nextSession = reachCue(plan, restored.session, plan.cues[1].id);
    const identity = { analysis, plan, routeState, demoContentHash: record.demoContentHash, selectedPlayerId: record.selectedPlayerId, sessionId: record.sessionId, runId: record.runId };
    const next = await controller.synchronizeDiagnosis(diagnosticInput(identity, nextSession, saved[plan.cues[1].id]));
    assert.equal(next?.state.activeCueId, plan.cues[1].id); assert.equal(adapter.lifecycleDegraded, false);
    assert.deepEqual(dispatched.filter(event => event.type === "START_CUE").map(event => event.cueId), [plan.cues[1].id]);
    assert(dispatched.filter(event => event.type === "OBSERVE_SEGMENT").every(event => event.segmentIndex > record.boundary.segmentIndex));
    const after = await library.loadReview(reviewId, { materializeExternalArtifacts: true }); assert.deepEqual(after.artifacts, before.artifacts); assert.deepEqual(after.runtimeHead, before.runtimeHead);
    assert.equal(externalCalls, 0); assert.equal(viewerCalls, 0);
    return { phase, pid: process.pid, seedPid, backend: result.checkpoint.backend, recoverableAfterRefresh: result.checkpoint.recoverableAfterRefresh,
      restored: result.restored, consumedCues: restored.session.consumed_cue_ids.length, graphEvents: dispatched.map(event => event.type),
      savedAnalysisAndNarrationReused: true, routeValidations, narrationRequests, externalCalls, viewerCalls, artifactsAndHeadUnchanged: true };
  } finally { preparation?.cancel(); controller?.dispose(); history.cancel(); installDesktopReviewLibrary(undefined); }
}

async function main() {
try { const result = await run(); await closeSqliteDatabaseOwnersForTests(); console.log(JSON.stringify({ ok: true, ...result, closed: true })); }
catch (error) { await closeSqliteDatabaseOwnersForTests(); const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "CHILD_VALIDATION_FAILED"; console.log(JSON.stringify({ ok: false, phase, stage, code, closed: true })); process.exitCode = 1; }
}
void main();
