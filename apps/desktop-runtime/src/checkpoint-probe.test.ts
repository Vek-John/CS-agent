import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDesktopUpdateBackup,
  probeDesktopCheckpointBackend,
} from "./checkpoint-probe";

test("update backup uses the verified SQLite backup bridge and private files", async (context) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cs-agent-update-backup-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.equal(await probeDesktopCheckpointBackend({ dataDir }), true);

  const summary = await createDesktopUpdateBackup({ dataDir, appVersion: "0.1.0" });
  assert.equal(summary.schemaVersion, "desktop-runtime-backup.v1");
  assert.equal(summary.migrationCount, 2);
  assert.match(summary.databasePath, /cs-agent-pre-update-0\.1\.0-\d+-[a-f0-9]{12}\.sqlite3$/u);
  assert.equal((await stat(summary.databasePath)).mode & 0o777, 0o600);
  assert.equal((await stat(summary.manifestPath)).mode & 0o777, 0o600);
  const manifest = JSON.parse(await readFile(summary.manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, "desktop-sqlite-backup.v1");
  assert.equal(manifest.databaseSha256, summary.databaseSha256);
  assert.equal(manifest.databasePath, summary.databasePath);
});
