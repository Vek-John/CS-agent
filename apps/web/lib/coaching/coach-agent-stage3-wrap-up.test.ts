import { describe, expect, it, vi } from "vitest";
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

async function verifiedFixture(third = false) {
  const { assembleCandidateSet, buildGatedAdviceOptions } = await import("@cs-coach/review-planner");
  const { decisionSnapshotFixture } = await import("../../../../libs/review-planner/src/teaching-gate-fixtures");
  const base = createFixtureReviewPlan(createSyntheticMirageTimeline());
  if (third) {
    const original = base.cues[1];
    const segment = base.segments.find(item => item.id === original.segment_id)!;
    base.cues.push({ ...original, id: "cue-third", segment_id: "segment-third" });
    base.segments.push({ ...segment, id: "segment-third", cue_ids: ["cue-third"], round_number: 4 });
  }
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
      decisionFacts: [{ id: fact, text: "当时存在已确认可安全到达的掩体和足够时间，决策时没有看到敌人。", availability: "DECISION" as const, available_at_tick: candidate.decisionTick, source: "DEMO" as const, observed_by_player: true }],
      playerActionFacts: [{ id: action, text: "记录确认玩家离开了原有掩体。", actorPlayerId: "p-user", availableAtTick: candidate.decisionTick, source: "DEMO" as const, evidenceRefs: [fact], limitations: [] }],
      outcomeFacts: [{ id: `outcome-${index}`, text: "玩家随后阵亡。", availableAtTick: candidate.revealTick, source: "DEMO" as const, outcomeKind: "DEATH" as const, evidenceRefs: [], limitations: [] }],
      behaviorHypotheses: [{ hypothesisId: `hypothesis-${index}`, kind: "ISOLATED_CONTACT", supportingEvidenceRefs: [fact, action], counterEvidenceRefs: [], confidence: 0.9, missingFields: [], limitations: [], allowedAsTeachingJudgment: true, reflectionOnly: false }],
      inferences: [], advice: [], evidence: [], limitations: [],
    };
  });
  const set = assembleCandidateSet({ id: "set", version: "test", demoId: base.demo_id, playerId: base.player_id, candidates, materials, generationManifest: { timelineVersion: "test", sceneIndexVersion: "test", observationVersion: "test", signalVersion: "test", candidateGeneratorVersion: "test" } });
  const plan = { ...base, cues: base.cues.map((cue, index) => ({ ...cue, candidate_id: candidates[index].candidateId, primary_focus_code: "VERIFIED_DECISION_REVIEW" })) };
  const completedCues = plan.cues.map((cue, index) => ({ cueId: cue.id, roundId: `round-${index}`, focus: "VERIFIED_DECISION_REVIEW", evidenceRefs: candidates[index].factRefs, adviceRefs: buildGatedAdviceOptions(candidates[index], materials[index]).filter((item) => item.applicability?.allowedIntoNarrator).map((item) => item.id) }));
  const summary: SessionSummaryInput = {
    schemaVersion: "coach-agent-session-summary.v1", completedCues, limitations: [],
    themes: [{ focus: "VERIFIED_DECISION_REVIEW", cueRefs: completedCues.map((cue) => cue.cueId), roundRefs: completedCues.map((cue) => cue.roundId), evidenceRefs: completedCues.flatMap((cue) => cue.evidenceRefs), adviceRefs: completedCues.flatMap((cue) => cue.adviceRefs), occurrence: completedCues.length, economyContext: "FULL", repeated: true, conflictEvidence: false, limitations: [] }],
  };
  const narration = Object.fromEntries(plan.cues.map((cue) => [cue.id, { cueId: cue.id, candidateId: cue.candidate_id, primaryFocusCode: "VERIFIED_DECISION_REVIEW", currentSituation: { text: "已确认的情况", refs: [] }, playerAction: { text: "已确认的动作", refs: [] }, coreIssue: { text: "不信任存储文案", refs: ["d"] }, betterPlay: { text: "不信任存储建议", refs: ["v"] }, outcomeImpact: { text: "未来结果不能进入总结依据", refs: ["o"] } }]));
  return { plan, summary, narration, set, candidates, materials, completedCues };
}

async function revisedFixture(third = false) {
  const f = await verifiedFixture(third);
  const { diagnoseCue, reviseDiagnosis } = await import("../../../../libs/coach-agent/src/teaching-diagnosis");
  const cue = f.plan.cues[0];
  const input = { cueId: cue.id, candidateId: cue.candidate_id,
    reflection: { cueId: cue.id, rawText: "我看到敌人在前面，想拿信息。", response: "ANSWERED" as const, source: "USER" as const, limitations: [] },
    decisionFacts: f.materials[0].decisionFacts,
    playerActionFacts: f.materials[0].playerActionFacts, outcomeFacts: [],
  };
  const original = diagnoseCue(input);
  const revised = reviseDiagnosis({ previous: original, input, disagreement: { ...input.reflection, rawText: "队友语音叫我先拉出去执行固定战术。" } });
  expect(original.cueCase.verdict?.type).toBe("INCONCLUSIVE");
  expect(original.cueCase.hinge?.kind).toBe("INFORMATION");
  expect(revised.cueCase.verdict).toMatchObject({ type: "INCONCLUSIVE", revision: 1 });
  expect(revised.cueCase.transferRule?.do).not.toBe(original.cueCase.transferRule?.do);
  expect(revised.cueCase.claims.every(claim => claim.source === "USER")).toBe(true);
  return { ...f, original, revised };
}

