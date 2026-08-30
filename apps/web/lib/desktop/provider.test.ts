import { afterEach, describe, expect, it, vi } from "vitest";
import { coachingProviderEnv } from "./provider";

const symbol = Symbol.for("cs-agent.desktop.provider.v1");
const providerGlobal = globalThis as typeof globalThis & { [symbol]?: unknown };

afterEach(() => {
  delete providerGlobal[symbol];
  vi.unstubAllEnvs();
});

describe("desktop coaching provider", () => {
  it("reads the in-memory compatible provider without copying it to process.env", () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    providerGlobal[symbol] = {
      kind: "OPENAI_COMPATIBLE", apiKey: "memory-only", baseUrl: "http://127.0.0.1:11434/v1", model: "local",
    };
    expect(coachingProviderEnv()).toEqual({
      DEEPSEEK_API_KEY: "memory-only",
      DEEPSEEK_MODEL: "local",
      DEEPSEEK_URL: "http://127.0.0.1:11434/v1/chat/completions",
      DEEPSEEK_ALLOW_EMPTY_KEY: false,
    });
    expect(Object.values(process.env)).not.toContain("memory-only");
  });

  it("fails closed for NONE", () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    providerGlobal[symbol] = { kind: "NONE", apiKey: null, baseUrl: null, model: null };
    expect(coachingProviderEnv()).toEqual({});
  });
});
