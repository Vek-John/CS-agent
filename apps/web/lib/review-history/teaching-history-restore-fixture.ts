import { self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import * as adapter from "@cs-coach/cs2d-analysis-adapter";
import * as planner from "@cs-coach/review-planner";
import { createCoachingSession } from "@cs-coach/session";
import { SessionRecoveryRecordSchema } from "@cs-coach/coach-agent/client";
import { SqliteDatabaseOwner } from "@cs-coach/memory-sqlite/server";
import { DesktopReviewLibrary, installDesktopReviewLibrary, type AppendArtifactInput, type CommitRuntimeHeadInput, type JsonValue } from "@cs-coach/review-library/server";

import { GET } from "../../app/api/review-history/[id]/route";
import { DESKTOP_APP_ORIGIN_HEADER } from "../desktop/request-origin";
import { buildInitialCoachingRouteState, createReviewPreparationOrchestrator } from "../coaching/cs2d-route-integration";

import { buildSessionRecoveryRecord, createRecoverySessionIdentity, createRecoveryReviewPreparationDependencies, normalizeRecoveryAnalysis, restoreRecoveryArtifacts, validateStoredReviewArtifacts } from "../recovery/cs2d-session-recovery";
import { validateReadyRevisionArtifacts, validateReviewArtifactAppend } from "./artifact-validation";
import { HistoryRestoreController, type ReviewHistoryDetail } from "./history-restore-controller";

import type { NarrationBundle } from "@cs-coach/contracts";
const ORIGIN = "http://127.0.0.1:43123";
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
// Synthetic Replay integer times are fixture coordinates, not parsed Demo ticks.
// Header bytes only exercise the managed-library lifecycle; parser readiness is stubbed.
const BYTES = Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(64, 3)]);
const HASH = createHash("sha256").update(BYTES).digest("hex");
export const cleanupRestoredHistoryFixture = () => { installDesktopReviewLibrary(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); };

export interface TeachingHistoryRestoreMeasurement {
  analysisBytes: number;
  detailBytes: number;
  sampleCount: number;
  groundSampleCount: number;
  analysisBuildMs: number;
  analysisSerializeMs: number;
  saveToHeadMs: number;
  getResponseMs: number;
  responseJsonMs: number;
  controllerOpenMs: number;
  recoveryPreparationMs: number;
  openToReadyMs: number;
  restoredAnalysisCalls: number;
  restoredNarrationCalls: number;
  restoredNetworkCalls: number;
  restoredViewerCalls: number;
}

