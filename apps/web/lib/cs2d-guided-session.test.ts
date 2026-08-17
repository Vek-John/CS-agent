import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import { guidedPlaybackDirective, guidedTransitionKey } from "./cs2d-guided-session";

const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());

describe("cs2d guided session synchronization", () => {
  it("maps playback, coaching pause and reveal onto the same canonical player", () => {
    let state = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
    const playing = guidedPlaybackDirective(plan, state);
    expect(playing.commands).toEqual([
      { type: "setCamera", mode: "full" },
      { type: "setSpeed", speed: 4 },
      { type: "seekCanonicalTick", canonicalTick: 256 },
      { type: "play" }
    ]);

    state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: 2350 });
    expect(state.phase).toBe("PAUSED_FOR_COACHING");
    expect(guidedPlaybackDirective(plan, state).commands).toEqual([
      { type: "setCamera", mode: "target" },
      { type: "pause" },
      { type: "seekCanonicalTick", canonicalTick: plan.cues[0].decision_tick }
    ]);

    state = reduceCoachingSession(plan, state, { type: "REVEAL_OUTCOME" });
    expect(guidedPlaybackDirective(plan, state).commands).toEqual([
      { type: "setCamera", mode: "full" },
      { type: "setSpeed", speed: 1 },
      { type: "seekCanonicalTick", canonicalTick: plan.cues[0].outcome_start_tick },
      { type: "play" }
    ]);

    state = reduceCoachingSession(plan, state, {
      type: "TICK",
      tick: plan.cues[0].outcome_end_tick
    });
    expect(state.phase).toBe("PAUSED_FOR_COACHING");
    expect(guidedPlaybackDirective(plan, state).commands).toEqual([
      { type: "setCamera", mode: "full" },
      { type: "pause" },
      { type: "seekCanonicalTick", canonicalTick: plan.cues[0].outcome_end_tick }
    ]);
  });

  it("auto-consumes explicit low-value skips without asking the user", () => {
    const manualPlan = {
      ...plan,
      id: "plan-cs2d-auto-skip",
      segments: plan.segments.map((segment) => segment.id === "seg-r1-freeze"
        ? { ...segment, reason_code: "LOW_VALUE_FAST_FORWARD" }
        : segment)
    };
    const state = reduceCoachingSession(manualPlan, createCoachingSession(manualPlan), { type: "START" });
    expect(state.phase).toBe("SKIPPING");
    expect(guidedPlaybackDirective(manualPlan, state)).toMatchObject({
      commands: [
        { type: "setCamera", mode: "full" },
        { type: "pause" },
        { type: "seekCanonicalTick", canonicalTick: manualPlan.segments[0].end_tick }
      ],
      automaticAction: { type: "SKIP_SEGMENT" }
    });
  });

  it("does not issue a new seek for every playback frame", () => {
    let state = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
    const before = guidedTransitionKey(state);
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: state.current_tick + 32 });
    expect(guidedTransitionKey(state)).toBe(before);
  });
});
