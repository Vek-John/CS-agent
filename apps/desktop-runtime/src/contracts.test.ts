import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  currentRuntimeProviderConfig,
  currentRuntimeDecisionProviderConfig,
  installRuntimeDecisionProviderConfig,
  installRuntimeProviderConfig,
  parseDesktopRuntimeInit,
  readInitLine,
  RuntimeStartupError,
} from "./contracts";

function validInit() {
  return {
    schemaVersion: "desktop-runtime-init.v1",
    appVersion: "0.1.0",
    buildSha: "0123456789abcdef",
    targetTriple: "aarch64-apple-darwin",
    dataDir: "/tmp/cs-agent/data",
    cacheDir: "/tmp/cs-agent/cache",
    logDir: "/tmp/cs-agent/log",
    runtimeRoot: "/tmp/cs-agent/runtime",
    viewerRoot: "/tmp/cs-agent/viewer",
    provider: { kind: "NONE", apiKey: null, baseUrl: null, model: null },
  } as const;
}

function startupCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof RuntimeStartupError ? error.code : undefined;
  }
  return undefined;
}

test("init envelope accepts only the exact v1 shape and absolute bounded paths", () => {
  assert.deepEqual(parseDesktopRuntimeInit(JSON.stringify(validInit())), validInit());
  assert.equal(startupCode(() => parseDesktopRuntimeInit(JSON.stringify({ ...validInit(), extra: true }))), "INIT_INVALID");
  assert.equal(startupCode(() => parseDesktopRuntimeInit(JSON.stringify({ ...validInit(), dataDir: "relative/data" }))), "INIT_INVALID");
  assert.equal(startupCode(() => parseDesktopRuntimeInit(JSON.stringify({ ...validInit(), appVersion: "x".repeat(121) }))), "INIT_INVALID");
  assert.equal(startupCode(() => parseDesktopRuntimeInit("{")), "INIT_INVALID");
});

test("provider config is a strict three-way union", () => {
  const deepseek = {
    ...validInit(),
    provider: { kind: "DEEPSEEK", apiKey: "secret-key", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  };
  assert.equal(parseDesktopRuntimeInit(JSON.stringify(deepseek)).provider.kind, "DEEPSEEK");

  const local = {
    ...validInit(),
    provider: { kind: "OPENAI_COMPATIBLE", apiKey: null, baseUrl: "http://127.0.0.1:11434/v1", model: "local" },
  };
  assert.equal(parseDesktopRuntimeInit(JSON.stringify(local)).provider.kind, "OPENAI_COMPATIBLE");

  for (const provider of [
    { kind: "NONE", apiKey: null, baseUrl: null, model: null, extra: true },
    { kind: "DEEPSEEK", apiKey: "short", baseUrl: "https://api.deepseek.com", model: "m" },
    { kind: "OPENAI_COMPATIBLE", apiKey: null, baseUrl: "http://example.com/v1", model: "m" },
    { kind: "OPENAI_COMPATIBLE", apiKey: null, baseUrl: "https://user@example.com/v1", model: "m" },
    { kind: "OPENAI_COMPATIBLE", apiKey: null, baseUrl: "https://example.com/v1?q=1", model: "m" },
  ]) {
    assert.equal(startupCode(() => parseDesktopRuntimeInit(JSON.stringify({ ...validInit(), provider }))), "INIT_INVALID");
  }
});

test("provider config remains in the explicit in-memory seam", () => {
  const provider = parseDesktopRuntimeInit(JSON.stringify({
    ...validInit(),
    provider: { kind: "DEEPSEEK", apiKey: "not-in-env", baseUrl: "https://api.deepseek.com/", model: "chat" },
  })).provider;
  installRuntimeProviderConfig(provider);
  assert.equal(currentRuntimeProviderConfig(), provider);
  assert.equal(Object.values(process.env).includes("not-in-env"), false);
});

test("optional decision provider preserves old init and validates the independent strict union", () => {
  const decisionProvider = {
    kind: "JEV", mode: "JEV_SHADOW", acceptance: "SHADOW_ONLY", apiKey: null, model: "jev-1.13.0",
  };
  assert.equal(parseDesktopRuntimeInit(JSON.stringify(validInit())).decisionProvider, undefined);
  for (const mode of ["JEV_SHADOW", "JEV_EXPERIMENT"]) {
    for (const acceptance of ["SHADOW_ONLY", "TEST_ONLY"]) {
      const config = { ...decisionProvider, mode, acceptance };
      const parsed = parseDesktopRuntimeInit(JSON.stringify({ ...validInit(), decisionProvider: config }));
      assert.deepEqual(parsed.decisionProvider, config);
      assert.equal(parsed.provider.kind, "NONE");
    }
  }
  for (const invalid of [
    null, { ...decisionProvider, kind: "DEEPSEEK" }, { ...decisionProvider, mode: "AUTO" },
    { ...decisionProvider, acceptance: "AUTO_ACCEPT" }, { ...decisionProvider, apiKey: "" },
    { ...decisionProvider, apiKey: "x\ny" }, { ...decisionProvider, apiKey: "x".repeat(513) },
    { ...decisionProvider, model: "jev-latest" }, { ...decisionProvider, baseUrl: "https://other.test" },
    { ...decisionProvider, extra: true },
  ]) {
    assert.equal(startupCode(() => parseDesktopRuntimeInit(JSON.stringify({ ...validInit(), decisionProvider: invalid }))), "INIT_INVALID");
  }
});

test("decision key stays in memory and old init clears a previous decision provider", () => {
  const parsed = parseDesktopRuntimeInit(JSON.stringify({
    ...validInit(), decisionProvider: {
      kind: "JEV", mode: "JEV_EXPERIMENT", acceptance: "TEST_ONLY", apiKey: "decision-memory-only-secret", model: "jev-1.13.0",
    },
  }));
  installRuntimeDecisionProviderConfig(parsed.decisionProvider);
  assert.equal(currentRuntimeDecisionProviderConfig(), parsed.decisionProvider);
  assert.equal(Object.values(process.env).includes("decision-memory-only-secret"), false);
  installRuntimeDecisionProviderConfig(parseDesktopRuntimeInit(JSON.stringify(validInit())).decisionProvider);
  assert.deepEqual(currentRuntimeDecisionProviderConfig(), { kind: "RULE_BASELINE" });
});

test("stdin contract consumes the first line and enforces timeout and byte limit", async () => {
  const stream = new PassThrough();
  const pending = readInitLine(stream, 100);
  stream.write(`${JSON.stringify(validInit())}\nignored\n`);
  assert.equal(await pending, JSON.stringify(validInit()));

  const timeoutStream = new PassThrough();
  await assert.rejects(readInitLine(timeoutStream, 5), (error: unknown) => error instanceof RuntimeStartupError && error.code === "INIT_TIMEOUT");
  timeoutStream.destroy();

  const largeStream = new PassThrough();
  const tooLarge = readInitLine(largeStream, 100, 8);
  largeStream.write("123456789\n");
  await assert.rejects(tooLarge, (error: unknown) => error instanceof RuntimeStartupError && error.code === "INIT_TOO_LARGE");
  largeStream.destroy();
});