/** Real SQLite lifecycle and GET handler; only parser/Viewer transport remain outside this fixture. */
export async function withReopenedTeachingHistory({ replay, transformAnalysis, beforeAnalysisSave, verify, onMeasurement }: {
  replay: adapter.Cs2dReplay;
  onMeasurement?: (value: TeachingHistoryRestoreMeasurement) => void;
  transformAnalysis?: (analysis: adapter.Cs2dAnalysisBundle) => adapter.Cs2dAnalysisBundle;
  beforeAnalysisSave?: (input: { analysis: adapter.Cs2dAnalysisBundle; validate: (payload: unknown) => void }) => void;
  verify: (result: { analysis: adapter.Cs2dAnalysisBundle; normalized: adapter.Cs2dAnalysisBundle; recovered: ReturnType<typeof restoreRecoveryArtifacts>; savedNarration: Record<string, NarrationBundle> }) => void | Promise<void>;
}): Promise<void> {
  const times = onMeasurement ? { analysisBuildMs: 0, analysisSerializeMs: 0, saveToHeadMs: 0, getResponseMs: 0, responseJsonMs: 0, controllerOpenMs: 0, recoveryPreparationMs: 0, openToReadyMs: 0 } : undefined;
  let analysisBytes = 0;
  const root = await mkdtemp(join(tmpdir(), "cs-agent-teaching-restore-"));
  const path = join(root, "history.sqlite3");
  let owner: SqliteDatabaseOwner | undefined;
  let preparation: ReturnType<typeof createReviewPreparationOrchestrator> | undefined;
  let controller: HistoryRestoreController | undefined;
  try {
    owner = new SqliteDatabaseOwner({ path });
    let library = new DesktopReviewLibrary({ owner, dataRoot: root });
    await library.initialize();
    const capability = library.issueImportCapability({ objectId: "synthetic-inventory", originalFilename: "fixture.dem", expectedByteLength: BYTES.length });
    const imported = await library.importDemo({ authorization: capability.authorization, objectId: "synthetic-inventory", stream: (async function* () { yield BYTES; })() });
    await library.finalizeDemoImport({ authorization: imported.validationCapability!.authorization, demoId: imported.demo.demoId, valid: true, parserVersion: "synthetic-lifecycle-no-parser" });
    const review = await library.createReview({ demoId: imported.demo.demoId, selectedPlayerId: self, selectedPlayerName: "Synthetic", title: "Inventory persistence" });
    const generateAnalysis = vi.spyOn(adapter, "buildCs2dAnalysisBundle");
    const generateNarration = vi.spyOn(planner, "deterministicNarrationBundle");
    const analysisStarted = performance.now();
    const current = adapter.buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-history-parser", demoContentHash: HASH });
    if (times) times.analysisBuildMs = performance.now() - analysisStarted;
    expect(current.metadata.adapter_version).toBe(adapter.CS2D_ADAPTER_VERSION);
    const analysis = transformAnalysis ? transformAnalysis(current) : current;
    expect(analysis.match_timeline.timeline_version).toBe(adapter.CS2D_TIMELINE_VERSION);
    expect(analysis.match_timeline.timeline_version).toMatch(/\/timeline\/1\.2\.0$/);
    if (times) {
      const started = performance.now();
      analysisBytes = Buffer.byteLength(adapter.serializeCs2dAnalysisBundle(analysis), "utf8");
      times.analysisSerializeMs = performance.now() - started;
    }
    const plan = analysis.review_plan;
    expect(plan.cues.length).toBeGreaterThan(0);
    const narrationByCue = Object.fromEntries(plan.cues.map(cue => {
      const impact = planner.buildOutcomeImpactForCue(cue, analysis.candidate_set, analysis.win_probability_timeline, analysis.match_timeline, self);
      return [cue.id, planner.deterministicNarrationBundle(planner.buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), planner.buildOutcomePackage(cue, analysis.candidate_set, impact))];
    }));
    const route = buildInitialCoachingRouteState(plan, { narrationByCue });
    const identity = createRecoverySessionIdentity();
    const session = createCoachingSession(plan, identity.sessionId, route);
    const record = buildSessionRecoveryRecord({ identity, demoContentHash: HASH, selectedPlayerId: self, plan, routeState: route, session,
      boundaryKind: "ROUTE_START", narrationByCue, analysis, agentCheckpointId: null });
    const saveStarted = performance.now();
    const revision = await library.startRevision({ reviewId: review.reviewId, analysisVersion: analysis.metadata.adapter_version, graphVersion: "coach-agent-graph.v3", promptVersion: plan.generation_manifest.prompt_version,
      modelMetadata: {}, routeId: plan.id, routeHash: route.routeFingerprint });
    const append = async (artifactType: AppendArtifactInput["artifactType"], artifactKey: string, schemaVersion: string, payload: unknown) => {
      const input: AppendArtifactInput = { reviewRevisionId: revision.reviewRevisionId, artifactType, artifactKey, artifactRevision: 1, schemaVersion, payload: json(payload), idempotencyKey: `${artifactType}:${artifactKey}` };
      validateReviewArtifactAppend(await library.loadReview(review.reviewId, { reviewRevisionId: revision.reviewRevisionId, materializeExternalArtifacts: true }), input);
      await library.appendArtifact(input);
    };
    if (beforeAnalysisSave) {
      const loaded = await library.loadReview(review.reviewId, { reviewRevisionId: revision.reviewRevisionId, materializeExternalArtifacts: true });
      beforeAnalysisSave({ analysis, validate: payload => validateReviewArtifactAppend(loaded, {
        reviewRevisionId: revision.reviewRevisionId, artifactType: "ANALYSIS_BUNDLE", artifactKey: "analysis", artifactRevision: 1,
        schemaVersion: "cs2d-analysis-bundle.v1", payload: json(payload), idempotencyKey: "ANALYSIS_BUNDLE:analysis",
      }) });
    }
    await append("ANALYSIS_BUNDLE", "analysis", "cs2d-analysis-bundle.v1", analysis);
    await append("CANDIDATE_SET", analysis.candidate_set.id, "candidate-set.v1", analysis.candidate_set);
    await append("REVIEW_PLAN", plan.id, "review-plan.v1", plan);
    for (const [cueId, narration] of Object.entries(narrationByCue)) await append("NARRATION_BUNDLE", cueId, "narration-bundle.v1", narration);
    await append("SESSION_RECOVERY", record.boundary.boundaryId, "session-recovery-record.v2", record);
    const head: CommitRuntimeHeadInput = { reviewId: review.reviewId, reviewRevisionId: revision.reviewRevisionId, expectedRecoveryArtifactId: null,
      recoveryArtifactKey: record.boundary.boundaryId, recoveryArtifactRevision: 1, sessionId: identity.sessionId, runId: identity.runId,
      demoId: imported.demo.demoId, demoContentHash: HASH, selectedPlayerId: self, routeId: plan.id, routeHash: route.routeFingerprint,
      recoveryBoundary: "ROUTE_START", defaultRouteCursor: 0, completedCueCount: 0, totalCueCount: plan.cues.length, stableProgress: record.cueProgress };
    validateReadyRevisionArtifacts(await library.loadReview(review.reviewId, { materializeExternalArtifacts: true, reviewRevisionId: revision.reviewRevisionId }), head);
    const committed = await library.commitRuntimeHead(head);
    if (times) times.saveToHeadMs = performance.now() - saveStarted;
    const savedArtifacts = (await library.loadReview(review.reviewId, { materializeExternalArtifacts: true })).artifacts;
    await owner.close(); owner = undefined;

    owner = new SqliteDatabaseOwner({ path });
    library = new DesktopReviewLibrary({ owner, dataRoot: root });
    await library.initialize(); installDesktopReviewLibrary(library);
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const forbiddenTransport = vi.fn(() => { throw new Error("RESTORE_MUST_NOT_GENERATE_OR_PARSE"); });
    vi.stubGlobal("fetch", forbiddenTransport);
    generateAnalysis.mockClear(); generateNarration.mockClear();
    const loadDetail = vi.fn(async (id: string) => {
      const started = performance.now();
      const response = await GET(new Request(`${ORIGIN}/api/review-history/${id}`, { headers: { [DESKTOP_APP_ORIGIN_HEADER]: ORIGIN } }), { params: Promise.resolve({ id }) });
      if (times) times.getResponseMs = performance.now() - started;
      expect(response.status).toBe(200);
      const bodyStarted = performance.now();
      const detail = await response.json() as ReviewHistoryDetail;
      if (times) times.responseJsonMs = performance.now() - bodyStarted;
      return detail;
    });
    const requestViewerSource = vi.fn(async () => { throw new Error("CONTROL_PLANE_MUST_NOT_REQUEST_DEMO_PARSE"); });
    const loadManagedDemo = vi.fn();
    controller = new HistoryRestoreController({ loadDetail, requestViewerSource, loadManagedDemo });
    const openStarted = performance.now();
    const restored = await controller.open(review.reviewId);
    if (times) times.controllerOpenMs = performance.now() - openStarted;
    expect(restored.missingArtifacts).toEqual([]); expect(restored.detail.runtimeHead).toEqual(committed);
    const recoveryStarted = performance.now();
    const validated = validateStoredReviewArtifacts({ ...restored, selectedPlayerId: self, demoContentHash: HASH, routeId: plan.id, routeHash: route.routeFingerprint });
    const recovery = SessionRecoveryRecordSchema.parse(restored.recoverySnapshot);
    const normalized = normalizeRecoveryAnalysis(validated.analysis, recovery);
    const recovered = restoreRecoveryArtifacts(recovery);
    const savedNarration = { ...recovered.narrationByCue, ...validated.narrationByCue };
    const restoredRoute = buildInitialCoachingRouteState(recovered.plan, { narrationByCue: savedNarration });
    const deps = createRecoveryReviewPreparationDependencies(normalized, recovery);
    const prepareRoute = vi.fn(deps.prepareRoute);
    const prepareNarration = vi.fn(deps.prepareNarration);
    preparation = createReviewPreparationOrchestrator("teaching-reopen", recovered.plan, { narrationByCue: savedNarration, readiness: restoredRoute.readiness }, { ...deps, prepareRoute, prepareNarration });
    const events: string[] = []; await preparation.run(event => events.push(event.type));
    if (times) { times.recoveryPreparationMs = performance.now() - recoveryStarted; times.openToReadyMs = performance.now() - openStarted; }
    expect(events).toContain("READY_TO_START"); expect(events).not.toContain("NARRATION_UPDATE");
    await verify({ analysis, normalized, recovered, savedNarration });
    // Include consumer verification (cache/View/questions) in the no-regeneration boundary.
    expect(prepareRoute).toHaveBeenCalledOnce(); // Frozen route validation, not a new Director call.
    expect(prepareNarration).not.toHaveBeenCalled(); expect(generateNarration).not.toHaveBeenCalled(); expect(generateAnalysis).not.toHaveBeenCalled();
    expect(forbiddenTransport).not.toHaveBeenCalled(); expect(requestViewerSource).not.toHaveBeenCalled(); expect(loadManagedDemo).not.toHaveBeenCalled();
    expect(normalized.match_timeline).toEqual(validated.analysis.match_timeline);
    const reopened = await library.loadReview(review.reviewId, { materializeExternalArtifacts: true });
    expect(reopened.artifacts).toEqual(savedArtifacts); // No repair/regeneration/append during restore.
    expect(reopened.runtimeHead).toEqual(committed);
    if (times && onMeasurement) onMeasurement({ ...times, analysisBytes,
      // Response.json's parsed DTO re-encodes to the same compact JSON representation; no second body clone.
      detailBytes: Buffer.byteLength(JSON.stringify(restored.detail), "utf8"),
      sampleCount: analysis.match_timeline.player_state_tracks?.length ?? 0,
      groundSampleCount: analysis.match_timeline.player_state_tracks?.filter(row => row.ground_evidence !== undefined).length ?? 0,
      restoredAnalysisCalls: generateAnalysis.mock.calls.length, restoredNarrationCalls: generateNarration.mock.calls.length,
      restoredNetworkCalls: forbiddenTransport.mock.calls.length,
      restoredViewerCalls: requestViewerSource.mock.calls.length + loadManagedDemo.mock.calls.length,
    });
  } finally {
    preparation?.cancel(); controller?.cancel(); installDesktopReviewLibrary(undefined);
    if (owner) await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}
