import { describe, expect, it } from "vitest";
import { parseMemoryEnabled } from "./feature-flag";

describe("memory feature flag", () => {
  it("only enables explicit true values", () => {
    expect(parseMemoryEnabled("true")).toBe(true);
    expect(parseMemoryEnabled("1")).toBe(true);
    expect(parseMemoryEnabled("ON")).toBe(true);
    expect(parseMemoryEnabled("false")).toBe(false);
    expect(parseMemoryEnabled("yes")).toBe(false);
    expect(parseMemoryEnabled(undefined)).toBe(false);
  });
});
