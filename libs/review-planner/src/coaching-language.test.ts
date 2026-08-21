import { describe, expect, it } from "vitest";
import { playerFacingFocusProblem } from "./coaching-language";

describe("player-facing coaching language", () => {
  it("translates internal focus codes into concrete CS consequences", () => {
    expect(playerFacingFocusProblem("OBJECTIVE_TIMING")).toContain("队友没到位");
    expect(playerFacingFocusProblem("CONVERT_ADVANTAGE")).toContain("优势");
    expect(playerFacingFocusProblem("SURVIVE_CONTACT")).toContain("补枪");
    expect(playerFacingFocusProblem("OBJECTIVE_TIMING")).not.toContain("OBJECTIVE_TIMING");
  });

  it("uses a player-facing fallback for an unknown internal code", () => {
    expect(playerFacingFocusProblem("UNKNOWN_INTERNAL_CODE")).toBe("这次处理没有留好退路和队友补枪条件，风险太高。");
  });
});
