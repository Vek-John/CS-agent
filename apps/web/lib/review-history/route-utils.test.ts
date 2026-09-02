import { describe, expect, it } from "vitest";
import { bridgeCapabilityToken } from "./capability-token";
describe("bridgeCapabilityToken", () => {
  it("returns exactly the token and never forwards a Bearer prefix", () => {
    const token = "a".repeat(43);
    expect(bridgeCapabilityToken(`Bearer ${token}`)).toBe(token);
    expect(bridgeCapabilityToken(token)).toBe(token);
    expect(bridgeCapabilityToken(`Bearer Bearer ${token}`)).toBeUndefined();
    expect(bridgeCapabilityToken("Bearer short")).toBeUndefined();
  });
});
