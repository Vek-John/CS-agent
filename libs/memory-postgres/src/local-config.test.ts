import { describe, expect, it } from "vitest";
import {
  MemoryDatabaseConfigurationError,
  resolveMemoryDatabaseUrl,
} from "./server";

describe("localhost PostgreSQL memory configuration", () => {
  it("prefers MEMORY_DATABASE_URL and falls back to DATABASE_URL", () => {
    expect(resolveMemoryDatabaseUrl({
      MEMORY_DATABASE_URL: "  postgresql://memory.invalid/local  ",
      DATABASE_URL: "postgresql://fallback.invalid/local",
    })).toBe("postgresql://memory.invalid/local");
    expect(resolveMemoryDatabaseUrl({
      DATABASE_URL: "  postgres://fallback.invalid/local  ",
    })).toBe("postgres://fallback.invalid/local");
  });

  it("fails with a stable code without echoing an absent or secret URL", () => {
    expect(() => resolveMemoryDatabaseUrl({})).toThrow(MemoryDatabaseConfigurationError);
    try {
      resolveMemoryDatabaseUrl({});
    } catch (error) {
      expect(error).toMatchObject({ code: "MEMORY_DATABASE_CONFIGURATION" });
      expect(String(error)).not.toContain("postgresql://");
    }
  });
});
