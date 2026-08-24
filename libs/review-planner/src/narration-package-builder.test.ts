import { describe, expect, it } from "vitest";
import type { CoachCue, CandidateSet, ObservableState, TeachingCandidate, WinProbabilityTimelineV1 } from "@cs-coach/contracts";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { assembleCandidateSet, deterministicDirectorFallback, compileReviewPlan } from "./teaching-pipeline";
import { assertPackageNamespaces, buildCoachingPackage, buildOutcomeImpactForCue, buildOutcomePackage } from "./narration-package-builder";

const timeline = createSyntheticMirageTimeline();
const manifest = {
  timelineVersion: timeline.timeline_version,
  sceneIndexVersion: "fixture-scene/1",
  observationVersion: "fixture-observation/1",
  signalVersion: "fixture-signal/1",
  candidateGeneratorVersion: "fixture-generator/1"
} as const;

function candidate(): TeachingCandidate {
  return {
    candidateId: "candidate-final",
    roundNumber: 1,
    source: { kind: "DEATH", refs: ["source-death"] },
    preRollStart: 800,
    decisionTick: 900,
    revealTick: 940,
    outcomeEnd: 1060,
    factRefs: ["decision-fact"],
    observableClaimRefs: ["claim-position"],
    actionRefs: ["action-fact"],
    outcomeRefs: ["outcome-fact"],
    evidenceRefs: ["evidence-final"],
    winRateSignalRefs: [],
    economySignalRefs: [],
    missingFields: [],
    limitations: [],
    deterministicScore: 5,
    resultSummary: { winProbabilityBefore: 0.7, winProbabilityAfter: 0.4, winProbabilityDelta: -0.3, winProbabilityPercentagePoints: -30, selectedPlayerDeath: true, economyClass: "FULL", concurrentEvents: false, missingFields: [], limitations: [] }
  };
}

function state(id = "observable-final"): ObservableState {
  return {
    id,
    demo_id: timeline.demo_id,
    timeline_version: timeline.timeline_version,
    observer_player_id: timeline.selected_player_id,
    at_tick: 850,
    observation_version: "fixture-observation/1",
    claims: [{
      id: "claim-position",
      claim_type: "PLAYER_POSITION",
      knowledge_kind: "OBSERVED",
      source_type: "DIRECT_VISION",
      subject_ref: "enemy-1",
      subject_resolution: "EXACT_PLAYER",
      available_from_tick: 840,
      evidence_tick: 840,
      spatial_estimate: { type: "EXACT_POINT", point: { x: 100, y: 100, z: 64 } },
      confidence: 0.95,
      sharing_scope: "SELF",
      evidence_refs: ["source-death"],
      derived_by: "fixture-observation",
      limitations: []
    }],
    limitations: []
  };
}

function setWithState(): { set: CandidateSet; observableState: ReturnType<typeof state> } {
  const item = candidate();
  const observableState = state();
  const set = assembleCandidateSet({
    id: "candidate-set-package",
    version: "fixture-candidate/1",
    demoId: timeline.demo_id,
    playerId: timeline.selected_player_id,
    candidates: [item],
    materials: [{
      candidateId: item.candidateId,
      decisionFacts: [{ id: "decision-fact", text: "决策时可见对手位置。", availability: "DECISION", available_at_tick: 850, source: "DEMO", observed_by_player: true }],
      playerActionFacts: [{ id: "action-fact", text: "你从掩体拉出。", actorPlayerId: timeline.selected_player_id, availableAtTick: 900, source: "DEMO", evidenceRefs: ["source-death"], limitations: [] }],
      outcomeFacts: [{ id: "outcome-fact", text: "结果窗口内你被击杀。", availableAtTick: 940, source: "DEMO", outcomeKind: "DEATH", evidenceRefs: ["source-death"], limitations: [] }],
      inferences: [],
      advice: [],
      evidence: [{ id: "evidence-final", source: "DEMO", label: "结构化证据", fact_refs: ["decision-fact"] }],
      observableStateId: observableState.id,
      limitations: []
    }],
    generationManifest: manifest
  });
  return { set, observableState };
}

function compiledCue(set: CandidateSet): CoachCue {
  return compileReviewPlan({
    timeline,
    candidateSet: set,
    directorDecisionSet: deterministicDirectorFallback(set),
    planId: "plan-package",
    observationVersion: manifest.observationVersion,
    signalVersion: manifest.signalVersion,
    plannerVersion: "fixture-planner/1"
  }).plan.cues[0];
}

