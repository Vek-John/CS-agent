import { describe, expect, it } from "vitest";
import type { SessionSummaryInput } from "@cs-coach/coach-agent/client";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { buildStage3WrapUpInput } from "./coach-agent-stage3-wrap-up";

describe("buildStage3WrapUpInput", () => {
  it("does not promote old unchecked advice or singleton history into a training habit", () => {
    const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());
    const cue = plan.cues[0];
    if (!cue) throw new Error("fixture cue missing");
    const summary: SessionSummaryInput = {
      schemaVersion: "coach-agent-session-summary.v1",
      themes: [{
        focus: "SURVIVE_THE_NEXT_CONTACT",
        cueRefs: [cue.id],
        roundRefs: ["round-2"],
        evidenceRefs: ["fact-r2-4v3"],
        occurrence: 1,
        economyContext: "FULL",
        repeated: true,
        conflictEvidence: false,
        adviceRefs: [cue.advice[0]?.id ?? "advice-r2-reset"],
        limitations: [],
      }],
      completedCues: [{
        cueId: cue.id,
        roundId: "round-2",
        focus: "SURVIVE_THE_NEXT_CONTACT",
        evidenceRefs: ["fact-r2-4v3"],
        adviceRefs: [cue.advice[0]?.id ?? "advice-r2-reset"],
      }],
      limitations: [],
    };
    const result = buildStage3WrapUpInput(plan, summary, {
      [cue.id]: {
        cueId: cue.id,
        candidateId: cue.candidate_id ?? "candidate",
        primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
        currentSituation: { text: "当前", refs: ["fact-r2-4v3"] },
        playerAction: { text: "动作", refs: ["action-r2"] },
        coreIssue: { text: "问题", refs: ["fact-r2-4v3"] },
        betterPlay: { text: "建议", refs: ["advice-r2-reset"] },
        outcomeImpact: { text: "结果", refs: ["fact-r2-outcome"] },
      },
      "uncompleted-cue": {} as never,
    });
    expect(result.presentableCues).toEqual({});
    expect(result.summary.themes).toEqual([]);
    expect(result.summary.completedCues).toEqual([]);
  });
});

