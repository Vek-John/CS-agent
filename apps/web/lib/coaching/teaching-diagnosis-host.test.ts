import { describe, expect, it } from "vitest";
import type { CoachCue } from "@cs-coach/contracts";
import { decisionFactsForCue } from "./teaching-diagnosis-host";

describe("teaching diagnosis evidence boundary", () => {
  it("does not widen an empty observable allowlist to hidden decision facts", () => {
    const cue = {
      decision_tick: 100,
      observable_fact_refs: [],
      facts: [
        {
          id: "fact-observed",
          text: "玩家决策前看到了可用信息。",
          availability: "DECISION",
          available_at_tick: 90,
          source: "DEMO",
          observed_by_player: true,
        },
        {
          id: "fact-hidden",
          text: "决策时存在但玩家不可直接观察的事实。",
          availability: "DECISION",
          available_at_tick: 90,
          source: "DEMO",
          observed_by_player: false,
        },
      ],
    } as unknown as CoachCue;

    expect(decisionFactsForCue(cue).map((fact) => fact.id)).toEqual(["fact-observed"]);
  });
});

it("projects teammate count only from the same decision's observable public roster", async () => {
  const { buildTeachingDiagnosisInput } = await import("./teaching-diagnosis-host");
  const { createSyntheticMirageTimeline } = await import("@cs-coach/demo-domain");
  const { createFixtureReviewPlan } = await import("@cs-coach/review-planner");
  const { decisionSnapshotFixture } = await import("../../../../libs/review-planner/src/teaching-gate-fixtures");
  const timeline = createSyntheticMirageTimeline();
  const plan = createFixtureReviewPlan(timeline);
  const cue = plan.cues[0];
  const snapshot = decisionSnapshotFixture(cue.decision_tick, cue.observable_fact_refs[0]);
  snapshot.selectedPlayerId = timeline.selected_player_id;
  const material = {
    candidateId: "candidate", decisionSnapshot: snapshot, decisionFacts: cue.facts.filter((fact) => fact.availability === "DECISION"), playerActionFacts: [], outcomeFacts: [], inferences: [], advice: [], evidence: [], limitations: [],
  };
  const state = { player_id: timeline.selected_player_id, tick: cue.decision_tick, side: "T" as const, world_position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, alive: true, health: 2, armor: 0, has_helmet: false, inventory: [], fact_refs: cue.observable_fact_refs, missing_fields: [] };
  const context = { plan, cue, material, timeline: { ...timeline, player_state_tracks: [state] }, selectedPlayerId: timeline.selected_player_id };
  const reflection = { cueId: cue.id, selectedGoal: "TRADE" as const, response: "ANSWERED" as const, source: "USER" as const, limitations: [] };
  expect(buildTeachingDiagnosisInput(context, reflection).decisionResources?.aliveTeammates).toBe(0);
  snapshot.aliveCounts = { ...snapshot.aliveCounts, boundary: "GROUND_TRUTH" };
  expect(buildTeachingDiagnosisInput(context, reflection).decisionResources?.aliveTeammates).toBeUndefined();
  snapshot.aliveCounts = { ...snapshot.aliveCounts, boundary: "OBSERVABLE" };
  snapshot.decisionTick += 1;
  expect(buildTeachingDiagnosisInput(context, reflection).decisionResources?.aliveTeammates).toBeUndefined();
});
