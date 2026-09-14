import { describe, expect, it } from "vitest";
import type { CandidateMaterial, DecisionCheck, DirectorDecisionSet, TeachingCandidate, ObservableDecisionContext, ObservationClaim } from "@cs-coach/contracts";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { assessCandidateTeaching, buildGatedAdviceOptions, evaluateAdviceApplicability, verifiedHabitKey } from "./teaching-gates";
import { assembleCandidateSet, buildDirectorRequest, collectNarrationBundleIssues, collectNarrationBundleReferenceIssues, compileReviewPlan, deterministicDirectorFallback, deterministicNarrationBundle } from "./teaching-pipeline";
import { buildCoachingPackage, buildOutcomePackage } from "./narration-package-builder";
import { decisionSnapshotFixture } from "./teaching-gate-fixtures";

function window(kind: TeachingCandidate["source"]["kind"] = "DEATH"): { candidate: TeachingCandidate; material: CandidateMaterial } {
  return {
    candidate: { candidateId: "candidate-a", roundNumber: 1, source: { kind, refs: ["source-a"] }, preRollStart: 836, decisionTick: 900, revealTick: 920, outcomeEnd: 1020, factRefs: ["fact-a"], observableClaimRefs: [], actionRefs: [], outcomeRefs: ["outcome-a"], evidenceRefs: ["evidence-a"], winRateSignalRefs: [], economySignalRefs: [], missingFields: [], limitations: [], deterministicScore: 5, resultSummary: { selectedPlayerDeath: kind === "DEATH", economyClass: "FULL", concurrentEvents: false, missingFields: [], limitations: [] } },
    material: { candidateId: "candidate-a", decisionFacts: [{ id: "fact-a", text: "当时你只剩 2 点生命值，且是己方唯一存活玩家。", availability: "DECISION", available_at_tick: 900, source: "DEMO", observed_by_player: true }], playerActionFacts: [], outcomeFacts: [{ id: "outcome-a", text: "你受到伤害。", availableAtTick: 920, source: "DEMO", outcomeKind: "HP_CHANGE", evidenceRefs: ["source-a"], limitations: [] }], inferences: [], advice: [], evidence: [], decisionSnapshot: decisionSnapshotFixture(), limitations: [] }
  };
}

function check(code: string, overrides: Partial<DecisionCheck> = {}): DecisionCheck {
  return { code, status: "APPLICABLE", boundary: "OBSERVABLE", evidenceRefs: ["fact-a"], missingFields: [], reason: "现场信息已确认。", ...overrides };
}

function withTeam(material: CandidateMaterial): CandidateMaterial {
  const snapshot = material.decisionSnapshot!;
  return { ...material, decisionSnapshot: { ...snapshot, aliveCounts: { ...snapshot.aliveCounts, value: { allies: 3, enemies: 3, includesSelectedPlayer: true } }, supportChecks: [check("teammateAlive"), check("higherHealthTeammate"), check("tradeWindow")], pressureChecks: [check("objectiveAllowsDelay")] } };
}

function setOf(pair = window()) {
  return assembleCandidateSet({ id: "set-a", version: "v1", demoId: "demo-fixture-mirage-v1", playerId: "p-user", candidates: [pair.candidate], materials: [pair.material], generationManifest: { timelineVersion: "t1", sceneIndexVersion: "s1", observationVersion: "o1", signalVersion: "s1", candidateGeneratorVersion: "g1" } });
}

function process(pair: ReturnType<typeof window>, kind: string) {
  pair.candidate = { ...pair.candidate, actionRefs: ["action-a"] };
  pair.material = { ...pair.material, playerActionFacts: [{ id: "action-a", text: "你完成了记录中可确认的行动。", actorPlayerId: "p-user", availableAtTick: 910, source: "DEMO", evidenceRefs: ["fact-a"], limitations: [] }], behaviorHypotheses: [{ hypothesisId: "hypothesis-a", kind, supportingEvidenceRefs: ["fact-a", "action-a"], counterEvidenceRefs: [], confidence: 0.9, missingFields: [], limitations: [], allowedAsTeachingJudgment: true, reflectionOnly: false }], decisionSnapshot: { ...pair.material.decisionSnapshot!, spatialChecks: [check(`behavior:${kind}`, { evidenceRefs: ["fact-a", "action-a"] })] } };
  return pair;
}

