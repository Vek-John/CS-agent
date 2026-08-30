import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  runDesktopMigrations,
  type DesktopMigrationPlan,
} from "./migrations";

describe("desktop migration batch atomicity", () => {
  it("rolls back the ledger, earlier DDL and user data when a later pending migration fails", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cs-agent-migrations-atomic-"),
    );
    const path = join(directory, "memory.sqlite3");
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "CREATE TABLE existing_user_data (id INTEGER PRIMARY KEY,value TEXT NOT NULL) STRICT; INSERT INTO existing_user_data(id,value) VALUES(1,'before')",
      );
      const plan: DesktopMigrationPlan = {
        applied: [],
        pending: [
          {
            id: "fixture-first",
            checksum: "fixture-first-checksum",
            sql: "ALTER TABLE existing_user_data ADD COLUMN future_value TEXT; UPDATE existing_user_data SET value='after'; CREATE TABLE future_from_first(id INTEGER PRIMARY KEY) STRICT;",
          },
          {
            id: "fixture-second",
            checksum: "fixture-second-checksum",
            sql: "CREATE TABLE future_from_second(id INTEGER PRIMARY KEY) STRICT; INSERT INTO table_that_does_not_exist(id) VALUES(1);",
          },
        ],
      };

      expect(() => runDesktopMigrations(db, { plan })).toThrow(
        /table_that_does_not_exist/u,
      );

      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='desktop_schema_migrations'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('future_from_first','future_from_second') ORDER BY name",
          )
          .all(),
      ).toEqual([]);
      expect(
        (
          db.prepare("PRAGMA table_info(existing_user_data)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      ).toEqual(["id", "value"]);
      expect(
        db.prepare("SELECT id,value FROM existing_user_data").all(),
      ).toEqual([{ id: 1, value: "before" }]);
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
