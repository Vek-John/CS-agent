import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlExecutor } from "@cs-coach/memory-postgres/server";

const poolFactory = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@cs-coach/memory-postgres/server", async () => {
  const actual = await vi.importActual<typeof import("@cs-coach/memory-postgres/server")>("@cs-coach/memory-postgres/server");
  return { ...actual, createNodePostgresPool: poolFactory.create };
});

import { createMemoryRuntime, resetMemoryRuntimeForTests } from "./server";

function executor(): SqlExecutor {
  return {
    query: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async (work) => work(executor())),
  };
}

function poolHandle() {
  const close = vi.fn(async () => undefined);
  return { pool: {}, executor: executor(), close };
}

function setCloudflareContext(value: unknown): void {
  const symbol = Symbol.for("__cloudflare-context__");
  (globalThis as unknown as Record<PropertyKey, unknown>)[symbol] = value;
}

function clearCloudflareContext(): void {
  const symbol = Symbol.for("__cloudflare-context__");
  Reflect.deleteProperty(globalThis as unknown as Record<PropertyKey, unknown>, symbol);
}

beforeEach(() => {
  poolFactory.create.mockReset();
  resetMemoryRuntimeForTests();
  clearCloudflareContext();
});

afterEach(() => {
  resetMemoryRuntimeForTests();
  clearCloudflareContext();
  vi.unstubAllEnvs();
});

describe("web memory runtime database selection", () => {
  it("does not initialize a configured database when the feature flag is off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEMORY_ENABLED", "true");
    const runtime = createMemoryRuntime({ memoryEnabled: false, databaseUrl: "postgresql://user:secret@db.invalid/memory" });
    await runtime.service.getBrief("principal-off");
    expect(await runtime.getAuthorization("principal-off")).toBeUndefined();
    expect(poolFactory.create).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("prefers MEMORY_DATABASE_URL and shares one lazy pool across concurrent reads", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEMORY_ENABLED", "true");
    vi.stubEnv("MEMORY_DATABASE_URL", "postgresql://preferred.invalid/memory");
    vi.stubEnv("DATABASE_URL", "postgresql://fallback.invalid/memory");
    const handle = poolHandle();
    poolFactory.create.mockResolvedValue(handle);
    const runtime = createMemoryRuntime();
    expect(runtime.storage).toBe("POSTGRES");
    expect(runtime.durable).toBe(true);
    await Promise.all([runtime.getAuthorization("principal-a"), runtime.getAuthorization("principal-b")]);
    expect(poolFactory.create).toHaveBeenCalledTimes(1);
    expect(poolFactory.create.mock.calls[0]?.[0]).toMatchObject({ connectionString: "postgresql://preferred.invalid/memory" });
    await runtime.close();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("uses the current Hyperdrive binding only when env URLs are absent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEMORY_ENABLED", "true");
    setCloudflareContext({ env: { HYPERDRIVE: { connectionString: "postgresql://hyperdrive.invalid/memory" } } });
    poolFactory.create.mockResolvedValue(poolHandle());
    const runtime = createMemoryRuntime();
    await runtime.getAuthorization("hyperdrive-principal");
    expect(poolFactory.create).toHaveBeenCalledTimes(1);
    expect(poolFactory.create.mock.calls[0]?.[0]).toMatchObject({ connectionString: "postgresql://hyperdrive.invalid/memory" });
  });

  it("fails closed and reports a sanitized reason when lazy pool creation fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEMORY_ENABLED", "true");
    vi.stubEnv("MEMORY_DATABASE_URL", "postgresql://user:secret@db.invalid/memory");
    poolFactory.create.mockRejectedValue(new Error("password=must-not-leak"));
    const runtime = createMemoryRuntime();
    expect(await runtime.getAuthorization("principal-failed")).toBeUndefined();
    expect(await runtime.isAuthorized("principal-failed")).toBe(false);
    expect(runtime.degradedReason).toBe("POSTGRES_UNAVAILABLE");
    expect(JSON.stringify({ reason: runtime.degradedReason })).not.toContain("password");
    expect(poolFactory.create).toHaveBeenCalledTimes(1);
  });

  it("returns explicit unavailable storage without a URL and honors an injected executor", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEMORY_ENABLED", "true");
    const unavailable = createMemoryRuntime();
    expect(unavailable.storage).toBe("UNAVAILABLE");
    expect(unavailable.durable).toBe(false);
    expect(unavailable.degradedReason).toBe("POSTGRES_EXECUTOR_NOT_CONFIGURED");

    const injected = createMemoryRuntime({ executor: executor(), memoryEnabled: true, nodeEnv: "production" });
    await injected.getAuthorization("injected-principal");
    expect(injected.storage).toBe("POSTGRES");
    expect(injected.durable).toBe(true);
    expect(poolFactory.create).not.toHaveBeenCalled();
  });
});
