import { describe, expect, it } from "vitest";
import { aggregateSessionThemes } from "./session-theme-aggregator";
import type { PresentableCueSummary } from "./types";

function cue(overrides: Partial<PresentableCueSummary> = {}): PresentableCueSummary {
  return {
    completionStatus: "COMPLETED",
    presentationStatus: "PRESENTABLE",
    cueId: "cue-1",
    roundId: "round-1",
    focus: "POSITIONING",
    evidenceRefs: ["evidence-1"],
    adviceRefs: [],
    economyContext: "FULL",
    conflictEvidence: false,
    ...overrides,
  };
}

describe("aggregateSessionThemes", () => {
  it("keeps a singleton non-repeated and aggregates repeated focus deterministically", () => {
    const themes = aggregateSessionThemes([
      cue(),
      cue({ cueId: "cue-2", roundId: "round-2", evidenceRefs: ["evidence-2"], economyContext: "FORCE" }),
      cue({ cueId: "cue-3", focus: "UTILITY", roundId: "round-3", evidenceRefs: ["evidence-3"], conflictEvidence: true, economyContext: "ECO" }),
    ]);

    expect(themes).toEqual([
      {
        focus: "POSITIONING",
        cueRefs: ["cue-1", "cue-2"],
        roundRefs: ["round-1", "round-2"],
        evidenceRefs: ["evidence-1", "evidence-2"],
        occurrence: 2,
        economyContext: "FORCE",
        repeated: true,
        conflictEvidence: false,
      },
      {
        focus: "UTILITY",
        cueRefs: ["cue-3"],
        roundRefs: ["round-3"],
        evidenceRefs: ["evidence-3"],
        occurrence: 1,
        economyContext: "ECO",
        repeated: false,
        conflictEvidence: true,
      },
    ]);
  });

  it("only accepts completed presentable summaries", () => {
    expect(() =>
      aggregateSessionThemes([
        cue({ presentationStatus: "PRESENTABLE", completionStatus: "COMPLETED" }),
        { ...cue(), completionStatus: "RUNNING" } as unknown as PresentableCueSummary,
      ]),
    ).toThrow();
  });

  it("keeps a deterministic bounded index for twenty same-focus cues and preserves the advised representative", () => {
    const summaries = Array.from({ length: 20 }, (_, index) => cue({
      cueId: `cue-${index + 1}`,
      roundId: `round-${index + 1}`,
      focus: "SURVIVE_CONTACT",
      evidenceRefs: Array.from({ length: 16 }, (_, refIndex) => `evidence-${index + 1}-${refIndex}`),
      adviceRefs: index === 19 ? ["advice-late-representative"] : [],
    }));

    const first = aggregateSessionThemes(summaries);
    const second = aggregateSessionThemes(summaries);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      focus: "SURVIVE_CONTACT",
      occurrence: 20,
      repeated: true,
    });
    expect(first[0]?.cueRefs).toHaveLength(16);
    expect(first[0]?.roundRefs).toHaveLength(16);
    expect(first[0]?.evidenceRefs).toHaveLength(16);
    expect(first[0]?.cueRefs[0]).toBe("cue-20");
    expect(first[0]?.roundRefs[0]).toBe("round-20");
    expect(first[0]?.evidenceRefs[0]).toBe("evidence-20-0");
  });
});
