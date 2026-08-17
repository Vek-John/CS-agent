import { describe, expect, it } from "vitest";

import { canShowGroundTruthForPhase } from "./review-perspective";

describe("guided replay perspective gate", () => {
  it("keeps omniscient replay locked before the decision is revealed", () => {
    expect(canShowGroundTruthForPhase("PLAYING", true, false)).toBe(false);
    expect(canShowGroundTruthForPhase("PAUSED_FOR_COACHING", true, false)).toBe(false);
  });

  it("allows omniscient truth during result playback and replay", () => {
    expect(canShowGroundTruthForPhase("REVEALING", true, false)).toBe(true);
    expect(canShowGroundTruthForPhase("REPLAYING", true, false)).toBe(true);
  });

  it("keeps the result available after the cue is revealed", () => {
    expect(canShowGroundTruthForPhase("PAUSED_FOR_COACHING", true, true)).toBe(true);
    expect(canShowGroundTruthForPhase("WRAP_UP", false, false)).toBe(true);
  });
});
