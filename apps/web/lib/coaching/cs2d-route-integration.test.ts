import { describe, expect, it, vi } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan, assembleCandidateSet, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { decisionSnapshotFixture } from "../../../../libs/review-planner/src/teaching-gate-fixtures";
import type { CandidateSet, WinProbabilityTimelineV1 } from "@cs-coach/contracts";
import {
  acceptNarrationUpdate,
  buildInitialCoachingRouteState,
  createCs2dReviewPreparationDependencies,
  createReviewPreparationOrchestrator,
  settlePreparedCoachingStart,
  activatePreparedCoachingSession,
  routeSnapshot
} from "./cs2d-route-integration";

describe("prepared start settlement", () => {
  function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
  it.each(["saved-refresh", "failed-mark", "failed-refresh"])("starts the real Session while %s bookkeeping is pending", async stage => {
    const { createCoachingSession } = await import("@cs-coach/session");
    const plan = compiledPlan(); const route = buildInitialCoachingRouteState(plan);
    const gate = deferred<void>(); const mount = vi.fn(); const persist = vi.fn(async () => undefined);
    const saved = vi.fn(); const unconfirmed = vi.fn();
    const markFailed = vi.fn(() => stage === "failed-mark" ? gate.promise : Promise.resolve());
    const refreshHistory = vi.fn(() => gate.promise);
    const activate = vi.fn(() => activatePreparedCoachingSession({ plan,
      initialSession: createCoachingSession(plan, "prepared-start-test", route), isCurrent: () => true,
      latestRouteState: () => route, persistStart: persist, acceptPersistedStart: vi.fn(), mountSession: mount,
    }));
    const result = await settlePreparedCoachingStart({ durability: stage === "saved-refresh" ? Promise.resolve() : Promise.reject(new Error("save unknown")),
      isCurrent: () => true, saved, unconfirmed, activate, markFailed, refreshHistory });
    expect(result).toBe(true); expect(mount).toHaveBeenCalledOnce(); expect(persist).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledTimes(stage === "saved-refresh" ? 1 : 0);
    expect(unconfirmed).toHaveBeenCalledTimes(stage === "saved-refresh" ? 0 : 1);
    expect(markFailed).toHaveBeenCalledTimes(stage === "saved-refresh" ? 0 : 1);
    gate.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(mount).toHaveBeenCalledOnce();
  });

  it("waits for durability and discards a superseded start before feedback or activation", async () => {
    const gate = deferred<void>(); let current = true;
    const activate = vi.fn(async () => true); const saved = vi.fn(); const unconfirmed = vi.fn(); const refreshHistory = vi.fn();
    const pending = settlePreparedCoachingStart({ durability: gate.promise, isCurrent: () => current, saved, unconfirmed, activate, refreshHistory });
    await Promise.resolve(); expect(activate).not.toHaveBeenCalled();
    current = false; gate.resolve(); expect(await pending).toBe(false);
    expect(saved).not.toHaveBeenCalled(); expect(unconfirmed).not.toHaveBeenCalled(); expect(refreshHistory).not.toHaveBeenCalled();
  });

  it("does not start a follow-up refresh after a late failure marker belongs to an old generation", async () => {
    const gate = deferred<void>(); let current = true; const refreshHistory = vi.fn();
    await settlePreparedCoachingStart({ durability: Promise.reject(new Error("save unknown")), isCurrent: () => current,
      saved: vi.fn(), unconfirmed: vi.fn(), activate: async () => true, markFailed: () => gate.promise, refreshHistory });
    current = false; gate.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(refreshHistory).not.toHaveBeenCalled();
  });

  it("observes bookkeeping errors without misclassifying activation failures as failed saves", async () => {
    const markFailed = vi.fn(); const unconfirmed = vi.fn(); const activationError = new Error("local activation failed");
    await expect(settlePreparedCoachingStart({ durability: Promise.resolve(), isCurrent: () => true,
      saved: vi.fn(), unconfirmed, markFailed, refreshHistory: async () => { throw new Error("list failed"); },
      activate: async () => { throw activationError; },
    })).rejects.toBe(activationError);
    expect(markFailed).not.toHaveBeenCalled(); expect(unconfirmed).not.toHaveBeenCalled();
    const refresh = vi.fn(async () => { throw new Error("list failed"); });
    expect(await settlePreparedCoachingStart({ durability: Promise.reject(new Error("save unknown")), isCurrent: () => true,
      saved: vi.fn(), unconfirmed, markFailed: async () => { throw new Error("status failed"); },
      refreshHistory: refresh, activate: async () => true,
    })).toBe(true);
    await Promise.resolve(); expect(refresh).toHaveBeenCalledWith(false);
  });
});

function compiledPlan() {
  const base = createFixtureReviewPlan(createSyntheticMirageTimeline());
  return {
    ...base,
    candidate_set_id: "candidate-set-fixture",
    candidate_set_version: "fixture/1",
    candidate_set_hash: "candidate-hash",
    compiler_provenance: {
      version: "compiler/1",
      route_fingerprint: "route-fingerprint",
      status: "SUCCEEDED" as const
    },
    cues: base.cues.map((cue, index) => ({
      ...cue,
      candidate_id: `candidate-${index + 1}`,
      primary_focus_code: "SURVIVE_CONTACT"
    }))
  };
}

