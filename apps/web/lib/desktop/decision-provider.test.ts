import { afterEach, describe, expect, it, vi } from "vitest";
import { coachingProviderEnv, decisionProviderEnv } from "./provider";

const symbol = Symbol.for("cs-agent.desktop.decision-provider.v1");
const generationSymbol = Symbol.for("cs-agent.desktop.provider.v1");
const globals = globalThis as typeof globalThis & { [symbol]?: unknown; [generationSymbol]?: unknown };

afterEach(() => {
  delete globals[symbol];
  delete globals[generationSymbol];
  vi.unstubAllEnvs();
});

describe("independent decision provider", () => {
  it("uses only explicit localhost pilot values and defaults to the baseline", () => {
    vi.stubEnv("DEPLOY_TARGET", "localhost");
    vi.stubEnv("CS_DECISION_ASSESSMENT_MODE", "");
    vi.stubEnv("JEV_API_KEY", "localhost-key");
    expect(decisionProviderEnv().CS_DECISION_ASSESSMENT_MODE).toBe("RULE_BASELINE");
    for (const mode of ["JEV_SHADOW", "JEV_EXPERIMENT"]) {
      vi.stubEnv("CS_DECISION_ASSESSMENT_MODE", mode);
      vi.stubEnv("CS_DECISION_ASSESSMENT_ACCEPTANCE", "TEST_ONLY");
      expect(decisionProviderEnv()).toEqual({
        JEV_API_KEY: "localhost-key", CS_DECISION_ASSESSMENT_MODE: mode,
        CS_DECISION_ASSESSMENT_ACCEPTANCE: "TEST_ONLY",
      });
    }
    vi.stubEnv("CS_DECISION_ASSESSMENT_ACCEPTANCE", "AUTO_ACCEPT");
    expect(decisionProviderEnv().CS_DECISION_ASSESSMENT_ACCEPTANCE).toBe("SHADOW_ONLY");
    vi.stubEnv("CS_DECISION_ASSESSMENT_MODE", "jev_shadow");
    expect(decisionProviderEnv().CS_DECISION_ASSESSMENT_MODE).toBe("RULE_BASELINE");
  });

  it("fails closed on desktop with old init, absent config, or explicit baseline even if environment has keys", () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    vi.stubEnv("CS_DECISION_ASSESSMENT_MODE", "JEV_EXPERIMENT");
    vi.stubEnv("CS_DECISION_ASSESSMENT_ACCEPTANCE", "TEST_ONLY");
    vi.stubEnv("JEV_API_KEY", "must-not-be-used");
    for (const config of [undefined, { kind: "RULE_BASELINE" }]) {
      globals[symbol] = config;
      expect(decisionProviderEnv()).toEqual({
        CS_DECISION_ASSESSMENT_MODE: "RULE_BASELINE", CS_DECISION_ASSESSMENT_ACCEPTANCE: "SHADOW_ONLY",
      });
    }
  });

  it("keeps generation and decision credentials independent and never copies keys into process.env", () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    globals[generationSymbol] = { kind: "DEEPSEEK", apiKey: "generation-only", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" };
    globals[symbol] = { kind: "JEV", apiKey: "decision-only", mode: "JEV_SHADOW", acceptance: "SHADOW_ONLY", model: "jev-1.13.0" };
    expect(decisionProviderEnv().JEV_API_KEY).toBe("decision-only");
    expect(coachingProviderEnv().DEEPSEEK_API_KEY).toBe("generation-only");
    expect(Object.values(process.env)).not.toContain("decision-only");
    expect(Object.keys(decisionProviderEnv())).not.toContain("DEEPSEEK_URL");
  });

  it("missing or invalid key stays absent without desktop environment fallback", () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    vi.stubEnv("JEV_API_KEY", "must-not-be-used");
    for (const apiKey of [null, "", "x\ny", "x".repeat(513)]) {
      globals[symbol] = { kind: "JEV", apiKey, mode: "JEV_SHADOW", acceptance: "SHADOW_ONLY", model: "jev-1.13.0" };
      expect(decisionProviderEnv().JEV_API_KEY).toBeUndefined();
      expect(decisionProviderEnv().CS_DECISION_ASSESSMENT_MODE).toBe("JEV_SHADOW");
    }
  });
});
