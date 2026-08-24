import { describe, expect, it } from "vitest";
import type { SessionSummaryInput } from "@cs-coach/coach-agent/client";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { buildStage3WrapUpInput } from "./coach-agent-stage3-wrap-up";

describe("buildStage3WrapUpInput", () => {
  it("reads only completed cue ids and keeps narration/advice refs route-owned", () => {
    const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());
    const cue = plan.cues[0];
    if (!cue) throw new Error("fixture cue missing");
    const summary: SessionSummaryInput = {
      schemaVersion: "coach-agent-session-summary.v1",
      themes: [{
        focus: "SURVIVE_THE_NEXT_CONTACT",
        cueRefs: [cue.id],
        roundRefs: ["round-2"],
        evidenceRefs: ["fact-r2-4v3"],
        occurrence: 1,
        economyContext: "FULL",
        repeated: true,
        conflictEvidence: false,
        adviceRefs: [cue.advice[0]?.id ?? "advice-r2-reset"],
        limitations: [],
      }],
      completedCues: [{
        cueId: cue.id,
        roundId: "round-2",
        focus: "SURVIVE_THE_NEXT_CONTACT",
        evidenceRefs: ["fact-r2-4v3"],
        adviceRefs: [cue.advice[0]?.id ?? "advice-r2-reset"],
      }],
      limitations: [],
    };
    const result = buildStage3WrapUpInput(plan, summary, {
      [cue.id]: {
        cueId: cue.id,
        candidateId: cue.candidate_id ?? "candidate",
        primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
        currentSituation: { text: "当前", refs: ["fact-r2-4v3"] },
        playerAction: { text: "动作", refs: ["action-r2"] },
        coreIssue: { text: "问题", refs: ["fact-r2-4v3"] },
        betterPlay: { text: "建议", refs: ["advice-r2-reset"] },
        outcomeImpact: { text: "结果", refs: ["fact-r2-outcome"] },
      },
      "uncompleted-cue": {} as never,
    });
    expect(Object.keys(result.presentableCues)).toEqual([cue.id]);
    expect(result.presentableCues[cue.id]?.coreIssue.refs).toEqual(["fact-r2-4v3"]);
    expect(result.presentableCues[cue.id]?.advice[0]?.id).toBe(cue.advice[0]?.id ?? "advice-r2-reset");
  });
});
