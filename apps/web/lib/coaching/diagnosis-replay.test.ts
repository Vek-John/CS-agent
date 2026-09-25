import { expect, it, vi } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createCoachingSession, reduceCoachingSession, type OutcomeReplayAction } from "@cs-coach/session";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { HostOutcomeReplayGuard, newManualVisitId, outcomeReplayInteractionKey, requestCurrentOutcomeReplay, requestTeachingDiagnosisReplay } from "./diagnosis-replay";
import { HostPlaybackControl } from "../playback/cs2d-playback-host";
import { guidedPlaybackDirective } from "./cs2d-guided-session";

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

it("refuses unbound replay in a manual visit without changing its default-route cursor", () => {
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

it.each([true, false])("runs the production Host entry for manual replay with diagnosis=%s", requireDiagnosis => {
  const live = fixture(); const cue = live.plan.cues[0];
  live.session = reduceCoachingSession(live.plan, live.session, { type: "RECORD_TEACHING_CASE", cueCase: live.cueCase });
  live.session = reduceCoachingSession(live.plan, live.session, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue.id, visitId: "manual-replay" });
  live.session = reduceCoachingSession(live.plan, live.session, { type: "TICK", tick: cue.outcome_end_tick });
  live.takenOver = true;
  const before = structuredClone(live.session);
  const target = { sessionId: live.session.id, cueId: cue.id, visitId: live.session.manual_cue_visit!.visit_id };
  const control = new HostPlaybackControl(); control.pause(); const epoch = control.epoch;
  const guard = new HostOutcomeReplayGuard();
  const notifyTransport = vi.fn(), invalidateSeek = vi.fn(), clearTakeover = vi.fn();
  const records = new Map<string, unknown>(); const queued: OutcomeReplayAction[] = [];
  const transition = (action: OutcomeReplayAction) => {
    if (!guard.begin({ ...live, action, control, notifyTransport, invalidateSeek, clearTakeover })) return;
    records.set(outcomeReplayInteractionKey(live.session, action), action);
    queued.push(action); // Model React's state update queue before liveSessionRef changes.
  };
  const read = () => ({ ...live, intentEpoch: control.epoch });
  expect(requestCurrentOutcomeReplay(target, read, transition, requireDiagnosis, epoch)).toBe(true);
  expect(requestCurrentOutcomeReplay(target, read, transition, requireDiagnosis, epoch)).toBe(false);
  transition(queued[0]); // Same state reference is also guarded against direct duplicate dispatch.
  expect(queued).toHaveLength(1); expect(records.size).toBe(1);
  expect(control.holding).toBe(false); expect(live.takenOver).toBe(true);
  expect(clearTakeover).not.toHaveBeenCalled(); expect(notifyTransport).toHaveBeenCalledOnce(); expect(invalidateSeek).toHaveBeenCalledOnce();
  live.session = reduceCoachingSession(live.plan, live.session, queued[0]);
  expect(live.session.phase).toBe("REPLAYING");
  const commands = guidedPlaybackDirective(live.plan, live.session, 64).commands;
  expect(commands).toContainEqual({ type: "play" });
  expect(commands).toContainEqual({ type: "seekCanonicalTick", canonicalTick: Math.max(live.plan.segments[live.session.current_segment_index].start_tick, cue.decision_tick - 64) });
  control.pause(); expect(control.canAdvance(live.session, true)).toBe(false);
  control.observe(false); control.resume(); expect(control.canAdvance(live.session, true)).toBe(true);
  live.session = reduceCoachingSession(live.plan, live.session, { type: "TICK", tick: cue.outcome_end_tick });
  expect(live.session).toMatchObject({ phase: "PAUSED_FOR_COACHING", current_tick: cue.decision_tick, manual_cue_visit: before.manual_cue_visit });
  for (const key of ["default_route_cursor", "revealed_cue_ids", "presented_cue_ids", "consumed_cue_ids", "cue_cases", "learning_threads", "outcome_completion"] as const) expect(live.session[key]).toEqual(before[key]);
  expect(guidedPlaybackDirective(live.plan, live.session).commands).toContainEqual({ type: "pause" });
  expect(guidedPlaybackDirective(live.plan, live.session).commands).toContainEqual({ type: "seekCanonicalTick", canonicalTick: cue.decision_tick });
  expect(requestCurrentOutcomeReplay(target, read, transition, requireDiagnosis, control.epoch)).toBe(true);
  expect(queued).toHaveLength(2); expect(records.size).toBe(1); // Another explicit replay, same idempotent visit record.
  live.session = reduceCoachingSession(live.plan, live.session, queued[1]);
  expect(live.session.phase).toBe("REPLAYING");
  live.session = reduceCoachingSession(live.plan, live.session, { type: "TICK", tick: cue.outcome_end_tick });
  expect(live.session.manual_cue_visit).toEqual(before.manual_cue_visit);
  const returned = reduceCoachingSession(live.plan, live.session, { type: "RETURN_TO_DEFAULT_ROUTE" });
  expect(returned.manual_cue_visit).toBeUndefined(); expect(returned.default_route_cursor).toEqual(before.default_route_cursor);
});

it("rejects old callbacks after immediate free-seek intent, even before React publishes manual cancellation", () => {
  const live = fixture(); const cueId = live.cueCase.cueId;
  live.session = reduceCoachingSession(live.plan, live.session, { type: "BEGIN_MANUAL_CUE_VISIT", cueId, visitId: "visit" });
  live.session = reduceCoachingSession(live.plan, live.session, { type: "TICK", tick: live.plan.cues[0].outcome_end_tick });
  live.takenOver = true;
  const control = new HostPlaybackControl(), renderedEpoch = control.epoch;
  const oldSession = live.session;
  control.reset(); // Actual markUserTookOver changes this immediately; reducer cancellation is still queued.
  const transition = vi.fn();
  expect(requestCurrentOutcomeReplay({ sessionId: live.session.id, cueId, visitId: "visit" }, () => ({ ...live, intentEpoch: control.epoch }), transition, false, renderedEpoch)).toBe(false);
  expect(transition).not.toHaveBeenCalled(); expect(live.session).toBe(oldSession);
});

it.each(["session", "cue", "visit", "missing-target", "busy", "gate", "end", "confirmed"])("refuses %s before Host resets or persistence", reason => {
  const live = fixture(), cue = live.plan.cues[0];
  live.session = reduceCoachingSession(live.plan, live.session, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue.id, visitId: "visit" });
  live.session = reduceCoachingSession(live.plan, live.session, { type: "TICK", tick: cue.outcome_end_tick });
  const action: OutcomeReplayAction = { type: "REPLAY_OUTCOME", target: { sessionId: live.session.id, cueId: cue.id, visitId: "visit" } };
  if (reason === "session") action.target!.sessionId = "old";
  if (reason === "cue") action.target!.cueId = "old";
  if (reason === "visit") action.target!.visitId = "old";
  if (reason === "missing-target") delete action.target;
  if (reason === "busy") live.busy = true;
  if (reason === "gate") live.session.outcome_completion = undefined;
  if (reason === "end") live.session.outcome_completion!.outcomeEndTick++;
  if (reason === "confirmed") live.session.outcome_completion!.completedAtTick = cue.outcome_end_tick - 1;
  const control = new HostPlaybackControl(); control.pause();
  const sideEffect = vi.fn(); const epoch = control.epoch;
  expect(new HostOutcomeReplayGuard().begin({ ...live, action, control, notifyTransport: sideEffect, invalidateSeek: sideEffect, clearTakeover: sideEffect })).toBe(false);
  expect(sideEffect).not.toHaveBeenCalled(); expect(control.epoch).toBe(epoch); expect(control.holding).toBe(true);
  if (reason !== "busy") expect(reduceCoachingSession(live.plan, live.session, action)).toBe(live.session);
});

it("preserves legacy default replay reset and gives visits bounded, distinct interaction keys", () => {
  const live = fixture(), control = new HostPlaybackControl(); control.pause();
  const clearTakeover = vi.fn(() => control.reset()); const untouched = vi.fn();
  expect(new HostOutcomeReplayGuard().begin({ ...live, control, action: { type: "REPLAY_OUTCOME" }, clearTakeover, notifyTransport: untouched, invalidateSeek: untouched })).toBe(true);
  expect(clearTakeover).toHaveBeenCalledOnce(); expect(control.holding).toBe(false); expect(untouched).not.toHaveBeenCalled();
  const first = newManualVisitId(), second = newManualVisitId();
  expect(first).not.toBe(second); expect(first.length).toBeLessThan(80);
  const key = (visitId: string) => outcomeReplayInteractionKey(live.session, { type: "REPLAY_OUTCOME", target: { sessionId: live.session.id, cueId: live.cueCase.cueId, visitId } });
  expect(key(first)).toBe(key(first)); expect(key(first)).not.toBe(key(second));
  expect(key("v".repeat(159) + "a")).not.toBe(key("v".repeat(159) + "b"));
  expect(key(first).length).toBeLessThan(80);
});
