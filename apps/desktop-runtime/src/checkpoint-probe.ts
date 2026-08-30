import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSqliteBackup, SqliteDatabaseOwner } from "@cs-coach/memory-sqlite/server";

interface CheckpointProbeInit {
  readonly dataDir: string;
  readonly appVersion?: string;
}

export interface DesktopUpdateBackupSummary {
  readonly schemaVersion: "desktop-runtime-backup.v1";
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly createdAt: string;
  readonly databaseSha256: string;
  readonly migrationCount: number;
}

/**
 * Opens the real desktop database with the same owner/migration code as the
 * application, verifies the checkpoint schema, drains, and closes it. The
 * application opens its long-lived owner after this fail-closed readiness
 * check; no in-memory test saver can satisfy the probe.
 */
export async function probeDesktopCheckpointBackend(init: CheckpointProbeInit): Promise<boolean> {
  const owner = new SqliteDatabaseOwner({ path: path.join(init.dataDir, "cs-agent.sqlite3") });
  try {
    const table = owner.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_checkpoints'").get() as { name?: unknown } | undefined;
    const writes = owner.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_checkpoint_writes'").get() as { name?: unknown } | undefined;
    return table?.name === "agent_checkpoints" && writes?.name === "agent_checkpoint_writes";
  } finally {
    await owner.close();
  }
}

export async function createDesktopUpdateBackup(
  init: CheckpointProbeInit,
): Promise<DesktopUpdateBackupSummary> {
  const backupDirectory = path.join(init.dataDir, "backups");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await chmod(backupDirectory, 0o700);
  const safeVersion = (init.appVersion ?? "unknown").replace(/[^A-Za-z0-9._-]/gu, "_");
  const suffix = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const databasePath = path.join(
    backupDirectory,
    `cs-agent-pre-update-${safeVersion}-${suffix}.sqlite3`,
  );
  const manifestPath = `${databasePath}.manifest.json`;
  const owner = new SqliteDatabaseOwner({ path: path.join(init.dataDir, "cs-agent.sqlite3") });
  try {
    const manifest = await createSqliteBackup(owner, databasePath);
    const summary: DesktopUpdateBackupSummary = {
      schemaVersion: "desktop-runtime-backup.v1",
      databasePath,
      manifestPath,
      createdAt: manifest.createdAt,
      databaseSha256: manifest.databaseSha256,
      migrationCount: manifest.migrationLedger.length,
    };
    try {
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, databasePath }, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(manifestPath, 0o600);
    } catch (error) {
      await Promise.all([
        rm(databasePath, { force: true }),
        rm(manifestPath, { force: true }),
      ]);
      throw error;
    }
    return summary;
  } finally {
    await owner.close();
  }
}
