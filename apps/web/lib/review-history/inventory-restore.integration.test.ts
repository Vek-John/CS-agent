import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import * as adapter from "@cs-coach/cs2d-analysis-adapter";
import * as planner from "@cs-coach/review-planner";
import { createCoachingSession } from "@cs-coach/session";
import { SessionRecoveryRecordSchema } from "@cs-coach/coach-agent/client";
import { SqliteDatabaseOwner } from "@cs-coach/memory-sqlite/server";
import { DesktopReviewLibrary, installDesktopReviewLibrary, type AppendArtifactInput, type CommitRuntimeHeadInput, type JsonValue } from "@cs-coach/review-library/server";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { GET } from "../../app/api/review-history/[id]/route";
import { DESKTOP_APP_ORIGIN_HEADER } from "../desktop/request-origin";
import { buildInitialCoachingRouteState, createReviewPreparationOrchestrator } from "../coaching/cs2d-route-integration";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "../coaching/cs2d-coaching-view";
import { buildTeachingDiagnosisInput } from "../coaching/teaching-diagnosis-host";
import { buildSessionRecoveryRecord, createRecoverySessionIdentity, createRecoveryReviewPreparationDependencies, normalizeRecoveryAnalysis, restoreRecoveryArtifacts, validateStoredReviewArtifacts } from "../recovery/cs2d-session-recovery";
import { validateReadyRevisionArtifacts, validateReviewArtifactAppend } from "./artifact-validation";
import { HistoryRestoreController, type ReviewHistoryDetail } from "./history-restore-controller";

