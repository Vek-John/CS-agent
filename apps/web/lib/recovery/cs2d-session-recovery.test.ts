import { describe, expect, it, vi } from "vitest";
import {
  buildCs2dAnalysisBundle,
  type Cs2dReplay,
} from "@cs-coach/cs2d-analysis-adapter";
import { createCoachingSession } from "@cs-coach/session";
import { requestDecisionAssessments } from "../coaching/decision-assessment-host";
import { buildInitialCoachingRouteState, createCs2dReviewPreparationDependencies } from "../coaching/cs2d-route-integration";
import {
  buildCoachingPackage,
  buildOutcomeImpactForCue,
  buildOutcomePackage,
  deterministicNarrationBundle,
  deterministicDirectorFallback,
  stableFingerprint,
} from "@cs-coach/review-planner";
import {
  assertRecoveryMatchesActiveRevision,
  buildReconnectReplayEvent,
  createRecoveryReviewPreparationDependencies,
  buildSessionRecoveryRecord,
  checkpointForRecoveryBoundary,
  createRecoverySessionIdentity,
  normalizeRecoveryAnalysis,
  restoreRecoveryArtifacts,
  isPreAgentRouteStartRecovery,
  mergePersistedToolResults,
  shouldReconnectRecoveryAgent,
  shouldPersistToolTransitionToRecovery,
  validateStoredReviewArtifacts,
} from "./cs2d-session-recovery";
import { SessionRecoveryRecordSchema } from "@cs-coach/coach-agent/client";

const HASH = "8".repeat(64);

function state(steamId: string, tick: number, health: number) {
  return {
    steamId,
    x: 100 + tick / 10,
    y: 200 + tick / 10,
    z: 64,
    yaw: 90,
    health,
    alive: health > 0,
    side: steamId === "dog" ? "T" as const : "CT" as const,
    weapon: steamId === "dog" ? "AK-47" : "M4A1-S",
    lastPlaceName: "Connector",
    money: 4200,
    equipValue: 5000,
    armor: 100,
    helmet: true,
    grenades: ["Smoke"],
  };
}

function replay(): Cs2dReplay {
  return {
    map: "de_mirage",
    demoTickRate: 64,
    frameRate: 8,
    players: [
      { steamId: "dog", name: "Dog", startSide: "T" },
      { steamId: "opponent", name: "Opponent", startSide: "CT" },
    ],
    rounds: [{
      number: 1,
      freezeStartTick: 0,
      startTick: 64,
      decidedTick: 640,
      endTick: 700,
      postEndTick: 760,
      winner: "CT",
      scoreCt: 0,
      scoreT: 0,
      frames: [
        { tick: 64, t: 1, players: [state("dog", 64, 100), state("opponent", 64, 100)] },
        { tick: 160, t: 2.5, players: [state("dog", 160, 100), state("opponent", 160, 100)] },
        { tick: 256, t: 4, players: [state("dog", 256, 30), state("opponent", 256, 100)] },
        { tick: 352, t: 5.5, players: [state("dog", 352, 0), state("opponent", 352, 100)] },
        { tick: 544, t: 8.5, players: [state("dog", 544, 0), state("opponent", 544, 100)] },
      ],
      events: [{
        type: "kill",
        tick: 352,
        t: 5.5,
        attackerSteamId: "opponent",
        victimSteamId: "dog",
        assisterSteamId: null,
        assistedFlash: false,
        weapon: "M4A1-S",
        headshot: false,
        x: 500,
        y: 300,
        z: 64,
      }],
      grenadePaths: [],
    }],
  };
}

function fixture() {
  const analysis = buildCs2dAnalysisBundle({
    replay: replay(),
    selectedSteamId: "dog",
    demoId: "cs2d-local-demo",
    demoContentHash: HASH,
    demoContentHashLatencyMs: 1,
  });
  const narrationByCue = Object.fromEntries(analysis.review_plan.cues.map((cue) => {
    const coaching = buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence);
    const impact = buildOutcomeImpactForCue(
      cue,
      analysis.candidate_set,
      analysis.win_probability_timeline,
      analysis.match_timeline,
      analysis.selected_steam_id,
    );
    return [cue.id, deterministicNarrationBundle(
      coaching,
      buildOutcomePackage(cue, analysis.candidate_set, impact),
    )];
  }));
  const readiness = Object.fromEntries(analysis.review_plan.cues.map((cue) => [cue.id, "READY" as const]));
  const routeState = buildInitialCoachingRouteState(analysis.review_plan, { narrationByCue, readiness });
  const identity = createRecoverySessionIdentity(() => "00000000-0000-4000-8000-000000000001");
  const session = createCoachingSession(analysis.review_plan, identity.sessionId, routeState);
  return { analysis, narrationByCue, routeState, identity, session };
}

