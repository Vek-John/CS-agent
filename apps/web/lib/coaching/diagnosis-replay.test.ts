import { expect, it, vi } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { requestTeachingDiagnosisReplay } from "./diagnosis-replay";

function fixture() {
  const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());
  const cue = plan.cues[0];
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
  session = reduceCoachingSession(plan, session, { type: "TICK", tick: cue.outcome_end_tick });
  const { cueCase } = diagnoseTeachingCue({ cueId: cue.id, reflection: {
    cueId: cue.id, rawText: "等队友同步", selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [],
  }, decisionFacts: [], playerActionFacts: [], outcomeFacts: [] });
  return { plan, session, cueCase, busy: false, takenOver: false };
}

it.each([
  "busy", "takeover", "session", "cue", "case", "phase", "unrevealed", "gate", "gate-cue",
  "pending", "fallback", "reflection", "hinge", "diagnosticResult", "verdict", "transferRule",
] as const)("rejects %s without a replay transition or diagnostic mutation", boundary => {
  const live = fixture();
  const requested = { sessionId: live.session.id, cueId: live.cueCase.cueId };
  switch (boundary) {
    case "busy": live.busy = true; break;
    case "takeover": live.takenOver = true; break;
    case "session": requested.sessionId = "stale-session"; break;
    case "cue": requested.cueId = "stale-cue"; break;
    case "case": live.cueCase.cueId = "other-cue"; break;
    case "phase": live.session.phase = "REPLAYING"; break;
    case "unrevealed": live.session.revealed_cue_ids = []; break;
    case "gate": live.session.outcome_completion = undefined; break;
    case "gate-cue": live.session.outcome_completion!.cueId = "other-cue"; break;
    case "pending": live.cueCase.status = "REFLECTION_PENDING"; break;
    case "fallback": live.cueCase.status = "FALLBACK"; break;
    default: delete live.cueCase[boundary];
  }
  const before = structuredClone(live);
  const transition = vi.fn();
  expect(requestTeachingDiagnosisReplay(requested, () => live, transition)).toBe(false);
  expect(transition).not.toHaveBeenCalled();
  expect(live).toEqual(before);
});

it("leaves a real manual visit and its saved default-route cursor unchanged", () => {
  const live = fixture();
  const cue = live.plan.cues[0];
  const cursor = structuredClone(live.session.default_route_cursor);
  live.session = reduceCoachingSession(live.plan, live.session, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue.id, visitId: "manual-visit" });
  live.session = reduceCoachingSession(live.plan, live.session, { type: "TICK", tick: cue.outcome_end_tick });
  expect(live.session.manual_cue_visit).toBeDefined();
  expect(live.session.phase).toBe("PAUSED_FOR_COACHING");
  const before = structuredClone(live.session);
  const transition = vi.fn();
  expect(requestTeachingDiagnosisReplay({ sessionId: live.session.id, cueId: cue.id }, () => live, transition)).toBe(false);
  expect(transition).not.toHaveBeenCalled();
  expect(live.session).toEqual(before);
  expect(live.session.default_route_cursor).toEqual(cursor);
});
