import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import {
  buildSessionSummary,
  createCoachingSession,
  getCurrentCue,
  reduceCoachingSession
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
