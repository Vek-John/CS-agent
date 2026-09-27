import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRemoteCoachAgentDispatchEnvelope, parseRemoteCoachAgentDispatchResponse, checkpointThreadIdForSession, SessionRecoveryRecordSchema,
  type CoachAgentEvent, type CoachAgentResult } from "../libs/coach-agent/src/remote-dispatch-client";
export interface HttpClient {
  json(path: string, init?: RequestInit): Promise<unknown>;
  importDemo(bytes: Uint8Array): Promise<{ demoId: string; contentHash: string }>;
}
const post = (value: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
function dispatcher(http: HttpClient, events: CoachAgentEvent[]) {
  return async (event: CoachAgentEvent): Promise<CoachAgentResult> => {
    const result = parseRemoteCoachAgentDispatchResponse(await http.json("/api/coaching/agent", post(createRemoteCoachAgentDispatchEnvelope(event))));
    assert.equal(result.checkpoint.backend, "SQLITE"); assert.equal(result.checkpoint.recoverableAfterRefresh, true); events.push(event); return result;
  };
}
export async function probe(http: HttpClient) {
  const result = await dispatcher(http, [])({ version: "coach-agent-event.v2", type: "OBSERVE_SEGMENT", eventId: "http-probe-observe",
    identity: { sessionId: "http-probe-session", runId: "http-probe-run", demoId: "synthetic", demoContentHash: "a".repeat(64), selectedPlayerId: "synthetic", routeId: "http-probe-route", routeHash: "probe-hash" },
    segmentId: "probe-ordinary", segmentIndex: 0, mode: "BRIEF", currentSessionPhase: "PLAYING" });
  return { backend: result.checkpoint.backend, recoverableAfterRefresh: result.checkpoint.recoverableAfterRefresh };
}

import { buildCs2dAnalysisBundle } from "../libs/cs2d-analysis-adapter/src/index";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "../libs/review-planner/src/index";
import { createCoachingSession, reduceCoachingSession } from "../libs/session/src/index";
import type { CoachingSessionState, ReviewPlan, NarrationBundle } from "../libs/contracts/src/index";
import { twoCueViewerReplay, twoCueViewerPlayer } from "./cs2d-host/viewer-two-cue-fixture";
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
  for (let n = 0; n < 2000; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error("OBSERVER_DEADLINE");
}
export async function seed(http: HttpClient) {
  let stage = "SEED_IMPORT";
  const events: CoachAgentEvent[] = [];
  const send = dispatcher(http, events);
  const bytes = Buffer.from("PBDEMS2\0", "binary"), hash = createHash("sha256").update(bytes).digest("hex");
  const imported = await http.importDemo(bytes);
  assert.equal(imported.contentHash, hash);
  const analysis = buildCs2dAnalysisBundle({ replay: twoCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: imported.demoId, demoContentHash: hash }), plan = analysis.review_plan;
  assert.equal(plan.cues.length, 2);
  const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set))]));
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue }), recoveryIdentity = createRecoverySessionIdentity();
  const identity = { analysis, plan, routeState, demoContentHash: hash, selectedPlayerId: twoCueViewerPlayer, sessionId: recoveryIdentity.sessionId, runId: recoveryIdentity.runId };
  let latest: CoachAgentResult | undefined;
  const controller = new CoachAgentStage3Controller({ adapter: new CoachAgentStage3HostAdapter(), dispatch: async event => { latest = await send(event); return latest; }, post: () => { throw Error("TOOL_NOT_EXPECTED"); }, bridgeAvailable: () => true, isLive: () => true });
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
    const review = await http.json("/api/review-history", post({ demoId: imported.demoId, selectedPlayerId: twoCueViewerPlayer, selectedPlayerName: "Synthetic", title: "HTTP recovery" })) as { reviewId: string };
    const revision = await http.json(`/api/review-history/${review.reviewId}/revisions`, post({ mode: "SELECT_PLAYER", analysisVersion: analysis.metadata.adapter_version,
      graphVersion: latest.state.graphVersion, promptVersion: plan.generation_manifest.prompt_version, modelMetadata: {}, routeId: plan.id, routeHash: routeState.routeFingerprint })) as { revisionId: string };
    const append = async (artifactType: string, artifactKey: string, schemaVersion: string, payload: unknown) => {
      await http.json(`/api/review-history/${review.reviewId}/artifacts`, post({ revisionId: revision.revisionId, artifactType, artifactKey, artifactRevision: 1,
        schemaVersion, payload, idempotencyKey: `${artifactType}:${artifactKey}` }));
    };
    await append("ANALYSIS_BUNDLE", "analysis", "cs2d-analysis-bundle.v1", analysis);
    await append("CANDIDATE_SET", analysis.candidate_set.id, "candidate-set.v1", analysis.candidate_set);
    await append("REVIEW_PLAN", plan.id, "review-plan.v1", plan);
    for (const [cue, narration] of Object.entries(narrationByCue)) await append("NARRATION_BUNDLE", cue, "narration-bundle.v1", narration);
    await append("SESSION_RECOVERY", "ordinary", "session-recovery-record.v2", record);
    const head = { reviewId: review.reviewId, reviewRevisionId: revision.revisionId, expectedRecoveryArtifactId: null, recoveryArtifactKey: "ordinary", recoveryArtifactRevision: 1,
      sessionId: record.sessionId, runId: record.runId, demoId: imported.demoId, demoContentHash: hash, selectedPlayerId: twoCueViewerPlayer, routeId: plan.id, routeHash: record.routeHash,
      recoveryBoundary: "ORDINARY_SEGMENT", defaultRouteCursor: record.boundary.segmentIndex, completedCueCount: 1, totalCueCount: 2,
      checkpointThreadId: checkpointThreadIdForSession(record.sessionId), checkpointNamespace: "", checkpointId: record.agentCheckpointId!, stableProgress: record.cueProgress };
    stage = "SEED_HEAD";
    await http.json(`/api/review-history/${review.reviewId}/runtime-head`, { ...post(head), method: "PUT" });
    return { reviewId: review.reviewId, summary: { stage, backend: latest.checkpoint.backend, recoverableAfterRefresh: latest.checkpoint.recoverableAfterRefresh,
      consumedCues: 1, graphEvents: events.map(event => event.type), generatedAnalysis: 1, generatedNarration: 2 } };

  } finally { controller.dispose(); }
}
export async function resume(http: HttpClient, reviewId: string) {
  const events: CoachAgentEvent[] = [], send = dispatcher(http, events);
  const before = await http.json(`/api/review-history/${reviewId}`) as ReviewHistoryDetail;
  let viewerCalls = 0;
  const history = new HistoryRestoreController({ loadDetail: async id => await http.json(`/api/review-history/${id}`) as ReviewHistoryDetail,
    requestViewerSource: async () => { viewerCalls++; throw Error("VIEWER_NOT_EXPECTED"); }, loadManagedDemo: () => { viewerCalls++; } });
  let controller: CoachAgentStage3Controller | undefined;
  let preparation: ReturnType<typeof createReviewPreparationOrchestrator> | undefined;
  try {
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
    const adapter = new CoachAgentStage3HostAdapter();
    controller = new CoachAgentStage3Controller({ adapter, dispatch: send, post: () => { throw Error("TOOL_NOT_EXPECTED"); }, bridgeAvailable: () => true, isLive: () => true });
    const event = buildReconnectReplayEvent(record), result = await controller.reconnect(event);
    assert.equal(result.restored, "MATCHED"); assert(controller.adoptRecoveredOrdinary(event, result));
    const nextSession = reachCue(plan, restored.session, plan.cues[1].id);
    const identity = { analysis, plan, routeState, demoContentHash: record.demoContentHash, selectedPlayerId: record.selectedPlayerId, sessionId: record.sessionId, runId: record.runId };
    const next = await controller.synchronizeDiagnosis(diagnosticInput(identity, nextSession, saved[plan.cues[1].id]));
    assert.equal(next?.state.activeCueId, plan.cues[1].id); assert.equal(adapter.lifecycleDegraded, false);
    assert.deepEqual(events.filter(event => event.type === "START_CUE").map(event => event.cueId), [plan.cues[1].id]);
    assert(events.filter(event => event.type === "OBSERVE_SEGMENT").every(event => event.segmentIndex > record.boundary.segmentIndex));
    const after = await http.json(`/api/review-history/${reviewId}`) as ReviewHistoryDetail;
    assert.deepEqual(after.artifacts, before.artifacts); assert.deepEqual(after.runtimeHead, before.runtimeHead); assert.equal(viewerCalls, 0);
    return { backend: result.checkpoint.backend, recoverableAfterRefresh: result.checkpoint.recoverableAfterRefresh, restored: result.restored,
      consumedCues: restored.session.consumed_cue_ids.length, graphEvents: events.map(event => event.type), savedAnalysisAndNarrationReused: true,
      routeValidations, narrationRequests, viewerCalls, artifactsAndHeadUnchanged: true };

  } finally { preparation?.cancel(); controller?.dispose(); history.cancel(); }
}