function narration(cueId: string, candidateId: string) {
  return {
    cueId,
    candidateId,
    primaryFocusCode: "SURVIVE_CONTACT",
    currentSituation: { text: "当前情况", refs: ["decision-ref"] },
    playerAction: { text: "玩家动作", refs: ["action-ref"] },
    coreIssue: { text: "核心问题", refs: ["decision-ref", "action-ref"] },
    betterPlay: { text: "更好的处理", refs: ["advice-ref"] },
    outcomeImpact: { text: "结果影响", refs: ["outcome-ref"] }
  } as const;
}

function planWithThirdCue() {
  const base = compiledPlan();
  const source = base.cues[1];
  const third = {
    ...source,
    id: "cue-third",
    candidate_id: "candidate-3"
  };
  return {
    ...base,
    id: "review-plan-fixture-three-cues",
    cues: [...base.cues, third],
    segments: base.segments.map((segment) =>
      segment.id === source.segment_id
        ? { ...segment, cue_ids: [...segment.cue_ids, third.id] }
        : segment
    )
  };
}

function integrationAnalysis(withThird = false) {
  const matchTimeline = createSyntheticMirageTimeline();
  const candidateData = [
    { id: "candidate-r2", roundNumber: 2, preRollStart: 2200, decisionTick: 2350, revealTick: 2460, outcomeEnd: 2700 },
    { id: "candidate-r3", roundNumber: 3, preRollStart: 3800, decisionTick: 3910, revealTick: 4020, outcomeEnd: 4250 },
    ...(withThird ? [{ id: "candidate-r4", roundNumber: 4, preRollStart: 5200, decisionTick: 5350, revealTick: 5460, outcomeEnd: 5700 }] : [])
  ] as const;
  const candidates = candidateData.map((item) => ({
    candidateId: item.id,
    roundNumber: item.roundNumber,
    source: { kind: "DEATH" as const, refs: [`fact-${item.id}`] },
    preRollStart: item.preRollStart,
    decisionTick: item.decisionTick,
    revealTick: item.revealTick,
    outcomeEnd: item.outcomeEnd,
    factRefs: [`fact-${item.id}`],
    observableClaimRefs: [],
    actionRefs: [`action-${item.id}`],
    outcomeRefs: [`outcome-${item.id}`],
    evidenceRefs: [`evidence-${item.id}`],
    winRateSignalRefs: [],
    economySignalRefs: [],
    missingFields: [],
    limitations: [],
    deterministicScore: item.roundNumber === 2 ? 4 : 7,
    resultSummary: {
      selectedPlayerDeath: true,
      economyClass: "FULL" as const,
      concurrentEvents: false,
      missingFields: [],
      limitations: []
    }
  }));
  const materials = candidateData.map((item) => ({
    candidateId: item.id,
    decisionSnapshot: decisionSnapshotFixture(item.decisionTick, `fact-${item.id}`),
    contextCode: item.id,
    decisionFacts: [{
      id: `fact-${item.id}`,
      text: "决策前可确认的局面事实。",
      availability: "DECISION" as const,
      available_at_tick: item.decisionTick - 20,
      source: "DEMO" as const,
      observed_by_player: true
    }],
    playerActionFacts: [{
      id: `action-${item.id}`,
      text: "玩家在队友尚未接上的窗口继续接触。",
      actorPlayerId: "p-user",
      availableAtTick: item.decisionTick,
      source: "DEMO" as const,
      evidenceRefs: [`fact-${item.id}`],
      limitations: []
    }],
    outcomeFacts: [{
      id: `outcome-${item.id}`,
      text: "结果窗口确认玩家先阵亡。",
      availableAtTick: item.revealTick,
      source: "DEMO" as const,
      outcomeKind: "DEATH" as const,
      evidenceRefs: [`fact-${item.id}`],
      limitations: []
    }],
    inferences: [],
    advice: [{
      id: `advice-${item.id}`,
      text: "先停在队友能补枪的位置，再决定是否继续拿空间。",
      trigger: "队友尚未接上时",
      fact_refs: [`fact-${item.id}`]
    }],
    evidence: [{
      id: `evidence-${item.id}`,
      source: "RULE" as const,
      label: "补枪距离规则",
      fact_refs: [`fact-${item.id}`]
    }],
    limitations: []
  }));
  const rawCandidateSet: CandidateSet = {
    id: "candidate-set-integration",
    version: "candidate/fixture",
    hash: "candidate-hash-integration",
    demoId: matchTimeline.demo_id,
    playerId: matchTimeline.selected_player_id,
    status: "COMPLETE",
    generationManifest: {
      timelineVersion: matchTimeline.timeline_version,
      sceneIndexVersion: "scene/fixture",
      observationVersion: "observation/fixture",
      signalVersion: "signal/fixture",
      candidateGeneratorVersion: "candidate/fixture"
    },
    candidates,
    materials,
    limitations: []
  };
  const candidateSet = assembleCandidateSet(rawCandidateSet);
  const winProbabilityTimeline: WinProbabilityTimelineV1 = {
    version: "win-probability-timeline.v1",
    status: "AVAILABLE",
    model: {
      provider: "CS_NET",
      revision: "fixture",
      assetUrl: "/models/fixture.onnx",
      assetSha256: "a".repeat(64),
      assetBytes: 1,
      quantization: "INT8",
      temperature: 1.0613423585891724,
      sourceCommit: "fixture",
      featureVersion: "fixture"
    },
    tickRate: matchTimeline.tick_rate,
    rounds: [
      {
        roundNumber: 2,
        startTick: 1600,
        endTick: 3200,
        winner: "CT",
        economy: { ct: "FULL", t: "FORCE", ctValue: 20000, tValue: 12000 },
        samples: [
          { tick: 2350, probability: 0.4, roundNumber: 2, side: "T", source: "CS_NET" },
          { tick: 2700, probability: 0.2, roundNumber: 2, side: "T", source: "CS_NET" }
        ]
      },
      {
        roundNumber: 3,
        startTick: 3200,
        endTick: 4800,
        winner: "CT",
        economy: { ct: "FULL", t: "FULL", ctValue: 20000, tValue: 20000 },
        samples: [
          { tick: 3910, probability: 0.35, roundNumber: 3, side: "T", source: "CS_NET" },
          { tick: 4250, probability: 0.15, roundNumber: 3, side: "T", source: "CS_NET" }
        ]
      }
    ],
    swings: [
      { id: "swing-r2", tick: 2460, before: 0.4, after: 0.2, delta: -0.2, direction: "DOWN", cause: "PLAYER_DEATH", selectedPlayerDeath: true, victimSide: "T", economy: "FORCE" },
      { id: "swing-r3", tick: 4020, before: 0.35, after: 0.15, delta: -0.2, direction: "DOWN", cause: "PLAYER_DEATH", selectedPlayerDeath: true, victimSide: "T", economy: "FULL" }
    ],
    limitations: []
  };
  return {
    candidateSet,
    observationEvidence: [],
    matchTimeline,
    winProbabilityTimeline,
    selectedPlayerId: matchTimeline.selected_player_id
  };
}

