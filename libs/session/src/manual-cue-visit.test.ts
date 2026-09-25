import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import type { ReviewPlan } from "@cs-coach/contracts";
import {
  captureSessionRecovery,
  createCoachingSession,
  getCurrentCue,
  reduceCoachingSession,
  rehydrateSessionRecovery,
} from "./index";

const basePlan = createFixtureReviewPlan(createSyntheticMirageTimeline());

function planWithManualTargets(): ReviewPlan {
  const source = basePlan.cues[1]!;
  const extra = [
    { id: "cue-r5-manual-3", segmentId: "seg-r5-manual-3", start: 6400, decision: 6800, end: 7100 },
    { id: "cue-r6-manual-4", segmentId: "seg-r6-manual-4", start: 7600, decision: 8000, end: 8300 },
  ];
  return {
    ...basePlan,
    id: "plan-manual-cue-visits",
    segments: [
      ...basePlan.segments,
      ...extra.map((cue, index) => ({
        id: cue.segmentId,
        round_number: 5 + index,
        start_tick: cue.start,
        end_tick: cue.end + 100,
        mode: "DEEP_DIVE" as const,
        reason_code: "MANUAL_FIXTURE",
        display_reason: "手动点播夹具",
        playback_speed: 1,
        cue_ids: [cue.id],
        expandable: true,
      })),
    ],
    cues: [
      ...basePlan.cues,
      ...extra.map((cue) => ({
        ...source,
        id: cue.id,
        segment_id: cue.segmentId,
        decision_tick: cue.decision,
        reveal_tick: cue.decision + 40,
        outcome_start_tick: cue.decision,
        outcome_end_tick: cue.end,
      })),
    ],
  };
}

function firstCuePaused(plan: ReviewPlan, readiness?: Record<string, "PENDING" | "READY" | "FALLBACK">) {
  const firstCue = plan.cues[0]!;
  let state = createCoachingSession(plan, "manual-visit-session", readiness ? { routeFingerprint: "manual-visit-route", readiness } : undefined);
  state = reduceCoachingSession(plan, state, { type: "START" });
  state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
  return reduceCoachingSession(plan, state, { type: "TICK", tick: firstCue.outcome_end_tick });
}

function completeManualCue(plan: ReviewPlan, state: ReturnType<typeof createCoachingSession>, cueId: string, visitId: string) {
  const cue = plan.cues.find((candidate) => candidate.id === cueId)!;
  let next = reduceCoachingSession(plan, state, { type: "BEGIN_MANUAL_CUE_VISIT", cueId, visitId });
  next = reduceCoachingSession(plan, next, { type: "TICK", tick: cue.outcome_end_tick });
  return next;
}