import { buildStage3Identity } from "../apps/web/lib/coaching/coach-agent-stage3-host-adapter";
import { buildTeachingDiagnosisSubmissionEvent } from "../apps/web/lib/coaching/teaching-diagnosis-host";
import { assertRecoveryTeachingProgress, restoreCheckpointTeachingCase } from "../apps/web/lib/recovery/cs2d-session-recovery";
import { answerGroundedCueQuestion, buildCurrentCueQuestionContext, CURRENT_CUE_ADVICE_QUESTION } from "../apps/web/lib/coaching/current-cue-questions";
import type { CueCase, LearningThread, UserReflection } from "../libs/contracts/src/index";
const diagnosisReflectionText = "我想先确认前方是否有人，然后再决定是否推进。" + "这是我当时的想法，不代表已经看见敌人。".repeat(14);

/** Answered default-diagnosis path; ordinary mode above is intentionally unchanged. */
export async function seedDiagnosis(http: HttpClient) {
  const events: CoachAgentEvent[] = [], send = dispatcher(http, events);
  const bytes = Buffer.from("PBDEMS2\0", "binary"), hash = createHash("sha256").update(bytes).digest("hex");
  const imported = await http.importDemo(bytes); assert.equal(imported.contentHash, hash);
  const analysis = buildCs2dAnalysisBundle({ replay: twoCueViewerReplay(), selectedSteamId: twoCueViewerPlayer, demoId: imported.demoId, demoContentHash: hash });
  const plan = analysis.review_plan; assert.equal(plan.cues.length, 2);
  const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set))]));
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue }), recoveryIdentity = createRecoverySessionIdentity();
  const identity = { analysis, plan, routeState, demoContentHash: hash, selectedPlayerId: twoCueViewerPlayer, sessionId: recoveryIdentity.sessionId, runId: recoveryIdentity.runId };
  const review = await http.json("/api/review-history", post({ demoId: imported.demoId, selectedPlayerId: twoCueViewerPlayer, selectedPlayerName: "Synthetic", title: "HTTP diagnosis recovery" })) as { reviewId: string };
  const { COACH_AGENT_GRAPH_VERSION } = await import("../libs/coach-agent/src/remote-dispatch-client");
  const revision = await http.json(`/api/review-history/${review.reviewId}/revisions`, post({ mode: "SELECT_PLAYER", analysisVersion: analysis.metadata.adapter_version,
    graphVersion: COACH_AGENT_GRAPH_VERSION, promptVersion: plan.generation_manifest.prompt_version, modelMetadata: {}, routeId: plan.id, routeHash: routeState.routeFingerprint })) as { revisionId: string };
  const artifactOrder: string[] = [];
  const append = async (artifactType: string, artifactKey: string, schemaVersion: string, payload: unknown, artifactRevision = 1) => {
    await http.json(`/api/review-history/${review.reviewId}/artifacts`, post({ revisionId: revision.revisionId, artifactType, artifactKey, artifactRevision, schemaVersion, payload,
      idempotencyKey: `${artifactType}:${artifactKey}:v${artifactRevision}` })); artifactOrder.push(artifactType);
  };
  await append("ANALYSIS_BUNDLE", "analysis", "cs2d-analysis-bundle.v1", analysis);
  await append("CANDIDATE_SET", analysis.candidate_set.id, "candidate-set.v1", analysis.candidate_set);
  await append("REVIEW_PLAN", plan.id, "review-plan.v1", plan);
  for (const [id, narration] of Object.entries(narrationByCue)) await append("NARRATION_BUNDLE", id, "narration-bundle.v1", narration);
  let session = reachCue(plan, reduceCoachingSession(plan, createCoachingSession(plan, identity.sessionId, routeState), { type: "START" }), plan.cues[0].id);
  const cue = plan.cues[0];
  const reflection: UserReflection = { cueId: cue.id, reflectionId: "synthetic-http-reflection", rawText: diagnosisReflectionText, selectedGoal: "GET_INFO", source: "USER", response: "ANSWERED", limitations: [] };
  // This is the live Host's ordering: USER text first, Graph diagnosis, all
  // independently saved teaching projections, then the checkpoint/head.
  await append("USER_INTERACTION", reflection.reflectionId!, "user-reflection.v1", { kind: "REFLECTION", reflection });
  const controller = new CoachAgentStage3Controller({ adapter: new CoachAgentStage3HostAdapter(), dispatch: send,
    post: () => { throw Error("VISUAL_TOOL_NOT_EXPECTED"); }, bridgeAvailable: () => true, isLive: () => true });
  try {
    assert(await controller.synchronizeDiagnosis(diagnosticInput(identity, session, narrationByCue[cue.id])));
    const context = { plan, cue, timeline: analysis.match_timeline, selectedPlayerId: twoCueViewerPlayer,
      material: analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id) };
    const submission = buildTeachingDiagnosisSubmissionEvent(context, reflection, { eventType: "SUBMIT_REFLECTION", eventId: "synthetic-http-submit-reflection", identity: buildStage3Identity(identity) });
    const agent = await send(submission), cueCase = agent.state.cueCases[cue.id], thread = agent.state.learningThreads.find(item => item.evidenceCueIds.includes(cue.id));
    assert(cueCase && thread && cueCase.diagnosticResult && cueCase.transferRule);
    assert.equal(cueCase.reflection?.rawText, diagnosisReflectionText); assert.equal(cueCase.reflection?.source, "USER");
    assert.equal(cueCase.attemptBudget.reflection, 1); assert.equal(agent.state.pendingToolCall, null); assert.equal(agent.effects.length, 0);
    session = restoreCheckpointTeachingCase(plan, session, cueCase, thread);
    const caseRevision = (cueCase.verdict?.revision ?? 0) + 1, threadRevision = thread.evidenceCueIds.length * 4 + caseRevision;
    await append("CUE_CASE", cue.id, "cue-case.v1", cueCase, caseRevision);
    await append("DIAGNOSTIC_RESULT", cueCase.diagnosticResult.resultId, "diagnostic-result.v1", cueCase.diagnosticResult);
    await append("TRANSFER_RULE", cueCase.transferRule.ruleId, "transfer-rule.v1", cueCase.transferRule, caseRevision);
    await append("LEARNING_THREAD", thread.threadId, "learning-thread.v1", thread, threadRevision);
    const record = buildCheckpointedRecoveryRecord({ identity: recoveryIdentity, analysis, plan, routeState, narrationByCue, session, demoContentHash: hash,
      selectedPlayerId: twoCueViewerPlayer, agentCheckpointId: null, boundaryKind: "CUE_PAUSED" }, { ...agent.state, checkpointId: agent.checkpoint.checkpointId });
    assert(record?.boundary.kind === "CUE_PAUSED");
    await append("SESSION_RECOVERY", "diagnosis-paused", "session-recovery-record.v2", record);
    await http.json(`/api/review-history/${review.reviewId}/runtime-head`, { ...post({ reviewRevisionId: revision.revisionId, expectedRecoveryArtifactId: null,
      recoveryArtifactKey: "diagnosis-paused", recoveryArtifactRevision: 1, sessionId: record.sessionId, runId: record.runId, demoId: imported.demoId,
      demoContentHash: hash, selectedPlayerId: twoCueViewerPlayer, routeId: plan.id, routeHash: record.routeHash, recoveryBoundary: "CUE_PAUSED",
      currentCueId: cue.id, defaultRouteCursor: record.boundary.segmentIndex, completedCueCount: session.consumed_cue_ids.length, totalCueCount: plan.cues.length,
      checkpointThreadId: checkpointThreadIdForSession(record.sessionId), checkpointNamespace: "", checkpointId: record.agentCheckpointId, stableProgress: record.cueProgress }), method: "PUT" });
    assert.equal(events.filter(event => event.type === "SUBMIT_REFLECTION").length, 1);
    return { reviewId: review.reviewId, summary: { mode: "DIAGNOSIS", boundary: "CUE_PAUSED", backend: agent.checkpoint.backend,
      recoverableAfterRefresh: agent.checkpoint.recoverableAfterRefresh, graphEvents: events.map(event => event.type), artifactOrder,
      response: cueCase.reflection.response, reflectionCharacters: diagnosisReflectionText.length, reflectionSource: cueCase.reflection.source,
      caseStatus: cueCase.status, diagnosticStatus: cueCase.diagnosticResult.status, verdict: cueCase.verdict?.type, attemptBudget: cueCase.attemptBudget,
      generatedAnalysis: 1, generatedNarration: 2, toolEffects: agent.effects.length } };
  } finally { controller.dispose(); }
}