describe("Host frozen route integration", () => {
  it("requires the first two cues to be READY/FALLBACK before startable", () => {
    const plan = compiledPlan();
    const first = plan.cues[0];
    const second = plan.cues[1];
    const pending = buildInitialCoachingRouteState(plan, {
      readiness: { [first.id]: "READY", [second.id]: "PENDING" },
      narrationByCue: { [first.id]: narration(first.id, first.candidate_id!) }
    });
    expect(pending.routeFrozen).toBe(true);
    expect(pending.startable).toBe(false);

    const ready = acceptNarrationUpdate(pending, {
      cueId: second.id,
      candidateId: second.candidate_id!,
      primaryFocusCode: second.primary_focus_code!,
      routeFingerprint: pending.routeFingerprint,
      readiness: "FALLBACK",
      narration: narration(second.id, second.candidate_id!)
    });
    expect(ready.accepted).toBe(true);
    expect(ready.state.startable).toBe(true);
  });

  it("does not let a readiness override without its matching bundle make the route startable", () => {
    const plan = compiledPlan();
    const first = plan.cues[0];
    const second = plan.cues[1];
    const state = buildInitialCoachingRouteState(plan, {
      readiness: { [first.id]: "READY", [second.id]: "FALLBACK" }
    });
    expect(state.readiness[first.id]).toBe("PENDING");
    expect(state.readiness[second.id]).toBe("PENDING");
    expect(state.startable).toBe(false);

    const withIdentityMismatch = buildInitialCoachingRouteState(plan, {
      readiness: { [first.id]: "READY" },
      narrationByCue: { [first.id]: narration(first.id, "wrong-candidate") }
    });
    expect(withIdentityMismatch.readiness[first.id]).toBe("PENDING");
    expect(withIdentityMismatch.startable).toBe(false);
  });

  it("merges narration readiness without changing route, ticks, order, or focus bindings", () => {
    const plan = compiledPlan();
    const state = buildInitialCoachingRouteState(plan, { readiness: Object.fromEntries(plan.cues.map((cue) => [cue.id, "PENDING" as const])) });
    const before = routeSnapshot(plan);
    const cue = plan.cues[0];
    const merged = acceptNarrationUpdate(state, {
      cueId: cue.id,
      candidateId: cue.candidate_id!,
      primaryFocusCode: cue.primary_focus_code!,
      routeFingerprint: state.routeFingerprint,
      readiness: "READY",
      narration: narration(cue.id, cue.candidate_id!)
    });
    expect(merged.accepted).toBe(true);
    expect(routeSnapshot(plan)).toEqual(before);
    expect(merged.state.cueOrder).toEqual(before.cueOrder);
    expect(merged.state.cueBindings).toEqual(before.cueBindings);
  });

  it("rejects a background update with a changed route fingerprint or binding", () => {
    const plan = compiledPlan();
    const state = buildInitialCoachingRouteState(plan);
    const cue = plan.cues[0];
    const result = acceptNarrationUpdate(state, {
      cueId: cue.id,
      candidateId: "changed-candidate",
      primaryFocusCode: cue.primary_focus_code!,
      routeFingerprint: "changed-route",
      readiness: "READY",
      narration: narration(cue.id, "changed-candidate")
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("ROUTE_FINGERPRINT_CHANGED");
  });

  it("runs route preparation before narration and keeps unexpected provider errors traceable", async () => {
    const plan = planWithThirdCue();
    const events: string[] = [];
    const prepared = new Map<string, ReturnType<typeof narration>>();
    const controller = createReviewPreparationOrchestrator(
      "generation-1",
      plan,
      {},
      {
        prepareRoute: async ({ inputPlan }) => {
          events.push("route");
          return inputPlan;
        },
        prepareNarration: async ({ cueId }) => {
          events.push(`narration:${cueId}`);
          throw new Error("DEEPSEEK_TIMEOUT: provider did not answer");
        },
        fallbackNarration: async ({ cueId, candidateId, primaryFocusCode }) => {
          const bundle = narration(cueId, candidateId);
          prepared.set(cueId, bundle);
          return {
            readiness: "FALLBACK" as const,
            narration: bundle,
            manifest: {
              status: "FALLBACK" as const,
              provider: "DETERMINISTIC" as const,
              reason: "DEEPSEEK_TIMEOUT",
              limitations: ["provider unavailable"]
            }
          };
        }
      }
    );

    await controller.run((event) => {
      if (event.type === "ROUTE_FROZEN") events.push("frozen");
      if (event.type === "NARRATION_UPDATE") events.push(`updated:${event.cueId}`);
      if (event.type === "READY_TO_START") events.push("ready");
    });

    expect(events[0]).toBe("route");
    expect(events).toContain("frozen");
    expect(events).toContain("ready");
    expect(prepared.size).toBe(plan.cues.length);
    expect(events.indexOf("ready")).toBeLessThan(events.indexOf(`narration:${plan.cues[2].id}`));
  });

  it("rejects narration whose manifest status or identity does not match the frozen cue", async () => {
    const plan = compiledPlan();
    const rejected: string[] = [];
    const controller = createReviewPreparationOrchestrator(
      "generation-2",
      plan,
      {},
      {
        prepareRoute: async ({ inputPlan }) => inputPlan,
        prepareNarration: async ({ cueId, candidateId, primaryFocusCode }) => ({
          readiness: "READY" as const,
          narration: narration(cueId, candidateId),
          manifest: {
            status: "FALLBACK" as const,
            provider: "DETERMINISTIC" as const,
            limitations: [],
            reason: `wrong status for ${primaryFocusCode}`
          }
        })
      }
    );
    await controller.run((event) => {
      if (event.type === "NARRATION_REJECTED") rejected.push(event.reason);
    });
    expect(rejected.length).toBe(plan.cues.length);
    expect(rejected.every((reason) => reason === "NARRATION_MANIFEST_STATUS_MISMATCH")).toBe(true);
  });

  it("does not inherit ROUTE_FROZEN from an adapter plan when Director/Compiler preparation fails", async () => {
    const plan = compiledPlan();
    let failureState: { routeFrozen: boolean; startable: boolean } | undefined;
    const controller = createReviewPreparationOrchestrator(
      "generation-3",
      plan,
      {},
      {
        prepareRoute: async () => {
          throw new Error("DIRECTOR_UNAVAILABLE");
        },
        prepareNarration: async () => {
          throw new Error("must not run before route");
        }
      }
    );
    await controller.run((event) => {
      if (event.type === "NARRATION_REJECTED") failureState = event.routeState;
    });
    expect(failureState).toMatchObject({ routeFrozen: false, startable: false });
  });

  it("runs the real Director → Compiler → package → Narrator seam on final cues only", async () => {
    const analysis = integrationAnalysis();
    const provisional = createFixtureReviewPlan(analysis.matchTimeline);
    const directorCalls: string[] = [];
    const narratorCalls: string[] = [];
    const dependencies = createCs2dReviewPreparationDependencies(analysis, {
      director: async (set) => {
        directorCalls.push(set.id);
        // Deliberately return reverse priority order; PlanCompiler restores
        // canonical route order while retaining the Director subset.
        return {
          candidateSetId: set.id,
          candidateSetVersion: set.version,
          candidateSetHash: set.hash,
          selected: [
            {
              candidateId: "candidate-r3",
              priority: 1,
              primaryFocusCode: "REVIEW_UNCERTAINTY",
              selectionReason: "第二个候选更值得先检查。",
              reasonRefs: ["fact-candidate-r3"],
              evidenceRefs: ["evidence-candidate-r3"],
              confidence: 0.8
            },
            {
              candidateId: "candidate-r2",
              priority: 2,
              primaryFocusCode: "REVIEW_UNCERTAINTY",
              selectionReason: "第一个候选保留为对照。",
              reasonRefs: ["fact-candidate-r2"],
              evidenceRefs: ["evidence-candidate-r2"],
              confidence: 0.8
            }
          ],
          manifest: {
            status: "SUCCEEDED",
            provider: "DEEPSEEK",
            promptVersion: "director/test-v2",
            limitations: []
          }
        };
      },
      narrator: async (context) => {
        narratorCalls.push(context.coachingPackage.cueId);
        return {
          status: "FALLBACK" as const,
          bundle: deterministicNarrationBundle(context.coachingPackage, context.outcomePackage),
          manifest: {
            status: "FALLBACK" as const,
            provider: "DETERMINISTIC" as const,
            reason: "MISSING_API_KEY",
            limitations: ["MISSING_API_KEY"]
          }
        };
      }
    });
    const events: string[] = [];
    let frozenPlanPrompt: string | undefined;
    const controller = createReviewPreparationOrchestrator("real-seam", provisional, {}, dependencies);
    await controller.run((event) => {
      events.push(event.type);
      if (event.type === "ROUTE_FROZEN") frozenPlanPrompt = event.plan.generation_manifest.prompt_version;
    });

    expect(directorCalls).toEqual([analysis.candidateSet.id]);
    expect(narratorCalls).toEqual(["c1", "c2"]);
    expect(frozenPlanPrompt).toBe("director/test-v2");
    expect(events).toContain("ROUTE_FROZEN");
    expect(events).toContain("READY_TO_START");
    expect(events.filter((event) => event === "NARRATION_UPDATE")).toHaveLength(2);
  });

  it("does not call Director or Narrator for an empty complete CandidateSet", async () => {
    const analysis = integrationAnalysis();
    const emptyAnalysis = {
      ...analysis,
      candidateSet: {
        ...analysis.candidateSet,
        hash: "empty-candidate-hash",
        candidates: [],
        materials: []
      }
    };
    let directorCalls = 0;
    let narratorCalls = 0;
    const dependencies = createCs2dReviewPreparationDependencies(emptyAnalysis, {
      director: async () => {
        directorCalls += 1;
        throw new Error("empty CandidateSet must not reach Director");
      },
      narrator: async () => {
        narratorCalls += 1;
        throw new Error("empty CandidateSet must not reach Narrator");
      }
    });
    const events: string[] = [];
    await createReviewPreparationOrchestrator(
      "empty-candidate-set",
      createFixtureReviewPlan(analysis.matchTimeline),
      {},
      dependencies
    ).run((event) => events.push(event.type));
    expect(directorCalls).toBe(0);
    expect(narratorCalls).toBe(0);
    expect(events).toContain("READY_TO_START");
  });

  it("keeps a failed CandidateSet out of both providers and compilation", async () => {
    const analysis = integrationAnalysis();
    const failedAnalysis = {
      ...analysis,
      candidateSet: {
        ...analysis.candidateSet,
        status: "FAILED" as const,
        failureReason: "INDEX_FAILED",
        candidates: [],
        materials: []
      }
    };
    let directorCalls = 0;
    let narratorCalls = 0;
    const dependencies = createCs2dReviewPreparationDependencies(failedAnalysis, {
      director: async () => {
        directorCalls += 1;
        throw new Error("failed CandidateSet must not reach Director");
      },
      narrator: async () => {
        narratorCalls += 1;
        throw new Error("failed CandidateSet must not reach Narrator");
      }
    });
    const events: string[] = [];
    await createReviewPreparationOrchestrator(
      "failed-candidate-set",
      createFixtureReviewPlan(analysis.matchTimeline),
      {},
      dependencies
    ).run((event) => events.push(event.type));
    expect(directorCalls).toBe(0);
    expect(narratorCalls).toBe(0);
    expect(events).toContain("NARRATION_REJECTED");
    expect(events).not.toContain("ROUTE_FROZEN");
  });

  it("silently stops a superseded generation before route freeze", async () => {
    const plan = compiledPlan();
    let resolveRoute!: (value: typeof plan) => void;
    const events: string[] = [];
    const controller = createReviewPreparationOrchestrator(
      "generation-cancel-route",
      plan,
      {},
      {
        prepareRoute: async () => new Promise((resolve) => { resolveRoute = resolve; }),
        prepareNarration: async () => { throw new Error("must not run"); }
      }
    );
    const run = controller.run((event) => events.push(event.type));
    controller.cancel();
    resolveRoute(plan);
    await run;
    expect(events).toEqual([]);
  });

  it("stops later narration when the Host rejects the recoverable start", async () => {
    const plan = planWithThirdCue();
    const prepared: string[] = [];
    const events: string[] = [];
    const controller = createReviewPreparationOrchestrator("invalid-recovery-start", plan, {}, {
      prepareRoute: async ({ inputPlan }) => inputPlan,
      prepareNarration: async ({ cueId, candidateId }) => {
        prepared.push(cueId);
        return { readiness: "READY", narration: narration(cueId, candidateId),
          manifest: { status: "SUCCEEDED", provider: "DETERMINISTIC", limitations: [] } };
      },
    });
    await controller.run(event => {
      events.push(event.type);
      // The Host cancels this generation if building its recovery record fails.
      if (event.type === "READY_TO_START") controller.cancel();
    });
    expect(events.at(-1)).toBe("READY_TO_START");
    expect(prepared).toEqual(plan.cues.slice(0, 2).map(cue => cue.id));
  });

  it("does not publish narration or READY_TO_START after cancellation during the first window", async () => {
    const plan = compiledPlan();
    const resolvers: Array<(value: {
      readiness: "READY";
      narration: ReturnType<typeof narration>;
      manifest: { status: "SUCCEEDED"; provider: "DETERMINISTIC"; limitations: readonly string[] };
    }) => void> = [];
    const events: string[] = [];
    const controller = createReviewPreparationOrchestrator(
      "generation-cancel-narration",
      plan,
      {},
      {
        prepareRoute: async ({ inputPlan }) => inputPlan,
        prepareNarration: async () => new Promise((resolve) => { resolvers.push(resolve); })
      }
    );
    const run = controller.run((event) => events.push(event.type));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContain("ROUTE_FROZEN");
    expect(resolvers.length).toBe(Math.min(2, plan.cues.length));
    controller.cancel();
    for (const [index, resolve] of resolvers.entries()) {
      const cue = plan.cues[index];
      resolve({
        readiness: "READY",
        narration: narration(cue.id, cue.candidate_id!),
        manifest: { status: "SUCCEEDED", provider: "DETERMINISTIC", limitations: [] }
      });
    }
    await run;
    expect(events).not.toContain("NARRATION_UPDATE");
    expect(events).not.toContain("READY_TO_START");
    expect(events).not.toContain("CANCELLED");
  });
});

it("retains a third cue's narration that completes while Session activation is awaiting durability", async () => {
  const { createCoachingSession } = await import("@cs-coach/session");
  const { activatePreparedCoachingSession } = await import("./cs2d-route-integration");
  const plan = planWithThirdCue();
  const third = plan.cues[2];
  const initialRoute = buildInitialCoachingRouteState(plan, { readiness: { [plan.cues[0].id]: "READY", [plan.cues[1].id]: "READY", [third.id]: "PENDING" } });
  let route = initialRoute;
  let mounted: ReturnType<typeof createCoachingSession> | undefined;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const activation = activatePreparedCoachingSession({
    plan, initialSession: createCoachingSession(plan, "delayed-start", initialRoute),
    isCurrent: () => true, latestRouteState: () => route,
    persistStart: () => pending, acceptPersistedStart() {}, mountSession: (session) => { mounted = session; },
  });
  // This is exactly the Host's NARRATION_UPDATE-before-mount window: only
  // routeStateRef exists yet, so there is no Session reducer target to update.
  route = { ...route, readiness: { ...route.readiness, [third.id]: "FALLBACK" } };
  expect(mounted).toBeUndefined();
  release();
  await activation;
  expect(mounted?.narration_readiness?.[third.id]).toBe("FALLBACK");
  expect(mounted?.route_fingerprint).toBe(initialRoute.routeFingerprint);
});

it("does not accept recovery results or mount a Session after its generation is superseded", async () => {
  const { createCoachingSession } = await import("@cs-coach/session");
  const { activatePreparedCoachingSession } = await import("./cs2d-route-integration");
  const plan = planWithThirdCue();
  const route = buildInitialCoachingRouteState(plan);
  let current = true;
  let accepted = false;
  let mounted = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const activation = activatePreparedCoachingSession({
    plan, initialSession: createCoachingSession(plan, "old-session", route), isCurrent: () => current,
    latestRouteState: () => route, persistStart: () => pending,
    acceptPersistedStart: () => { accepted = true; }, mountSession: () => { mounted = true; },
  });
  current = false;
  release();
  expect(await activation).toBe(false);
  expect(accepted).toBe(false);
  expect(mounted).toBe(false);
});

it("does not merge readiness from a different frozen route during activation", async () => {
  const { createCoachingSession } = await import("@cs-coach/session");
  const { activatePreparedCoachingSession } = await import("./cs2d-route-integration");
  const plan = planWithThirdCue();
  const route = buildInitialCoachingRouteState(plan);
  let accepted = false;
  let mounted = false;
  expect(await activatePreparedCoachingSession({
    plan, initialSession: createCoachingSession(plan, "route-bound-session", route), isCurrent: () => true,
    latestRouteState: () => ({ ...route, routeFingerprint: "another-route" }), persistStart: async () => undefined,
    acceptPersistedStart: () => { accepted = true; }, mountSession: () => { mounted = true; },
  })).toBe(false);
  expect(accepted).toBe(false);
  expect(mounted).toBe(false);
});


describe("real preparation clients with bounded transport", () => {
  it("freezes the full route and starts after Director/first-window timeouts, then prepares later cues", async () => {
    vi.useFakeTimers();
    try {
      const { requestTeachingDirector } = await import("./deepseek-director");
      const { requestNarrationBundle } = await import("./narrator-contract");
      const analysis = integrationAnalysis(true);
      const provisional = createFixtureReviewPlan(analysis.matchTimeline);
      const late: Array<() => void> = [];
      const lateDirectorJson = vi.fn(async () => { throw Error("late headers must not read body"); });
      const directorFetch = vi.fn(() => new Promise<Response>(resolve => {
        late.push(() => resolve(Object.assign(new Response(), { json: lateDirectorJson })));
      }));
      const narratorFetch = vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
        late.push(() => reject(Error("late narrator body")));
      }) } as Response));
      const dependencies = createCs2dReviewPreparationDependencies(analysis, {
        assessDecisions: async candidateSet => ({ candidateSet, run: { version: "decision-assessment-run.v1", mode: "RULE_BASELINE", calls: 0, accepted: 0, records: [] } }),
        director: (set, options) => requestTeachingDirector(set, { ...options, fetcher: directorFetch }),
        narrator: (context, options) => { delete context.request.approvedNarration; return requestNarrationBundle(context, { ...options, fetcher: narratorFetch }); },
      });
      const events: import("./cs2d-route-integration").ReviewPreparationEvent[] = [];
      const controller = createReviewPreparationOrchestrator("bounded-clients", provisional, {}, dependencies);
      const run = controller.run(event => events.push(event));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(directorFetch).toHaveBeenCalledTimes(1);
      expect(narratorFetch).toHaveBeenCalledTimes(2);
      const frozen = events.find(event => event.type === "ROUTE_FROZEN")!;
      expect(frozen.plan.cues).toHaveLength(3);
      const shape = routeSnapshot(frozen.plan);
      await vi.advanceTimersByTimeAsync(20_000);
      const ready = events.find(event => event.type === "READY_TO_START")!;
      expect(ready.routeState.startable).toBe(true);
      expect(routeSnapshot(ready.plan)).toEqual(shape);
      expect(ready.plan.segments[0].start_tick).toBe(provisional.segments[0].start_tick);
      expect(ready.plan.segments.at(-1)?.end_tick).toBe(provisional.segments.at(-1)?.end_tick);
      expect(narratorFetch).toHaveBeenCalledTimes(3);
      expect(events.filter(event => event.type === "NARRATION_UPDATE")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(20_000); await run;
      const updates = events.filter(event => event.type === "NARRATION_UPDATE");
      expect(updates).toHaveLength(3);
      for (const event of updates) {
        const cue = ready.plan.cues.find(item => item.id === event.cueId)!;
        expect(event.result.manifest).toMatchObject({ status: "FALLBACK", reason: "LOCAL_REQUEST_TIMEOUT" });
        expect(event.result.narration).toMatchObject({ cueId: cue.id, candidateId: cue.candidate_id, primaryFocusCode: cue.primary_focus_code });
      }
      const beforeLate = JSON.stringify(events);
      late.forEach(release => release()); await vi.advanceTimersByTimeAsync(0);
      expect(JSON.stringify(events)).toBe(beforeLate);
      expect(lateDirectorJson).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(["director", "narrator"] as const)("cancel during %s exits without publishing readiness or invoking recovery fallback", async stage => {
    vi.useFakeTimers();
    try {
      const { requestTeachingDirector } = await import("./deepseek-director");
      const { requestNarrationBundle } = await import("./narrator-contract");
      const analysis = integrationAnalysis();
      const lateRejects: Array<(reason: Error) => void> = [];
      const fetcher = vi.fn(() => new Promise<Response>((_resolve, reject) => lateRejects.push(reject)));
      const dependencies = createCs2dReviewPreparationDependencies(analysis, {
        assessDecisions: async candidateSet => ({ candidateSet, run: { version: "decision-assessment-run.v1", mode: "RULE_BASELINE", calls: 0, accepted: 0, records: [] } }),
        director: (set, options) => requestTeachingDirector(set, { ...options, fetcher }),
        narrator: (context, options) => { delete context.request.approvedNarration; return requestNarrationBundle(context, { ...options, fetcher }); },
      });
      const fallbackNarration = vi.fn();
      const events: string[] = [];
      const controller = createReviewPreparationOrchestrator("cancel-old-demo-player", createFixtureReviewPlan(analysis.matchTimeline), {}, { ...dependencies, fallbackNarration });
      const run = controller.run(event => events.push(event.type));
      await vi.advanceTimersByTimeAsync(stage === "director" ? 0 : 20_000);
      expect(fetcher).toHaveBeenCalledTimes(stage === "director" ? 1 : 3);
      controller.cancel(); await run;
      const beforeLate = [...events];
      lateRejects.forEach(reject => reject(Error("superseded result"))); await vi.advanceTimersByTimeAsync(20_000);
      expect(events).toEqual(beforeLate);
      expect(events).not.toContain("READY_TO_START");
      expect(events).not.toContain("NARRATION_UPDATE");
      expect(fallbackNarration).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

it("prepares the first window and later closed cues without network or timer waits, then reuses saved narration", async () => {
  vi.useFakeTimers();
  const { requestNarrationBundle } = await import("./narrator-contract");
  const { deterministicDirectorFallback } = await import("@cs-coach/review-planner");
  const analysis = integrationAnalysis(true);
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  const expected = new Map<string, ReturnType<typeof deterministicNarrationBundle>>();
  const dependencies = createCs2dReviewPreparationDependencies(analysis, {
    assessDecisions: async candidateSet => ({ candidateSet, run: { version: "decision-assessment-run.v1", mode: "RULE_BASELINE", calls: 0, accepted: 0, records: [] } }),
    director: async set => deterministicDirectorFallback(set),
    narrator: (context, options) => {
      expected.set(context.coachingPackage.cueId, deterministicNarrationBundle(context.coachingPackage, context.outcomePackage));
      return requestNarrationBundle(context, { ...options, fetcher });
    },
  });
  const events: import("./cs2d-route-integration").ReviewPreparationEvent[] = [];
  const controller = createReviewPreparationOrchestrator("local-closed", createFixtureReviewPlan(analysis.matchTimeline), {}, dependencies);
  const run = controller.run(event => events.push(event));
  try {
    await vi.advanceTimersByTimeAsync(0);
    await run;
    const readyIndex = events.findIndex(event => event.type === "READY_TO_START");
    expect(readyIndex).toBeGreaterThan(0);
    expect(events.slice(0, readyIndex).filter(event => event.type === "NARRATION_UPDATE")).toHaveLength(2);
    const ready = events[readyIndex];
    if (ready.type !== "READY_TO_START") throw Error("Expected startup readiness");
    expect(ready.routeState.startable).toBe(true);
    const updates = events.filter(event => event.type === "NARRATION_UPDATE");
    expect(updates).toHaveLength(3);
    for (const update of updates) {
      expect(update.result.narration).toEqual(expected.get(update.cueId));
      expect(update.result).toMatchObject({ readiness: "FALLBACK", manifest: { status: "DISABLED", provider: "DETERMINISTIC", reason: "CLOSED_SEMANTIC_PROJECTION" } });
    }
    expect(events.some(event => event.type === "NARRATION_REJECTED")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const saved = JSON.parse(JSON.stringify({ readiness: Object.fromEntries(updates.map(update => [update.cueId, update.result.readiness])), narrationByCue: Object.fromEntries(updates.map(update => [update.cueId, update.result.narration])) }));
    // Previously saved, identity-bound prose is restored as-is, never rewritten by the fast path.
    saved.narrationByCue[updates[0].cueId].coreIssue.text = "已保存的旧讲解正文。";
    const unchanged = JSON.stringify(saved);
    const prepareNarration = vi.fn();
    const restored: import("./cs2d-route-integration").ReviewPreparationEvent[] = [];
    await createReviewPreparationOrchestrator("restored-closed", ready.plan, saved, { prepareRoute: async ({ inputPlan }) => inputPlan, prepareNarration }).run(event => restored.push(event));
    expect(prepareNarration).not.toHaveBeenCalled();
    expect(restored.some(event => event.type === "READY_TO_START")).toBe(true);
    expect(JSON.stringify(saved)).toBe(unchanged);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { controller.cancel(); await run; vi.useRealTimers(); }
});

it("does not publish a local completion after its preparation generation is cancelled", async () => {
  const { requestNarrationBundle } = await import("./narrator-contract");
  const { deterministicDirectorFallback } = await import("@cs-coach/review-planner");
  const analysis = integrationAnalysis();
  const fetcher = vi.fn();
  let controller: ReturnType<typeof createReviewPreparationOrchestrator>;
  const dependencies = createCs2dReviewPreparationDependencies(analysis, {
    assessDecisions: async candidateSet => ({ candidateSet, run: { version: "decision-assessment-run.v1", mode: "RULE_BASELINE", calls: 0, accepted: 0, records: [] } }),
    director: async set => deterministicDirectorFallback(set),
    narrator: (context, options) => {
      const result = requestNarrationBundle(context, { ...options, fetcher });
      controller.cancel();
      return result;
    },
  });
  controller = createReviewPreparationOrchestrator("cancel-local-closed", createFixtureReviewPlan(analysis.matchTimeline), {}, dependencies);
  const events: string[] = [];
  await controller.run(event => events.push(event.type));
  expect(events).not.toContain("NARRATION_UPDATE");
  expect(events).not.toContain("READY_TO_START");
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps a domain-valid projection beyond provider wire limits ready through fallback", async () => {
  const { requestNarrationBundle } = await import("./narrator-contract");
  const { deterministicDirectorFallback } = await import("@cs-coach/review-planner");
  const analysis = integrationAnalysis();
  const fetcher = vi.fn();
  const dependencies = createCs2dReviewPreparationDependencies(analysis, {
    assessDecisions: async candidateSet => ({ candidateSet, run: { version: "decision-assessment-run.v1", mode: "RULE_BASELINE", calls: 0, accepted: 0, records: [] } }),
    director: async set => deterministicDirectorFallback(set),
    narrator: (context, options) => {
      context.coachingPackage.decisionContext.facts[0].text = "可核对的已记录事实。".repeat(200);
      return requestNarrationBundle(context, { ...options, fetcher });
    },
  });
  const events: import("./cs2d-route-integration").ReviewPreparationEvent[] = [];
  await createReviewPreparationOrchestrator("long-closed", createFixtureReviewPlan(analysis.matchTimeline), {}, dependencies).run(event => events.push(event));
  expect(events.some(event => event.type === "READY_TO_START" && event.routeState.startable)).toBe(true);
  expect(events.some(event => event.type === "NARRATION_REJECTED")).toBe(false);
  for (const event of events.filter(event => event.type === "NARRATION_UPDATE")) expect(event.result.manifest.reason).toBe("LOCAL_WIRE_VALIDATION_FAILED");
  expect(fetcher).not.toHaveBeenCalled();
});
