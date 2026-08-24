import { describe, expect, it } from "vitest";
import type {
  CandidateGeneratorInput,
  CanonicalAnalysisFact,
  CanonicalSignal,
  WinProbabilityTimelineV1
} from "@cs-coach/contracts";
import { MAX_DIRECTOR_PACKET_CANDIDATES } from "@cs-coach/contracts";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import {
  assertValidNarrationBundle,
  buildDirectorRequest,
  compileReviewPlan,
  collectDirectorDecisionIssues,
  deterministicDirectorFallback,
  deterministicNarrationBundle
} from "./teaching-pipeline";
import { buildCoachingPackage, buildOutcomePackage } from "./narration-package-builder";
import { generateCandidateSet } from "./candidate-generator";

const manifest = {
  timelineVersion: "fixture-timeline/1.0.0",
  sceneIndexVersion: "fixture-scenes/1.0.0",
  observationVersion: "fixture-observation/1.0.0",
  signalVersion: "fixture-signals/1.0.0",
  candidateGeneratorVersion: "review-planner/candidate-generator/1.0.0"
} as const;

function baseFacts(roundNumber = 2, tick = 2350): CanonicalAnalysisFact[] {
  return [
    { id: `state-${roundNumber}`, kind: "DECISION_CONTEXT", roundNumber, tick: tick - 20, text: "决策时有可用位置和装备事实。", sourceRefs: ["state-source"], observedByPlayer: true, missingFields: [], limitations: [] },
    { id: `action-${roundNumber}`, kind: "PLAYER_ACTION", roundNumber, tick, text: "你在窗口内继续处理当前接触。", sourceRefs: ["action-source"], observedByPlayer: true, missingFields: [], limitations: [] },
    { id: `outcome-${roundNumber}`, kind: "OUTCOME", roundNumber, tick: tick + 80, text: "结果窗口内发生了可验证事件。", sourceRefs: ["outcome-source"], observedByPlayer: true, missingFields: [], limitations: [], outcomeKind: "DEATH" }
  ];
}

function signal(kind: CanonicalSignal["kind"], roundNumber = 2, tick = 2350): CanonicalSignal {
  return {
    signalId: `${kind.toLowerCase()}-signal`,
    kind,
    roundNumber,
    sourceTick: tick + 80,
    decisionTick: tick,
    revealTick: tick + 80,
    sourceRefs: [`${kind.toLowerCase()}-source`],
    factRefs: [`state-${roundNumber}`],
    actionRefs: [`action-${roundNumber}`],
    outcomeRefs: [`outcome-${roundNumber}`],
    observableClaimRefs: [],
    evidenceRefs: [`${kind.toLowerCase()}-evidence`],
    playerSide: "T",
    playerContext: { playerSide: "T", activeItemClass: "WEAPON", armor: 100, helmet: true, economyClass: "FULL" },
    selectedPlayerDeath: kind === "DEATH",
    missingFields: [],
    limitations: []
  };
}

function winTimeline(swing: { id: string; tick: number; before: number; after: number }): WinProbabilityTimelineV1 {
  return {
    version: "win-probability-timeline.v1",
    status: "AVAILABLE",
    model: { provider: "CS_NET", revision: "fixture", assetUrl: "fixture", assetSha256: "a".repeat(64), assetBytes: 1, quantization: "INT8", temperature: 1, sourceCommit: "fixture", featureVersion: "fixture" },
    tickRate: 64,
    rounds: [{ roundNumber: 2, startTick: 1600, endTick: 3200, winner: "CT", economy: { ct: "FULL", t: "ECO", ctValue: 20_000, tValue: 1_500 }, samples: [{ tick: swing.tick - 20, probability: swing.before, roundNumber: 2, side: "CT", source: "CS_NET" }, { tick: swing.tick, probability: swing.after, roundNumber: 2, side: "CT", source: "CS_NET" }] }],
    swings: [{ id: swing.id, tick: swing.tick, before: swing.before, after: swing.after, delta: swing.after - swing.before, direction: swing.after < swing.before ? "DOWN" : "UP", cause: "PLAYER_DEATH", selectedPlayerDeath: false, victimSide: "CT", economy: "FULL" }],
    limitations: []
  };
}

function input(signals: readonly CanonicalSignal[], timeline = winTimeline({ id: "swing-1", tick: 2430, before: 0.3, after: 0.7 })): CandidateGeneratorInput {
  return { demoId: "demo-fixture-mirage-v1", playerId: "p-user", timeline: createSyntheticMirageTimeline(), facts: baseFacts(), signals, winProbabilityTimeline: timeline, generationManifest: manifest };
}

