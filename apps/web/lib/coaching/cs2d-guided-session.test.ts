import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import {
  createGuidedSeekGate,
  guidedPlaybackDirective,
  guidedTransitionKey,
  isGuidedSeekLanding
} from "./cs2d-guided-session";

const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());

describe("cs2d guided session synchronization", () => {
  it("pre-rolls one second, plays through the outcome, then returns to the decision", () => {
    let state = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
    const playing = guidedPlaybackDirective(plan, state);
    expect(playing.commands).toEqual([
      { type: "setCamera", mode: "full" },
      { type: "setSpeed", speed: 4 },
      { type: "seekCanonicalTick", canonicalTick: 256 },
      { type: "play" }
    ]);

    state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
    const cue = plan.cues[0];
    const cueSegment = plan.segments.find((segment) => segment.id === cue.segment_id);
    expect(cueSegment).toBeDefined();
    expect(guidedPlaybackDirective(plan, state, 64).commands).toContainEqual({
      type: "seekCanonicalTick",
      canonicalTick: Math.max(cueSegment!.start_tick, cue.decision_tick - 64)
    });

    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.decision_tick });
    expect(state.phase).toBe("REVEALING");
    expect(state.revealed_cue_ids).not.toContain(cue.id);
    expect(guidedPlaybackDirective(plan, state).commands).toEqual([
      { type: "setCamera", mode: "target" },
      { type: "setSpeed", speed: 1 },
      { type: "seekCanonicalTick", canonicalTick: cue.outcome_start_tick },
      { type: "play" }
    ]);

    state = reduceCoachingSession(plan, state, {
      type: "TICK",
      tick: cue.outcome_end_tick - 1
    });
    expect(state.phase).toBe("REVEALING");
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
    expect(state.phase).toBe("PAUSED_FOR_COACHING");
    expect(state.revealed_cue_ids).toContain(cue.id);
    expect(guidedPlaybackDirective(plan, state).commands).toEqual([
      { type: "setCamera", mode: "target" },
      { type: "pause" },
      { type: "seekCanonicalTick", canonicalTick: cue.decision_tick }
    ]);
  });

  it("replays a revealed cue from the same one-second pre-roll at normal speed", () => {
    let state = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
    state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: 2350 });
    state = reduceCoachingSession(plan, state, {
      type: "TICK",
      tick: plan.cues[0].outcome_end_tick
    });
    state = reduceCoachingSession(plan, state, { type: "REPLAY_OUTCOME" });

    expect(guidedPlaybackDirective(plan, state).commands).toEqual([
      { type: "setCamera", mode: "target" },
      { type: "setSpeed", speed: 1 },
      {
        type: "seekCanonicalTick",
        canonicalTick: Math.max(
          plan.segments.find((segment) => segment.id === plan.cues[0].segment_id)!.start_tick,
          plan.cues[0].decision_tick - 64
        )
      },
      { type: "play" }
    ]);
  });

  it("does not accept a stale large tick before a guided seek lands", () => {
    const gate = createGuidedSeekGate(7, 2_000, 64);

    expect(isGuidedSeekLanding(gate, 2_500)).toBe(false);
    expect(isGuidedSeekLanding(gate, 1_992)).toBe(true);
    expect(isGuidedSeekLanding({ ...gate, epoch: 8 }, 2_000)).toBe(true);
  });

  it("keeps a stale post-outcome state out of the session transition", () => {
    let state = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
    state = reduceCoachingSession(plan, state, { type: "ADVANCE_SEGMENT" });
    const cue = plan.cues[0];
    const seek = guidedPlaybackDirective(plan, state, 64).commands.find(
      (command): command is Extract<typeof command, { type: "seekCanonicalTick" }> => command.type === "seekCanonicalTick"
    );
    expect(seek).toBeDefined();
    const gate = createGuidedSeekGate(1, seek!.canonicalTick, 64);

    if (isGuidedSeekLanding(gate, cue.outcome_end_tick)) {
      state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
    }
    expect(state.phase).toBe("PLAYING");
    expect(state.revealed_cue_ids).not.toContain(cue.id);
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
