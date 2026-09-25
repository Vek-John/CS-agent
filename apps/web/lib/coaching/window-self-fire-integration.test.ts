import { expect, it } from "vitest";
import { analyzeFire, fireReplay } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { consumeRoute } from "../../../../tools/validate-real-action-replay";
import { buildTeachingDiagnosisSubmissionEvent } from "./teaching-diagnosis-host";
import { parseRemoteCoachAgentDispatchEnvelope, createRemoteCoachAgentDispatchEnvelope } from "@cs-coach/coach-agent/client";

it.each(["DEATH", "HP_CHANGE"] as const)("naturally replays attributed window fire for %s after the real Session gate", async kind => {
  const bundle = analyzeFire(fireReplay(kind));
  const result = await consumeRoute({ plan: bundle.review_plan, set: bundle.candidate_set, observations: bundle.observation_evidence, tickRate: 64, hash: "a".repeat(64), player: 1 });
  expect(result.sessionCompleted).toBe(true);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ effectCount: 1, simulatedAckClosed: true, assessment: "INSUFFICIENT_EVIDENCE", command: { tool: "REPLAY_CUE_SLOW", speed: 0.5, callIdFromGraph: true } });
  expect(result.rows[0].failure).toBeUndefined();
  const cue = bundle.review_plan.cues[0];
  const event = buildTeachingDiagnosisSubmissionEvent({ plan: bundle.review_plan, cue, timeline: bundle.match_timeline, selectedPlayerId: bundle.selected_steam_id, material: bundle.candidate_set.materials.find(m => m.candidateId === cue.candidate_id) }, { cueId: cue.id, selectedGoal: "OTHER", source: "USER", response: "ANSWERED", limitations: [] }, { eventType: "SUBMIT_REFLECTION", eventId: "fire-diagnosis", identity: { demoId: bundle.demo_id, selectedPlayerId: bundle.selected_steam_id, demoContentHash: "a".repeat(64), routeId: bundle.review_plan.id, routeHash: "test-route", sessionId: "test-session", runId: "test-run" } });
  expect(event.input.playerActionFacts[0].presentationOnly).toBe(true);
  const decoded = parseRemoteCoachAgentDispatchEnvelope(JSON.parse(JSON.stringify(createRemoteCoachAgentDispatchEnvelope(event))));
  expect(decoded.event).toEqual(event);
});
