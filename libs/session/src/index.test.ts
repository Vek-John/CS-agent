import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import {
  buildSessionSummary,
  canPresentOutcome,
  completeOutcomeGate,
  captureSessionRecovery,
  createOutcomeCompletionGate,
  createCoachingSession,
  getCurrentCue,
  reduceCoachingSession,
  rehydrateSessionRecovery
} from "./index";

const timeline = createSyntheticMirageTimeline();
const plan = createFixtureReviewPlan(timeline);

function reachFirstCue() {
  let state = createCoachingSession(plan);
  state = reduceCoachingSession(plan, state, { type: "START" });
  state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
  state = reduceCoachingSession(plan, state, { type: "TICK", tick: 2350 });
  return state;
}

function planWithThirdCue() {
  const sourceCue = plan.cues[1];
  if (!sourceCue) throw new Error("fixture third cue source missing");
  const segment = {
    id: "seg-r5-third",
    round_number: 5,
    start_tick: 6400,
    end_tick: 7600,
    mode: "DEEP_DIVE" as const,
    reason_code: "THIRD_CUE",
    display_reason: "第三个教学点",
    playback_speed: 1,
    cue_ids: ["cue-r5-third"],
    expandable: true
  };
  const cue = {
    ...sourceCue,
    id: "cue-r5-third",
    segment_id: segment.id,
    decision_tick: 6800,
    reveal_tick: 6900,
    outcome_start_tick: 6800,
    outcome_end_tick: 7100
  };
  return {
    ...plan,
    id: "plan-fixture-three-cues",
    segments: [...plan.segments, segment],
    cues: [...plan.cues, cue]
  };
}

function reachSecondCuePaused(testPlan: typeof plan) {
  const firstCue = testPlan.cues[0];
  const secondCue = testPlan.cues[1];
  if (!firstCue || !secondCue) throw new Error("fixture second cue missing");
  let state = createCoachingSession(testPlan);
  state = reduceCoachingSession(testPlan, state, { type: "START" });
  state = reduceCoachingSession(testPlan, state, {
    type: "TICK",
    tick: testPlan.segments[1]!.end_tick
  });
  state = reduceCoachingSession(testPlan, state, { type: "TICK", tick: firstCue.outcome_end_tick });
  state = reduceCoachingSession(testPlan, state, { type: "ADVANCE_SEGMENT" });
  state = reduceCoachingSession(testPlan, state, { type: "TICK", tick: secondCue.outcome_end_tick });
  return state;
}

