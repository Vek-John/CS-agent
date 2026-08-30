import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_CHECKPOINT_MIGRATION_ID,
  DESKTOP_CHECKPOINT_SQL,
  DESKTOP_MEMORY_MIGRATION_ID,
  DESKTOP_MEMORY_SQL,
  DESKTOP_MIGRATIONS,
} from "./migrations";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const normalizeSql = (sql: string): string => sql.replace(/\s+/g, "");
const checksum = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex");

describe("desktop migration checked-in SQL", () => {
  it.each([
    [DESKTOP_MEMORY_MIGRATION_ID, "001-memory-core.sql", DESKTOP_MEMORY_SQL],
    [
      DESKTOP_CHECKPOINT_MIGRATION_ID,
      "002-agent-checkpoint.sql",
      DESKTOP_CHECKPOINT_SQL,
    ],
  ] as const)(
    "keeps %s identical to its checked-in SQL file",
    async (id, file, embedded) => {
      const checkedIn = await readFile(
        join(repositoryRoot, "migrations/desktop", file),
        "utf8",
      );
      expect(normalizeSql(checkedIn)).toBe(normalizeSql(embedded));
      expect(checksum(normalizeSql(checkedIn))).toBe(
        checksum(normalizeSql(embedded)),
      );
      const migration = DESKTOP_MIGRATIONS.find(
        (candidate) => candidate.id === id,
      );
      expect(migration?.checksum).toBe(checksum(embedded));
    },
  );
});