describe("cs2d recovery Host Adapter", () => {
  it("persists and restores the actual prepared route, including its assessment audit", async () => {
    const input = fixture();
    const dependencies = createCs2dReviewPreparationDependencies({
      candidateSet: input.analysis.candidate_set,
      observationEvidence: input.analysis.observation_evidence,
      matchTimeline: input.analysis.match_timeline,
      winProbabilityTimeline: input.analysis.win_probability_timeline,
      selectedPlayerId: "dog",
    }, {
      assessDecisions: (set, options) => requestDecisionAssessments(set, {
        ...options,
        fetcher: async () => Response.json({ mode: "RULE_BASELINE", acceptance: "DISABLED" }),
      }),
      director: async (set) => deterministicDirectorFallback(set, "TEST_LOCAL_PROVIDER"),
    });
    const plan = await dependencies.prepareRoute({
      generationId: "test-preparation", inputPlan: input.analysis.review_plan, signal: new AbortController().signal,
    });
    expect(plan.decision_assessment_run).toEqual({
      version: "decision-assessment-run.v1", mode: "RULE_BASELINE", calls: 0, accepted: 0, records: [],
    });
    const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, deterministicNarrationBundle(
      buildCoachingPackage(cue, input.analysis.candidate_set, input.analysis.observation_evidence),
      buildOutcomePackage(cue, input.analysis.candidate_set, buildOutcomeImpactForCue(cue, input.analysis.candidate_set,
        input.analysis.win_probability_timeline, input.analysis.match_timeline, "dog")),
    )]));
    const routeState = buildInitialCoachingRouteState(plan, { narrationByCue,
      readiness: Object.fromEntries(plan.cues.map(cue => [cue.id, "READY" as const])),
    });
    const record = buildSessionRecoveryRecord({ ...input, plan, routeState, narrationByCue,
      session: createCoachingSession(plan, input.identity.sessionId, routeState),
      boundaryKind: "ROUTE_START", demoContentHash: HASH, selectedPlayerId: "dog", agentCheckpointId: null,
    });
    const restored = restoreRecoveryArtifacts(SessionRecoveryRecordSchema.parse(JSON.parse(JSON.stringify(record))));
    expect(restored.plan).toEqual(plan);
    expect(restored.routeState.startable).toBe(true);
  });

  it("restores legacy wording as an artifact without weakening live narration or reference validation", () => {
    const input = fixture();
    const analysis = JSON.parse(JSON.stringify(input.analysis));
    const strip = (value: Record<string, unknown>) => {
      for (const key of ["decisionSnapshot", "observableContext", "assessment", "adviceOptions", "behaviorHypotheses"]) delete value[key];
    };
    analysis.candidate_set.candidates.forEach(strip);
    analysis.candidate_set.materials.forEach(strip);
    analysis.review_plan.cues.forEach(strip);
    analysis.metadata.adapter_version = "cs2d-analysis-adapter/1.4.0";
    const { hash: _hash, ...candidateContents } = analysis.candidate_set;
    analysis.candidate_set.hash = stableFingerprint({ ...candidateContents, failureReason: undefined });
    analysis.review_plan.candidate_set_hash = analysis.candidate_set.hash;
    analysis.review_plan.director_decision_set.candidateSetHash = analysis.candidate_set.hash;
    const cueId = analysis.review_plan.cues[0].id as string;
    const narrationByCue = JSON.parse(JSON.stringify(input.narrationByCue));
    narrationByCue[cueId].betterPlay.text = "让高血量队友先接触，你跟着补枪。";
    const args = { analysis, candidateSet: analysis.candidate_set, plan: analysis.review_plan, narrationByCue,
      cueCases: {}, learningThreads: [], summary: null, selectedPlayerId: "dog", demoContentHash: HASH };
    const restored = validateStoredReviewArtifacts(args);
    expect(restored.narrationByCue[cueId]?.betterPlay.text).toBe(narrationByCue[cueId].betterPlay.text);
    expect(restored.analysis.candidate_set.hash).toBe(analysis.candidate_set.hash);
    expect(() => validateStoredReviewArtifacts({ ...args, analysis: input.analysis, candidateSet: input.analysis.candidate_set, plan: input.analysis.review_plan })).toThrow(/NarrationBundle validation failed/);
    narrationByCue[cueId].betterPlay.refs = ["unknown-future-ref"];
    expect(() => validateStoredReviewArtifacts(args)).toThrow(/NarrationBundle validation failed/);
  });

  it("revalidates stored analysis, plan, narration, and cross-artifact identities", () => {
    const input = fixture();
    const validated = validateStoredReviewArtifacts({
      analysis: input.analysis,
      candidateSet: input.analysis.candidate_set,
      plan: input.analysis.review_plan,
      narrationByCue: input.narrationByCue,
      cueCases: {},
      learningThreads: [],
      summary: null,
      selectedPlayerId: "dog",
      demoContentHash: HASH,
      routeId: input.analysis.review_plan.id,
      routeHash: input.routeState.routeFingerprint,
    });
    expect(validated.analysis.demo_id).toBe("cs2d-local-demo");
    expect(validated.plan.id).toBe(input.analysis.review_plan.id);
    expect(Object.keys(validated.narrationByCue)).toEqual(Object.keys(input.narrationByCue));

    expect(() => validateStoredReviewArtifacts({
      analysis: input.analysis,
      candidateSet: input.analysis.candidate_set,
      plan: input.analysis.review_plan,
      narrationByCue: input.narrationByCue,
      cueCases: {},
      learningThreads: [],
      summary: null,
      selectedPlayerId: "opponent",
      demoContentHash: HASH,
      routeId: input.analysis.review_plan.id,
      routeHash: input.routeState.routeFingerprint,
    })).toThrow(/identity/u);

    const cueId = input.analysis.review_plan.cues[0]!.id;
    expect(() => validateStoredReviewArtifacts({
      analysis: input.analysis,
      candidateSet: input.analysis.candidate_set,
      plan: input.analysis.review_plan,
      narrationByCue: {
        ...input.narrationByCue,
        [cueId]: { ...input.narrationByCue[cueId]!, candidateId: "wrong-candidate" },
      },
      cueCases: {},
      learningThreads: [],
      summary: null,
      selectedPlayerId: "dog",
      demoContentHash: HASH,
      routeId: input.analysis.review_plan.id,
      routeHash: input.routeState.routeFingerprint,
    })).toThrow(/NarrationBundle validation failed/u);
  });

  it("keeps manual tool transitions out of the stable RecoveryBoundary store", () => {
    expect(shouldPersistToolTransitionToRecovery("MANUAL")).toBe(false);
    expect(shouldPersistToolTransitionToRecovery("DEFAULT")).toBe(true);
  });
  it("builds and restores a bounded route-start record", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: "checkpoint-1",
      createdAt: 1,
      updatedAt: 2,
    });
    const restored = restoreRecoveryArtifacts(record);

    expect(record).toMatchObject({
      recoveryId: input.identity.recoveryId,
      sessionId: input.identity.sessionId,
      runId: input.identity.runId,
      boundary: { kind: "ROUTE_START", segmentIndex: 0 },
    });
    expect(restored.plan.id).toBe(input.analysis.review_plan.id);
    expect(restored.session).toMatchObject({ id: input.identity.sessionId, phase: "INTRO", current_segment_index: 0 });
    expect(Object.keys(restored.narrationByCue).length).toBeLessThanOrEqual(3);
  });

  it("refuses to pair a valid recovery record with a different active Revision identity", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: null,
    });

    expect(() => assertRecoveryMatchesActiveRevision(record, input.analysis.review_plan)).not.toThrow();
    expect(() => assertRecoveryMatchesActiveRevision(
      { ...record, routeId: "another-revision-route" },
      input.analysis.review_plan,
    )).toThrow("active Revision");
    expect(() => assertRecoveryMatchesActiveRevision(
      { ...record, routeHash: "another-revision-hash" },
      input.analysis.review_plan,
    )).toThrow("active Revision");
  });

  it("accepts the same structured analysis and rejects identity, hash, player, route, and tick drift", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: "checkpoint-1",
    });

    expect(normalizeRecoveryAnalysis(input.analysis, record)).toBe(input.analysis);
    expect(() => normalizeRecoveryAnalysis({ ...input.analysis, demo_id: "other-demo" }, record)).toThrow("Demo identity");
    expect(() => normalizeRecoveryAnalysis({ ...input.analysis, metadata: { ...input.analysis.metadata, demo_content_hash: "f".repeat(64) } }, record)).toThrow("Demo hash");
    const { demo_content_hash: _missingHash, ...metadataWithoutHash } = input.analysis.metadata;
    expect(() => normalizeRecoveryAnalysis({ ...input.analysis, metadata: metadataWithoutHash }, record)).toThrow("Demo hash");
    expect(() => normalizeRecoveryAnalysis({ ...input.analysis, selected_steam_id: "opponent" }, record)).toThrow("player");
    expect(() => restoreRecoveryArtifacts({ ...record, routeHash: "other-route" })).toThrow("route");

    const cue = input.analysis.review_plan.cues[0]!;
    const candidates = input.analysis.candidate_set.candidates.map((candidate) => candidate.candidateId === cue.candidate_id
      ? { ...candidate, decisionTick: candidate.decisionTick + 1 }
      : candidate);
    expect(() => normalizeRecoveryAnalysis({
      ...input.analysis,
      candidate_set: { ...input.analysis.candidate_set, candidates },
    }, record)).toThrow("candidate/tick");
  });

  it("builds reconnect from the persisted random identity and exact checkpoint", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: "checkpoint-exact",
    });
    const reconnect = buildReconnectReplayEvent(record);

    expect(reconnect.identity).toMatchObject({
      runId: input.identity.runId,
      sessionId: input.identity.sessionId,
      demoId: "cs2d-local-demo",
      routeId: record.routeId,
      routeHash: record.routeHash,
    });
    expect(reconnect.expectedCheckpointId).toBe("checkpoint-exact");
    expect(reconnect.pendingToolDisposition).toEqual({ status: "NONE" });
    expect(() => buildReconnectReplayEvent({
      ...record,
      versions: { ...record.versions, graph: "coach-agent-graph.v999" },
    })).toThrow("versions");
  });

  it("keeps a pre-Agent ROUTE_START recovery out of Graph reconnect", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: null,
    });

    expect(shouldReconnectRecoveryAgent(record)).toBe(false);
    expect(isPreAgentRouteStartRecovery(record)).toBe(true);
    expect(() => buildReconnectReplayEvent(record)).toThrow("no Agent checkpoint");
  });

  it("does not accept a checkpointless mid-route boundary as a pre-Agent recovery", () => {
    const input = fixture();
    const record = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: null,
    });
    const cue = input.analysis.review_plan.cues[0]!;
    const invalidMidRoute = {
      ...record,
      boundary: {
        kind: "CUE_PAUSED" as const,
        boundaryId: "boundary-cue",
        segmentId: cue.segment_id,
        segmentIndex: input.analysis.review_plan.segments.findIndex((segment) => segment.id === cue.segment_id),
        cueId: cue.id,
        sessionPhase: "PAUSED_FOR_COACHING" as const,
        outcomeGateStatus: "COMPLETE" as const,
      },
    };
    expect(shouldReconnectRecoveryAgent(invalidMidRoute)).toBe(false);
    expect(isPreAgentRouteStartRecovery(invalidMidRoute)).toBe(false);
  });

  it("never binds a previous cue checkpoint to the next paused boundary", () => {
    const boundary = {
      kind: "CUE_PAUSED" as const,
      boundaryId: "boundary-cue-2",
      segmentId: "segment-2",
      segmentIndex: 4,
      cueId: "cue-2",
      sessionPhase: "PAUSED_FOR_COACHING" as const,
      outcomeGateStatus: "COMPLETE" as const,
    };
    expect(checkpointForRecoveryBoundary({
      checkpointId: "checkpoint-cue-1",
      activeCueId: "cue-1",
      currentSessionPhase: "PAUSED_FOR_COACHING",
      routeCursor: 3,
      sessionStatus: "ACTIVE",
    }, boundary)).toBeNull();
    expect(checkpointForRecoveryBoundary({
      checkpointId: "checkpoint-cue-2",
      activeCueId: "cue-2",
      currentSessionPhase: "PAUSED_FOR_COACHING",
      routeCursor: 4,
      sessionStatus: "ACTIVE",
    }, boundary)).toBe("checkpoint-cue-2");
  });

  it("round-trips presented cues independently from consumed/completed progress", () => {
    const input = fixture();
    const cue = input.analysis.review_plan.cues[0]!;
    const session = {
      ...input.session,
      presented_cue_ids: [cue.id],
      consumed_cue_ids: [],
    };
    const record = buildSessionRecoveryRecord({
      ...input,
      session,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: null,
    });
    expect(record.cueProgress).toMatchObject({ presentedCueIds: [cue.id], completedCueIds: [], consumedCueIds: [] });
    expect(restoreRecoveryArtifacts(record).session.presented_cue_ids).toEqual([cue.id]);
  });

  it("binds WRAP_UP only to the completed checkpoint at the matching route cursor", () => {
    const boundary = {
      kind: "WRAP_UP" as const,
      boundaryId: "boundary-wrap-up",
      segmentIndex: 9,
    };
    expect(checkpointForRecoveryBoundary({
      checkpointId: "checkpoint-completed",
      activeCueId: "cue-last",
      currentSessionPhase: "PAUSED_FOR_COACHING",
      routeCursor: 9,
      sessionStatus: "COMPLETED",
    }, boundary)).toBe("checkpoint-completed");
    expect(checkpointForRecoveryBoundary({
      checkpointId: "checkpoint-active",
      activeCueId: "cue-last",
      currentSessionPhase: "WRAP_UP",
      routeCursor: 9,
      sessionStatus: "ACTIVE",
    }, boundary)).toBeNull();
    expect(checkpointForRecoveryBoundary({
      checkpointId: "checkpoint-previous-cue",
      activeCueId: "cue-last",
      currentSessionPhase: "PAUSED_FOR_COACHING",
      routeCursor: 8,
      sessionStatus: "COMPLETED",
    }, boundary)).toBeNull();
  });

  it("reuses a persisted ToolResult to close a POSTED recovery ledger without replaying the tool", () => {
    const input = fixture();
    const cue = input.analysis.review_plan.cues[0]!;
    const base = buildSessionRecoveryRecord({
      ...input,
      plan: input.analysis.review_plan,
      boundaryKind: "ROUTE_START",
      demoContentHash: HASH,
      selectedPlayerId: "dog",
      agentCheckpointId: null,
    });
    const posted = SessionRecoveryRecordSchema.parse({
      ...base,
      toolLedger: [{
        callId: "call-recovered",
        cueId: cue.id,
        capabilityId: "cap-focus-map",
        status: "POSTED",
        observationCode: null,
        result: null,
      }],
    });
    const result = {
      callId: "call-recovered",
      status: "SUCCEEDED",
      observation: { code: "EVIDENCE_SHOWN", completed: true },
      limitations: [],
    } as const;

    const merged = mergePersistedToolResults(posted, { "call-recovered": result });
    expect(merged.toolLedger[0]).toMatchObject({
      status: "RESULTED",
      observationCode: "EVIDENCE_SHOWN",
      result,
    });
    expect(() => mergePersistedToolResults(posted, {
      "another-call": result,
    })).toThrow(/key does not match callId/u);
  });
});

