import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_COACH_ENV_KEYS,
  assertLocalPortAvailable,
  formatLocalMemoryDiagnostic,
  inspectLocalMemoryEnvironment,
  parseLocalCoachEnv,
  parseLocalhostArgs,
  resolveLocalCoachEnvironment,
  signalOwnedChild,
} from "./run-localhost.mjs";

const source = readFileSync(new URL("./run-localhost.mjs", import.meta.url), "utf8");

function listen(server, host = "127.0.0.1") {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen({ host, port: 0 }, () => resolvePromise(server.address()));
  });
}

function close(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
}

describe("localhost runtime bootstrap contract", () => {
  it("defaults Memory off while letting explicit shell variables override the local file", () => {
    const defaults = resolveLocalCoachEnvironment({}, {});
    expect(defaults.MEMORY_ENABLED).toBe("false");

    const fromFile = resolveLocalCoachEnvironment({ MEMORY_ENABLED: "on" }, {});
    expect(fromFile.MEMORY_ENABLED).toBe("on");

    const fromShell = resolveLocalCoachEnvironment(
      { MEMORY_ENABLED: "false", MEMORY_DATABASE_URL: "postgresql://file-secret" },
      { MEMORY_ENABLED: "true", MEMORY_DATABASE_URL: "postgresql://shell-secret" },
    );
    expect(fromShell.MEMORY_ENABLED).toBe("true");
    expect(fromShell.MEMORY_DATABASE_URL).toBe("postgresql://shell-secret");
    expect(fromShell.NEXT_PUBLIC_DEPLOY_TARGET).toBe("localhost");
  });

  it("uses the cross-platform --memory default without overriding an explicit flag", () => {
    expect(parseLocalhostArgs(["--memory"])).toEqual({ enableMemoryByDefault: true });
    expect(resolveLocalCoachEnvironment({}, {}, { enableMemoryByDefault: true }).MEMORY_ENABLED).toBe("true");
    expect(resolveLocalCoachEnvironment(
      { MEMORY_ENABLED: "false" },
      {},
      { enableMemoryByDefault: true },
    ).MEMORY_ENABLED).toBe("false");
    expect(resolveLocalCoachEnvironment(
      { MEMORY_ENABLED: "true" },
      { MEMORY_ENABLED: "false" },
      { enableMemoryByDefault: true },
    ).MEMORY_ENABLED).toBe("false");
    expect(() => parseLocalhostArgs(["--unknown"])).toThrow(/unsupported option/);

    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts["dev:memory"]).toBe("node tools/run-localhost.mjs --memory");
  });

  it("accepts only the documented local Memory configuration without exposing values", () => {
    expect(LOCAL_COACH_ENV_KEYS).toEqual(expect.arrayContaining([
      "MEMORY_ENABLED",
      "MEMORY_DATABASE_URL",
      "MEMORY_EMBEDDING_URL",
      "MEMORY_PRINCIPAL_SECRET",
    ]));
    expect(parseLocalCoachEnv([
      "MEMORY_ENABLED=true",
      "MEMORY_DATABASE_URL=postgresql://private-value",
      "MEMORY_EMBEDDING_URL=https://embedding.invalid/v1",
      "MEMORY_PRINCIPAL_SECRET=private-principal-value",
    ].join("\n"))).toMatchObject({ MEMORY_ENABLED: "true" });

    let message = "";
    try {
      parseLocalCoachEnv("UNSUPPORTED_KEY=private-value");
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("UNSUPPORTED_KEY");
    expect(message).not.toContain("private-value");
  });

  it("reports disabled, InMemory fallback, and PostgreSQL modes without logging secrets", () => {
    expect(inspectLocalMemoryEnvironment({ MEMORY_ENABLED: "false" })).toMatchObject({
      featureEnabled: false,
      storage: "IN_MEMORY",
    });
    expect(formatLocalMemoryDiagnostic({ MEMORY_ENABLED: "true" })).toContain("storage=IN_MEMORY fallback");

    const configured = {
      MEMORY_ENABLED: "true",
      MEMORY_DATABASE_URL: "postgresql://private-db-value",
      MEMORY_EMBEDDING_URL: "https://private-embedding-value",
      MEMORY_PRINCIPAL_SECRET: "private-principal-value",
    };
    const diagnostic = formatLocalMemoryDiagnostic(configured);
    expect(diagnostic).toContain("storage=POSTGRES");
    expect(diagnostic).toContain("embedding=configured");
    expect(diagnostic).toContain("principal=stable");
    expect(diagnostic).not.toContain("private-db-value");
    expect(diagnostic).not.toContain("private-embedding-value");
    expect(diagnostic).not.toContain("private-principal-value");
    expect(formatLocalMemoryDiagnostic({ MEMORY_ENABLED: "yes" })).toContain("treated as false");
  });

  it("fails a port preflight without terminating the existing listener", async () => {
    const existing = createServer();
    const address = await listen(existing);
    expect(address).toBeTruthy();
    await expect(assertLocalPortAvailable("test", address.port, "127.0.0.1")).rejects.toThrow(/already in use/);
    expect(existing.listening).toBe(true);
    await close(existing);
    await expect(assertLocalPortAvailable("test", address.port, "127.0.0.1")).resolves.toBeUndefined();
  });

  it("signals the owned Unix process group and falls back to the direct child safely", () => {
    const killProcess = vi.fn();
    const child = { pid: 4321, exitCode: null, signalCode: null, kill: vi.fn() };
    signalOwnedChild(child, "SIGTERM", { platform: "darwin", killProcess });
    expect(killProcess).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();

    const fallbackChild = { pid: 4322, exitCode: null, signalCode: null, kill: vi.fn() };
    signalOwnedChild(fallbackChild, "SIGTERM", {
      platform: "darwin",
      killProcess: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
    });
    expect(fallbackChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("preflights both ports before preparation or service launch", () => {
    const preflight = source.indexOf("await Promise.all([");
    const preparation = source.indexOf("const modelResult = spawnSync(");
    const launch = source.indexOf("const cs2d = supervisor.launch(");
    expect(preflight).toBeGreaterThan(-1);
    expect(preparation).toBeGreaterThan(preflight);
    expect(launch).toBeGreaterThan(preparation);
    expect(source).toMatch(/detached:/);
    expect(source).toContain("signalOwnedChild(record.child, 'SIGKILL')");
  });
});