describe("CoachingSession deterministic safety kernel", () => {
  it("auto-consumes freeze time while retaining it in the event log and full plan", () => {
    let state = createCoachingSession(plan);
    state = reduceCoachingSession(plan, state, { type: "START" });

    expect(state.phase).toBe("PLAYING");
    expect(state.current_segment_index).toBe(1);
    expect(state.current_tick).toBe(256);
    expect(plan.segments[0]).toMatchObject({
      id: "seg-r1-freeze",
      mode: "SKIP",
      reason_code: "FREEZE_TIME",
      start_tick: 0,
      end_tick: 256
    });
    expect(state.user_events).toContainEqual(
      expect.objectContaining({
        type: "SEGMENT_SKIPPED",
        segment_id: "seg-r1-freeze",
        at_tick: 256,
        detail: "AUTO_FREEZE_TIME"
      })
    );
  });

  it("keeps non-freeze skips explicit and expandable by the user", () => {
    const planWithManualSkip = {
      ...plan,
      id: "plan-fixture-manual-skip",
      segments: plan.segments.map((segment) =>
        segment.id === "seg-r1-freeze"
          ? { ...segment, reason_code: "LOW_VALUE_NO_SUBJECT_EVENT" }
          : segment
      )
    };
    let state = createCoachingSession(planWithManualSkip);
    state = reduceCoachingSession(planWithManualSkip, state, { type: "START" });

    expect(state.phase).toBe("SKIPPING");
    expect(state.current_segment_index).toBe(0);
    state = reduceCoachingSession(planWithManualSkip, state, { type: "EXPAND_SKIP" });
    expect(state.phase).toBe("PLAYING");
    expect(state.expanded_segment_ids).toContain("seg-r1-freeze");
  });

  it("keeps outcome unrevealed at the decision boundary", () => {
    const state = reachFirstCue();
    const cue = getCurrentCue(plan, state);

    expect(state.phase).toBe("REVEALING");
    expect(state.current_tick).toBe(cue?.decision_tick);
    expect(state.revealed_cue_ids).not.toContain(cue?.id);
  });

  it("buffers only at a natural segment boundary while the next cue is pending", () => {
    const cue = plan.cues[0];
    const cueSegment = plan.segments.find((segment) => segment.id === cue.segment_id);
    expect(cueSegment).toBeDefined();
    let state = createCoachingSession(plan, "buffering-session", {
      routeFingerprint: "route-fixture",
      readiness: { [cue.id]: "PENDING" }
    });
    state = reduceCoachingSession(plan, state, { type: "START" });
    expect(state.phase).toBe("PLAYING");

    state = reduceCoachingSession(plan, state, { type: "TICK", tick: plan.segments[1].end_tick });
    expect(state.phase).toBe("BUFFERING");
    expect(state.current_cue_id).toBe(cue.id);
    expect(state.current_tick).toBe(cueSegment!.start_tick);
    expect(state.user_events).toContainEqual(expect.objectContaining({
      type: "NARRATION_BUFFERED",
      cue_id: cue.id,
      detail: "NARRATION_PENDING"
    }));

    state = reduceCoachingSession(plan, state, { type: "NARRATION_READY", cueId: cue.id, readiness: "READY" });
    expect(state.phase).toBe("PLAYING");
    expect(state.buffered_from_phase).toBeUndefined();
    expect(state.narration_readiness?.[cue.id]).toBe("READY");
    expect(state.user_events).toContainEqual(expect.objectContaining({
      type: "NARRATION_READY",
      cue_id: cue.id,
      detail: "READY"
    }));
  });

  it("treats deterministic FALLBACK as playable and does not buffer ordinary gaps", () => {
    const cue = plan.cues[0];
    let state = createCoachingSession(plan, "fallback-session", {
      routeFingerprint: "route-fixture",
      readiness: { [cue.id]: "FALLBACK" }
    });
    state = reduceCoachingSession(plan, state, { type: "START" });
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: plan.segments[1].end_tick });
    expect(state.phase).toBe("PLAYING");
    expect(state.phase).not.toBe("BUFFERING");
    expect(state.current_cue_id).toBe(cue.id);

    const ordinary = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
    expect(ordinary.phase).toBe("PLAYING");
  });

  it("reveals the outcome only after continuous playback reaches its end", () => {
    let state = reachFirstCue();
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: plan.cues[0].outcome_end_tick - 1 });
    expect(state.phase).toBe("REVEALING");
    expect(state.revealed_cue_ids).not.toContain("cue-r2-overpeek");
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: plan.cues[0].outcome_end_tick });
    expect(state.phase).toBe("PAUSED_FOR_COACHING");
    expect(state.current_tick).toBe(plan.cues[0].decision_tick);
    expect(state.revealed_cue_ids).toContain("cue-r2-overpeek");

    state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
    expect(state.consumed_cue_ids).toContain("cue-r2-overpeek");
    expect(state.current_segment_index).toBe(5);
  });

  it("keeps the pure outcome presentation gate one-way across replay", () => {
    let state = reachFirstCue();
    const cue = plan.cues[0];
    expect(state.outcome_completion).toMatchObject({ cueId: cue.id, status: "LOCKED" });
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick - 1 });
    expect(state.outcome_completion?.status).toBe("LOCKED");
    expect(canPresentOutcome(state.outcome_completion ?? { cueId: cue.id, outcomeEndTick: cue.outcome_end_tick, status: "LOCKED" })).toBe(false);
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
    expect(state.outcome_completion).toMatchObject({ cueId: cue.id, status: "COMPLETE", completedAtTick: cue.outcome_end_tick });
    expect(canPresentOutcome(state.outcome_completion!)).toBe(true);

    state = reduceCoachingSession(plan, state, { type: "REPLAY_OUTCOME" });
    expect(state.outcome_completion).toMatchObject({ cueId: cue.id, status: "COMPLETE", completedAtTick: cue.outcome_end_tick });
    expect(canPresentOutcome(state.outcome_completion!)).toBe(true);
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
    expect(canPresentOutcome(state.outcome_completion!)).toBe(true);
  });

  it("captures and rehydrates a completed cue boundary with plan-derived coordinates", () => {
    const state = reduceCoachingSession(plan, reachFirstCue(), {
      type: "TICK",
      tick: plan.cues[0]!.outcome_end_tick,
    });
    const snapshot = captureSessionRecovery(plan, state, "CUE_PAUSED");

    expect(snapshot.boundary).toEqual({
      kind: "CUE_PAUSED",
      segmentId: plan.cues[0]!.segment_id,
      segmentIndex: plan.segments.findIndex((segment) => segment.id === plan.cues[0]!.segment_id),
      cueId: plan.cues[0]!.id,
    });
    expect(snapshot.boundary).not.toHaveProperty("current_tick");
    expect(snapshot.boundary).not.toHaveProperty("outcomeEndTick");

    const restored = rehydrateSessionRecovery(snapshot, plan);
    expect(restored).toMatchObject({
      id: state.id,
      phase: "PAUSED_FOR_COACHING",
      current_segment_index: state.current_segment_index,
      current_cue_id: state.current_cue_id,
      current_tick: plan.cues[0]!.decision_tick,
      consumed_cue_ids: state.consumed_cue_ids,
      revealed_cue_ids: state.revealed_cue_ids,
    });
    expect(restored.outcome_completion).toEqual({
      cueId: plan.cues[0]!.id,
      outcomeEndTick: plan.cues[0]!.outcome_end_tick,
      status: "COMPLETE",
      completedAtTick: plan.cues[0]!.outcome_end_tick,
    });
  });

  it("accepts only the untouched route start and plan-derived wrap-up boundaries", () => {
    const routeStart = captureSessionRecovery(plan, createCoachingSession(plan, "route-start"), "ROUTE_START");
    expect(rehydrateSessionRecovery(routeStart, plan)).toMatchObject({
      id: "route-start",
      phase: "INTRO",
      current_segment_index: 0,
      current_tick: plan.segments[0]!.start_tick,
    });

    let state = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
    let guard = 0;
    while (state.phase !== "WRAP_UP" && guard < 50) {
      guard += 1;
      const cue = getCurrentCue(plan, state);
      if (state.phase === "SKIPPING") state = reduceCoachingSession(plan, state, { type: "SKIP_SEGMENT" });
      else if (state.phase === "PLAYING" && cue && !state.revealed_cue_ids.includes(cue.id)) state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
      else if (state.phase === "PLAYING") state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
      else if (state.phase === "REVEALING" && cue) state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
      else if (state.phase === "PAUSED_FOR_COACHING") state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
    }
    const wrapUp = captureSessionRecovery(plan, state, "WRAP_UP");
    expect(wrapUp.boundary).toEqual({ kind: "WRAP_UP", segmentIndex: plan.segments.length });
    expect(rehydrateSessionRecovery(wrapUp, plan)).toMatchObject({ phase: "WRAP_UP", current_tick: plan.segments.at(-1)!.end_tick });
  });

  it("rejects an incomplete gate, route mismatch, and caller-supplied boundary coordinates", () => {
    const state = reachFirstCue();
    expect(() => captureSessionRecovery(plan, state, "CUE_PAUSED")).toThrow("completed outcome gate");

    const completed = reduceCoachingSession(plan, state, { type: "TICK", tick: plan.cues[0]!.outcome_end_tick });
    const snapshot = captureSessionRecovery(plan, completed, "CUE_PAUSED");
    expect(() => rehydrateSessionRecovery(snapshot, { ...plan, id: "different-plan" })).toThrow("route hash");
    expect(() => rehydrateSessionRecovery({
      ...snapshot,
      boundary: { kind: "WRAP_UP", segmentIndex: 99 },
    } as never)).toThrow("wrap-up index");
  });

  it("resets the active cue route when manual return deliberately re-walks it", () => {
    const cue = plan.cues[0];
    let state = reachFirstCue();
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
    expect(state.outcome_completion?.status).toBe("COMPLETE");
    state = reduceCoachingSession(plan, state, { type: "RETURN_TO_NEAREST_CUE", tick: cue.decision_tick });
    expect(state.revealed_cue_ids).not.toContain(cue.id);
    expect(state.outcome_completion).toBeUndefined();
  });

  it("returns manual playback to the nearest coaching cue and replays its context", () => {
    const firstCue = plan.cues[0];
    const secondCue = plan.cues[1];
    const firstSegmentIndex = plan.segments.findIndex((segment) => segment.id === firstCue.segment_id);
    const secondSegmentIndex = plan.segments.findIndex((segment) => segment.id === secondCue.segment_id);
    const firstSegment = plan.segments[firstSegmentIndex];
    const secondSegment = plan.segments[secondSegmentIndex];
    let state = reachFirstCue();

    state = {
      ...state,
      consumed_cue_ids: [firstCue.id, secondCue.id],
      revealed_cue_ids: [firstCue.id, secondCue.id]
    };
    state = reduceCoachingSession(plan, state, {
      type: "RETURN_TO_NEAREST_CUE",
      tick: secondCue.decision_tick - 1
    });

    expect(state).toMatchObject({
      phase: "PLAYING",
      current_segment_index: secondSegmentIndex,
      current_cue_id: secondCue.id,
      current_tick: secondSegment.start_tick
    });
    expect(state.consumed_cue_ids).toEqual([firstCue.id]);
    expect(state.revealed_cue_ids).toEqual([firstCue.id]);

    const midpoint = (firstCue.decision_tick + secondCue.decision_tick) / 2;
    state = reduceCoachingSession(plan, state, {
      type: "RETURN_TO_NEAREST_CUE",
      tick: midpoint
    });
    expect(state.current_segment_index).toBe(secondSegmentIndex);
    expect(state.current_tick).toBe(secondSegment.start_tick);
    expect(state.current_tick).not.toBe(firstSegment.start_tick);
  });

  it("revokes an unreconciled revealed cue during takeover so it pauses again after the target cue", () => {
    const testPlan = planWithThirdCue();
    const firstCue = testPlan.cues[0]!;
    const secondCue = testPlan.cues[1]!;
    const secondSegment = testPlan.segments.find((segment) => segment.id === secondCue.segment_id)!;
    let state = reachSecondCuePaused(testPlan);

    expect(state.consumed_cue_ids).toEqual([firstCue.id]);
    expect(state.revealed_cue_ids).toEqual([firstCue.id, secondCue.id]);

    state = reduceCoachingSession(testPlan, state, {
      type: "RETURN_TO_NEAREST_CUE",
      tick: firstCue.decision_tick
    });
    expect(state.consumed_cue_ids).toEqual([]);
    expect(state.revealed_cue_ids).toEqual([]);

    state = reduceCoachingSession(testPlan, state, { type: "TICK", tick: firstCue.outcome_end_tick });
    state = reduceCoachingSession(testPlan, state, { type: "ADVANCE_SEGMENT" });
    state = reduceCoachingSession(testPlan, state, { type: "TICK", tick: secondCue.outcome_end_tick });

    expect(state.current_cue_id).toBe(secondCue.id);
    expect(state.current_segment_index).toBe(testPlan.segments.indexOf(secondSegment));
    expect(state.phase).toBe("PAUSED_FOR_COACHING");
    expect(state.outcome_completion).toMatchObject({ cueId: secondCue.id, status: "COMPLETE" });
  });

  it("does not force a second teaching pass for a revealed cue that was already consumed", () => {
    const testPlan = planWithThirdCue();
    const firstCue = testPlan.cues[0]!;
    const secondCue = testPlan.cues[1]!;
    const thirdCue = testPlan.cues[2]!;
    const secondSegment = testPlan.segments.find((segment) => segment.id === secondCue.segment_id)!;
    let state = reachSecondCuePaused(testPlan);

    state = {
      ...state,
      consumed_cue_ids: [firstCue.id, secondCue.id]
    };
    state = reduceCoachingSession(testPlan, state, {
      type: "RETURN_TO_NEAREST_CUE",
      tick: firstCue.decision_tick
    });
    state = reduceCoachingSession(testPlan, state, { type: "TICK", tick: firstCue.outcome_end_tick });
    state = reduceCoachingSession(testPlan, state, { type: "ADVANCE_SEGMENT" });
    state = reduceCoachingSession(testPlan, state, { type: "TICK", tick: secondSegment.end_tick });
    let guard = 0;
    while (state.current_cue_id !== thirdCue.id && guard < 4) {
      const currentSegment = testPlan.segments[state.current_segment_index];
      if (!currentSegment) break;
      state = reduceCoachingSession(testPlan, state, { type: "TICK", tick: currentSegment.end_tick });
      guard += 1;
    }

    expect(state.current_cue_id).toBe(thirdCue.id);
    expect(state.phase).toBe("PLAYING");
    expect(state.revealed_cue_ids).toContain(secondCue.id);
  });

  it("unlocks a summary only after the entire path is consumed", () => {
    let state = createCoachingSession(plan);
    expect(() => buildSessionSummary(plan, state)).toThrow("stays locked");
    state = reduceCoachingSession(plan, state, { type: "START" });

    let guard = 0;
    while (state.phase !== "WRAP_UP" && guard < 50) {
      guard += 1;
      const cue = getCurrentCue(plan, state);
      if (state.phase === "SKIPPING") {
        state = reduceCoachingSession(plan, state, { type: "SKIP_SEGMENT" });
      } else if (state.phase === "PLAYING" && cue && !state.revealed_cue_ids.includes(cue.id)) {
        state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
      } else if (state.phase === "PLAYING") {
        state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
      } else if (state.phase === "REVEALING" && cue) {
        state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
      } else if (state.phase === "PAUSED_FOR_COACHING") {
        state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
      }
    }

    expect(guard).toBeLessThan(50);
    expect(state.phase).toBe("WRAP_UP");
    const summary = buildSessionSummary(plan, state);
    expect(summary.representative_rounds).toEqual([2, 3]);
    expect(summary.positive).toContain("2 个关键讲解点");
    expect(summary.positive).not.toContain("第四回合");
    expect(summary.next_match_goal).toBe(plan.cues.at(-1)?.advice[0]?.text);
    expect(summary.checkpoints).toEqual([
      "拿到人数领先且最近队友无法在约 2 秒内补枪",
      "准备越过不可回撤的拐角之前"
    ]);

    state = reduceCoachingSession(plan, state, { type: "COMPLETE_SESSION" });
    expect(state.phase).toBe("COMPLETED");
  });
});
