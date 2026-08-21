import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import type {
  CandidateMaterial,
  CandidateSet,
  CoachingPackage,
  DirectorDecisionSet,
  OutcomePackage,
  TeachingCandidate
} from "@cs-coach/contracts";
import {
  assertValidNarrationBundle,
  buildCoachingRouteState,
  collectDirectorDecisionIssues,
  collectNarrationBundleIssues,
  compileReviewPlan,
  deterministicDirectorFallback,
  deterministicNarrationBundle,
  assembleCandidateSet,
  mergeNarration
} from "./teaching-pipeline";

const manifest = {
  timelineVersion: "fixture-timeline/1.0.0",
  sceneIndexVersion: "fixture-scenes/1.0.0",
  observationVersion: "fixture-observation/1.0.0",
  signalVersion: "fixture-signals/1.0.0",
  candidateGeneratorVersion: "fixture-candidates/1.0.0"
} as const;

function candidate(candidateId: string, decisionTick: number, roundNumber = 1, score = 5): TeachingCandidate {
  return {
    candidateId,
    roundNumber,
    source: { kind: "DEATH", refs: [`source-${candidateId}`] },
    preRollStart: decisionTick - 64,
    decisionTick,
    revealTick: decisionTick + 20,
    outcomeEnd: decisionTick + 120,
    factRefs: [`fact-${candidateId}`],
    observableClaimRefs: [],
    actionRefs: [`action-${candidateId}`],
    outcomeRefs: [`outcome-${candidateId}`],
    evidenceRefs: [`evidence-${candidateId}`],
    winRateSignalRefs: [],
    economySignalRefs: [],
    missingFields: [],
    limitations: [],
    deterministicScore: score,
    resultSummary: {
      selectedPlayerDeath: false,
      economyClass: "FULL",
      concurrentEvents: false,
      missingFields: [],
      limitations: []
    }
  };
}

function material(candidateId: string): CandidateMaterial {
  return {
    candidateId,
    decisionFacts: [{
      id: `fact-${candidateId}`,
      text: "决策时有可用的事实。",
      availability: "DECISION",
      available_at_tick: 100,
      source: "DEMO",
      observed_by_player: true
    }],
    playerActionFacts: [{
      id: `action-${candidateId}`,
      text: "你继续处理当前接触。",
      actorPlayerId: "p-user",
      availableAtTick: 100,
      source: "DEMO",
      evidenceRefs: [`source-${candidateId}`],
      limitations: []
    }],
    outcomeFacts: [{
      id: `outcome-${candidateId}`,
      text: "结果事实在窗口完成后可见。",
      availableAtTick: 220,
      source: "DEMO",
      outcomeKind: "DEATH",
      evidenceRefs: [`source-${candidateId}`],
      limitations: []
    }],
    inferences: [],
    advice: [],
    evidence: [{ id: `evidence-${candidateId}`, source: "DEMO", label: "Demo", fact_refs: [`fact-${candidateId}`] }],
    economy: "FULL",
    limitations: []
  };
}

function setOf(...items: TeachingCandidate[]): CandidateSet {
  return assembleCandidateSet({
    id: "candidate-set-fixture",
    version: "fixture-signals/1.0.0",
    demoId: "demo-fixture-mirage-v1",
    playerId: "p-user",
    candidates: items,
    materials: items.map((item) => material(item.candidateId)),
    generationManifest: manifest
  });
}

function compile(set: CandidateSet) {
  const timeline = createSyntheticMirageTimeline();
  return compileReviewPlan({
    timeline,
    candidateSet: set,
    directorDecisionSet: deterministicDirectorFallback(set),
    planId: "plan-pipeline-fixture",
    observationVersion: manifest.observationVersion,
    signalVersion: manifest.signalVersion,
    plannerVersion: "fixture-planner/1.0.0",
    parserVersion: "fixture-parser/1.0.0"
  });
}