function unavailableTimeline(): WinProbabilityTimelineV1 {
  return {
    ...winTimeline({ id: "unavailable", tick: 2430, before: 0.3, after: 0.7 }),
    status: "UNAVAILABLE",
    rounds: [],
    swings: [],
    unavailableReason: "fixture model unavailable"
  };
}

describe("parser-neutral CandidateGenerator", () => {
  it("nominates from canonical facts/signals rather than prebuilt TeachingCandidate objects", () => {
    const set = generateCandidateSet(input([signal("DEATH")]));
    expect(set.candidates[0].candidateId).toContain("candidate-r2-death");
    expect(set.materials[0].advice).toEqual([]);
    expect(set.materials[0].decisionFacts[0].id).toBe("state-2");
  });

  it("maps T-side CT probability to selected-player probability before scoring", () => {
    const set = generateCandidateSet(input([signal("DEATH")], winTimeline({ id: "t-drop", tick: 2430, before: 0.3, after: 0.7 })));
    expect(set.candidates[0].resultSummary).toMatchObject({ winProbabilityBefore: 0.7, winProbabilityAfter: 0.3, winProbabilityDelta: -0.4, winProbabilityPercentagePoints: -40 });
  });

  it("creates an independent selected-side WIN_RATE_DROP candidate", () => {
    const facts = baseFacts();
    const noEventInput = input([], winTimeline({ id: "independent-drop", tick: 2430, before: 0.3, after: 0.7 }));
    const set = generateCandidateSet({ ...noEventInput, facts, signals: [] });
    expect(set.candidates.some((candidate) => candidate.source.kind === "WIN_RATE_DROP")).toBe(true);
  });

  it("merges a death and a coincident swing into one stable candidate", () => {
    const set = generateCandidateSet(input([signal("DEATH")], winTimeline({ id: "death-swing", tick: 2430, before: 0.3, after: 0.7 })));
    expect(set.candidates.filter((candidate) => candidate.roundNumber === 2)).toHaveLength(1);
    expect(set.candidates[0].source.kind).toBe("DEATH");
    expect(set.candidates[0].winRateSignalRefs).toHaveLength(1);
  });

  it("prefers death over an overlapping HP_CHANGE signal", () => {
    const set = generateCandidateSet(input([signal("HP_CHANGE"), signal("DEATH")]));
    const decision = deterministicDirectorFallback(set);
    expect(decision.selected[0].candidateId).toContain("death");
  });

  it("does not turn a successful kill with a rising selected-side win rate into a coaching stop", () => {
    const successfulKill = { ...signal("KILL"), playerSide: "CT" as const, selectedPlayerDeath: false };
    const set = generateCandidateSet(input(
      [successfulKill],
      winTimeline({ id: "successful-kill", tick: 2430, before: 0.3, after: 0.7 })
    ));

    expect(set.candidates.some((candidate) => candidate.source.kind === "KILL")).toBe(true);
    expect(set.candidates.find((candidate) => candidate.source.kind === "KILL")?.resultSummary.winProbabilityDelta).toBeUndefined();
    expect(buildDirectorRequest(set).candidates).toHaveLength(0);
    expect(deterministicDirectorFallback(set).selected).toHaveLength(0);
  });

  it("keeps a no-model KILL as a fact candidate but creates no provider job or coaching route", () => {
    const set = generateCandidateSet(input([{ ...signal("KILL"), playerSide: "CT" as const }], unavailableTimeline()));
    expect(set.candidates.some((candidate) => candidate.source.kind === "KILL")).toBe(true);
    expect(buildDirectorRequest(set).candidates).toHaveLength(0);
    const director = deterministicDirectorFallback(set, "NO_MODEL");
    expect(director.manifest.status).toBe("DISABLED");
    expect(director.selected).toHaveLength(0);
    const compiled = compileReviewPlan({
      timeline: createSyntheticMirageTimeline(),
      candidateSet: set,
      directorDecisionSet: director,
      planId: "no-model-kill-plan",
      observationVersion: manifest.observationVersion,
      signalVersion: manifest.signalVersion,
      plannerVersion: "fixture-planner/1"
    });
    expect(compiled.plan.cues).toHaveLength(0);
  });

  it("rejects a positive KILL even if a Director tries to select it", () => {
    const successfulKill = { ...signal("KILL"), playerSide: "CT" as const, selectedPlayerDeath: false };
    const set = generateCandidateSet(input(
      [successfulKill],
      winTimeline({ id: "successful-kill-director", tick: 2430, before: 0.3, after: 0.7 })
    ));
    const candidate = set.candidates[0];
    const issues = collectDirectorDecisionIssues(set, {
      candidateSetId: set.id,
      candidateSetVersion: set.version,
      candidateSetHash: set.hash,
      selected: [{
        candidateId: candidate.candidateId,
        priority: 1,
        primaryFocusCode: "CONVERT_ADVANTAGE",
        selectionReason: "尝试选择成功对枪。",
        reasonRefs: candidate.factRefs.slice(0, 1),
        evidenceRefs: candidate.evidenceRefs.slice(0, 1),
        confidence: 0.8
      }],
      manifest: { status: "SUCCEEDED", provider: "DEEPSEEK", limitations: [] }
    });
    expect(issues.some((issue) => issue.includes("practical negative outcome"))).toBe(true);
    const compiled = compileReviewPlan({
      timeline: createSyntheticMirageTimeline(),
      candidateSet: set,
      directorDecisionSet: {
        candidateSetId: set.id,
        candidateSetVersion: set.version,
        candidateSetHash: set.hash,
        selected: [{
          candidateId: candidate.candidateId,
          priority: 1,
          primaryFocusCode: "CONVERT_ADVANTAGE",
          selectionReason: "尝试选择成功对枪。",
          reasonRefs: candidate.factRefs.slice(0, 1),
          evidenceRefs: candidate.evidenceRefs.slice(0, 1),
          confidence: 0.8
        }],
        manifest: { status: "SUCCEEDED", provider: "DEEPSEEK", limitations: [] }
      },
      planId: "positive-kill-plan",
      observationVersion: manifest.observationVersion,
      signalVersion: manifest.signalVersion,
      plannerVersion: "fixture-planner/1"
    });
    expect(compiled.directorDecisionSet.manifest.status).toBe("DISABLED");
    expect(compiled.plan.cues).toHaveLength(0);
  });

  it("sends economy and result summaries into the compact Director packet", () => {
    const set = generateCandidateSet(input([signal("DEATH")]));
    const request = buildDirectorRequest(set);
    expect(request.candidates[0].resultSummary).toMatchObject({ economyClass: "ECO", selectedPlayerDeath: true });
    expect(request.candidates[0].allowedFocusCodes).toContain("SURVIVE_THE_NEXT_CONTACT");
  });

  it("keeps a 100-candidate CandidateSet but budgets the provider packet to 32", () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ ...signal(index % 2 === 0 ? "DEATH" : "HP_CHANGE", 2, 1900 + index * 10), signalId: `many-${index}` }));
    const set = generateCandidateSet({ ...input(many), signals: many });
    const request = buildDirectorRequest(set);
    expect(set.candidates.length).toBeGreaterThan(32);
    expect(request.candidates.length).toBeLessThanOrEqual(MAX_DIRECTOR_PACKET_CANDIDATES);
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThan(48 * 1024);
  });
});

describe("compiled cues have a deterministic narration fallback", () => {
  it("builds and validates a five-field fallback for every selected cue", () => {
    const set = generateCandidateSet(input([signal("DEATH"), signal("BOMB", 3, 3850)]));
    const timeline = createSyntheticMirageTimeline();
    const director = deterministicDirectorFallback(set);
    const compiled = compileReviewPlan({ timeline, candidateSet: set, directorDecisionSet: director, planId: "plan-generator-test", observationVersion: manifest.observationVersion, signalVersion: manifest.signalVersion, plannerVersion: "fixture-planner/1.0.0" });
    for (const cue of compiled.plan.cues) {
      const coaching = buildCoachingPackage(cue, set, []);
      const outcome = buildOutcomePackage(cue, set, { cueId: cue.id, beforeProbability: 0.6, afterProbability: 0.4, delta: -0.2, percentagePoints: -20, relativeChange: -1 / 3, attribution: "MODEL_SWING", confidence: "MEDIUM", text: "模型结果窗口影响", limitations: [] });
      const bundle = deterministicNarrationBundle(coaching, outcome);
      expect(() => assertValidNarrationBundle(bundle, coaching, outcome)).not.toThrow();
    }
  });
});