it("does not repeat frozen advice as a habit after a real user disagreement changed the diagnosis", async () => {
  const f = await revisedFixture();
  const { requestSessionWrapUp } = await import("./deepseek-wrap-up");
  const old = await requestSessionWrapUp(buildStage3WrapUpInput(f.plan, f.summary, f.narration, f.set));
  expect(old.bundle.themes).toHaveLength(1);
  const projected = buildStage3WrapUpInput(f.plan, f.summary, f.narration, f.set, [f.revised.cueCase]);
  expect(projected.summary.themes).toEqual([]);
  const result = await requestSessionWrapUp(projected);
  expect(result.bundle.themes).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(old.bundle.themes[0].trainingAdvice.text);
  const { REVISED_DIAGNOSIS_SUMMARY_LIMITATION } = await import("@cs-coach/coach-agent/client");
  expect(result.bundle.limitations).toContain(REVISED_DIAGNOSIS_SUMMARY_LIMITATION);
  expect(JSON.stringify(projected)).not.toContain("队友语音叫");
  const { completeAndSaveSessionWrapUp } = await import("./session-wrap-up-completion");
  const artifact = vi.fn(async (..._args: unknown[]) => undefined); const onResult = vi.fn();
  await completeAndSaveSessionWrapUp({ buildInput: () => projected, isCurrent: () => true, persistence: { artifact },
    onRequest: vi.fn(), onResult, onSaveError: vi.fn() });
  expect(artifact).toHaveBeenCalledOnce();
  expect(artifact.mock.calls[0][2]).toEqual(onResult.mock.calls[0][0]);
  expect(JSON.parse(JSON.stringify(onResult.mock.calls[0][0])).bundle.limitations).toContain(REVISED_DIAGNOSIS_SUMMARY_LIMITATION);
});

it("keeps two remaining verified supports while removing the revised cue from every source list", async () => {
  const f = await revisedFixture(true);
  const summary = { ...f.summary, completedCues: [f.summary.completedCues[1]] };
  const projected = buildStage3WrapUpInput(f.plan, summary, f.narration, f.set, [f.revised.cueCase]);
  expect(projected.summary.themes).toHaveLength(1);
  const theme = projected.summary.themes[0];
  expect(theme.occurrence).toBe(2); expect(theme.cueRefs).toEqual(f.plan.cues.slice(1).map(cue => cue.id));
  expect(theme.roundRefs).toEqual(["round-3", "round-4"]);
  expect(theme.evidenceRefs).not.toContain("fact-0");
  expect(theme.adviceRefs).not.toContain(f.summary.completedCues[0].adviceRefs[0]);
  expect(projected.presentableCues[f.plan.cues[0].id]).toBeUndefined();
  const { buildSessionWrapUpRequest } = await import("@cs-coach/coach-agent/client");
  expect(buildSessionWrapUpRequest(projected).themes[0].occurrence).toBe(2);
  const onlyRevisedRepresentative = { ...f.summary, completedCues: [f.summary.completedCues[0]] };
  expect(buildStage3WrapUpInput(f.plan, onlyRevisedRepresentative, f.narration, f.set, [f.revised.cueCase]).summary.themes).toEqual([]);
});

it("honors confirmed/restored revisions from either source without promoting unrelated cases", async () => {
  const f = await revisedFixture();
  const restored = JSON.parse(JSON.stringify({ ...f.revised.cueCase, status: "COMPLETED" }));
  for (const sources of [[restored, f.original.cueCase], [f.original.cueCase, restored]]) {
    expect(buildStage3WrapUpInput(f.plan, f.summary, f.narration, f.set, sources).summary.themes).toEqual([]);
  }
  for (const sources of [[], [f.original.cueCase], [{ ...restored, cueId: "unrelated" }], [{ ...restored, candidateId: "other-candidate" }]]) {
    expect(buildStage3WrapUpInput(f.plan, f.summary, f.narration, f.set, sources).summary.themes).toHaveLength(1);
  }
  const full = { ...f.summary, limitations: Array.from({ length: 8 }, (_, i) => `必须保留的条件${i}`) };
  expect(() => buildStage3WrapUpInput(f.plan, full, f.narration, f.set, [restored])).toThrow("SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT");
  expect(full.limitations).toHaveLength(8);
});