describe("CandidateGenerator → Director → PlanCompiler seam", () => {
  it("sorts and fingerprints the same CandidateSet deterministically", () => {
    const first = setOf(candidate("b", 300), candidate("a", 300));
    const second = setOf(candidate("a", 300), candidate("b", 300));
    expect(first.candidates.map((item) => item.candidateId)).toEqual(["a", "b"]);
    expect(first.hash).toBe(second.hash);
    expect(deterministicDirectorFallback(first)).toEqual(deterministicDirectorFallback(second));
  });

  it("keeps UNKNOWN/missing-field candidates selectable instead of treating them as low value", () => {
    const item = { ...candidate("unknown", 900, 1, 0), missingFields: ["economy", "action_precision"] };
    const set = setOf(item);
    const decision = deterministicDirectorFallback(set);
    expect(decision.selected).toHaveLength(1);
    expect(decision.selected[0].candidateId).toBe("unknown");
  });

  it("rejects unknown refs and duplicate candidates in Director output", () => {
    const set = setOf(candidate("a", 900));
    const valid = deterministicDirectorFallback(set);
    const bad: DirectorDecisionSet = {
      ...valid,
      selected: [{
        ...valid.selected[0],
        candidateId: "missing",
        reasonRefs: ["not-a-ref"]
      }, { ...valid.selected[0] }]
    };
    expect(collectDirectorDecisionIssues(set, bad).join(" ")).toMatch(/unknown candidate|more than once/);
  });

  it("rejects a provider-selected incomplete candidate and falls back without blocking route coverage", () => {
    const complete = candidate("complete", 900, 1);
    const incomplete: TeachingCandidate = {
      ...candidate("incomplete", 1200, 1),
      factRefs: [],
      actionRefs: [],
      outcomeRefs: [],
      winRateSignalRefs: []
    };
    const set = setOf(complete, incomplete);
    const providerSelection: DirectorDecisionSet = {
      candidateSetId: set.id,
      candidateSetVersion: set.version,
      candidateSetHash: set.hash,
      selected: [{
        candidateId: incomplete.candidateId,
        priority: 1,
        primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
        selectionReason: "模型选择该候选",
        reasonRefs: ["source-incomplete"],
        evidenceRefs: ["evidence-incomplete"],
        confidence: 0.8
      }],
      manifest: { status: "SUCCEEDED", provider: "DEEPSEEK", limitations: [] }
    };
    expect(collectDirectorDecisionIssues(set, providerSelection).join(" ")).toMatch(/no decision fact|no verified player action|no outcome/);
    const compiled = compileReviewPlan({
      timeline: createSyntheticMirageTimeline(),
      candidateSet: set,
      directorDecisionSet: providerSelection,
      planId: "incomplete-provider-plan",
      observationVersion: manifest.observationVersion,
      signalVersion: manifest.signalVersion,
      plannerVersion: "fixture-planner/1"
    });
    expect(compiled.directorDecisionSet.manifest.status).toBe("FALLBACK");
    expect(compiled.plan.status).toBe("COMPLETE");
    expect(compiled.plan.cues.every((cue) => cue.candidate_id !== "incomplete")).toBe(true);
  });

  it("refuses FAILED index artifacts instead of compiling them to skip segments", () => {
    const failed = assembleCandidateSet({
      id: "failed-index",
      version: "fixture-signals/1.0.0",
      demoId: "demo-fixture-mirage-v1",
      playerId: "p-user",
      candidates: [],
      materials: [],
      status: "FAILED",
      failureReason: "fixture parser failed",
      generationManifest: manifest
    });
    expect(failed.status).toBe("FAILED");
    expect(() => compile(failed)).toThrow(/failed CandidateSet/);
  });

  it("marks route completeness separately from narration readiness and keeps ordinary gaps BRIEF", () => {
    const result = compile(setOf(candidate("a", 900, 1), candidate("b", 2200, 2)));
    expect(result.plan.status).toBe("COMPLETE");
    expect(result.plan.segments.some((segment) => segment.mode === "BRIEF")).toBe(true);
    expect(result.plan.compiler_provenance?.route_fingerprint).toBeTruthy();
    const state = buildCoachingRouteState(result.plan, "COMPLETE");
    expect(state.routeFrozen).toBe(true);
    expect(state.startable).toBe(false);
    expect(state.cueOrder).toEqual(result.plan.cues.map((cue) => cue.id));
  });

  it("rejects a background update that changes a frozen cue binding", () => {
    const result = compile(setOf(candidate("a", 900, 1)));
    const state = buildCoachingRouteState(result.plan, "COMPLETE", { c1: "PENDING" });
    const cue = result.plan.cues[0];
    const bundle = {
      cueId: cue.id,
      candidateId: "changed",
      primaryFocusCode: cue.primary_focus_code!,
      currentSituation: { text: "s", refs: ["fact-a"] },
      playerAction: { text: "a", refs: ["action-a"] },
      coreIssue: { text: "i", refs: ["fact-a", "action-a"] },
      betterPlay: { text: "b", refs: ["a1"] },
      outcomeImpact: { text: "o", refs: ["outcome-a"] }
    };
    const merged = mergeNarration(state, {
      cueId: cue.id,
      candidateId: "changed",
      primaryFocusCode: cue.primary_focus_code!,
      routeFingerprint: state.routeFingerprint,
      readiness: "READY",
      narration: bundle
    });
    expect(merged.accepted).toBe(false);
    expect(merged).toMatchObject({ reason: "FROZEN_PLAN_BINDING_CHANGED" });
  });

  it.each([
    ["consumed", ["c1"], []],
    ["frozen", [], ["c1"]]
  ] as const)("rejects a background update for an already %s cue", (_label, consumedCueIds, frozenCueIds) => {
    const result = compile(setOf(candidate("a", 900, 1)));
    const cue = result.plan.cues[0];
    const state = buildCoachingRouteState(
      result.plan,
      "COMPLETE",
      { [cue.id]: "PENDING" },
      consumedCueIds,
      frozenCueIds
    );
    const merged = mergeNarration(state, {
      cueId: cue.id,
      candidateId: cue.candidate_id!,
      primaryFocusCode: cue.primary_focus_code!,
      routeFingerprint: state.routeFingerprint,
      readiness: "READY",
      narration: {
        cueId: cue.id,
        candidateId: cue.candidate_id!,
        primaryFocusCode: cue.primary_focus_code!,
        currentSituation: { text: "s", refs: ["fact-a"] },
        playerAction: { text: "a", refs: ["action-a"] },
        coreIssue: { text: "i", refs: ["fact-a", "action-a"] },
        betterPlay: { text: "b", refs: ["advice-a"] },
        outcomeImpact: { text: "o", refs: ["outcome-a"] }
      }
    });
    expect(merged.accepted).toBe(false);
    expect(merged).toMatchObject({ reason: "CUE_ALREADY_CONSUMED_OR_FROZEN" });
  });
});