it("retains the last recoverable boundary while a rendered paused cue awaits its matching checkpoint", async () => {
  const { buildCheckpointedRecoveryRecord } = await import("./cs2d-session-recovery");
  const { reduceCoachingSession } = await import("@cs-coach/session");
  const input = fixture();
  const plan = input.analysis.review_plan;
  const cue = plan.cues[0];
  let session = reduceCoachingSession(plan, input.session, { type: "START" });
  for (let step = 0; step < plan.segments.length + 2 && session.phase !== "PAUSED_FOR_COACHING"; step++) {
    session = session.phase === "SKIPPING"
      ? reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" })
      : reduceCoachingSession(plan, session, { type: "TICK", tick: Math.max(plan.segments[session.current_segment_index].end_tick, cue.outcome_end_tick) });
  }
  expect(session.phase).toBe("PAUSED_FOR_COACHING");
  const base = { ...input, plan, demoContentHash: HASH, selectedPlayerId: "dog", agentCheckpointId: null };
  let durable = buildSessionRecoveryRecord({ ...base, boundaryKind: "ROUTE_START" });
  const pausedInput = { ...base, session, boundaryKind: "CUE_PAUSED" as const };
  let release!: () => void;
  const checkpointPending = new Promise<void>((resolve) => { release = resolve; });
  const completion = checkpointPending.then(() => {
    durable = buildCheckpointedRecoveryRecord(pausedInput, { checkpointId: "checkpoint-paused", activeCueId: cue.id, currentSessionPhase: "PAUSED_FOR_COACHING", routeCursor: session.current_segment_index, sessionStatus: "ACTIVE" }) ?? durable;
  });
  durable = buildCheckpointedRecoveryRecord(pausedInput, undefined) ?? durable;
  expect(durable.boundary.kind).toBe("ROUTE_START");
  release();
  await completion;
  expect(durable.boundary.kind).toBe("CUE_PAUSED");
  expect(durable.agentCheckpointId).toBe("checkpoint-paused");
});