function impactMaterial(candidate: TeachingCandidate): CandidateSet["materials"][number] {
  const candidateId = candidate.candidateId;
  const decisionId = candidate.factRefs[0];
  const actionId = candidate.actionRefs[0];
  const outcomeId = candidate.outcomeRefs[0];
  const evidenceId = candidate.evidenceRefs[0];
  return {
    candidateId,
    decisionFacts: [{ id: decisionId, text: "决策事实", availability: "DECISION", available_at_tick: 100, source: "DEMO", observed_by_player: true }],
    playerActionFacts: [{ id: actionId, text: "玩家动作", actorPlayerId: timeline.selected_player_id, availableAtTick: 100, source: "DEMO", evidenceRefs: [`source-${candidateId}`], limitations: [] }],
    outcomeFacts: [{ id: outcomeId, text: "结果事实", availableAtTick: 200, source: "DEMO", outcomeKind: "DEATH", evidenceRefs: [`source-${candidateId}`], limitations: [] }],
    inferences: [],
    advice: [],
    evidence: [{ id: evidenceId, source: "DEMO", label: "证据", fact_refs: [decisionId] }],
    limitations: []
  };
}

describe("CandidateSet-backed narration package builder", () => {
  it("resolves ObservableState only through final candidate material and claim refs", () => {
    const { set, observableState } = setWithState();
    const cue = compiledCue(set);
    const coaching = buildCoachingPackage(cue, set, [observableState]);
    expect(coaching.decisionContext.claims.map((claim) => claim.id)).toEqual(["claim-position"]);
    expect(coaching.allowedRefs.decision).toContain("claim-position");
    expect(coaching.candidateId).toBe(cue.candidate_id);
  });

  it("rejects a wrong state, missing cue state binding, and cross-namespace IDs", () => {
    const { set, observableState } = setWithState();
    const cue = compiledCue(set);
    expect(() => buildCoachingPackage(cue, set, [{ ...observableState, id: "observable-wrong" }])).toThrow(/missing ObservableState/);
    expect(() => buildCoachingPackage({ ...cue, observable_state_id: "observable-wrong" }, set, [observableState])).toThrow(/wrong ObservableState/);
    expect(() => buildCoachingPackage({ ...cue, advice: [{ ...cue.advice[0], id: "decision-fact" }] }, set, [observableState])).toThrow(/overlaps/);
  });

  it("keeps outcome package identity bound to the final cue candidate", () => {
    const { set, observableState } = setWithState();
    const cue = compiledCue(set);
    const coaching = buildCoachingPackage(cue, set, [observableState]);
    const outcome = buildOutcomePackage(cue, set, { cueId: cue.id, beforeProbability: 0.7, afterProbability: 0.4, delta: -0.3, percentagePoints: -30, relativeChange: -0.42, attribution: "SELECTED_PLAYER_DEATH", confidence: "HIGH", text: "我方胜率下降。", limitations: [] });
    expect(() => assertPackageNamespaces(coaching, outcome)).not.toThrow();
    expect(outcome.candidateId).toBe("candidate-final");
    expect(() => buildOutcomePackage({ ...cue, candidate_id: "candidate-other" }, set, undefined)).toThrow(/unknown candidate/);
  });

  it("rebuilds OutcomeImpact from final candidate identity after Director subset/order changes", () => {
    const first = candidate();
    const second: TeachingCandidate = {
      ...first,
      candidateId: "candidate-second",
      roundNumber: 2,
      source: { kind: "DEATH", refs: ["source-second"] },
      factRefs: ["decision-second"],
      actionRefs: ["action-second"],
      outcomeRefs: ["outcome-second"],
      evidenceRefs: ["evidence-second"],
      preRollStart: 1900,
      decisionTick: 2000,
      revealTick: 2040,
      outcomeEnd: 2160,
      resultSummary: { ...first.resultSummary, winProbabilityBefore: 0.61, winProbabilityAfter: 0.21, winProbabilityDelta: -0.4, winProbabilityPercentagePoints: -40 }
    };
    const set = assembleCandidateSet({
      id: "candidate-set-impact-order",
      version: "fixture-candidate/1",
      demoId: timeline.demo_id,
      playerId: timeline.selected_player_id,
      candidates: [first, second],
      materials: [impactMaterial(first), impactMaterial(second)],
      generationManifest: manifest
    });
    const plan = compileReviewPlan({ timeline, candidateSet: set, directorDecisionSet: deterministicDirectorFallback(set), planId: "impact-order-plan", observationVersion: manifest.observationVersion, signalVersion: manifest.signalVersion, plannerVersion: "fixture-planner/1" }).plan;
    const finalOrder = [...plan.cues].reverse();
    const winTimeline: WinProbabilityTimelineV1 = {
      version: "win-probability-timeline.v1",
      status: "AVAILABLE",
      model: { provider: "CS_NET", revision: "fixture", assetUrl: "fixture", assetSha256: "a".repeat(64), assetBytes: 1, quantization: "INT8", temperature: 1, sourceCommit: "fixture", featureVersion: "fixture" },
      tickRate: 64,
      rounds: [],
      swings: [],
      limitations: []
    };
    const impacts = finalOrder.map((cue) => buildOutcomeImpactForCue(cue, set, winTimeline, timeline, timeline.selected_player_id));
    expect(impacts.find((impact) => impact?.cueId === finalOrder[0].id)?.beforeProbability).toBe(0.61);
    expect(impacts.find((impact) => impact?.cueId === finalOrder[0].id)?.afterProbability).toBe(0.21);
    expect(impacts.find((impact) => impact?.cueId === finalOrder[1].id)?.beforeProbability).toBe(0.7);
    expect(impacts.find((impact) => impact?.cueId === finalOrder[1].id)?.afterProbability).toBe(0.4);
  });

  it("omits cue-level win-rate prose when the rounded change is zero", () => {
    const flat = {
      ...candidate(),
      resultSummary: {
        ...candidate().resultSummary,
        winProbabilityBefore: 0.944,
        winProbabilityAfter: 0.9444,
        winProbabilityDelta: 0.0004,
        winProbabilityPercentagePoints: 0
      }
    } satisfies TeachingCandidate;
    const set = assembleCandidateSet({
      id: "candidate-set-flat-impact",
      version: "fixture-candidate/1",
      demoId: timeline.demo_id,
      playerId: timeline.selected_player_id,
      candidates: [flat],
      materials: [impactMaterial(flat)],
      generationManifest: manifest
    });
    const cue = compiledCue(set);
    const winTimeline: WinProbabilityTimelineV1 = {
      version: "win-probability-timeline.v1",
      status: "AVAILABLE",
      model: { provider: "CS_NET", revision: "fixture", assetUrl: "fixture", assetSha256: "a".repeat(64), assetBytes: 1, quantization: "INT8", temperature: 1, sourceCommit: "fixture", featureVersion: "fixture" },
      tickRate: 64,
      rounds: [],
      swings: [],
      limitations: []
    };

    expect(buildOutcomeImpactForCue(cue, set, winTimeline, timeline, timeline.selected_player_id)).toBeUndefined();
  });

  it("does not build a positive win-rate impact for a successful kill cue", () => {
    const kill = {
      ...candidate(),
      candidateId: "candidate-successful-kill",
      source: { kind: "KILL" as const, refs: ["source-kill"] },
      resultSummary: {
        ...candidate().resultSummary,
        selectedPlayerDeath: false,
        winProbabilityBefore: 0.4,
        winProbabilityAfter: 0.7,
        winProbabilityDelta: 0.3,
        winProbabilityPercentagePoints: 30
      }
    } satisfies TeachingCandidate;
    const set = assembleCandidateSet({
      id: "candidate-set-successful-kill",
      version: "fixture-candidate/1",
      demoId: timeline.demo_id,
      playerId: timeline.selected_player_id,
      candidates: [kill],
      materials: [impactMaterial(kill)],
      generationManifest: manifest
    });
    const cue = { ...compiledCue(setWithState().set), candidate_id: kill.candidateId, observable_state_id: undefined };
    const winTimeline: WinProbabilityTimelineV1 = {
      version: "win-probability-timeline.v1",
      status: "AVAILABLE",
      model: { provider: "CS_NET", revision: "fixture", assetUrl: "fixture", assetSha256: "a".repeat(64), assetBytes: 1, quantization: "INT8", temperature: 1, sourceCommit: "fixture", featureVersion: "fixture" },
      tickRate: 64,
      rounds: [],
      swings: [],
      limitations: []
    };

    expect(buildOutcomeImpactForCue(cue, set, winTimeline, timeline, timeline.selected_player_id)).toBeUndefined();
    const positiveImpact = {
      cueId: cue.id,
      beforeProbability: 0.4,
      afterProbability: 0.7,
      delta: 0.3,
      percentagePoints: 30,
      relativeChange: 0.75,
      attribution: "MODEL_SWING" as const,
      confidence: "HIGH" as const,
      text: "我方胜率上升。",
      limitations: []
    };
    const outcome = buildOutcomePackage(cue, set, positiveImpact);
    expect(outcome.winProbabilityImpact).toBeUndefined();
    expect(outcome.measurementRefs).toEqual([]);
  });

  it("does not fabricate a win-rate impact when the model timeline is unavailable", () => {
    const { set } = setWithState();
    const cue = compiledCue(set);
    const unavailable: WinProbabilityTimelineV1 = {
      version: "win-probability-timeline.v1",
      status: "UNAVAILABLE",
      model: { provider: "CS_NET", revision: "fixture", assetUrl: "fixture", assetSha256: "a".repeat(64), assetBytes: 1, quantization: "INT8", temperature: 1, sourceCommit: "fixture", featureVersion: "fixture" },
      tickRate: 64,
      rounds: [],
      swings: [],
      limitations: ["模型不可用"]
    };
    expect(buildOutcomeImpactForCue(cue, set, unavailable, timeline, timeline.selected_player_id)).toBeUndefined();
  });
});
