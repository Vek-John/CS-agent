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
  snapshot.roundNumber = 2;
  const material = {
    candidateId: "candidate", decisionSnapshot: snapshot, decisionFacts: cue.facts.filter((fact) => fact.availability === "DECISION"), playerActionFacts: [], outcomeFacts: [], inferences: [], advice: [], evidence: [], limitations: [],
  };
  const state = { player_id: timeline.selected_player_id, tick: cue.decision_tick, side: "T" as const, world_position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, alive: true, health: 2, armor: 0, has_helmet: false, inventory: [], fact_refs: cue.observable_fact_refs, missing_fields: [] };
  const context = { plan, cue, material, timeline: { ...timeline, player_state_tracks: [state] }, selectedPlayerId: timeline.selected_player_id };
  const reflection = { cueId: cue.id, selectedGoal: "TRADE" as const, response: "ANSWERED" as const, source: "USER" as const, limitations: [] };
  expect(buildTeachingDiagnosisInput(context, reflection).decisionRoster?.aliveTeammates).toBe(0);
  snapshot.aliveCounts = { ...snapshot.aliveCounts, boundary: "GROUND_TRUTH" };
  expect(buildTeachingDiagnosisInput(context, reflection).decisionRoster?.aliveTeammates).toBeUndefined();
  snapshot.aliveCounts = { ...snapshot.aliveCounts, boundary: "OBSERVABLE" };
  snapshot.decisionTick += 1;
  expect(buildTeachingDiagnosisInput(context, reflection).decisionRoster?.aliveTeammates).toBeUndefined();
});


it.each([false, true])("Host resource diagnosis does not count weapons or missing inventory (missing=%s)", async (missing) => {
  const { runTeachingDiagnosis } = await import("./teaching-diagnosis-host");
  const { createSyntheticMirageTimeline } = await import("@cs-coach/demo-domain");
  const { createFixtureReviewPlan } = await import("@cs-coach/review-planner");
  const timeline = createSyntheticMirageTimeline();
  const plan = createFixtureReviewPlan(timeline);
  const cue = plan.cues[0];
  const state = { player_id: timeline.selected_player_id, tick: cue.decision_tick, side: "T" as const, world_position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, alive: true, health: 100, armor: 100, has_helmet: true, inventory: missing ? [] : [{ item_id: "ak47", item_class: "WEAPON", count: 1 }], fact_refs: cue.observable_fact_refs, missing_fields: missing ? ["inventory"] : [] };
  const output = runTeachingDiagnosis({ plan, cue, timeline: { ...timeline, player_state_tracks: [state] }, selectedPlayerId: timeline.selected_player_id }, { cueId: cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] });
  const measurement = output.cueCase.diagnosticResult?.measurements.find(item => item.label === "决策时道具数量");
  expect(measurement?.value).toBe(missing ? undefined : 0);
});

it.each([
  { name: "mixed", inventory: [{ item_id: "ak47", item_class: "WEAPON", count: 1 }, { item_id: "flash", item_class: "UTILITY", count: 2 }], missing: [], expected: 2 },
  { name: "known empty", inventory: [], missing: [], expected: 0 },
  { name: "partial", inventory: [{ item_id: "flash", item_class: "UTILITY", count: 1 }], missing: ["inventory"], expected: undefined },
  { name: "unsupported", inventory: [{ item_id: "smokegrenade", item_class: "UNKNOWN", count: 1 }], missing: [], expected: undefined },
  { name: "fractional", inventory: [{ item_id: "flash", item_class: "UTILITY", count: 0.5 }], missing: [], expected: undefined },
])("keeps Host, strict Graph packet and deterministic API utility counts aligned: $name", async ({ inventory, missing, expected }) => {
  const { buildTeachingDiagnosisSubmissionEvent, runTeachingDiagnosis } = await import("./teaching-diagnosis-host");
  const { createSyntheticMirageTimeline } = await import("@cs-coach/demo-domain");
  const { createFixtureReviewPlan } = await import("@cs-coach/review-planner");
  const { createCoachAgentRuntime, createRemoteCoachAgentDispatchEnvelope, parseRemoteCoachAgentDispatchEnvelope } = await import("@cs-coach/coach-agent");
  const { fixtureIdentity } = await import("../../../../libs/coach-agent/src/test-fixtures");
  const { POST } = await import("../../app/api/coaching/diagnose/route");
  const timeline = createSyntheticMirageTimeline();
  const plan = createFixtureReviewPlan(timeline);
  const cue = plan.cues[0];
  const state = { player_id: timeline.selected_player_id, tick: cue.decision_tick, side: "T" as const, world_position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, alive: true, health: 100, armor: 100, has_helmet: true, inventory, fact_refs: cue.observable_fact_refs, missing_fields: missing };
  const context = { plan, cue, timeline: { ...timeline, player_state_tracks: [state] }, selectedPlayerId: timeline.selected_player_id };
  const reflection = { cueId: cue.id, selectedGoal: "OTHER" as const, response: "ANSWERED" as const, source: "USER" as const, limitations: [] };
  const event = buildTeachingDiagnosisSubmissionEvent(context, reflection, { eventType: "SUBMIT_REFLECTION", eventId: "utility-reflection", identity: { ...fixtureIdentity, selectedPlayerId: timeline.selected_player_id } });
  expect(event.input.decisionResources?.utilityCount).toBe(expected);
  expect(event.input.decisionResources).not.toHaveProperty("inventoryCount");
  expect(event.input).not.toHaveProperty("decisionState");
  expect(JSON.stringify(event.input.decisionResources)).not.toMatch(/item_id|player_id|position|tick|inventory/);
  const envelope = parseRemoteCoachAgentDispatchEnvelope(JSON.parse(JSON.stringify(createRemoteCoachAgentDispatchEnvelope(event))));
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  const dispatched = await runtime.dispatch(envelope.event);
  const local = runTeachingDiagnosis(context, reflection);
  const body = await (await POST(new Request("http://localhost/api/coaching/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "START", outcomeGateStatus: "COMPLETE", input: { ...event.input, reflection } }) }))).json();
  expect(body.status).toBe("SUCCEEDED");
  expect(dispatched.status).toBe("COMPLETED");
  for (const result of [local.cueCase.diagnosticResult, dispatched.state.cueCases[cue.id]?.diagnosticResult, body.cueCase.diagnosticResult]) {
    expect(result?.measurements.find((item: { label: string }) => item.label === "决策时道具数量")?.value).toBe(expected);
    expect(result?.status).toBe(local.cueCase.diagnosticResult?.status);
  }
  const duplicate = await runtime.dispatch(envelope.event);
  expect(duplicate.state.cueCases).toEqual(dispatched.state.cueCases);
  expect(duplicate.state.cueCases[cue.id]?.attemptBudget.reflection).toBe(1);
  expect(duplicate.state.trace).toEqual(dispatched.state.trace);
});