it("keeps only repeated verified conditions with freshly applicable advice", async () => {
  const { assembleCandidateSet, buildGatedAdviceOptions } = await import("@cs-coach/review-planner");
  const { decisionSnapshotFixture } = await import("../../../../libs/review-planner/src/teaching-gate-fixtures");
  const base = createFixtureReviewPlan(createSyntheticMirageTimeline());
  const candidates = base.cues.map((cue, index) => ({
    candidateId: `candidate-${index}`, roundNumber: index + 1, source: { kind: "DEATH" as const, refs: [`source-${index}`] },
    preRollStart: cue.decision_tick - 10, decisionTick: cue.decision_tick, revealTick: cue.reveal_tick, outcomeEnd: cue.outcome_end_tick,
    factRefs: [`fact-${index}`], observableClaimRefs: [], actionRefs: [`action-${index}`], outcomeRefs: [`outcome-${index}`], evidenceRefs: [`fact-${index}`], winRateSignalRefs: [], economySignalRefs: [], missingFields: [], limitations: [], deterministicScore: 8,
    resultSummary: { selectedPlayerDeath: true, economyClass: "FULL" as const, concurrentEvents: false, missingFields: [], limitations: [] },
  }));
  const materials = candidates.map((candidate, index) => {
    const fact = candidate.factRefs[0];
    const action = candidate.actionRefs[0];
    const snapshot = decisionSnapshotFixture(candidate.decisionTick, fact);
    snapshot.spatialChecks = ["safeReachableCover", "objectiveAllowsDelay", "behavior:ISOLATED_CONTACT"].map((code) => ({ code, status: "APPLICABLE" as const, boundary: "OBSERVABLE" as const, evidenceRefs: [fact, action], missingFields: [], reason: "当前现场记录已确认这个条件。" }));
    // Applicability uses observable decision evidence; behavior independently binds a real action.
    snapshot.spatialChecks = snapshot.spatialChecks.map((check) => check.code.startsWith("behavior:") ? check : { ...check, evidenceRefs: [fact] });
    return {
      candidateId: candidate.candidateId, decisionSnapshot: snapshot,
      decisionFacts: [{ id: fact, text: "当时存在已确认可安全到达的掩体和足够时间。", availability: "DECISION" as const, available_at_tick: candidate.decisionTick, source: "DEMO" as const, observed_by_player: true }],
      playerActionFacts: [{ id: action, text: "记录确认玩家离开了原有掩体。", actorPlayerId: "p-user", availableAtTick: candidate.decisionTick, source: "DEMO" as const, evidenceRefs: [fact], limitations: [] }],
      outcomeFacts: [{ id: `outcome-${index}`, text: "玩家随后阵亡。", availableAtTick: candidate.revealTick, source: "DEMO" as const, outcomeKind: "DEATH" as const, evidenceRefs: [], limitations: [] }],
      behaviorHypotheses: [{ hypothesisId: `hypothesis-${index}`, kind: "ISOLATED_CONTACT", supportingEvidenceRefs: [fact, action], counterEvidenceRefs: [], confidence: 0.9, missingFields: [], limitations: [], allowedAsTeachingJudgment: true, reflectionOnly: false }],
      inferences: [], advice: [], evidence: [], limitations: [],
    };
  });
  const set = assembleCandidateSet({ id: "set", version: "test", demoId: base.demo_id, playerId: base.player_id, candidates, materials, generationManifest: { timelineVersion: "test", sceneIndexVersion: "test", observationVersion: "test", signalVersion: "test", candidateGeneratorVersion: "test" } });
  const plan = { ...base, cues: base.cues.map((cue, index) => ({ ...cue, candidate_id: candidates[index].candidateId })) };
  const completedCues = plan.cues.map((cue, index) => ({ cueId: cue.id, roundId: `round-${index}`, focus: "VERIFIED_DECISION_REVIEW", evidenceRefs: candidates[index].factRefs, adviceRefs: buildGatedAdviceOptions(candidates[index], materials[index]).filter((item) => item.applicability?.allowedIntoNarrator).map((item) => item.id) }));
  const summary: SessionSummaryInput = {
    schemaVersion: "coach-agent-session-summary.v1", completedCues, limitations: [],
    themes: [{ focus: "VERIFIED_DECISION_REVIEW", cueRefs: completedCues.map((cue) => cue.cueId), roundRefs: completedCues.map((cue) => cue.roundId), evidenceRefs: completedCues.flatMap((cue) => cue.evidenceRefs), adviceRefs: completedCues.flatMap((cue) => cue.adviceRefs), occurrence: completedCues.length, economyContext: "FULL", repeated: true, conflictEvidence: false, limitations: [] }],
  };
  const narration = Object.fromEntries(plan.cues.map((cue) => [cue.id, { cueId: cue.id, candidateId: cue.candidate_id, primaryFocusCode: "VERIFIED_DECISION_REVIEW", currentSituation: { text: "已确认的情况", refs: [] }, playerAction: { text: "已确认的动作", refs: [] }, coreIssue: { text: "不信任存储文案", refs: ["d"] }, betterPlay: { text: "不信任存储建议", refs: ["v"] }, outcomeImpact: { text: "未来结果不能进入总结依据", refs: ["o"] } }]));
  const projected = buildStage3WrapUpInput(plan, summary, narration, set);
  expect(projected.summary.themes).toHaveLength(1);
  expect(projected.summary.themes[0].occurrence).toBe(2);
  expect(Object.values(projected.presentableCues).every((cue) => cue.advice[0].text.includes("已确认能够安全到达的掩体"))).toBe(true);
  expect(JSON.stringify(projected)).not.toMatch(/不信任存储|未来结果不能/);
  const denied = { ...set, materials: set.materials.map((material) => ({ ...material, decisionSnapshot: { ...material.decisionSnapshot!, spatialChecks: [] } })) };
  expect(buildStage3WrapUpInput(plan, summary, narration, denied).summary.themes).toEqual([]);
});
