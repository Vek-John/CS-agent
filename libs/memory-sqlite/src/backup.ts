import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { SqliteDatabaseOwner } from "./database";
import { DESKTOP_MIGRATIONS, runDesktopMigrations } from "./migrations";
import type { DesktopMigrationPlan } from "./migrations";

export interface SqliteBackupManifest {
  schemaVersion: "desktop-sqlite-backup.v1";
  createdAt: string;
  databaseSha256: string;
  migrationLedger: readonly { migrationId: string; checksum: string }[];
}
function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function validatedLedger(
  rows: readonly { migration_id: string; checksum: string }[],
  requireComplete: boolean,
): readonly { migrationId: string; checksum: string }[] {
  if (requireComplete && rows.length !== DESKTOP_MIGRATIONS.length)
    throw new Error("SQLITE_MIGRATION_LEDGER_INCOMPLETE");
  const actual = new Map(rows.map((row) => [row.migration_id, row.checksum]));
  for (const row of rows) {
    const known = DESKTOP_MIGRATIONS.find(
      (migration) => migration.id === row.migration_id,
    );
    if (!known || known.checksum !== row.checksum)
      throw new Error(`SQLITE_MIGRATION_DRIFT:${row.migration_id}`);
  }
  const prefix = DESKTOP_MIGRATIONS.slice(0, rows.length);
  if (prefix.some((migration) => !actual.has(migration.id)))
    throw new Error("SQLITE_MIGRATION_LEDGER_NOT_PREFIX");
  return prefix.map((migration) => ({
    migrationId: migration.id,
    checksum: migration.checksum,
  }));
}
function readValidatedLedger(
  db: DatabaseSync,
): readonly { migrationId: string; checksum: string }[] {
  const rows = db
    .prepare(
      "SELECT migration_id,checksum FROM desktop_schema_migrations ORDER BY migration_id",
    )
    .all() as Array<{ migration_id: string; checksum: string }>;
  return validatedLedger(rows, true);
}
function readAppliedLedger(
  db: DatabaseSync,
): readonly { migrationId: string; checksum: string }[] {
  const exists = db
    .prepare(
      "SELECT 1 present FROM sqlite_master WHERE type='table' AND name='desktop_schema_migrations'",
    )
    .get();
  if (!exists) return [];
  const rows = db
    .prepare(
      "SELECT migration_id,checksum FROM desktop_schema_migrations ORDER BY migration_id",
    )
    .all() as Array<{ migration_id: string; checksum: string }>;
  return validatedLedger(rows, false);
}
function verifyManifest(
  path: string,
  manifest: SqliteBackupManifest,
  sourceLedger: readonly { migrationId: string; checksum: string }[],
): void {
  if (
    manifest.schemaVersion !== "desktop-sqlite-backup.v1" ||
    manifest.databaseSha256 !== sha(path)
  )
    throw new Error("SQLITE_BACKUP_CHECKSUM_MISMATCH");
  const manifestLedger = validatedLedger(
    manifest.migrationLedger.map((migration) => ({
      migration_id: migration.migrationId,
      checksum: migration.checksum,
    })),
    false,
  );
  const expected = sourceLedger.map(
    (migration) => `${migration.migrationId}:${migration.checksum}`,
  );
  const actual = manifestLedger.map(
    (migration) => `${migration.migrationId}:${migration.checksum}`,
  );
  if (
    actual.length !== expected.length ||
    expected.some((value) => !actual.includes(value))
  )
    throw new Error("SQLITE_BACKUP_LEDGER_MISMATCH");
}
export function verifySqliteDatabase(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (
      integrity.length !== 1 ||
      String(Object.values(integrity[0])[0]).toLowerCase() !== "ok"
    )
      throw new Error("SQLITE_INTEGRITY_CHECK_FAILED");
    const foreign = db.prepare("PRAGMA foreign_key_check").all();
    if (foreign.length) throw new Error("SQLITE_FOREIGN_KEY_CHECK_FAILED");
    readValidatedLedger(db);
  } finally {
    db.close();
  }
}
export function createPreMigrationBackup(
  db: DatabaseSync,
  sourcePath: string,
  plan: DesktopMigrationPlan,
): { readonly databasePath: string; readonly manifestPath: string } {
  const source = resolve(sourcePath);
  const suffix = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const databasePath = `${source}.pre-migration-${suffix}.sqlite3`;
  const manifestPath = `${databasePath}.manifest.json`;
  if (existsSync(databasePath) || existsSync(manifestPath))
    throw new Error("SQLITE_BACKUP_DESTINATION_EXISTS");
  try {
    db.prepare("VACUUM INTO ?").run(databasePath);
    chmodSync(databasePath, 0o600);
    const snapshot = new DatabaseSync(databasePath, { readOnly: true });
    let ledger;
    try {
      const integrity = snapshot
        .prepare("PRAGMA integrity_check")
        .all() as Array<Record<string, unknown>>;
      if (
        integrity.length !== 1 ||
        String(Object.values(integrity[0])[0]).toLowerCase() !== "ok"
      )
        throw new Error("SQLITE_INTEGRITY_CHECK_FAILED");
      if (snapshot.prepare("PRAGMA foreign_key_check").all().length > 0)
        throw new Error("SQLITE_FOREIGN_KEY_CHECK_FAILED");
      ledger = readAppliedLedger(snapshot);
    } finally {
      snapshot.close();
    }
    const manifest = {
      schemaVersion: "desktop-sqlite-pre-migration-backup.v1",
      createdAt: new Date().toISOString(),
      databaseSha256: sha(databasePath),
      appliedMigrations: ledger,
      pendingMigrations: plan.pending.map((migration) => migration.id),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(manifestPath, 0o600);
    return { databasePath, manifestPath };
  } catch (error) {
    rmSync(databasePath, { force: true });
    rmSync(manifestPath, { force: true });
    throw error;
  }
}
export async function createSqliteBackup(
  owner: SqliteDatabaseOwner,
  destination: string,
): Promise<SqliteBackupManifest> {
  const target = resolve(destination);
  if (dirname(target) === target || target === owner.path)
    throw new Error("INVALID_BACKUP_DESTINATION");
  if (existsSync(target)) throw new Error("SQLITE_BACKUP_DESTINATION_EXISTS");
  await owner.drain();
  try {
    await backup(owner.db, target);
    chmodSync(target, 0o600);
    verifySqliteDatabase(target);
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
  const db = new DatabaseSync(target, { readOnly: true });
  let ledger;
  try {
    ledger = readValidatedLedger(db);
  } finally {
    db.close();
  }
  return {
    schemaVersion: "desktop-sqlite-backup.v1",
    createdAt: new Date().toISOString(),
    databaseSha256: sha(target),
    migrationLedger: ledger,
  };
}
export async function stageSqliteRestore(
  source: string,
  stagingPath: string,
  manifest?: SqliteBackupManifest,
): Promise<string> {
  const sourcePath = resolve(source),
    stage = resolve(stagingPath);
  if (sourcePath === stage) throw new Error("INVALID_RESTORE_STAGING_PATH");
  if (existsSync(stage)) throw new Error("SQLITE_RESTORE_STAGING_EXISTS");
  const inspection = new DatabaseSync(sourcePath, { readOnly: true });
  let sourceLedger;
  try {
    const integrity = inspection.prepare("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (
      integrity.length !== 1 ||
      String(Object.values(integrity[0])[0]).toLowerCase() !== "ok"
    )
      throw new Error("SQLITE_INTEGRITY_CHECK_FAILED");
    if (inspection.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error("SQLITE_FOREIGN_KEY_CHECK_FAILED");
    sourceLedger = readAppliedLedger(inspection);
  } finally {
    inspection.close();
  }
  if (manifest) verifyManifest(sourcePath, manifest, sourceLedger);
  const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(sourceDb, stage);
    chmodSync(stage, 0o600);
  } catch (error) {
    rmSync(stage, { force: true });
    throw error;
  } finally {
    sourceDb.close();
  }
  try {
    const stagedDb = new DatabaseSync(stage);
    try {
      stagedDb.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL");
      runDesktopMigrations(stagedDb);
    } finally {
      stagedDb.close();
    }
    verifySqliteDatabase(stage);
  } catch (error) {
    rmSync(stage, { force: true });
    throw error;
  }
  return stage;
}
export function atomicReplaceSqliteFromStaging(
  stagingPath: string,
  inactiveDestination: string,
): void {
  const stage = resolve(stagingPath),
    destination = resolve(inactiveDestination);
  if (stage === destination) throw new Error("INVALID_RESTORE_DESTINATION");
  if (existsSync(destination))
    throw new Error("SQLITE_RESTORE_DESTINATION_EXISTS");
  verifySqliteDatabase(stage);
  renameSync(stage, destination);
  chmodSync(destination, 0o600);
}
export function discardStagedSqliteRestore(stagingPath: string): void {
  rmSync(resolve(stagingPath), { force: true });
}
