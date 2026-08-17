import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { buildCoachingCueView } from "./cs2d-coaching-view";

const cue = createFixtureReviewPlan(createSyntheticMirageTimeline()).cues[0];

describe("cs2d paused coaching cue view", () => {
  it("keeps outcome facts locked before playback completes", () => {
    const view = buildCoachingCueView(cue, false);

    expect(view.decisionFacts.map((fact) => fact.id)).toEqual([
      "fact-r2-4v3",
      "fact-r2-spacing"
    ]);
    expect(view.outcomeFacts).toEqual([]);
    expect(view.question).toContain("当前是 4 打 3");
  });

  it("reveals only typed outcome facts after the endpoint", () => {
    const view = buildCoachingCueView({
      ...cue,
      facts: [
        ...cue.facts,
        {
          id: "fact-too-early",
          text: "不应显示的过早结果",
          availability: "OUTCOME",
          available_at_tick: cue.reveal_tick - 1,
          source: "DEMO",
          observed_by_player: true
        },
        {
          id: "fact-too-late",
          text: "不应显示的未来结果",
          availability: "OUTCOME",
          available_at_tick: cue.outcome_end_tick + 1,
          source: "DEMO",
          observed_by_player: true
        }
      ]
    }, true);

    expect(view.outcomeFacts.map((fact) => fact.id)).toEqual(["fact-r2-outcome"]);
    expect(view.outcomeFacts[0].availability).toBe("OUTCOME");
    expect(view.advice?.text).toContain("队友可补枪");
  });
});