it("keeps only repeated verified conditions with freshly applicable advice", async () => {
  const { plan, summary, narration, set, candidates, completedCues } = await verifiedFixture();
  const projected = buildStage3WrapUpInput(plan, summary, narration, set);
  expect(projected.summary.themes).toHaveLength(1);
  expect(projected.summary.themes[0].occurrence).toBe(2);
  expect(Object.values(projected.presentableCues).every((cue) => cue.advice[0].text.includes("已确认能够安全到达的掩体"))).toBe(true);
  expect(JSON.stringify(projected)).not.toMatch(/不信任存储|未来结果不能/);
  // Graph retains all supporting cueRefs but only one representative per theme.
  const { createCoachAgentRuntime } = await import("@cs-coach/coach-agent");
  const { startCueEvent, fixtureIdentity } = await import("../../../../libs/coach-agent/src/test-fixtures");
  const { buildSessionWrapUpRequest } = await import("@cs-coach/coach-agent/client");
  const { requestSessionWrapUp } = await import("./deepseek-wrap-up");
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  for (const [index, completed] of completedCues.entries()) {
    const event = startCueEvent({ eventId: `completed-${index}`, cueId: completed.cueId, segmentId: `segment-${index}`, routeSegmentIndex: index, capabilities: [] });
    event.focus = completed.focus;
    event.sessionThemes = [];
    event.allowedEvidenceSummary = [{ namespace: "DECISION", refs: [...completed.evidenceRefs] }, { namespace: "ADVICE", refs: [...completed.adviceRefs] }];
    event.presentableSummary = { ...event.presentableSummary!, cueId: completed.cueId, roundId: completed.roundId, focus: completed.focus, evidenceRefs: [...completed.evidenceRefs], adviceRefs: [...completed.adviceRefs] };
    const result = await runtime.dispatch(event);
    expect(result.state.runStatus).toBe("CUE_COMPLETED");
    expect(result.state.sessionSummaryInput).toBeNull();
  }
  const finished = await runtime.dispatch({ version: "coach-agent-event.v2", type: "COMPLETE_SESSION", eventId: "full-session-complete", identity: fixtureIdentity });
  const graphShape = finished.state.sessionSummaryInput!;
  expect(graphShape.completedCues).toHaveLength(1);
  expect(graphShape.themes[0].cueRefs).toHaveLength(2);
  const projectedGraph = buildStage3WrapUpInput(plan, graphShape, narration, set);
  expect(projectedGraph.summary.themes).toHaveLength(1);
  expect(Object.keys(projectedGraph.presentableCues)).toEqual(graphShape.completedCues.map(cue => cue.cueId));
  expect(buildSessionWrapUpRequest(projectedGraph).completedCues).toHaveLength(1);
  const local = await requestSessionWrapUp(projectedGraph, { fetcher: async () => { throw Error("No wrap-up network expected"); } });
  expect(local.bundle.themes).toHaveLength(1);
  expect(local.manifest.reason).toBe("CLOSED_SESSION_PROJECTION");
  expect(buildStage3WrapUpInput(plan, { ...graphShape, themes: [{ ...graphShape.themes[0], cueRefs: [completedCues[0].cueId] }] }, narration, set).summary.themes).toEqual([]);
  expect(buildStage3WrapUpInput(plan, graphShape, { [completedCues[0].cueId]: narration[completedCues[0].cueId] }, set).summary.themes).toEqual([]);
  expect(buildStage3WrapUpInput(plan, { ...graphShape, themes: [{ ...graphShape.themes[0], conflictEvidence: true }] }, narration, set).summary.themes).toEqual([]);
  const noRepresentativeAdvice = { ...graphShape, completedCues: graphShape.completedCues.map(cue => ({ ...cue, adviceRefs: [] })) };
  expect(buildStage3WrapUpInput(plan, noRepresentativeAdvice, narration, set).summary.themes).toEqual([]);

  const mismatchedHabit = structuredClone(set);
  mismatchedHabit.materials[1].behaviorHypotheses![0].kind = "DELAYED_OBJECTIVE_ACTION";
  mismatchedHabit.materials[1].decisionSnapshot!.spatialChecks = mismatchedHabit.materials[1].decisionSnapshot!.spatialChecks.map(check => check.code.startsWith("behavior:") ? { ...check, code: "behavior:DELAYED_OBJECTIVE_ACTION" } : check);
  expect(buildStage3WrapUpInput(plan, graphShape, narration, mismatchedHabit).summary.themes).toEqual([]);
  const presentationOnly = { ...set, materials: set.materials.map(material => ({ ...material, playerActionFacts: material.playerActionFacts.map(fact => ({ ...fact, presentationOnly: true as const })) })) };
  expect(buildStage3WrapUpInput(plan, graphShape, narration, presentationOnly).summary.themes).toEqual([]);
  const denied = { ...set, materials: set.materials.map((material) => ({ ...material, decisionSnapshot: { ...material.decisionSnapshot!, spatialChecks: [] } })) };
  expect(buildStage3WrapUpInput(plan, summary, narration, denied).summary.themes).toEqual([]);
});
