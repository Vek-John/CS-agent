import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  DESKTOP_CHECKPOINT_MIGRATION_ID,
  DESKTOP_CHECKPOINT_SQL,
  DESKTOP_MEMORY_MIGRATION_ID,
  DESKTOP_MEMORY_SQL,
  DESKTOP_MEMORY_EVIDENCE_MIGRATION_ID,
  DESKTOP_MEMORY_EVIDENCE_SQL,
  DESKTOP_RUNTIME_HEAD_RECOVERY_MIGRATION_ID,
  DESKTOP_RUNTIME_HEAD_RECOVERY_SQL,
  DESKTOP_REVIEW_ARTIFACT_CONTRACT_MIGRATION_ID,
  DESKTOP_REVIEW_ARTIFACT_CONTRACT_SQL,
  DESKTOP_MIGRATIONS,
  DESKTOP_REVIEW_HISTORY_MIGRATION_ID,
  DESKTOP_REVIEW_HISTORY_SQL,
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
    [
      DESKTOP_REVIEW_HISTORY_MIGRATION_ID,
      "003-review-history-core.sql",
      DESKTOP_REVIEW_HISTORY_SQL,
    ],
    [
      DESKTOP_MEMORY_EVIDENCE_MIGRATION_ID,
      "004-memory-evidence-identity.sql",
      DESKTOP_MEMORY_EVIDENCE_SQL,
    ],
    [
      DESKTOP_RUNTIME_HEAD_RECOVERY_MIGRATION_ID,
      "005-runtime-head-recovery-identity.sql",
      DESKTOP_RUNTIME_HEAD_RECOVERY_SQL,
    ],
    [
      DESKTOP_REVIEW_ARTIFACT_CONTRACT_MIGRATION_ID,
      "006-review-artifact-contract.sql",
      DESKTOP_REVIEW_ARTIFACT_CONTRACT_SQL,
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

  it("marks pre-migration revisions v1 while allowing new writers to declare v2", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(DESKTOP_REVIEW_HISTORY_SQL);
      db.exec("INSERT INTO demo_assets(demo_id,content_hash,relative_path,original_filename,byte_size,status,imported_at,last_opened_at) VALUES('demo-old','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','library/demos/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dem','old.dem',8,'READY','2026-09-01','2026-09-01')");
      db.exec("INSERT INTO reviews(review_id,demo_id,selected_player_id,selected_player_name,title,status,created_at,last_opened_at) VALUES('review-old','demo-old','player-old','Old','Old review','READY','2026-09-01','2026-09-01')");
      db.exec("INSERT INTO review_revisions(review_revision_id,review_id,analysis_version,graph_version,prompt_version,model_json,route_hash,status,created_at) VALUES('revision-old','review-old','a','g','p','{}','route','READY','2026-09-01')");
      db.exec(DESKTOP_REVIEW_ARTIFACT_CONTRACT_SQL);
      expect(db.prepare("SELECT artifact_contract_version FROM review_revisions WHERE review_revision_id='revision-old'").get())
        .toEqual({ artifact_contract_version: 1 });
      db.exec("INSERT INTO review_revisions(review_revision_id,review_id,analysis_version,graph_version,prompt_version,model_json,route_hash,status,artifact_contract_version,created_at) VALUES('revision-new','review-old','a','g','p','{}','route','PREPARING',2,'2026-09-03')");
      expect(db.prepare("SELECT artifact_contract_version FROM review_revisions WHERE review_revision_id='revision-new'").get())
        .toEqual({ artifact_contract_version: 2 });
    } finally {
      db.close();
    }
  });
});