it("restores only the checkpoint case matching the paused cue without advancing its gates", async () => {
  const { restoreCheckpointTeachingCase } = await import("./cs2d-session-recovery");
  const { reduceCoachingSession } = await import("@cs-coach/session");
  const { diagnoseTeachingCue } = await import("@cs-coach/coach-agent/client");
  const input = fixture();
  const plan = input.analysis.review_plan;
  const cue = plan.cues[0];
  let session = reduceCoachingSession(plan, input.session, { type: "START" });
  for (let step = 0; step < plan.segments.length + 2 && session.phase !== "PAUSED_FOR_COACHING"; step++) {
    session = session.phase === "SKIPPING" ? reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" }) : reduceCoachingSession(plan, session, { type: "TICK", tick: Math.max(plan.segments[session.current_segment_index].end_tick, cue.outcome_end_tick) });
  }
  const saved = diagnoseTeachingCue({ cueId: cue.id, reflection: { cueId: cue.id, selectedGoal: "TRADE", source: "USER", response: "ANSWERED", limitations: [] }, decisionFacts: [], playerActionFacts: [], outcomeFacts: [], decisionResources: { health: 2, armor: 0, hasHelmet: false, aliveTeammates: 0, evidenceRefs: ["roster"] } });
  const restored = restoreCheckpointTeachingCase(plan, session, saved.cueCase, saved.learningThread);
  expect(restored.cue_cases?.[cue.id].reflection?.selectedGoal).toBe("TRADE");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { TeachingDiagnosisPanel } = await import("../../components/playback/teaching-diagnosis-panel");
  const html = renderToStaticMarkup(createElement(TeachingDiagnosisPanel, { cue, decisionFacts: [], cueCase: restored.cue_cases?.[cue.id], hasTrustedDecisionContext: Boolean(cue.assessment && cue.observableContext), onSubmit() {}, onSkip() {}, onConfirm() {}, onDisagree() {} }));
  expect(html).toContain("四名队友都已阵亡");
  expect(html).not.toContain("先说说你的思路");
  expect(restored.phase).toBe(session.phase);
  expect(restored.outcome_completion).toEqual(session.outcome_completion);
  expect(restored.consumed_cue_ids).toEqual(session.consumed_cue_ids);
  expect(restoreCheckpointTeachingCase(plan, session, { ...saved.cueCase, cueId: "another-cue" })).toBe(session);
});


