import { describe, expect, it } from "vitest";
import { parseMemoryMigrationArgs, runMemoryMigrationCli } from "./migrate-memory.mjs";

describe("memory migration CLI", () => {
  it("defaults to core and reads the optional vector switch from the environment", () => {
    const defaults = { includeVector: false, help: false, dryRun: false, checkConfig: false };
    expect(parseMemoryMigrationArgs([], {})).toEqual(defaults);
    expect(parseMemoryMigrationArgs([], { MEMORY_WITH_VECTOR: "true" })).toEqual({ ...defaults, includeVector: true });
    expect(parseMemoryMigrationArgs(["--with-vector"], {})).toEqual({ ...defaults, includeVector: true });
    expect(parseMemoryMigrationArgs(["--", "--with-vector"], {})).toEqual({ ...defaults, includeVector: true });
    expect(parseMemoryMigrationArgs(["--with-vector", "--without-vector"], {})).toEqual(defaults);
    expect(parseMemoryMigrationArgs(["--dry-run", "--check-config"], {})).toEqual({ ...defaults, dryRun: true, checkConfig: true });
  });

  it("rejects unknown arguments and supports help without importing pg", () => {
    expect(() => parseMemoryMigrationArgs(["--dangerous"])).toThrow("Unknown migration argument");
    expect(parseMemoryMigrationArgs(["--help"], {})).toEqual({ includeVector: false, help: true, dryRun: false, checkConfig: false });
  });

  it("prints the selected migration plan in dry-run mode without requiring config or opening a pool", async () => {
    const output = [];
    let opened = 0;
    const status = await runMemoryMigrationCli({
      argv: ["--dry-run", "--with-vector"],
      env: {},
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      createPool: async () => { opened += 1; throw new Error("must not connect"); },
      getMigrationPlan: () => ["memory-core-001", "memory-core-003", "memory-vector-002"],
    });
    expect(status).toBe(0);
    expect(opened).toBe(0);
    expect(output.join("\n")).toContain("memory-core-001 -> memory-core-003 -> memory-vector-002");
    expect(output.join("\n")).toContain("configuration: absent");
  });

  it("checks localhost configuration without connecting or exposing the URL", async () => {
    const output = [];
    let opened = 0;
    const secretUrl = "postgresql://local-user:local-password@localhost:5432/memory";
    const status = await runMemoryMigrationCli({
      argv: ["--check-config"],
      env: { MEMORY_DATABASE_URL: secretUrl, DATABASE_URL: "postgresql://fallback:secret@localhost/fallback" },
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      createPool: async () => { opened += 1; throw new Error("must not connect"); },
    });
    expect(status).toBe(0);
    expect(opened).toBe(0);
    expect(output.join("\n")).toContain("MEMORY_DATABASE_URL");
    expect(output.join("\n")).not.toContain(secretUrl);
    expect(output.join("\n")).not.toContain("local-password");
  });

  it("returns a non-zero status with a clear message when the URL is missing", async () => {
    const errors = [];
    const status = await runMemoryMigrationCli({
      argv: [],
      env: {},
      stdout: () => undefined,
      stderr: (line) => errors.push(line),
    });
    expect(status).toBe(1);
    expect(errors.join("\n")).toContain("MEMORY_DATABASE_CONFIGURATION");
    expect(errors.join("\n")).toContain("MEMORY_DATABASE_URL");
  });

  it("runs the existing migration runner and always closes the injected pool", async () => {
    const calls = [];
    let closed = 0;
    const output = [];
    const status = await runMemoryMigrationCli({
      argv: ["--with-vector"],
      env: { DATABASE_URL: "postgresql://user:secret@db.invalid/memory" },
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      createPool: async (options) => {
        calls.push({ kind: "create", options });
        return { executor: { query: async () => ({ rows: [] }) }, close: async () => { closed += 1; } };
      },
      runMigrations: async (executor, options) => {
        calls.push({ kind: "migrate", executor, options });
        return ["memory-core-001", "memory-core-003", "memory-vector-002"];
      },
    });
    expect(status).toBe(0);
    expect(calls.map(({ kind }) => kind)).toEqual(["create", "migrate"]);
    expect(calls[0].options.connectionString).toBe("postgresql://user:secret@db.invalid/memory");
    expect(calls[1].options).toEqual({ includeVector: true });
    expect(closed).toBe(1);
    expect(output.join("\n")).toContain("Memory migrations applied: memory-core-001, memory-core-003, memory-vector-002");
  });

  it("returns failure and still closes the injected pool when migration fails", async () => {
    let closed = 0;
    const errors = [];
    const status = await runMemoryMigrationCli({
      argv: [],
      env: { MEMORY_DATABASE_URL: "postgresql://user:secret@db.invalid/memory" },
      stderr: (line) => errors.push(line),
      createPool: async () => ({ executor: { query: async () => ({ rows: [] }) }, close: async () => { closed += 1; } }),
      runMigrations: async () => { throw new Error("migration failed"); },
    });
    expect(status).toBe(1);
    expect(closed).toBe(1);
    expect(errors.join("\n")).toContain("migration failed");
  });

  it("redacts a PostgreSQL URL and password if the driver includes them in an error", async () => {
    const errors = [];
    const status = await runMemoryMigrationCli({
      argv: [],
      env: { MEMORY_DATABASE_URL: "postgresql://configured-user:configured-password@localhost/memory" },
      stderr: (line) => errors.push(line),
      createPool: async () => ({ executor: { query: async () => ({ rows: [] }) }, close: async () => undefined }),
      runMigrations: async () => {
        throw Object.assign(
          new Error("could not connect to postgresql://alice:hunter2@db.example/memory?password=hunter2"),
          { code: "ECONNREFUSED" },
        );
      },
    });
    const logged = errors.join("\n");
    expect(status).toBe(1);
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain("alice");
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("db.example");
  });
});
