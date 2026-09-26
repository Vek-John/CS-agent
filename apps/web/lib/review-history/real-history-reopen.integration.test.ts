import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import * as adapter from "@cs-coach/cs2d-analysis-adapter";
import * as planner from "@cs-coach/review-planner";
import { SessionRecoveryRecordSchema } from "@cs-coach/coach-agent/client";
import { threadIdForIdentity } from "../../../../libs/coach-agent/src/identity";
import { SqliteCheckpointSaver, SqliteDatabaseOwner } from "@cs-coach/memory-sqlite/server";
import { DesktopReviewLibrary, installDesktopReviewLibrary, type AppendArtifactInput, type CommitRuntimeHeadInput } from "@cs-coach/review-library/server";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { consumeGuidedRoute, type GuidedRouteArtifacts } from "../../../../tools/validate-guided-lifecycle";
import { GET } from "../../app/api/review-history/[id]/route";
import { POST } from "../../app/api/review-history/[id]/artifacts/route";
import { PUT } from "../../app/api/review-history/[id]/runtime-head/route";
import { DESKTOP_APP_ORIGIN_HEADER } from "../desktop/request-origin";
import { buildInitialCoachingRouteState, createReviewPreparationOrchestrator } from "../coaching/cs2d-route-integration";
import { buildSessionRecoveryRecord, createRecoverySessionIdentity, createRecoveryReviewPreparationDependencies, normalizeRecoveryAnalysis, restoreRecoveryArtifacts, validateStoredReviewArtifacts } from "../recovery/cs2d-session-recovery";
import * as artifactValidation from "./artifact-validation";
import { HistoryRestoreController, type ReviewHistoryDetail } from "./history-restore-controller";

