import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import {
  answerCurrentCueQuestion,
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
  state = reduceCoachingSession(plan, state, { type: "SKIP_SEGMENT" });
  state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
  state = reduceCoachingSession(plan, state, { type: "SKIP_SEGMENT" });
  state = reduceCoachingSession(plan, state, { type: "TICK", tick: 2350 });
  return state;
}

describe("CoachingSession deterministic safety kernel", () => {
  it("keeps skips explicit and allows the user to expand them", () => {
    let state = createCoachingSession(plan);
    state = reduceCoachingSession(plan, state, { type: "START" });

    expect(state.phase).toBe("SKIPPING");
    state = reduceCoachingSession(plan, state, { type: "EXPAND_SKIP" });
    expect(state.phase).toBe("PLAYING");
    expect(state.expanded_segment_ids).toContain("seg-r1-freeze");
  });

  it("pauses before the decision and does not reveal outcome facts to questions", () => {
    const state = reachFirstCue();
    const cue = getCurrentCue(plan, state);

    expect(state.phase).toBe("PAUSED_FOR_COACHING");
    expect(state.current_tick).toBe(cue?.decision_tick);

    const answer = answerCurrentCueQuestion(plan, state, "为什么不继续打？");
    expect(answer.citation_refs).not.toContain("fact-r2-outcome");
    expect(answer.text).not.toContain("先被击杀");
  });

  it("requires outcome reveal before advancing a teaching segment", () => {
    let state = reachFirstCue();
    const blocked = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
    expect(blocked).toEqual(state);

    state = reduceCoachingSession(plan, state, { type: "REVEAL_OUTCOME" });
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: 2700 });
    expect(state.revealed_cue_ids).toContain("cue-r2-overpeek");

    state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
    expect(state.consumed_cue_ids).toContain("cue-r2-overpeek");
    expect(state.current_segment_index).toBe(4);
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
        state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.decision_tick });
      } else if (state.phase === "PLAYING") {
        state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
      } else if (state.phase === "PAUSED_FOR_COACHING" && cue && !state.revealed_cue_ids.includes(cue.id)) {
        state = reduceCoachingSession(plan, state, { type: "REVEAL_OUTCOME" });
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
