import { describe, expect, it } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import {
  assertValidReviewPlan,
  collectReviewPlanIssues,
  createFixtureReviewPlan,
  ReviewPlanValidationError
} from "./index";

describe("ReviewPlan invariants", () => {
  it("accepts a deterministic plan that covers every tick and every round", () => {
    const timeline = createSyntheticMirageTimeline();
    const plan = createFixtureReviewPlan(timeline);

    expect(assertValidReviewPlan(timeline, plan)).toBe(plan);
    expect(plan.segments[0].start_tick).toBe(timeline.start_tick);
    expect(plan.segments.at(-1)?.end_tick).toBe(timeline.end_tick);
    expect(new Set(plan.segments.map((segment) => segment.round_number))).toEqual(
      new Set([1, 2, 3, 4])
    );
  });

  it("rejects an unexplained timeline gap", () => {
    const timeline = createSyntheticMirageTimeline();
    const plan = structuredClone(createFixtureReviewPlan(timeline));
    plan.segments[1].start_tick += 1;

    expect(() => assertValidReviewPlan(timeline, plan)).toThrow(ReviewPlanValidationError);
    expect(collectReviewPlanIssues(timeline, plan).join(" ")).toContain("gap or overlap");
  });

  it("rejects future outcome evidence in the decision-time observable state", () => {
    const timeline = createSyntheticMirageTimeline();
    const plan = structuredClone(createFixtureReviewPlan(timeline));
    plan.cues[0].observable_fact_refs.push("fact-r2-outcome");

    expect(collectReviewPlanIssues(timeline, plan).join(" ")).toContain(
      "future or unobserved fact fact-r2-outcome"
    );
  });
});