it("reuses saved preparation without opening either bounded client request", async () => {
  const { createReviewPreparationOrchestrator } = await import("../coaching/cs2d-route-integration");
  const input = fixture();
  const record = buildSessionRecoveryRecord({ ...input, plan: input.analysis.review_plan,
    boundaryKind: "ROUTE_START", demoContentHash: HASH, selectedPlayerId: "dog", agentCheckpointId: "checkpoint-1" });
  const dependencies = createRecoveryReviewPreparationDependencies(input.analysis, record);
  const fetcher = vi.fn(() => { throw Error("saved preparation must not request transport"); });
  vi.stubGlobal("fetch", fetcher);
  try {
    const events: string[] = [];
    const controller = createReviewPreparationOrchestrator("saved-preparation", input.analysis.review_plan,
      { narrationByCue: input.narrationByCue, readiness: input.routeState.readiness }, dependencies);
    await controller.run(event => events.push(event.type));
    expect(events).toContain("READY_TO_START");
    expect(events).not.toContain("NARRATION_UPDATE");
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it.each(["legacy", "zero", "known", "partial"])("restores %s saved utility measurements unchanged without requesting diagnosis", async kind => {
  const { restoreCheckpointTeachingCase } = await import("./cs2d-session-recovery");
  const { reduceCoachingSession } = await import("@cs-coach/session");
  const { diagnoseTeachingCue, TeachingDiagnosisOutputSchema } = await import("@cs-coach/coach-agent/client");
  const input = fixture();
  const plan = input.analysis.review_plan;
  const cue = plan.cues[0];
  let session = reduceCoachingSession(plan, input.session, { type: "START" });
  for (let step = 0; step < plan.segments.length + 2 && session.phase !== "PAUSED_FOR_COACHING"; step++) {
    session = session.phase === "SKIPPING" ? reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" }) : reduceCoachingSession(plan, session, { type: "TICK", tick: Math.max(plan.segments[session.current_segment_index].end_tick, cue.outcome_end_tick) });
  }
  const produced = diagnoseTeachingCue({ cueId: cue.id, reflection: { cueId: cue.id, selectedGoal: "OTHER", source: "USER", response: "ANSWERED", limitations: [] }, decisionFacts: [], playerActionFacts: [], outcomeFacts: [], decisionResources: { health: kind === "partial" ? 70 : 100, armor: kind === "partial" ? 80 : 100, ...(kind === "partial" ? {} : { hasHelmet: true }), utilityCount: kind === "zero" ? 0 : 2, evidenceRefs: [] } });
  // Historical fixture: older versions labeled inventoryCount as utility, even for fractional totals.
  const saved = JSON.parse(JSON.stringify(produced));
  if (kind === "legacy") saved.cueCase.diagnosticResult.measurements.find((item: { label: string }) => item.label === "决策时道具数量").value = 1.5;
  const parsed = TeachingDiagnosisOutputSchema.parse(saved);
  const fetcher = vi.fn(() => { throw Error("restoring stored diagnosis must not request transport"); });
  vi.stubGlobal("fetch", fetcher);
  try {
    const restored = restoreCheckpointTeachingCase(plan, session, parsed.cueCase, parsed.learningThread);
    expect(restored.cue_cases?.[cue.id]?.diagnosticResult).toEqual(saved.cueCase.diagnosticResult);
    if (kind === "partial") expect(restored.cue_cases?.[cue.id]?.diagnosticResult?.status).toBe("UNVERIFIABLE");
    expect(restored.phase).toBe(session.phase);
    expect(restored.outcome_completion).toEqual(session.outcome_completion);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it.each(["DISABLED", "SUCCEEDED"] as const)("restores %s wrap-up artifacts without rewriting text or invoking providers", async status => {
  const input = fixture();
  const summary = { status, bundle: { schemaVersion: "coach-agent-session-wrap-up.v1", themes: [{ focus: "saved-focus", summary: { text: "已保存总结正文", refs: [input.analysis.review_plan.cues[0].id] }, trainingAdvice: { text: "已保存训练建议", refs: ["saved-advice"] } }], limitations: ["保存时的限定"] }, manifest: { status, provider: status === "SUCCEEDED" ? "DEEPSEEK" : "DETERMINISTIC", reason: status === "DISABLED" ? "CLOSED_SESSION_PROJECTION" : undefined, limitations: [] } };
  const saved = JSON.parse(JSON.stringify(summary));
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  try {
    const restored = validateStoredReviewArtifacts({ analysis: input.analysis, candidateSet: input.analysis.candidate_set, plan: input.analysis.review_plan, narrationByCue: input.narrationByCue, cueCases: {}, learningThreads: [], summary: saved, selectedPlayerId: "dog", demoContentHash: HASH });
    expect(restored.summary).toEqual(saved);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});


it("reconnects a revised diagnosis checkpoint into the recovered paused Session and reuses its grounded answers", async () => {
  const { createMemoryTestCheckpointSaver } = await import("../../../../libs/coach-agent/src/test-fixtures");
  const { createCoachAgentRuntime, FakePolicyAdapter } = await import("@cs-coach/coach-agent");
  const { reduceCoachingSession } = await import("@cs-coach/session");
  const { CoachAgentStage3Controller } = await import("../coaching/coach-agent-stage3-controller");
  const { buildStage3Identity } = await import("../coaching/coach-agent-stage3-host-adapter");
  const { buildTeachingDiagnosisSubmissionEvent } = await import("../coaching/teaching-diagnosis-host");
  const { buildCheckpointedRecoveryRecord, restoreCheckpointTeachingCase } = await import("./cs2d-session-recovery");
  const { buildCurrentCueQuestionContext, answerGroundedCueQuestion, CURRENT_CUE_ADVICE_QUESTION } = await import("../coaching/current-cue-questions");
  const { buildLocalAgentMemoryEvents } = await import("../memory/agent-events");
  const input = fixture(), plan = input.analysis.review_plan, cue = plan.cues[0];
  let session = reduceCoachingSession(plan, input.session, { type: "START" });
  for (let step = 0; step < plan.segments.length + 2 && session.phase !== "PAUSED_FOR_COACHING"; step++) {
    session = session.phase === "SKIPPING" ? reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" })
      : reduceCoachingSession(plan, session, { type: "TICK", tick: Math.max(plan.segments[session.current_segment_index].end_tick, cue.outcome_end_tick) });
  }
  expect(session.current_cue_id).toBe(cue.id);
  const saver = createMemoryTestCheckpointSaver(), policy = new FakePolicyAdapter({ failure: new Error("no visual Policy during recovery") });
  const runtime = createCoachAgentRuntime({ checkpointer: saver, policy });
  const post = vi.fn();
  const controller = new CoachAgentStage3Controller({ dispatch: event => runtime.dispatch(event), post, bridgeAvailable: () => true, isLive: () => true });
  const hostInput = { plan, routeState: input.routeState, cue, narration: input.narrationByCue[cue.id],
    outcomeGate: session.outcome_completion!, currentSessionPhase: "PAUSED_FOR_COACHING" as const,
    analysis: input.analysis, demoContentHash: HASH, selectedPlayerId: "dog", sessionId: input.identity.sessionId,
    runId: input.identity.runId, generation: 1, tickRate: input.analysis.match_timeline.tick_rate,
    evidence: { candidate: input.analysis.candidate_set.candidates.find(c => c.candidateId === cue.candidate_id),
      material: input.analysis.candidate_set.materials.find(m => m.candidateId === cue.candidate_id) },
  } satisfies Parameters<InstanceType<typeof CoachAgentStage3Controller>["synchronizeDiagnosis"]>[0];
  const context = { plan, cue, timeline: input.analysis.match_timeline, selectedPlayerId: "dog",
    material: input.analysis.candidate_set.materials.find(m => m.candidateId === cue.candidate_id) };
  try {
    expect(await controller.synchronizeDiagnosis(hostInput)).toBeDefined();
    const identity = buildStage3Identity(hostInput);
    const firstText = "原思路".repeat(160) + "没有看到敌人。";
    const secondText = "新补充".repeat(160) + "听到了脚步但不确定来源。";
    const reflection = { cueId: cue.id, rawText: firstText, selectedGoal: "OTHER" as const, source: "USER" as const, response: "ANSWERED" as const, limitations: [] };
    await runtime.dispatch(buildTeachingDiagnosisSubmissionEvent(context, reflection, { eventType: "SUBMIT_REFLECTION", eventId: "source-reflection", identity }));
    const revised = await runtime.dispatch(buildTeachingDiagnosisSubmissionEvent(context, { ...reflection, rawText: secondText }, { eventType: "SUBMIT_DISAGREEMENT", eventId: "source-disagreement", identity }));
    const savedCase = revised.state.cueCases[cue.id];
    expect(savedCase.status).toBe("DISAGREED");
    session = restoreCheckpointTeachingCase(plan, session, savedCase, revised.state.learningThreads[0]);
    const draft = buildCheckpointedRecoveryRecord({ ...input, plan, session, boundaryKind: "CUE_PAUSED", demoContentHash: HASH,
      selectedPlayerId: "dog", agentCheckpointId: revised.checkpoint.checkpointId }, {
      checkpointId: revised.checkpoint.checkpointId, activeCueId: revised.state.activeCueId,
      currentSessionPhase: revised.state.currentSessionPhase, routeCursor: revised.state.routeCursor, sessionStatus: revised.state.sessionStatus,
    });
    expect(draft).toBeDefined();
    const record = SessionRecoveryRecordSchema.parse(JSON.parse(JSON.stringify(draft)));
    const restored = restoreRecoveryArtifacts(record);
    expect(restored.session.cue_cases?.[cue.id]).toBeUndefined(); // Diagnosis lives in the Agent checkpoint.
    const producer = await import("../../../../libs/coach-agent/src/teaching-diagnosis");
    const diagnosisCalls = vi.spyOn(producer, "diagnoseTeachingCue");
    const revisionCalls = vi.spyOn(producer, "reviseTeachingDiagnosis");
    const runtimeB = createCoachAgentRuntime({ checkpointer: saver, policy });
    const dispatch = vi.fn((event: Parameters<typeof runtimeB.dispatch>[0]) => runtimeB.dispatch(event));
    const resumed = new CoachAgentStage3Controller({ dispatch, post, bridgeAvailable: () => true, isLive: () => true });
    try {
      const reconnect = buildReconnectReplayEvent(record);
      const agent = await resumed.reconnect(reconnect);
      expect(agent.restored).toBe("MATCHED");
      expect(agent.state.cueCases[cue.id]).toEqual(savedCase);
      const landed = restoreCheckpointTeachingCase(restored.plan, restored.session, agent.state.cueCases[cue.id], agent.state.learningThreads[0]);
      resumed.adoptRecoveredCue(cue.id, landed.current_segment_index);
      expect(landed.outcome_completion).toEqual(session.outcome_completion);
      expect(landed.default_route_cursor).toEqual(session.default_route_cursor);
      expect(landed.consumed_cue_ids).toEqual(session.consumed_cue_ids);
      expect(landed.cue_cases?.[cue.id]?.previousReflection?.rawText).toBe(firstText);
      expect(landed.cue_cases?.[cue.id]?.reflection?.rawText).toBe(secondText);
      const before = structuredClone(landed);
      const questions = buildCurrentCueQuestionContext({ plan: restored.plan, session: landed, generation: 2,
        cueCase: landed.cue_cases?.[cue.id], diagnosticsEnabled: true, busy: false, takenOver: false });
      expect(questions).toBeDefined();
      const answer = answerGroundedCueQuestion(questions!, CURRENT_CUE_ADVICE_QUESTION);
      expect(answer.items.some(item => item.text.includes(savedCase.transferRule!.do))).toBe(true);
      expect(landed).toEqual(before);
      expect(buildLocalAgentMemoryEvents(reconnect, agent, "test-principal")).toEqual([]);
      const duplicate = await resumed.reconnect(reconnect);
      expect(duplicate.state.cueCases[cue.id]).toEqual(savedCase);
      expect(duplicate.checkpoint.checkpointId).toBe(agent.checkpoint.checkpointId);
      expect(dispatch.mock.calls.map(([event]) => event.type)).toEqual(["RECONNECT_REPLAY", "RECONNECT_REPLAY"]);
      expect(diagnosisCalls).not.toHaveBeenCalled(); expect(revisionCalls).not.toHaveBeenCalled();
      expect(policy.calls).toHaveLength(0); expect(post).not.toHaveBeenCalled();
    } finally { resumed.dispose(); diagnosisCalls.mockRestore(); revisionCalls.mockRestore(); }
  } finally { controller.dispose(); }
});
