import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabaseOwner } from "./database";
import { stageSqliteRestore } from "./backup";
import type { SqliteBackupManifest } from "./backup";
import {
  DESKTOP_MEMORY_MIGRATION_ID,
  DESKTOP_MEMORY_SQL,
  DESKTOP_MIGRATIONS,
} from "./migrations";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "cs-agent-migration-backup-"));
  cleanup.push(value);
  return value;
}

function createMemoryOnlyDatabase(path: string): void {
  const migration = DESKTOP_MIGRATIONS.find(
    (candidate) => candidate.id === DESKTOP_MEMORY_MIGRATION_ID,
  );
  if (!migration) throw new Error("memory migration fixture missing");
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "CREATE TABLE desktop_schema_migrations (migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT",
    );
    db.exec(DESKTOP_MEMORY_SQL);
    db.prepare(
      "INSERT INTO desktop_schema_migrations(migration_id,checksum,applied_at) VALUES(?,?,?)",
    ).run(migration.id, migration.checksum, "2026-08-30T00:00:00.000Z");
  } finally {
    db.close();
  }
}

describe("desktop migration backup gate", () => {
  it("backs up an existing database before applying a pending migration", async () => {
    const root = await directory();
    const path = join(root, "memory.sqlite3");
    createMemoryOnlyDatabase(path);

    const owner = new SqliteDatabaseOwner({ path });
    const openFiles = await readdir(root);
    for (const name of openFiles.filter((name) =>
      name.startsWith("memory.sqlite3"),
    )) {
      expect((await stat(join(root, name))).mode & 0o777).toBe(0o600);
    }
    await owner.close();

    const backup = openFiles.find(
      (name) =>
        name.startsWith("memory.sqlite3.pre-migration-") &&
        name.endsWith(".sqlite3"),
    );
    expect(backup).toBeDefined();
    expect(
      openFiles.find((name) => name === `${backup}.manifest.json`),
    ).toBeDefined();
    const snapshot = new DatabaseSync(join(root, backup!));
    try {
      expect(
        snapshot
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_checkpoints'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        snapshot
          .prepare("SELECT migration_id FROM desktop_schema_migrations")
          .all(),
      ).toEqual([{ migration_id: DESKTOP_MEMORY_MIGRATION_ID }]);
    } finally {
      snapshot.close();
    }
  });

  it("does not create a meaningless backup for a new empty database", async () => {
    const root = await directory();
    const path = join(root, "memory.sqlite3");
    const owner = new SqliteDatabaseOwner({ path });
    await owner.close();
    expect(
      (await readdir(root)).filter((name) => name.includes("pre-migration")),
    ).toEqual([]);
  });

  it("fails closed before migration when the backup gate fails", async () => {
    const root = await directory();
    const path = join(root, "memory.sqlite3");
    createMemoryOnlyDatabase(path);

    expect(
      () =>
        new SqliteDatabaseOwner({
          path,
          beforeMigrations: () => {
            throw new Error("BACKUP_FAILED");
          },
        }),
    ).toThrow("BACKUP_FAILED");

    const unchanged = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        unchanged
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_checkpoints'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        unchanged
          .prepare("SELECT migration_id FROM desktop_schema_migrations")
          .all(),
      ).toEqual([{ migration_id: DESKTOP_MEMORY_MIGRATION_ID }]);
    } finally {
      unchanged.close();
    }
  });

  it("accepts only a known checksum-correct migration prefix and upgrades the staging copy", async () => {
    const root = await directory();
    const source = join(root, "old.sqlite3");
    const stage = join(root, "stage.sqlite3");
    createMemoryOnlyDatabase(source);
    const old = new DatabaseSync(source);
    old
      .prepare(
        "INSERT INTO app_users(user_id,updated_at) VALUES('preserved','2026-08-30T00:00:00.000Z')",
      )
      .run();
    old.close();

    const oldManifest: SqliteBackupManifest = {
      schemaVersion: "desktop-sqlite-backup.v1",
      createdAt: "2026-08-30T00:00:00.000Z",
      databaseSha256: createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
      migrationLedger: [
        {
          migrationId: DESKTOP_MIGRATIONS[0].id,
          checksum: DESKTOP_MIGRATIONS[0].checksum,
        },
      ],
    };
    await stageSqliteRestore(source, stage, oldManifest);
    const upgraded = new DatabaseSync(stage, { readOnly: true });
    try {
      expect(
        DESKTOP_MIGRATIONS.map((migration) =>
          upgraded
            .prepare(
              "SELECT migration_id FROM desktop_schema_migrations WHERE migration_id=?",
            )
            .get(migration.id),
        ),
      ).toEqual(
        DESKTOP_MIGRATIONS.map((migration) => ({
          migration_id: migration.id,
        })),
      );
      expect(
        upgraded.prepare("SELECT user_id FROM app_users").all(),
      ).toEqual([{ user_id: "preserved" }]);
      expect(
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='demo_assets'",
          )
          .get(),
      ).toEqual({ name: "demo_assets" });
    } finally {
      upgraded.close();
    }
  });

  it("rejects a non-prefix or unknown future ledger before creating staging", async () => {
    const root = await directory();
    const source = join(root, "future.sqlite3");
    createMemoryOnlyDatabase(source);
    const db = new DatabaseSync(source);
    db.prepare(
      "INSERT INTO desktop_schema_migrations(migration_id,checksum,applied_at) VALUES('desktop-future-999','unknown','2026-08-30T00:00:00.000Z')",
    ).run();
    db.close();

    await expect(
      stageSqliteRestore(source, join(root, "must-not-exist.sqlite3")),
    ).rejects.toThrow("SQLITE_MIGRATION_DRIFT:desktop-future-999");
    expect(await readdir(root)).not.toContain("must-not-exist.sqlite3");
  });
});
