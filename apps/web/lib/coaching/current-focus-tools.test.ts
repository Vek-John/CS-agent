import { describe, expect, it } from "vitest";
import type { CandidateMaterial, TeachingCandidate } from "@cs-coach/contracts";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { assembleCandidateSet, compileReviewPlan, deterministicDirectorFallback, deterministicNarrationBundle, buildCoachingPackage, buildOutcomePackage } from "@cs-coach/review-planner";
import { decisionSnapshotFixture } from "../../../../libs/review-planner/src/teaching-gate-fixtures";
import { buildInitialCoachingRouteState } from "./cs2d-route-integration";
import { CoachAgentStage3HostAdapter, buildStage3StartCue, type Stage3HostAdapterInput } from "./coach-agent-stage3-host-adapter";

// Synthetic facts exercise the actual assessment/Compiler, never measured Demo ticks.
function compiledInput(withAction = true): Stage3HostAdapterInput {
  const timeline = createSyntheticMirageTimeline();
  const candidate: TeachingCandidate = { candidateId: "candidate-action", roundNumber: 1, source: { kind: "DEATH", refs: ["source-death"] }, preRollStart: 836, decisionTick: 900, revealTick: 920, outcomeEnd: 1020, factRefs: ["fact-a"], observableClaimRefs: [], actionRefs: withAction ? ["action-a"] : [], outcomeRefs: ["outcome-a"], evidenceRefs: [], winRateSignalRefs: [], economySignalRefs: [], missingFields: [], limitations: [], deterministicScore: 5, resultSummary: { selectedPlayerDeath: true, economyClass: "FULL", concurrentEvents: false, missingFields: [], limitations: [] } };
  const material: CandidateMaterial = { candidateId: candidate.candidateId, decisionFacts: [{ id: "fact-a", text: "本人存活状态已记录。", availability: "DECISION", available_at_tick: 900, source: "DEMO", observed_by_player: true }], playerActionFacts: withAction ? [{ id: "action-a", text: "本人完成了一次可确认的开枪动作。", actorPlayerId: timeline.selected_player_id, availableAtTick: 910, source: "DEMO", evidenceRefs: ["fact-a"], limitations: [] }] : [], outcomeFacts: [{ id: "outcome-a", text: "本人随后阵亡。", availableAtTick: 920, source: "DEMO", outcomeKind: "DEATH", evidenceRefs: ["source-death"], limitations: [] }], inferences: [], advice: [], evidence: [], decisionSnapshot: { ...decisionSnapshotFixture(), selectedPlayerId: timeline.selected_player_id }, limitations: [] };
  const set = assembleCandidateSet({ id: "current-focus-set", version: "v1", demoId: timeline.demo_id, playerId: timeline.selected_player_id, candidates: [candidate], materials: [material], generationManifest: { timelineVersion: "t1", sceneIndexVersion: "s1", observationVersion: "o1", signalVersion: "s1", candidateGeneratorVersion: "g1" } });
  const { plan } = compileReviewPlan({ timeline, candidateSet: set, directorDecisionSet: deterministicDirectorFallback(set), planId: "current-focus-plan", observationVersion: "o1", signalVersion: "s1" });
  const cue = plan.cues[0];
  if (!cue) throw Error("Compiler did not produce the fixture cue");
  const narration = deterministicNarrationBundle(buildCoachingPackage(cue, set, []), buildOutcomePackage(cue, set));
  const routeState = buildInitialCoachingRouteState(plan, { readiness: { [cue.id]: "FALLBACK" }, narrationByCue: { [cue.id]: narration } });
  return { plan, cue, narration, routeState, analysis: { demo_id: plan.demo_id, selected_steam_id: plan.player_id }, demoContentHash: "a".repeat(64), selectedPlayerId: plan.player_id, sessionId: "current-focus-session", runId: "current-focus-run", generation: 1, tickRate: 64, currentSessionPhase: "PAUSED_FOR_COACHING", outcomeGate: { cueId: cue.id, status: "COMPLETE", outcomeEndTick: cue.outcome_end_tick, completedAtTick: cue.outcome_end_tick }, evidence: { candidate: set.candidates[0], material: set.materials[0] } };
}

describe("current Compiler focus to evidence demonstration", () => {
  it("keeps a recorded action replayable without claiming a verified tactical mistake", () => {
    const input = compiledInput();
    expect(input.cue.primary_focus_code).toBe("REVIEW_UNCERTAINTY");
    expect(input.cue.assessment?.kind).toBe("INSUFFICIENT_EVIDENCE");
    expect(input.cue.action_fact_refs).toContain("action-a");
    expect(buildStage3StartCue(input).capabilities.map(c => c.tool)).toContain("REPLAY_CUE_SLOW");
  });
  it("does not turn a decision/outcome-only current cue into a demonstration", () => {
    expect(buildStage3StartCue(compiledInput(false)).capabilities).toEqual([]);
  });
});

