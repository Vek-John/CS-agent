import { describe, expect, it } from "vitest";
import { playerFacingFocusProblem, playerFacingLimitation } from "./coaching-language";

describe("player-facing coaching language", () => {
  it.each(["OBJECTIVE_TIMING", "CONVERT_ADVANTAGE", "SURVIVE_CONTACT", "UNKNOWN_INTERNAL_CODE"])("does not infer mistakes from focus %s", (focus) => {
    expect(playerFacingFocusProblem(focus)).toContain("证据不足");
    expect(playerFacingFocusProblem(focus)).not.toContain(focus);
    expect(playerFacingFocusProblem(focus)).not.toMatch(/你没|队友没|风险太高/);
  });
  it("projects internal limitations as understandable uncertainty", () => {
    expect(playerFacingLimitation("ObservationState renderer lossless refId schema TRADE tick")).toBe("部分现场信息无法确认，因此暂不作确定判断。");
  });
});