export async function resumeDiagnosis(http: HttpClient, reviewId: string) {
  let stage = "READ_DETAIL";
  const events: CoachAgentEvent[] = [], send = dispatcher(http, events);
  const before = await http.json(`/api/review-history/${reviewId}`) as ReviewHistoryDetail;
  let viewerCalls = 0;
  const history = new HistoryRestoreController({ loadDetail: async id => await http.json(`/api/review-history/${id}`) as ReviewHistoryDetail,
    requestViewerSource: async () => { viewerCalls++; throw Error("VIEWER_NOT_EXPECTED"); }, loadManagedDemo: () => { viewerCalls++; } });
  let controller: CoachAgentStage3Controller | undefined, preparation: ReturnType<typeof createReviewPreparationOrchestrator> | undefined;
  try {
    stage = "VALIDATE_ARTIFACTS";
    const opened = await history.open(reviewId), record = SessionRecoveryRecordSchema.parse(opened.recoverySnapshot);
    assert.equal(record.boundary.kind, "CUE_PAUSED");
    const validated = validateStoredReviewArtifacts({ ...opened, selectedPlayerId: record.selectedPlayerId, demoContentHash: record.demoContentHash });
    const analysis = normalizeRecoveryAnalysis(validated.analysis, record), restored = restoreRecoveryArtifacts(record), plan = restored.plan;
    const cue = plan.cues.find(item => item.id === restored.session.current_cue_id); assert(cue);
    const savedCase = validated.cueCases[cue.id], savedThread = validated.learningThreads.find(item => item.evidenceCueIds.includes(cue.id));
    assert(savedCase && savedThread && savedCase.diagnosticResult && savedCase.transferRule);
    stage = "USER_REFLECTION_MATCH";
    const interaction = before.artifacts.find(item => item.kind === "USER_INTERACTION" && item.key === "synthetic-http-reflection")?.payload as { kind: string; reflection: UserReflection };
    assert.equal(interaction.kind, "REFLECTION"); assert.equal(interaction.reflection.rawText, diagnosisReflectionText);
    assert.equal(savedCase.reflection?.rawText, interaction.reflection.rawText); assert.equal(savedCase.reflection?.source, "USER");
    assert.deepEqual(before.artifacts.find(item => item.kind === "DIAGNOSTIC_RESULT")?.payload, savedCase.diagnosticResult);
    assert.deepEqual(before.artifacts.find(item => item.kind === "TRANSFER_RULE")?.payload, savedCase.transferRule);
    stage = "PREPARATION_READY";
    const savedNarration = { ...restored.narrationByCue, ...validated.narrationByCue }, routeState = buildInitialCoachingRouteState(plan, { narrationByCue: savedNarration });
    const deps = createRecoveryReviewPreparationDependencies(analysis, record); let routeValidations = 0, narrationRequests = 0;
    preparation = createReviewPreparationOrchestrator("http-diagnosis-resume", plan, { narrationByCue: savedNarration, readiness: routeState.readiness }, {
      prepareRoute: async input => { routeValidations++; return deps.prepareRoute(input); }, prepareNarration: async () => { narrationRequests++; throw Error("REGENERATION_FORBIDDEN"); } });
    const prepEvents: string[] = []; await preparation.run(event => prepEvents.push(event.type)); assert(prepEvents.includes("READY_TO_START")); assert.equal(narrationRequests, 0);
    controller = new CoachAgentStage3Controller({ adapter: new CoachAgentStage3HostAdapter(), dispatch: send,
      post: () => { throw Error("VISUAL_TOOL_NOT_EXPECTED"); }, bridgeAvailable: () => true, isLive: () => true });
    stage = "EXACT_RECONNECT";
    const reconnect = buildReconnectReplayEvent(record);
    const result = await controller.reconnect(reconnect, agent => assertRecoveryTeachingProgress(plan, record, validated.cueCases, agent));
    assert.equal(result.restored, "MATCHED"); assert.equal(result.effects.length, 0);
    stage = "CASE_THREAD_MATCH";
    const recoveredCase = result.state.cueCases[cue.id], recoveredThread = result.state.learningThreads.find(item => item.threadId === savedThread.threadId);
    assert.deepEqual(recoveredCase, savedCase); assert.deepEqual(recoveredThread, savedThread);
    assert.deepEqual(recoveredCase.attemptBudget, savedCase.attemptBudget);
    stage = "SESSION_CASE_MATCH";
    const landed = restoreCheckpointTeachingCase(plan, restored.session, recoveredCase, recoveredThread);
    controller.adoptRecoveredCue(cue.id, landed.current_segment_index);
    assert.deepEqual(landed.cue_cases?.[cue.id], savedCase); assert.equal(landed.cue_cases?.[cue.id].reflection?.rawText, diagnosisReflectionText);
    assert.deepEqual(landed.outcome_completion, restored.session.outcome_completion); assert.equal(landed.phase, "PAUSED_FOR_COACHING");
    stage = "QUESTION_CONTEXT";
    const context = buildCurrentCueQuestionContext({ plan, session: landed, generation: 2, cueCase: landed.cue_cases?.[cue.id], diagnosticsEnabled: true, busy: false, takenOver: false });
    assert(context); stage = "QUESTION_ANSWER"; const answer = answerGroundedCueQuestion(context, CURRENT_CUE_ADVICE_QUESTION);
    const advice = context.advice; assert(advice);
    assert.equal(advice.when, savedCase.transferRule.when); assert.equal(advice.do, savedCase.transferRule.do);
    assert.equal(advice.unless, savedCase.transferRule.unless);
    const core = [{ text: `当：${advice.when}`, refs: advice.refs }, { text: `做：${advice.do}`, refs: advice.refs },
      ...(advice.unless ? [{ text: `除非：${advice.unless}`, refs: advice.refs }] : [])];
    assert.deepEqual(answer.items.slice(0, core.length), core);
    assert.deepEqual(advice.refs, savedCase.transferRule.refs.filter(ref => context.facts.some(fact => fact.refs.includes(ref))));
    assert.deepEqual(answer.items.slice(core.length), advice.limitations.map(text => ({ text: `适用限制：${text}`, refs: [] })));

    assert.deepEqual(events.map(event => event.type), ["RECONNECT_REPLAY"]); assert.equal(viewerCalls, 0);
    stage = "PERSISTENCE_UNCHANGED";
    const after = await http.json(`/api/review-history/${reviewId}`) as ReviewHistoryDetail;
    assert.deepEqual(after.artifacts, before.artifacts); assert.deepEqual(after.runtimeHead, before.runtimeHead);
    return { mode: "DIAGNOSIS", restored: result.restored, backend: result.checkpoint.backend, recoverableAfterRefresh: result.checkpoint.recoverableAfterRefresh,
      graphEvents: events.map(event => event.type), caseStatus: savedCase.status, diagnosticStatus: savedCase.diagnosticResult.status, verdict: savedCase.verdict?.type,
      reflectionCharacters: diagnosisReflectionText.length, fullUserReflectionPreserved: true, savedCaseAndCheckpointEqual: true, savedThreadAndCheckpointEqual: true,
      attemptBudget: savedCase.attemptBudget, questionItemCount: answer.items.length, questionCoreRefCount: advice.refs.length, questionLimitationCount: advice.limitations.length, routeValidations, narrationRequests, viewerCalls, toolEffects: result.effects.length,
      artifactsAndHeadUnchanged: true };
  } catch (error) {
    const detail = error instanceof Error && /^[A-Z0-9_:]+$/.test(error.message) ? `_${error.message}` : "";
    throw Error(`DIAGNOSIS_${stage}${detail}`);
  } finally { preparation?.cancel(); controller?.dispose(); history.cancel(); }
}
