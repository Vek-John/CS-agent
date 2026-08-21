import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import type { CandidateSet, WinProbabilityTimelineV1 } from "@cs-coach/contracts";
import {
  acceptNarrationUpdate,
  buildInitialCoachingRouteState,
  createCs2dReviewPreparationDependencies,
  createReviewPreparationOrchestrator,
  routeSnapshot
} from "./cs2d-route-integration";

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

function integrationAnalysis() {
  const matchTimeline = createSyntheticMirageTimeline();
  const candidateData = [
    { id: "candidate-r2", roundNumber: 2, preRollStart: 2200, decisionTick: 2350, revealTick: 2460, outcomeEnd: 2700 },
    { id: "candidate-r3", roundNumber: 3, preRollStart: 3800, decisionTick: 3910, revealTick: 4020, outcomeEnd: 4250 }
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
  const candidateSet: CandidateSet = {
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
              primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
              selectionReason: "第二个候选更值得先检查。",
              reasonRefs: ["fact-candidate-r3"],
              evidenceRefs: ["evidence-candidate-r3"],
              confidence: 0.8
            },
            {
              candidateId: "candidate-r2",
              priority: 2,
              primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
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
        const decisionRef = context.coachingPackage.allowedRefs.decision[0] ?? "decision-ref";
        const actionRef = context.coachingPackage.allowedRefs.action[0] ?? "action-ref";
        const adviceRef = context.coachingPackage.allowedRefs.advice[0] ?? "advice-ref";
        const outcomeRef = context.outcomePackage.outcomeFacts[0]?.id ?? context.outcomePackage.measurementRefs[0] ?? "outcome-ref";
        return {
          status: "FALLBACK" as const,
          bundle: {
            cueId: context.coachingPackage.cueId,
            candidateId: context.coachingPackage.candidateId,
            primaryFocusCode: context.coachingPackage.primaryFocusCode,
            currentSituation: { text: "当前可确认的情况。", refs: [decisionRef] },
            playerAction: { text: "你在这个窗口继续接触。", refs: [actionRef] },
            coreIssue: { text: "核心问题是补枪关系没有保持。", refs: [decisionRef, actionRef] },
            betterPlay: { text: "先停一下，再根据新信息决定。", refs: [adviceRef] },
            outcomeImpact: { text: "结果窗口已经完整播放。", refs: [outcomeRef] }
          },
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