describe("NarrationBundle field boundaries", () => {
  function packages(): { coaching: CoachingPackage; outcome: OutcomePackage } {
    return {
      coaching: {
        cueId: "c1",
        candidateId: "candidate-a",
        decisionContext: { facts: [{ id: "df1", text: "决策事实", availability: "DECISION", available_at_tick: 1, source: "DEMO", observed_by_player: true }], claims: [] },
        playerAction: [{ id: "act1", text: "玩家动作", actorPlayerId: "p-user", availableAtTick: 1, source: "DEMO", evidenceRefs: ["ev1"], limitations: [] }],
        inferences: [],
        advice: [{ id: "adv1", text: "建议", trigger: "触发", fact_refs: ["df1"] }],
        evidence: [{ id: "ev1", source: "RULE", label: "规则", fact_refs: ["df1"] }],
        primaryFocusCode: "SURVIVE_CONTACT",
        allowedRefs: { decision: ["df1"], action: ["act1"], advice: ["adv1"], evidence: ["ev1"] },
        limitations: []
      },
      outcome: {
        cueId: "c1",
        candidateId: "candidate-a",
        outcomeFacts: [{ id: "of1", text: "结果", availableAtTick: 5, source: "DEMO", outcomeKind: "DEATH", evidenceRefs: ["ev1"], limitations: [] }],
        deathKillHpRefs: ["of1"],
        measurementRefs: [],
        confounders: [],
        limitations: []
      }
    };
  }

  it("accepts only a strict five-field bundle with separate namespaces", () => {
    const { coaching, outcome } = packages();
    const bundle = deterministicNarrationBundle(coaching, outcome);
    expect(() => assertValidNarrationBundle(bundle, coaching, outcome)).not.toThrow();
    expect(Object.keys(bundle).sort()).toEqual(["betterPlay", "candidateId", "coreIssue", "cueId", "currentSituation", "outcomeImpact", "playerAction", "primaryFocusCode"].sort());
  });

  it("rejects outcome refs in decision fields and rejects reference-free facts", () => {
    const { coaching, outcome } = packages();
    const bundle = deterministicNarrationBundle(coaching, outcome);
    const crossed = { ...bundle, currentSituation: { text: "future", refs: ["of1"] } };
    expect(collectNarrationBundleIssues(crossed, coaching, outcome).join(" ")).toMatch(/currentSituation|Outcome refs/);
    const missing = { ...bundle, playerAction: { text: "no ref", refs: [] } };
    expect(collectNarrationBundleIssues(missing, coaching, outcome).join(" ")).toContain("playerAction");
  });
});
