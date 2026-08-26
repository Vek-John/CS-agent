import { describe, expect, it } from "vitest";
import type { CoachCue } from "@cs-coach/contracts";
import { decisionFactsForCue } from "./teaching-diagnosis-host";

describe("teaching diagnosis evidence boundary", () => {
  it("does not widen an empty observable allowlist to hidden decision facts", () => {
    const cue = {
      decision_tick: 100,
      observable_fact_refs: [],
      facts: [
        {
          id: "fact-observed",
          text: "玩家决策前看到了可用信息。",
          availability: "DECISION",
          available_at_tick: 90,
          source: "DEMO",
          observed_by_player: true,
        },
        {
          id: "fact-hidden",
          text: "决策时存在但玩家不可直接观察的事实。",
          availability: "DECISION",
          available_at_tick: 90,
          source: "DEMO",
          observed_by_player: false,
        },
      ],
    } as unknown as CoachCue;

    expect(decisionFactsForCue(cue).map((fact) => fact.id)).toEqual(["fact-observed"]);
  });
});