const ORIGIN = "http://127.0.0.1:43123";
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
// Synthetic Replay integer times are fixture coordinates, not parsed Demo ticks.
// Header bytes only exercise the managed-library lifecycle; parser readiness is stubbed.
const BYTES = Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(64, 3)]);
const HASH = createHash("sha256").update(BYTES).digest("hex");
const cases = [
  { name: "known empty", kinds: [] as string[], version: 1 as const, known: [] as string[] },
  { name: "known Flash", kinds: ["Flash"], version: 1 as const, known: ["Flash"] },
  { name: "known Smoke", kinds: ["Smoke"], version: 1 as const, known: ["Smoke"] },
  { name: "unknown", kinds: undefined, version: 1 as const, known: undefined },
  { name: "invalid kind", kinds: ["not-a-known-grenade"], version: 1 as const, known: undefined },
  { name: "unversioned parser list", kinds: ["Flash"], version: undefined, known: undefined },
];
afterEach(() => { installDesktopReviewLibrary(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(cases)("reopens persisted $name inventory without regenerating teaching", async ({ kinds, version, known }) => {
  const root = await mkdtemp(join(tmpdir(), "cs-agent-inventory-restore-"));
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
    const source = fireReplay("DEATH", []);
    const replay: adapter.Cs2dReplay = { ...source, rounds: source.rounds.map(round => ({ ...round,
      frames: round.frames.map(frame => ({ ...frame, players: frame.players.map(player => ({ ...player, grenades: kinds, grenadeInventoryVersion: version })) })),
    })) };
    const generateAnalysis = vi.spyOn(adapter, "buildCs2dAnalysisBundle");
    const generateNarration = vi.spyOn(planner, "deterministicNarrationBundle");
    const analysis = adapter.buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-inventory-parser", demoContentHash: HASH });
    expect(analysis.metadata.adapter_version).toContain("1.11");
    expect(analysis.match_timeline.timeline_version).toBe(adapter.CS2D_TIMELINE_VERSION);
    expect(analysis.match_timeline.timeline_version).toMatch(/\/timeline\/1\.2\.0$/);
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
    const revision = await library.startRevision({ reviewId: review.reviewId, analysisVersion: analysis.metadata.adapter_version, graphVersion: "coach-agent-graph.v3", promptVersion: plan.generation_manifest.prompt_version,
      modelMetadata: {}, routeId: plan.id, routeHash: route.routeFingerprint });
    const append = async (artifactType: AppendArtifactInput["artifactType"], artifactKey: string, schemaVersion: string, payload: unknown) => {
      const input: AppendArtifactInput = { reviewRevisionId: revision.reviewRevisionId, artifactType, artifactKey, artifactRevision: 1, schemaVersion, payload: json(payload), idempotencyKey: `${artifactType}:${artifactKey}` };
      validateReviewArtifactAppend(await library.loadReview(review.reviewId, { reviewRevisionId: revision.reviewRevisionId, materializeExternalArtifacts: true }), input);
      await library.appendArtifact(input);
    };
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
      const response = await GET(new Request(`${ORIGIN}/api/review-history/${id}`, { headers: { [DESKTOP_APP_ORIGIN_HEADER]: ORIGIN } }), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(200); return await response.json() as ReviewHistoryDetail;
    });
    const requestViewerSource = vi.fn(async () => { throw new Error("CONTROL_PLANE_MUST_NOT_REQUEST_DEMO_PARSE"); });
    const loadManagedDemo = vi.fn();
    controller = new HistoryRestoreController({ loadDetail, requestViewerSource, loadManagedDemo });
    const restored = await controller.open(review.reviewId);
    expect(restored.missingArtifacts).toEqual([]); expect(restored.detail.runtimeHead).toEqual(committed);
    const validated = validateStoredReviewArtifacts({ ...restored, selectedPlayerId: self, demoContentHash: HASH, routeId: plan.id, routeHash: route.routeFingerprint });
    const recovery = SessionRecoveryRecordSchema.parse(restored.recoverySnapshot);
    const normalized = normalizeRecoveryAnalysis(validated.analysis, recovery);
    const recovered = restoreRecoveryArtifacts(recovery);
    const savedNarration = { ...recovered.narrationByCue, ...validated.narrationByCue };
    const restoredRoute = buildInitialCoachingRouteState(recovered.plan, { narrationByCue: savedNarration });
    const deps = createRecoveryReviewPreparationDependencies(normalized, recovery);
    const prepareRoute = vi.fn(deps.prepareRoute);
    const prepareNarration = vi.fn(deps.prepareNarration);
    preparation = createReviewPreparationOrchestrator("inventory-reopen", recovered.plan, { narrationByCue: savedNarration, readiness: restoredRoute.readiness }, { ...deps, prepareRoute, prepareNarration });
    const events: string[] = []; await preparation.run(event => events.push(event.type));
    expect(events).toContain("READY_TO_START"); expect(events).not.toContain("NARRATION_UPDATE");
    expect(prepareRoute).toHaveBeenCalledOnce(); // Frozen route validation, not a new Director call.
    expect(prepareNarration).not.toHaveBeenCalled(); expect(generateNarration).not.toHaveBeenCalled(); expect(generateAnalysis).not.toHaveBeenCalled();
    expect(forbiddenTransport).not.toHaveBeenCalled(); expect(requestViewerSource).not.toHaveBeenCalled(); expect(loadManagedDemo).not.toHaveBeenCalled();
    const cue = recovered.plan.cues[0];
    const state = playerStateAtOrBefore(normalized.match_timeline.player_state_tracks ?? [], self, cue.decision_tick);
    expect(state).toBeDefined();
    expect(state!.missing_fields.includes("inventory")).toBe(known === undefined);
    expect(state!.missing_fields.includes("inventory.count")).toBe(Boolean(known?.length));
    const material = normalized.candidate_set.materials.find(item => item.candidateId === cue.candidate_id);
    expect(material?.decisionSnapshot?.selectedPlayer.value?.grenades).toEqual(known ?? null);
    const view = buildThreeStageCoachingView({ narration: savedNarration[cue.id], decisionState: state,
      semantics: { ...material, ...cue }, decisionTick: cue.decision_tick,
      decisionFacts: buildCoachingCueView(cue, false).decisionFacts, outcomeFacts: [] });
    const expectedUtility = known?.length === 0 ? ["无道具"]
      : known?.[0] === "Flash" ? ["闪光弹（数量未知）"]
      : known?.[0] === "Smoke" ? ["烟雾弹（数量未知）"] : [];
    expect(view.currentState.chips.filter(chip => chip.kind === "utility").map(chip => chip.text)).toEqual(expectedUtility);
    const diagnostic = buildTeachingDiagnosisInput({ plan: recovered.plan, cue, material, timeline: normalized.match_timeline, selectedPlayerId: self },
      { cueId: cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] });
    expect(diagnostic.decisionResources?.health).toBe(state!.health);
    expect(diagnostic.decisionResources?.evidenceRefs.length).toBeGreaterThan(0);
    expect(diagnostic.decisionResources?.utilityCount).toBe(known?.length === 0 ? 0 : undefined);
    expect(normalized.match_timeline).toEqual(validated.analysis.match_timeline);
    const reopened = await library.loadReview(review.reviewId, { materializeExternalArtifacts: true });
    expect(reopened.artifacts).toEqual(savedArtifacts); // No repair/regeneration/append during restore.
    expect(reopened.runtimeHead).toEqual(committed);
  } finally {
    preparation?.cancel(); controller?.cancel(); installDesktopReviewLibrary(undefined);
    if (owner) await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