it("naturally dispatches exactly one action replay through the default Graph and Host binding", async () => {
  const { createCoachAgentRuntime } = await import("@cs-coach/coach-agent");
  const input = compiledInput();
  const adapter = new CoachAgentStage3HostAdapter();
  const prepared = adapter.prepareStart(input);
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  await observePrecedingSegments(input, adapter, runtime);
  const result = await runtime.dispatch(prepared.event);
  expect(result.effects).toHaveLength(1);
  const request = result.effects[0];
  expect(request.tool).toBe("REPLAY_CUE_SLOW");
  expect(result.state.selectedTeachingMove).toMatchObject({ presentationPurpose: "ACTION_FACT_REPLAY" });
  const context = { generation: input.generation, currentSessionPhase: input.currentSessionPhase, outcomeGate: input.outcomeGate };
  const command = adapter.createTeachingToolCommand(request, context);
  expect(command).toMatchObject({ type: "teachingTool", tool: "REPLAY_CUE_SLOW", args: { speed: 0.5, outcomeEndCanonicalTick: input.cue.outcome_end_tick } });
  expect(adapter.createTeachingToolCommand(request, context)).toBeUndefined();
  expect(input.cue.assessment?.kind).toBe("INSUFFICIENT_EVIDENCE");
});

it("naturally finishes when the Compiler has no independent action", async () => {
  const { createCoachAgentRuntime } = await import("@cs-coach/coach-agent");
  const input = compiledInput(false);
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  await observePrecedingSegments(input, new CoachAgentStage3HostAdapter(), runtime);
  const result = await runtime.dispatch(buildStage3StartCue(input).event);
  expect(result.effects).toEqual([]);
  expect(result.state.runStatus).toBe("CUE_COMPLETED");
});

it.each([
  ["wrong candidate", (i: Stage3HostAdapterInput) => { i.evidence.material!.candidateId = "other"; }],
  ["wrong actor", (i: Stage3HostAdapterInput) => { i.evidence.material!.playerActionFacts[0].actorPlayerId = "other"; }],
  ["future action", (i: Stage3HostAdapterInput) => { i.evidence.material!.playerActionFacts[0].availableAtTick = i.cue.outcome_end_tick + 1; }],
  ["uncited action", (i: Stage3HostAdapterInput) => { i.narration.playerAction.refs = []; }],
  ["unbound action", (i: Stage3HostAdapterInput) => { i.evidence.candidate!.actionRefs = []; }],
])("does not grant an action purpose for %s", (_label, mutate) => {
  const input = compiledInput();
  mutate(input);
  expect(buildStage3StartCue(input).capabilities).toEqual([]);
});

it("retains the outcome completion gate", () => {
  const input = compiledInput();
  expect(() => buildStage3StartCue({ ...input, outcomeGate: { ...input.outcomeGate, status: "LOCKED" } })).toThrow();
});

async function observePrecedingSegments(input: Stage3HostAdapterInput, adapter: CoachAgentStage3HostAdapter, runtime: import("@cs-coach/coach-agent").CoachAgentRuntime) {
  for (const [index, segment] of input.plan.segments.entries()) {
    if (segment.id === input.cue.segment_id) break;
    if (segment.mode !== "SKIP" && segment.mode !== "BRIEF" && segment.mode !== "OBSERVE") throw Error("Unexpected preceding teaching cue");
    await runtime.dispatch(adapter.createObserveSegmentEvent(input, segment.id, index, segment.mode, "SKIPPING", `observe-${index}`));
  }
}

it("rejects current purposes when a COMPLETE gate belongs to a shorter window", () => {
  const input = compiledInput();
  expect(buildStage3StartCue({ ...input, outcomeGate: { ...input.outcomeGate, outcomeEndTick: input.cue.reveal_tick, completedAtTick: input.cue.reveal_tick } }).capabilities).toEqual([]);
});
it("rejects current purposes when completion has not reached the outcome end", () => {
  const input = compiledInput();
  expect(buildStage3StartCue({ ...input, outcomeGate: { ...input.outcomeGate, completedAtTick: input.cue.outcome_end_tick - 1 } }).capabilities).toEqual([]);
});

it("does not accept a supplied cue window that differs from the frozen plan", () => {
  const input = compiledInput();
  const extendedEnd = input.cue.outcome_end_tick + 64;
  const changed: Stage3HostAdapterInput = {
    ...input,
    cue: { ...input.cue, outcome_end_tick: extendedEnd },
    evidence: { ...input.evidence, candidate: { ...input.evidence.candidate!, outcomeEnd: extendedEnd } },
    outcomeGate: { ...input.outcomeGate, outcomeEndTick: extendedEnd, completedAtTick: extendedEnd },
  };
  expect(buildStage3StartCue(changed).capabilities).toEqual([]);
});