const ORIGIN = "http://127.0.0.1:43123";
const headers = { [DESKTOP_APP_ORIGIN_HEADER]: ORIGIN, "content-type": "application/json" };
afterEach(() => { installDesktopReviewLibrary(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Normal CI uses explicitly synthetic Replay times/header bytes. Opt-in uses one
// authorized Demo read and one installed WASM parse; only anonymous timings escape.
async function reopenCompletedRoute(real: boolean) {
  const started = performance.now();
  const root = await mkdtemp(join(tmpdir(), "cs-agent-history-reopen-"));
  const path = join(root, "history.sqlite3");
  let owner: SqliteDatabaseOwner | undefined;
  let preparation: ReturnType<typeof createReviewPreparationOrchestrator> | undefined;
  let controller: HistoryRestoreController | undefined;
  try {
    const transport = vi.fn(() => { throw new Error("UNEXPECTED_NETWORK"); });
    vi.stubGlobal("fetch", transport); vi.stubEnv("DEPLOY_TARGET", "desktop");
    const bytes = real ? await readFile(process.env.CS_AGENT_VALIDATION_DEMO!) : Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(64, 3)]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    let replay: adapter.Cs2dReplay = { ...fireReplay("DEATH"),
      generatedBy: "cs2-demo-parser-wasm@0.0.0+cs-coach.hurt-events.v1.shot-identity.v2.ammo-clip.v2.bomb-identity.v1.death-identity.v1.frame-identity.v1.active-weapon-identity.v1.grenade-inventory.v1.primary-weapon.v1",
    }, selected = self, parseMs = 0;
    if (real) {
      const parser = await import(/* @vite-ignore */ new URL("../../../../.local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser.js", import.meta.url).href);
      parser.initSync({ module: await readFile(".local-data/upstream/cs2d/apps/app/src/viewer/parser/demo_parser_bg.wasm") });
      const began = performance.now(), parsed = parser.parse_demo(bytes, 8, undefined);
      try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); }
      parseMs = Math.round(performance.now() - began);
      const player = replay.players.find(item => item.name === process.env.CS_AGENT_VALIDATION_PLAYER);
      expect(Boolean(player), "selected player exists").toBe(true); selected = player!.steamId;
    }
    owner = new SqliteDatabaseOwner({ path });
    let library = new DesktopReviewLibrary({ owner, dataRoot: root });
    await library.initialize(); installDesktopReviewLibrary(library);
    const cap = library.issueImportCapability({ objectId: "history-reopen", originalFilename: "validation.dem", expectedByteLength: bytes.length });
    const imported = await library.importDemo({ authorization: cap.authorization, objectId: "history-reopen", stream: (async function* () { yield bytes; })() });
    await library.finalizeDemoImport({ authorization: imported.validationCapability!.authorization, demoId: imported.demo.demoId, valid: true });
    const generateAnalysis = vi.spyOn(adapter, "buildCs2dAnalysisBundle"), generateNarration = vi.spyOn(planner, "deterministicNarrationBundle");
    const analysis = adapter.buildCs2dAnalysisBundle({ replay, selectedSteamId: selected, demoId: imported.demo.demoId, demoContentHash: hash });
    const analysisJson = adapter.serializeCs2dAnalysisBundle(analysis);
    const captured: { value?: GuidedRouteArtifacts } = {};
    const lifecycle = await consumeGuidedRoute(analysis, hash, "ALL_SKIP", {
      runtime: { checkpointer: new SqliteCheckpointSaver({ owner }), checkpoint: "sqlite", checkpointBackend: "SQLITE" },
      capture: value => { captured.value = value; },
    });
    const { session, routeState, narrationByCue, summary, completedGraph } = captured.value!;
    expect(completedGraph.checkpoint.backend).toBe("SQLITE");
    expect(completedGraph.checkpoint.checkpointId).toBeTruthy();
    const plan = analysis.review_plan;
    const identity = { ...createRecoverySessionIdentity(), sessionId: completedGraph.identity.sessionId, runId: completedGraph.identity.runId };
    const record = buildSessionRecoveryRecord({ identity, demoContentHash: hash, selectedPlayerId: selected, plan, routeState, session,
      boundaryKind: "WRAP_UP", narrationByCue, analysis, agentCheckpointId: completedGraph.checkpoint.checkpointId });
    const review = await library.createReview({ demoId: imported.demo.demoId, selectedPlayerId: selected, selectedPlayerName: "Validation", title: "Completed route" });
    const revision = await library.startRevision({ reviewId: review.reviewId, analysisVersion: analysis.metadata.adapter_version, graphVersion: "coach-agent-graph.v3", promptVersion: plan.generation_manifest.prompt_version,
      modelMetadata: {}, routeId: plan.id, routeHash: routeState.routeFingerprint });
    const context = { params: Promise.resolve({ id: review.reviewId }) };
    const artifacts: { kind: string; requestBytes: number; elapsedMs: number; loadMs: number; validationMs: number; writeMs: number }[] = [];
    let loadMs = 0, validationMs = 0, writeMs = 0;
    const load = library.loadReview.bind(library), write = library.appendArtifact.bind(library);
    const validate = artifactValidation.validateReviewArtifactAppend;
    vi.spyOn(library, "loadReview").mockImplementation(async (...args) => {
      const began = performance.now(); try { return await load(...args); } finally { loadMs += performance.now() - began; }
    });
    vi.spyOn(library, "appendArtifact").mockImplementation(async (...args) => {
      const began = performance.now(); try { return await write(...args); } finally { writeMs += performance.now() - began; }
    });
    vi.spyOn(artifactValidation, "validateReviewArtifactAppend").mockImplementation((...args) => {
      const began = performance.now(); try { return validate(...args); } finally { validationMs += performance.now() - began; }
    });
    const append = async (artifactType: AppendArtifactInput["artifactType"], artifactKey: string, schemaVersion: string, payload: unknown) => {
      const body = JSON.stringify({ revisionId: revision.reviewRevisionId, artifactType, artifactKey, artifactRevision: 1, schemaVersion, payload, idempotencyKey: `${artifactType}:${artifactKey}` });
      loadMs = 0; validationMs = 0; writeMs = 0;
      const began = performance.now();
      const response = await POST(new Request(`${ORIGIN}/api/review-history/${review.reviewId}/artifacts`, { method: "POST", headers, body }), context);
      const result = await response.json();
      expect(response.status, `${artifactType}: ${result.code ?? "saved"}; bytes=${Buffer.byteLength(body)}`).toBe(201);
      artifacts.push({ kind: artifactType, requestBytes: Buffer.byteLength(body), elapsedMs: Math.round(performance.now() - began), loadMs: Math.round(loadMs), validationMs: Math.round(validationMs), writeMs: Math.round(writeMs) });
    };
    const saveStarted = performance.now();
    await append("ANALYSIS_BUNDLE", analysis.demo_id, "cs2d-analysis-bundle.v1", JSON.parse(analysisJson));
    await append("CANDIDATE_SET", analysis.candidate_set.id, "candidate-set.v1", analysis.candidate_set);
    await append("REVIEW_PLAN", plan.id, "review-plan.v1", plan);
    for (const [cueId, narration] of Object.entries(narrationByCue)) await append("NARRATION_BUNDLE", cueId, "narration-bundle.v1", narration);
    for (const [cueId, cueCase] of Object.entries(session.cue_cases ?? {})) {
      await append("USER_INTERACTION", `skip:${cueId}`, "user-reflection.v1", { kind: "REFLECTION_SKIPPED", reflection: cueCase.reflection });
      await append("CUE_CASE", cueId, "cue-case.v1", cueCase);
    }
    await append("SESSION_SUMMARY", identity.sessionId, "session-wrap-up.v1", summary);
    await append("SESSION_RECOVERY", record.boundary.boundaryId, "session-recovery-record.v2", record);
    const head: CommitRuntimeHeadInput = { reviewId: review.reviewId, reviewRevisionId: revision.reviewRevisionId, expectedRecoveryArtifactId: null,
      recoveryArtifactKey: record.boundary.boundaryId, recoveryArtifactRevision: 1, sessionId: identity.sessionId, runId: identity.runId,
      demoId: imported.demo.demoId, demoContentHash: hash, selectedPlayerId: selected, routeId: plan.id, routeHash: routeState.routeFingerprint,
      recoveryBoundary: "WRAP_UP", defaultRouteCursor: record.boundary.segmentIndex, completedCueCount: plan.cues.length, totalCueCount: plan.cues.length, stableProgress: record.cueProgress,
      checkpointThreadId: threadIdForIdentity(completedGraph.identity), checkpointNamespace: "", checkpointId: completedGraph.checkpoint.checkpointId!,
      reviewStatus: "COMPLETED", completedAt: new Date().toISOString() };
    const headResponse = await PUT(new Request(`${ORIGIN}/api/review-history/${review.reviewId}/runtime-head`, { method: "PUT", headers, body: JSON.stringify(head) }), context);
    const committed = await headResponse.json();
    expect(headResponse.status, committed.code).toBe(200);
    const saveMs = Math.round(performance.now() - saveStarted);
    const saved = await library.loadReview(review.reviewId);
    const artifactCount = saved.artifacts.length;
    const analysisStorage = saved.artifacts.find(item => item.artifactType === "ANALYSIS_BUNDLE")!.storageKind;
    const candidateStorage = saved.artifacts.find(item => item.artifactType === "CANDIDATE_SET")!.storageKind;
    if (real) expect(candidateStorage).toBe("GZIP_FILE");
    await owner.close(); owner = undefined; installDesktopReviewLibrary(undefined);

    const reopenStarted = performance.now();
    owner = new SqliteDatabaseOwner({ path });
    library = new DesktopReviewLibrary({ owner, dataRoot: root });
    await library.initialize(); installDesktopReviewLibrary(library);
    generateAnalysis.mockClear(); generateNarration.mockClear();
    const requestViewerSource = vi.fn(async () => { throw new Error("RESTORE_MUST_NOT_PARSE"); }), loadManagedDemo = vi.fn();
    controller = new HistoryRestoreController({ loadDetail: async id => {
      const response = await GET(new Request(`${ORIGIN}/api/review-history/${id}`, { headers }), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(200); return await response.json() as ReviewHistoryDetail;
    }, requestViewerSource, loadManagedDemo });
    const restored = await controller.open(review.reviewId);
    expect(restored.missingArtifacts).toEqual([]);
    expect(restored.detail.runtimeHead).toEqual(committed);
    const validated = validateStoredReviewArtifacts({ ...restored, selectedPlayerId: selected, demoContentHash: hash, routeId: plan.id, routeHash: routeState.routeFingerprint });
    expect(validated.summary).toEqual(summary);
    expect(validated.cueCases).toEqual(session.cue_cases);
    const recovery = SessionRecoveryRecordSchema.parse(restored.recoverySnapshot);
    const normalized = normalizeRecoveryAnalysis(validated.analysis, recovery), recovered = restoreRecoveryArtifacts(recovery);
    expect(recovered.session.phase).toBe("WRAP_UP");
    expect(recovered.session.consumed_cue_ids).toEqual(session.consumed_cue_ids);
    const savedNarration = { ...recovered.narrationByCue, ...validated.narrationByCue };
    const restoredRoute = buildInitialCoachingRouteState(recovered.plan, { narrationByCue: savedNarration });
    const deps = createRecoveryReviewPreparationDependencies(normalized, recovery), prepareNarration = vi.fn(deps.prepareNarration);
    preparation = createReviewPreparationOrchestrator("history-reopen", recovered.plan, { narrationByCue: savedNarration, readiness: restoredRoute.readiness }, { ...deps, prepareNarration });
    const events: string[] = []; await preparation.run(event => events.push(event.type));
    expect(events).toContain("READY_TO_START"); expect(events).not.toContain("NARRATION_UPDATE");
    expect(prepareNarration).not.toHaveBeenCalled(); expect(generateAnalysis).not.toHaveBeenCalled(); expect(generateNarration).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled(); expect(requestViewerSource).not.toHaveBeenCalled(); expect(loadManagedDemo).not.toHaveBeenCalled();
    const reopened = await library.loadReview(review.reviewId);
    expect(reopened.artifacts).toHaveLength(artifactCount); expect(reopened.runtimeHead).toEqual(committed); expect(reopened.review.status).toBe("COMPLETED");
    const result = { status: "PASSED", source: real ? "REAL_DEMO" : "SYNTHETIC", demoBytes: bytes.length, demoReads: real ? 1 : 0, parsePasses: real ? 1 : 0, parseMs,
      parserRevision: real ? replay.generatedBy : "SYNTHETIC", analysisBytes: Buffer.byteLength(analysisJson), analysisStorage, candidateStorage, artifactCount, artifacts,
      saveMs, reopenMs: Math.round(performance.now() - reopenStarted), totalMs: Math.round(performance.now() - started), lifecycle,
      restoredPhase: recovered.session.phase, restoredReviewStatus: reopened.review.status, newAnalysis: 0, newNarration: 0, networkCalls: 0, viewerRequests: 0,
      limitation: "Actual HTTP route handlers run in-process, not a listening server. Harness-driven Session ticks; no Viewer/UI or CS-Net inference. SQLite graph checkpoint persisted and terminal head validated; no graph reconnect dispatch." };
    if (real && process.env.CS_AGENT_VALIDATION_RESULT) await writeFile(process.env.CS_AGENT_VALIDATION_RESULT, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    preparation?.cancel(); controller?.cancel(); installDesktopReviewLibrary(undefined);
    if (owner) await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}
it("persists completed synthetic route through artifact/head APIs and reopens without regeneration", () => reopenCompletedRoute(false), 30_000);
it.skipIf(!process.env.CS_AGENT_VALIDATION_DEMO)("reopens completed real Demo artifacts at actual scale", () => reopenCompletedRoute(true), 120_000);