describe("ManualCueVisit separates temporary presentation from the default route", () => {
  it.each([true, false])("replays only the completed matching visit, default-seen=%s", seen => {
    const plan = planWithManualTargets();
    const cue = seen ? plan.cues[0] : plan.cues.at(-1)!;
    const paused = firstCuePaused(plan);
    const target = { sessionId: paused.id, cueId: cue.id, visitId: "manual-replay" };
    const action = { type: "REPLAY_OUTCOME" as const, target };
    let state = reduceCoachingSession(plan, paused, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue.id, visitId: target.visitId });
    expect(state.outcome_completion).toBeUndefined();
    expect(reduceCoachingSession(plan, state, action)).toBe(state);
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.decision_tick });
    expect(reduceCoachingSession(plan, state, action)).toBe(state);
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
    expect(state.revealed_cue_ids.includes(cue.id)).toBe(seen);
    const stale = { type: "REPLAY_OUTCOME" as const, target: { ...target, visitId: "stale-visit" } };
    expect(reduceCoachingSession(plan, state, stale)).toBe(state);
    const replaying = reduceCoachingSession(plan, state, action);
    expect(replaying.phase).toBe("REPLAYING");
    expect(replaying.manual_cue_visit).toEqual(state.manual_cue_visit);
    expect(replaying.default_route_cursor).toEqual(paused.default_route_cursor);
    const returned = reduceCoachingSession(plan, replaying, { type: "TICK", tick: cue.outcome_end_tick });
    expect(returned.current_tick).toBe(cue.decision_tick);
    expect(returned.manual_cue_visit).toEqual(state.manual_cue_visit);
    expect(returned.revealed_cue_ids).toEqual(state.revealed_cue_ids);
    expect(returned.consumed_cue_ids).toEqual(state.consumed_cue_ids);
    expect(returned.presented_cue_ids).toEqual(state.presented_cue_ids);
  });
  it("runs a frozen cue through outcome and gate without changing the paused default cursor", () => {
    const plan = planWithManualTargets();
    const cue1 = plan.cues[0]!;
    const cue4 = plan.cues.at(-1)!;
    const paused = firstCuePaused(plan);
    const expectedDefault = paused.default_route_cursor;
    let manual = reduceCoachingSession(plan, paused, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue4.id, visitId: "visit-cue4" });
    manual = reduceCoachingSession(plan, manual, { type: "CUE_PRESENTED", cueId: cue4.id, visitId: "visit-cue4" });
    expect(manual.presented_cue_ids).toEqual([]);
    manual = reduceCoachingSession(plan, manual, { type: "TICK", tick: cue4.outcome_end_tick });

    expect(manual.manual_cue_visit).toEqual({ visit_id: "visit-cue4", cue_id: cue4.id });
    expect(manual.default_route_cursor).toEqual(expectedDefault);
    expect(manual).toMatchObject({
      phase: "PAUSED_FOR_COACHING",
      current_cue_id: cue4.id,
      current_tick: cue4.decision_tick,
      outcome_completion: { cueId: cue4.id, status: "COMPLETE" },
    });
    expect(manual.consumed_cue_ids).not.toContain(cue4.id);
    expect(manual.revealed_cue_ids).toContain(cue1.id);
    expect(manual.revealed_cue_ids).not.toContain(cue4.id);
  });

  it("revisits an already presented default cue through a fresh outcome gate without advancing the route", () => {
    const plan = planWithManualTargets();
    const cue = plan.cues[0]!;
    const segment = plan.segments.find((candidate) => candidate.id === cue.segment_id)!;
    const paused = reduceCoachingSession(plan, firstCuePaused(plan), {
      type: "CUE_PRESENTED", cueId: cue.id,
    });
    expect(paused.presented_cue_ids).toEqual([cue.id]);

    // Free viewing leaves the reducer-owned default cursor untouched. The
    // Host starts this visit when "讲解最近教练点" targets the same viewed cue.
    let state = reduceCoachingSession(plan, paused, {
      type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue.id, visitId: "revisit-presented-cue",
    });
    expect(state.outcome_completion).toBeUndefined();
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.decision_tick });
    expect(state).toMatchObject({
      phase: "REVEALING",
      current_cue_id: cue.id,
      outcome_completion: { cueId: cue.id, status: "LOCKED" },
    });

    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
    expect(state).toMatchObject({
      phase: "PAUSED_FOR_COACHING",
      current_cue_id: cue.id,
      current_tick: cue.decision_tick,
      outcome_completion: { cueId: cue.id, status: "COMPLETE" },
      manual_cue_visit: { visit_id: "revisit-presented-cue", cue_id: cue.id },
    });
    const completedVisit = state;
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: segment.end_tick });
    state = reduceCoachingSession(plan, state, {
      type: "CUE_PRESENTED", cueId: cue.id, visitId: "revisit-presented-cue",
    });
    expect(state).toEqual(completedVisit);
    expect(state.default_route_cursor).toEqual(paused.default_route_cursor);
    expect(state.revealed_cue_ids).toEqual(paused.revealed_cue_ids);
    expect(state.consumed_cue_ids).toEqual(paused.consumed_cue_ids);
    expect(state.presented_cue_ids).toEqual(paused.presented_cue_ids);
    expect(state.user_events.filter((entry) => entry.type === "CUE_PRESENTED")).toHaveLength(1);
    expect(state.user_events.filter((entry) => entry.type === "OUTCOME_REVEALED")).toHaveLength(1);
    expect(state.user_events.filter((entry) => entry.type === "OUTCOME_REPLAYED")).toHaveLength(1);

    const returned = reduceCoachingSession(plan, state, { type: "CANCEL_MANUAL_CUE_VISIT" });
    expect(returned).toMatchObject({
      phase: paused.phase,
      current_cue_id: paused.current_cue_id,
      current_tick: paused.current_tick,
      outcome_completion: paused.outcome_completion,
      default_route_cursor: paused.default_route_cursor,
    });
    expect(returned.manual_cue_visit).toBeUndefined();
    expect(returned.user_events).toEqual(state.user_events);
  });

  it("rejects a PENDING manual target before it can enter a playback or policy-capable state", () => {
    const plan = planWithManualTargets();
    const cue4 = plan.cues.at(-1)!;
    const paused = firstCuePaused(plan, { [cue4.id]: "PENDING" });
    const rejected = reduceCoachingSession(plan, paused, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue4.id, visitId: "pending-cue4" });

    expect(rejected.manual_cue_visit).toBeUndefined();
    expect(rejected.default_route_cursor).toEqual(paused.default_route_cursor);
    expect(rejected.current_cue_id).toBe(paused.current_cue_id);
    expect(rejected.phase).toBe("PAUSED_FOR_COACHING");
  });

  it("marks a complete manual cue presented exactly once and restores the original default pause", () => {
    const plan = planWithManualTargets();
    const cue1 = plan.cues[0]!;
    const cue4 = plan.cues.at(-1)!;
    const paused = firstCuePaused(plan);
    let state = completeManualCue(plan, paused, cue4.id, "present-cue4");

    state = reduceCoachingSession(plan, state, { type: "CUE_PRESENTED", cueId: cue4.id, visitId: "present-cue4" });
    state = reduceCoachingSession(plan, state, { type: "CUE_PRESENTED", cueId: cue4.id, visitId: "present-cue4" });
    expect(state.presented_cue_ids).toEqual([cue4.id]);
    expect(state.consumed_cue_ids).not.toContain(cue4.id);
    const snapshot = captureSessionRecovery(plan, state, "CUE_PAUSED");
    expect(snapshot).toMatchObject({ schemaVersion: "session-recovery-session.v2", presentedCueIds: [cue4.id] });
    expect(rehydrateSessionRecovery(snapshot, plan).presented_cue_ids).toEqual([cue4.id]);

    state = reduceCoachingSession(plan, state, { type: "RETURN_TO_DEFAULT_ROUTE" });
    expect(state).toMatchObject({
      phase: "PAUSED_FOR_COACHING",
      current_cue_id: cue1.id,
      current_tick: cue1.decision_tick,
      outcome_completion: { cueId: cue1.id, status: "COMPLETE" },
      manual_cue_visit: undefined,
    });
  });

  it("keeps one default cursor across consecutive manual visits and captures only that stable boundary", () => {
    const plan = planWithManualTargets();
    const cue3 = plan.cues.at(-2)!;
    const cue4 = plan.cues.at(-1)!;
    const paused = firstCuePaused(plan);
    let state = reduceCoachingSession(plan, paused, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue4.id, visitId: "visit-cue4" });
    const defaultCursor = state.default_route_cursor;
    state = reduceCoachingSession(plan, state, { type: "BEGIN_MANUAL_CUE_VISIT", cueId: cue3.id, visitId: "visit-cue3" });

    expect(state.manual_cue_visit).toEqual({ visit_id: "visit-cue3", cue_id: cue3.id });
    expect(state.default_route_cursor).toEqual(defaultCursor);
    const snapshot = captureSessionRecovery(plan, state, "CUE_PAUSED");
    expect(snapshot.boundary).toMatchObject({ kind: "CUE_PAUSED", cueId: plan.cues[0]!.id });
    const restored = rehydrateSessionRecovery(snapshot, plan);
    expect(restored).toMatchObject({
      current_cue_id: plan.cues[0]!.id,
      phase: "PAUSED_FOR_COACHING",
    });
    expect(restored.manual_cue_visit).toBeUndefined();
  });

  it("passes a Presented cue through the default timeline and consumes it once only when leaving its segment", () => {
    const plan = planWithManualTargets();
    const cue4 = plan.cues.at(-1)!;
    let state = firstCuePaused(plan);
    state = completeManualCue(plan, state, cue4.id, "presented-pass");
    state = reduceCoachingSession(plan, state, { type: "CUE_PRESENTED", cueId: cue4.id, visitId: "presented-pass" });
    state = reduceCoachingSession(plan, state, { type: "CANCEL_MANUAL_CUE_VISIT" });

    let guard = 0;
    while (getCurrentCue(plan, state)?.id !== cue4.id && guard++ < 12) {
      const cue = getCurrentCue(plan, state);
      if (state.phase === "PAUSED_FOR_COACHING") state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
      else if (state.phase === "PLAYING") state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue?.outcome_end_tick ?? plan.segments[state.current_segment_index]!.end_tick });
      else if (state.phase === "SKIPPING") state = reduceCoachingSession(plan, state, { type: "SKIP_SEGMENT" });
      else throw new Error(`unexpected default phase ${state.phase}`);
    }

    const cue4Segment = plan.segments.find((segment) => segment.id === cue4.segment_id)!;
    expect(state).toMatchObject({ phase: "PLAYING", current_cue_id: cue4.id });
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue4Segment.end_tick - 1 });
    expect(state.phase).toBe("PLAYING");
    expect(state.consumed_cue_ids).not.toContain(cue4.id);
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue4Segment.end_tick });
    expect(state.consumed_cue_ids.filter((cueId) => cueId === cue4.id)).toHaveLength(1);
    expect(state.user_events.filter((entry) => entry.cue_id === cue4.id && entry.type === "OUTCOME_REVEALED")).toHaveLength(0);
  });
});