describe("trusted teaching and advice gates", () => {
  it("rejects every teammate-dependent option when all four teammates are dead", () => {
    const pair = window();
    const options = buildGatedAdviceOptions(pair.candidate, pair.material);
    expect(options.filter((option) => option.requiredPreconditions.some((condition) => condition.code === "teammateAlive")).every((option) => option.applicability?.status === "INAPPLICABLE")).toBe(true);
    expect(options.filter((option) => option.applicability?.allowedIntoNarrator)).toEqual([]);
    expect(assessCandidateTeaching(pair.candidate, pair.material).kind).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("requires a verified contact window, not just living teammates", () => {
    const pair = window();
    pair.material = withTeam(pair.material);
    pair.material.decisionSnapshot = { ...pair.material.decisionSnapshot!, supportChecks: [check("teammateAlive"), check("higherHealthTeammate"), check("tradeWindow", { status: "UNVERIFIABLE", missingFields: ["contact_timing"] })] };
    const option = buildGatedAdviceOptions(pair.candidate, pair.material).find((item) => item.code === "HIGH_HEALTH_TEAMMATE_FIRST")!;
    expect(option.applicability?.status).toBe("UNVERIFIABLE");
    expect(option.applicability?.missingFields).toContain("tradeWindow");
  });

  it("approves concrete advice only when every condition has observable evidence", () => {
    const pair = window();
    pair.material = withTeam(pair.material);
    const option = buildGatedAdviceOptions(pair.candidate, pair.material).find((item) => item.code === "HIGH_HEALTH_TEAMMATE_FIRST")!;
    expect(option.applicability).toMatchObject({ status: "APPLICABLE", allowedIntoNarrator: true });
    expect(option.fact_refs).toEqual(["fact-a"]);
    expect(option.applicability?.preconditions).toHaveLength(4);
  });

  it("uses world state only to veto; true hidden spatial knowledge cannot approve", () => {
    const pair = window();
    pair.material = withTeam(pair.material);
    pair.material.decisionSnapshot = { ...pair.material.decisionSnapshot!, spatialChecks: [check("knownAlternateRoute", { boundary: "GROUND_TRUTH", evidenceRefs: ["hidden-enemy-position"] })] };
    let option = buildGatedAdviceOptions(pair.candidate, pair.material).find((item) => item.code === "KNOWN_ALTERNATE_ROUTE")!;
    expect(option.applicability?.status).toBe("UNVERIFIABLE");
    pair.material.decisionSnapshot.spatialChecks = [check("knownAlternateRoute", { boundary: "GROUND_TRUTH", status: "INAPPLICABLE", evidenceRefs: ["hidden-enemy-position"] })];
    option = buildGatedAdviceOptions(pair.candidate, pair.material).find((item) => item.code === "KNOWN_ALTERNATE_ROUTE")!;
    expect(option.applicability?.status).toBe("INAPPLICABLE");
    expect(option.fact_refs).toEqual([]);
  });

  it("rejects delay when the objective deadline forbids it and never substitutes generic cover", () => {
    const pair = window();
    pair.material = withTeam(pair.material);
    pair.material.decisionSnapshot = { ...pair.material.decisionSnapshot!, pressureChecks: [check("objectiveAllowsDelay", { status: "INAPPLICABLE", boundary: "APPLICABILITY_ONLY" })] };
    expect(buildGatedAdviceOptions(pair.candidate, pair.material).every((option) => option.applicability?.status === "INAPPLICABLE")).toBe(true);
  });

  it("does not infer a positioning mistake from grenade damage", () => {
    const pair = window("HP_CHANGE");
    pair.material.outcomeFacts = [{ ...pair.material.outcomeFacts[0], text: "你受到手雷伤害。" }];
    const assessment = assessCandidateTeaching(pair.candidate, pair.material);
    expect(assessment.kind).toBe("INSUFFICIENT_EVIDENCE");
    expect(assessment.hasEvaluableDecision).toBe(false);
    expect(assessment.explanation).not.toMatch(/枪线|站位|继续/);
  });

  it("retains positive win probability as counterevidence without proving process correctness", () => {
    const pair = window();
    pair.candidate = { ...pair.candidate, winRateSignalRefs: ["positive-swing"], resultSummary: { ...pair.candidate.resultSummary, winProbabilityBefore: 0.11, winProbabilityAfter: 0.24, winProbabilityDelta: 0.13 } };
    const assessment = assessCandidateTeaching(pair.candidate, pair.material);
    expect(assessment.kind).toBe("INSUFFICIENT_EVIDENCE");
    expect(assessment.counterEvidenceRefs).toContain("positive-swing");
  });

  it("skips a routine utility event but can recognize independently verified purposeful utility", () => {
    const pair = window("UTILITY");
    expect(assessCandidateTeaching(pair.candidate, pair.material).kind).toBe("NO_TEACHING_VALUE");
    process(pair, "PURPOSEFUL_UTILITY");
    expect(assessCandidateTeaching(pair.candidate, pair.material).kind).toBe("POSITIVE_PROCESS");
    const set = setOf(pair);
    const compiled = compileReviewPlan({ timeline: createSyntheticMirageTimeline(), candidateSet: set, directorDecisionSet: deterministicDirectorFallback(set), planId: "positive-plan", observationVersion: "o1", signalVersion: "s1" });
    expect(compiled.plan.cues[0]?.inferences[0]).toMatchObject({
      counter_evidence_refs: [], missing_fields: [], limitations: [],
      hypothesis_refs: ["hypothesis-a"], allowed_as_teaching_judgment: true, reflection_only: false,
    });
  });

  it.each([["AIM_EXECUTION_FAILURE", "EXECUTION_ISSUE"], ["OBJECTIVE_FORCED_ACTION", "FORCED_CHOICE"]])("distinguishes verified %s from decision mistakes", (kind, expected) => {
    const pair = process(window(), kind);
    expect(assessCandidateTeaching(pair.candidate, pair.material).kind).toBe(expected);
  });

  it("cannot promote a hypothesis label without independent process checks", () => {
    const pair = process(window(), "ISOLATED_CONTACT");
    pair.material = withTeam(pair.material);
    pair.material.decisionSnapshot = { ...pair.material.decisionSnapshot!, spatialChecks: [] };
    expect(assessCandidateTeaching(pair.candidate, pair.material).kind).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("counterevidence prevents a confident negative classification and habit aggregation", () => {
    const pair = process(window(), "ISOLATED_CONTACT");
    pair.material = withTeam(pair.material);
    expect(assessCandidateTeaching(pair.candidate, pair.material).kind).toBe("DECISION_ERROR");
    expect(verifiedHabitKey(pair.candidate, pair.material)).toContain("ISOLATED_CONTACT");
    pair.candidate = { ...pair.candidate, winRateSignalRefs: ["positive-swing"], resultSummary: { ...pair.candidate.resultSummary, winProbabilityDelta: 0.13 } };
    expect(assessCandidateTeaching(pair.candidate, pair.material).kind).toBe("INSUFFICIENT_EVIDENCE");
    expect(verifiedHabitKey(pair.candidate, pair.material)).toBeUndefined();
  });

  it("rejects a forged Director negative focus and rechecks the compiled advice", () => {
    const set = setOf();
    const fallback = deterministicDirectorFallback(set);
    const forged: DirectorDecisionSet = { ...fallback, selected: [{ ...fallback.selected[0], primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT" }], manifest: { status: "SUCCEEDED", provider: "DEEPSEEK", limitations: [] } };
    const result = compileReviewPlan({ timeline: createSyntheticMirageTimeline(), candidateSet: set, directorDecisionSet: forged, planId: "plan-a", observationVersion: "o1", signalVersion: "s1" });
    expect(result.issues.join(" ")).toContain("unallowlisted");
    expect(result.plan.cues[0]).toMatchObject({ primary_focus_code: "REVIEW_UNCERTAINTY", advice: [], assessment: { kind: "INSUFFICIENT_EVIDENCE" } });
    expect(result.plan.habit_clusters).toEqual([]);
  });

  it("does not leak hidden state or timestamps in the Director summary", () => {
    const request = buildDirectorRequest(setOf());
    expect(request.candidates[0].assessment?.kind).toBe("INSUFFICIENT_EVIDENCE");
    expect(request.candidates[0].approvedAdvice).toEqual([]);
    const json = JSON.stringify(request.candidates);
    expect(json).not.toMatch(/decisionSnapshot|selectedPlayerId|decisionTick|sampledAtTick|supportChecks|GROUND_TRUTH/);
  });


  it("keeps empty actions/advice honest and rejects invented narrator tactics even with valid refs", () => {
    const set = setOf();
    const result = compileReviewPlan({ timeline: createSyntheticMirageTimeline(), candidateSet: set, directorDecisionSet: deterministicDirectorFallback(set), planId: "plan-a", observationVersion: "o1", signalVersion: "s1" });
    const cue = result.plan.cues[0];
    const coaching = buildCoachingPackage(cue, set, []);
    const outcome = buildOutcomePackage(cue, set);
    const narration = deterministicNarrationBundle(coaching, outcome);
    expect(narration.playerAction).toMatchObject({ text: "当前记录不足以确认具体行动意图。", refs: [] });
    expect(coaching.advice).toEqual([]);
    expect(collectNarrationBundleIssues(narration, coaching, outcome)).toEqual([]);
    expect(collectNarrationBundleReferenceIssues({ ...narration, betterPlay: { text: "历史未经验证建议", refs: narration.betterPlay.refs } }, coaching, outcome)).toEqual([]);
    expect(collectNarrationBundleIssues({ ...narration, betterPlay: { text: "让高血量队友先接触，你跟进补枪。", refs: ["fact-a"] } }, coaching, outcome).join(" ")).toContain("unverified semantic content");
    expect(JSON.stringify(narration)).not.toMatch(/ObservationState|renderer|lossless|refId|schema|TRADE/);
  });

  it.each([
    ["future evidence", { available_from_tick: 899, evidence_tick: 901 }],
    ["expired evidence", { available_from_tick: 899, evidence_tick: 899, expires_at_tick: 900 }]
  ])("does not approve advice from %s claims", (_label, times) => {
    const pair = window();
    pair.material = withTeam(pair.material);
    const claim = { id: "claim-a", claim_type: "DIRECT_VISUAL", knowledge_kind: "DIRECT_VISUAL", source_type: "DEMO_POV", subject_resolution: "EXACT", spatial_estimate: { type: "NONE" }, confidence: 1, sharing_scope: "PRIVATE", evidence_refs: ["fact-a"], derived_by: "fixture", limitations: [], ...times } as unknown as ObservationClaim;
    pair.material.observableContext = { version: "observable-decision-context.v1", boundary: "OBSERVABLE", publicFacts: [], state: { id: "state-a", demo_id: "demo-fixture-mirage-v1", timeline_version: "t1", observer_player_id: "p-user", at_tick: 900, observation_version: "o1", claims: [claim], limitations: [] }, snapshotId: pair.material.decisionSnapshot!.snapshotId, source: "DEMO_OBSERVER_EVIDENCE", freshness: { sampledAtTick: 900, ageTicks: 0 }, confidence: 1, missingFields: [], limitations: [] } satisfies ObservableDecisionContext;
    pair.material.decisionSnapshot = { ...pair.material.decisionSnapshot!, spatialChecks: [check("knownAlternateRoute", { evidenceRefs: ["claim-a"] })] };
    expect(buildGatedAdviceOptions(pair.candidate, pair.material).find((option) => option.code === "KNOWN_ALTERNATE_ROUTE")?.applicability?.status).toBe("UNVERIFIABLE");
  });

  it("caps a genuinely eligible 40-process Director packet at 32 compact summaries", () => {
    const pair = process(window("UTILITY"), "PURPOSEFUL_UTILITY");
    const seed = setOf(pair);
    const candidates = Array.from({ length: 40 }, (_, index) => ({ ...pair.candidate, candidateId: `candidate-${index}`, roundNumber: index + 1 }));
    const set = assembleCandidateSet({ ...seed, candidates, materials: candidates.map((candidate) => ({ ...pair.material, candidateId: candidate.candidateId })) });
    const request = buildDirectorRequest(set);
    expect(request.candidates).toHaveLength(32);
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThan(64 * 1024);
  });

  it("enforces the option timing window and refuses stale source facts", () => {
    const pair = window();
    pair.material = withTeam(pair.material);
    const option = buildGatedAdviceOptions(pair.candidate, pair.material)[0];
    expect(evaluateAdviceApplicability(option, pair.material, 901, ["fact-a"]).status).toBe("INAPPLICABLE");
    pair.material.decisionFacts = [{ ...pair.material.decisionFacts[0], available_at_tick: 950 }];
    expect(buildGatedAdviceOptions(pair.candidate, pair.material)[0].applicability?.status).toBe("UNVERIFIABLE");
  });
});
