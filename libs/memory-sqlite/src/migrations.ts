import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const DESKTOP_MEMORY_MIGRATION_ID = "desktop-memory-001" as const;
export const DESKTOP_CHECKPOINT_MIGRATION_ID =
  "desktop-checkpoint-002" as const;
export const DESKTOP_REVIEW_HISTORY_MIGRATION_ID =
  "desktop-review-history-003" as const;
export const DESKTOP_MEMORY_EVIDENCE_MIGRATION_ID =
  "desktop-memory-evidence-004" as const;
export const DESKTOP_RUNTIME_HEAD_RECOVERY_MIGRATION_ID =
  "desktop-runtime-head-recovery-005" as const;
export const DESKTOP_REVIEW_ARTIFACT_CONTRACT_MIGRATION_ID =
  "desktop-review-artifact-contract-006" as const;

export const DESKTOP_MEMORY_SQL = String.raw`
CREATE TABLE app_users (user_id TEXT PRIMARY KEY,memory_enabled INTEGER NOT NULL DEFAULT 0 CHECK(memory_enabled IN (0,1)),consent TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(consent IN ('GRANTED','REVOKED','UNKNOWN')),consent_version INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,memory_deleted_at TEXT) STRICT;
CREATE TABLE memory_records (user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,memory_id TEXT NOT NULL,logical_key TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),revision INTEGER NOT NULL,updated_at TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(user_id,memory_id),UNIQUE(user_id,logical_key)) STRICT;
CREATE TABLE memory_revisions (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(user_id,memory_id,revision),FOREIGN KEY(user_id,memory_id) REFERENCES memory_records(user_id,memory_id) ON DELETE CASCADE) STRICT;
CREATE TABLE user_preferences (user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,preference_key TEXT NOT NULL,value_json TEXT NOT NULL,source TEXT NOT NULL,refs_json TEXT NOT NULL,label TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,preference_key)) STRICT;
CREATE TABLE learning_threads (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,thread_id TEXT NOT NULL,logical_key TEXT NOT NULL,status TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),revision INTEGER NOT NULL,thread_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,memory_id,thread_id),UNIQUE(user_id,thread_id),FOREIGN KEY(user_id,memory_id) REFERENCES memory_records(user_id,memory_id) ON DELETE CASCADE) STRICT;
CREATE TABLE memory_events (user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,event_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,session_id TEXT NOT NULL,event_type TEXT NOT NULL,target_memory_id TEXT,logical_key TEXT,status TEXT NOT NULL DEFAULT 'POSTED' CHECK(status IN ('POSTED','CONSUMED','RETRY','DEAD_LETTER')),attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,error_code TEXT,created_at TEXT NOT NULL,consumed_at TEXT,event_json TEXT NOT NULL,PRIMARY KEY(user_id,event_id),UNIQUE(user_id,idempotency_key)) STRICT;
CREATE TABLE memory_write_receipts (user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,idempotency_key TEXT NOT NULL,memory_id TEXT,revision INTEGER,created_at TEXT NOT NULL,PRIMARY KEY(user_id,idempotency_key)) STRICT;
CREATE TABLE memory_cue_effects (user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,session_id TEXT NOT NULL,cue_id TEXT NOT NULL,logical_key TEXT NOT NULL,effect_type TEXT NOT NULL,memory_id TEXT,producer_version TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,session_id,cue_id,logical_key,effect_type)) STRICT;
CREATE TABLE memory_tombstones (user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,memory_id TEXT NOT NULL,logical_key TEXT NOT NULL,revision INTEGER NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(user_id,memory_id),UNIQUE(user_id,logical_key)) STRICT;
CREATE TABLE memory_embeddings (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,dimension INTEGER NOT NULL,norm REAL NOT NULL,model TEXT NOT NULL,content_hash TEXT NOT NULL,source_revision INTEGER NOT NULL,vector_blob BLOB NOT NULL,created_at TEXT NOT NULL,deleted_at TEXT,PRIMARY KEY(user_id,memory_id),FOREIGN KEY(user_id,memory_id) REFERENCES memory_records(user_id,memory_id) ON DELETE CASCADE) STRICT;
CREATE TABLE memory_observations (user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,observation_id TEXT NOT NULL,memory_id TEXT,session_id TEXT NOT NULL,cue_id TEXT NOT NULL,taxonomy_code TEXT NOT NULL,demo_content_hash TEXT NOT NULL,source_ref_json TEXT,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,observation_id),UNIQUE(user_id,session_id,cue_id,taxonomy_code),FOREIGN KEY(user_id,memory_id) REFERENCES memory_records(user_id,memory_id) ON DELETE SET NULL) STRICT;
CREATE TABLE memory_evidence (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,ref_key TEXT NOT NULL,evidence_json TEXT NOT NULL,PRIMARY KEY(user_id,memory_id,ref_key),FOREIGN KEY(user_id,memory_id) REFERENCES memory_records(user_id,memory_id) ON DELETE CASCADE) STRICT;
CREATE INDEX memory_records_recall_idx ON memory_records(user_id,active,status,updated_at DESC);
CREATE INDEX memory_events_session_idx ON memory_events(user_id,session_id);
CREATE INDEX learning_threads_active_idx ON learning_threads(user_id,active,updated_at DESC);`;

export const DESKTOP_CHECKPOINT_SQL = String.raw`
CREATE TABLE agent_checkpoints (thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,checkpoint_id TEXT NOT NULL,parent_checkpoint_id TEXT,checkpoint_type TEXT NOT NULL,checkpoint_data BLOB NOT NULL,metadata_type TEXT NOT NULL,metadata_data BLOB NOT NULL,completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),created_seq INTEGER PRIMARY KEY AUTOINCREMENT,UNIQUE(thread_id,checkpoint_ns,checkpoint_id)) STRICT;
CREATE TABLE agent_checkpoint_writes (thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,checkpoint_id TEXT NOT NULL,task_id TEXT NOT NULL,write_index INTEGER NOT NULL,channel TEXT NOT NULL,value_type TEXT NOT NULL,value_data BLOB NOT NULL,PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,write_index),FOREIGN KEY(thread_id,checkpoint_ns,checkpoint_id) REFERENCES agent_checkpoints(thread_id,checkpoint_ns,checkpoint_id) ON DELETE CASCADE) STRICT;`;

export const DESKTOP_REVIEW_HISTORY_SQL = String.raw`
CREATE TABLE demo_assets (demo_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL UNIQUE CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),relative_path TEXT NOT NULL UNIQUE,original_filename TEXT NOT NULL,byte_size INTEGER NOT NULL CHECK(byte_size>=8),map_name TEXT,match_started_at TEXT,match_duration_ms INTEGER CHECK(match_duration_ms IS NULL OR match_duration_ms>=0),status TEXT NOT NULL CHECK(status IN ('IMPORTING','READY','MISSING','CORRUPT')),imported_at TEXT NOT NULL,last_opened_at TEXT NOT NULL,parser_version TEXT,last_verified_at TEXT) STRICT;
CREATE TABLE reviews (review_id TEXT PRIMARY KEY,demo_id TEXT NOT NULL REFERENCES demo_assets(demo_id) ON DELETE CASCADE,selected_player_id TEXT NOT NULL,selected_player_name TEXT NOT NULL,title TEXT NOT NULL,map_name TEXT,score_text TEXT,status TEXT NOT NULL CHECK(status IN ('PREPARING','READY','IN_PROGRESS','COMPLETED','FAILED','STALE')),active_revision_id TEXT,current_cue_id TEXT,current_playback_tick INTEGER CHECK(current_playback_tick IS NULL OR current_playback_tick>=0),completed_cue_count INTEGER NOT NULL DEFAULT 0 CHECK(completed_cue_count>=0),total_cue_count INTEGER NOT NULL DEFAULT 0 CHECK(total_cue_count>=0),created_at TEXT NOT NULL,last_opened_at TEXT NOT NULL,completed_at TEXT) STRICT;
CREATE TABLE review_revisions (review_revision_id TEXT PRIMARY KEY,review_id TEXT NOT NULL REFERENCES reviews(review_id) ON DELETE CASCADE,analysis_version TEXT NOT NULL,graph_version TEXT NOT NULL,prompt_version TEXT NOT NULL,model_json TEXT NOT NULL CHECK(json_valid(model_json)),route_id TEXT,route_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PREPARING','READY','FAILED')),created_at TEXT NOT NULL) STRICT;
CREATE TABLE review_artifacts (artifact_id TEXT PRIMARY KEY,review_revision_id TEXT NOT NULL REFERENCES review_revisions(review_revision_id) ON DELETE CASCADE,artifact_type TEXT NOT NULL CHECK(artifact_type IN ('ANALYSIS_BUNDLE','CANDIDATE_SET','REVIEW_PLAN','NARRATION_BUNDLE','CUE_CASE','DIAGNOSTIC_RESULT','TRANSFER_RULE','LEARNING_THREAD','SESSION_RECOVERY','SESSION_SUMMARY','TOOL_RESULT','USER_INTERACTION')),artifact_key TEXT NOT NULL,artifact_revision INTEGER NOT NULL CHECK(artifact_revision>=1),schema_version TEXT NOT NULL,checksum TEXT NOT NULL CHECK(length(checksum)=64 AND checksum NOT GLOB '*[^0-9a-f]*'),storage_kind TEXT NOT NULL CHECK(storage_kind IN ('SQLITE_JSON','GZIP_FILE')),relative_path TEXT,json_payload TEXT CHECK(json_payload IS NULL OR json_valid(json_payload)),byte_size INTEGER NOT NULL CHECK(byte_size>=0),idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,CHECK((storage_kind='SQLITE_JSON' AND relative_path IS NULL AND json_payload IS NOT NULL) OR (storage_kind='GZIP_FILE' AND relative_path IS NOT NULL AND json_payload IS NULL)),UNIQUE(review_revision_id,artifact_type,artifact_key,artifact_revision),UNIQUE(review_revision_id,idempotency_key)) STRICT;
CREATE TABLE review_runtime_heads (review_id TEXT PRIMARY KEY REFERENCES reviews(review_id) ON DELETE CASCADE,review_revision_id TEXT NOT NULL REFERENCES review_revisions(review_revision_id) ON DELETE CASCADE,session_id TEXT NOT NULL,run_id TEXT NOT NULL,demo_id TEXT NOT NULL,demo_content_hash TEXT NOT NULL CHECK(length(demo_content_hash)=64 AND demo_content_hash NOT GLOB '*[^0-9a-f]*'),selected_player_id TEXT NOT NULL,route_id TEXT NOT NULL,route_hash TEXT NOT NULL,recovery_boundary TEXT NOT NULL CHECK(recovery_boundary IN ('ROUTE_START','CUE_PAUSED','WRAP_UP')),checkpoint_thread_id TEXT,checkpoint_namespace TEXT,checkpoint_id TEXT,current_cue_id TEXT,default_route_cursor INTEGER NOT NULL CHECK(default_route_cursor>=0),completed_cue_count INTEGER NOT NULL CHECK(completed_cue_count>=0),total_cue_count INTEGER NOT NULL CHECK(total_cue_count>=0),last_playback_tick INTEGER CHECK(last_playback_tick IS NULL OR last_playback_tick>=0),stable_progress_json TEXT NOT NULL CHECK(json_valid(stable_progress_json)),updated_at TEXT NOT NULL,CHECK(((checkpoint_thread_id IS NULL AND checkpoint_namespace IS NULL AND checkpoint_id IS NULL) OR (checkpoint_thread_id IS NOT NULL AND checkpoint_namespace IS NOT NULL AND checkpoint_id IS NOT NULL)) AND (recovery_boundary='ROUTE_START' OR checkpoint_id IS NOT NULL))) STRICT;
CREATE TABLE library_import_jobs (job_id TEXT PRIMARY KEY,object_id TEXT NOT NULL,candidate_demo_id TEXT NOT NULL,original_filename TEXT NOT NULL,expected_byte_length INTEGER NOT NULL CHECK(expected_byte_length>=8),temp_relative_path TEXT NOT NULL UNIQUE,final_relative_path TEXT,content_hash TEXT,byte_size INTEGER,status TEXT NOT NULL CHECK(status IN ('WRITING','PUBLISHING','COMPLETED','FAILED')),error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
CREATE TABLE library_artifact_jobs (job_id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL,review_revision_id TEXT NOT NULL,artifact_type TEXT NOT NULL,artifact_key TEXT NOT NULL,artifact_revision INTEGER NOT NULL CHECK(artifact_revision>=1),schema_version TEXT NOT NULL,checksum TEXT NOT NULL CHECK(length(checksum)=64 AND checksum NOT GLOB '*[^0-9a-f]*'),idempotency_key TEXT NOT NULL,temp_relative_path TEXT NOT NULL UNIQUE,final_relative_path TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('WRITING','PUBLISHING','COMPLETED','FAILED')),error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
CREATE TABLE library_delete_jobs (job_id TEXT PRIMARY KEY,target_kind TEXT NOT NULL CHECK(target_kind IN ('REVIEW','DEMO')),target_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PREPARED','FILES_DELETED','COMPLETED','FAILED')),snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
CREATE INDEX reviews_history_idx ON reviews(last_opened_at DESC,review_id DESC);
CREATE INDEX reviews_demo_idx ON reviews(demo_id,created_at DESC);
CREATE INDEX review_revisions_review_idx ON review_revisions(review_id,created_at DESC);
CREATE INDEX review_artifacts_revision_idx ON review_artifacts(review_revision_id,artifact_type,artifact_key);
CREATE INDEX library_import_jobs_status_idx ON library_import_jobs(status,updated_at);
CREATE INDEX library_delete_jobs_status_idx ON library_delete_jobs(status,updated_at);`;

export const DESKTOP_MEMORY_EVIDENCE_SQL = String.raw`
CREATE TABLE memory_opportunity_claims (user_id TEXT NOT NULL,demo_content_hash TEXT NOT NULL CHECK(length(demo_content_hash)=64 AND demo_content_hash NOT GLOB '*[^0-9a-f]*'),selected_player_id TEXT NOT NULL,stable_cue_source_id TEXT NOT NULL,taxonomy_code TEXT NOT NULL,first_analysis_evidence_revision TEXT NOT NULL,latest_analysis_evidence_revision TEXT NOT NULL,claimed_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code)) STRICT;
CREATE TABLE memory_opportunity_evidence (user_id TEXT NOT NULL,demo_content_hash TEXT NOT NULL,selected_player_id TEXT NOT NULL,stable_cue_source_id TEXT NOT NULL,taxonomy_code TEXT NOT NULL,evidence_key TEXT NOT NULL,analysis_evidence_revision TEXT NOT NULL,source_review_id TEXT,source_review_revision_id TEXT,source_artifact_id TEXT,evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),availability TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(availability IN ('AVAILABLE','DELETED')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,evidence_key),FOREIGN KEY(user_id,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code) REFERENCES memory_opportunity_claims(user_id,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code) ON DELETE CASCADE) STRICT;
CREATE TABLE memory_evidence_tombstones (user_id TEXT NOT NULL,evidence_key TEXT NOT NULL,demo_content_hash TEXT NOT NULL CHECK(length(demo_content_hash)=64 AND demo_content_hash NOT GLOB '*[^0-9a-f]*'),selected_player_id TEXT NOT NULL,stable_cue_source_id TEXT NOT NULL,taxonomy_code TEXT NOT NULL,source_review_id TEXT,source_review_revision_id TEXT,source_artifact_id TEXT,deleted_at TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(user_id,evidence_key)) STRICT;
CREATE INDEX memory_opportunity_demo_idx ON memory_opportunity_claims(user_id,demo_content_hash,selected_player_id);
CREATE INDEX memory_opportunity_evidence_review_idx ON memory_opportunity_evidence(source_review_id,availability);
CREATE INDEX memory_evidence_tombstones_review_idx ON memory_evidence_tombstones(source_review_id,deleted_at);`;

export const DESKTOP_RUNTIME_HEAD_RECOVERY_SQL = String.raw`
ALTER TABLE review_runtime_heads ADD COLUMN recovery_artifact_id TEXT REFERENCES review_artifacts(artifact_id) ON DELETE CASCADE;
ALTER TABLE review_runtime_heads ADD COLUMN recovery_artifact_key TEXT;
ALTER TABLE review_runtime_heads ADD COLUMN recovery_artifact_revision INTEGER CHECK(recovery_artifact_revision IS NULL OR recovery_artifact_revision>=1);
UPDATE review_runtime_heads
SET recovery_artifact_id=(SELECT artifact_id FROM review_artifacts WHERE review_revision_id=review_runtime_heads.review_revision_id AND artifact_type='SESSION_RECOVERY' LIMIT 1),
    recovery_artifact_key=(SELECT artifact_key FROM review_artifacts WHERE review_revision_id=review_runtime_heads.review_revision_id AND artifact_type='SESSION_RECOVERY' LIMIT 1),
    recovery_artifact_revision=(SELECT artifact_revision FROM review_artifacts WHERE review_revision_id=review_runtime_heads.review_revision_id AND artifact_type='SESSION_RECOVERY' LIMIT 1)
WHERE (SELECT COUNT(*) FROM review_artifacts WHERE review_revision_id=review_runtime_heads.review_revision_id AND artifact_type='SESSION_RECOVERY')=1;
CREATE UNIQUE INDEX review_runtime_heads_recovery_artifact_idx ON review_runtime_heads(recovery_artifact_id) WHERE recovery_artifact_id IS NOT NULL;`;

export const DESKTOP_REVIEW_ARTIFACT_CONTRACT_SQL = String.raw`
ALTER TABLE review_revisions
ADD COLUMN artifact_contract_version INTEGER NOT NULL DEFAULT 1
CHECK(artifact_contract_version IN (1,2));`;

export interface DesktopMigration {
  id: string;
  sql: string;
  checksum: string;
}
export interface DesktopMigrationPlan {
  readonly applied: readonly DesktopMigration[];
  readonly pending: readonly DesktopMigration[];
}
const checksum = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex");
export const DESKTOP_MIGRATIONS: readonly DesktopMigration[] = [
  {
    id: DESKTOP_MEMORY_MIGRATION_ID,
    sql: DESKTOP_MEMORY_SQL,
    checksum: checksum(DESKTOP_MEMORY_SQL),
  },
  {
    id: DESKTOP_CHECKPOINT_MIGRATION_ID,
    sql: DESKTOP_CHECKPOINT_SQL,
    checksum: checksum(DESKTOP_CHECKPOINT_SQL),
  },
  {
    id: DESKTOP_REVIEW_HISTORY_MIGRATION_ID,
    sql: DESKTOP_REVIEW_HISTORY_SQL,
    checksum: checksum(DESKTOP_REVIEW_HISTORY_SQL),
  },
  {
    id: DESKTOP_MEMORY_EVIDENCE_MIGRATION_ID,
    sql: DESKTOP_MEMORY_EVIDENCE_SQL,
    checksum: checksum(DESKTOP_MEMORY_EVIDENCE_SQL),
  },
  {
    id: DESKTOP_RUNTIME_HEAD_RECOVERY_MIGRATION_ID,
    sql: DESKTOP_RUNTIME_HEAD_RECOVERY_SQL,
    checksum: checksum(DESKTOP_RUNTIME_HEAD_RECOVERY_SQL),
  },
  {
    id: DESKTOP_REVIEW_ARTIFACT_CONTRACT_MIGRATION_ID,
    sql: DESKTOP_REVIEW_ARTIFACT_CONTRACT_SQL,
    checksum: checksum(DESKTOP_REVIEW_ARTIFACT_CONTRACT_SQL),
  },
];

export function getDesktopMigrationPlan(
  db: DatabaseSync,
): DesktopMigrationPlan {
  const ledgerExists = Boolean(
    db
      .prepare(
        "SELECT 1 present FROM sqlite_master WHERE type='table' AND name='desktop_schema_migrations'",
      )
      .get(),
  );
  const selected = ledgerExists
    ? (db
        .prepare("SELECT migration_id,checksum FROM desktop_schema_migrations")
        .all() as Array<{ migration_id: string; checksum: string }>)
    : [];
  const known = new Map(selected.map((row) => [row.migration_id, row.checksum]));
  for (const row of selected) {
    const expected = DESKTOP_MIGRATIONS.find(
      (item) => item.id === row.migration_id,
    );
    if (!expected || expected.checksum !== row.checksum)
      throw new Error(`SQLITE_MIGRATION_DRIFT:${row.migration_id}`);
  }
  let appliedCount = 0;
  while (
    appliedCount < DESKTOP_MIGRATIONS.length &&
    known.has(DESKTOP_MIGRATIONS[appliedCount].id)
  )
    appliedCount += 1;
  if (known.size !== appliedCount)
    throw new Error("SQLITE_MIGRATION_LEDGER_NOT_PREFIX");
  return {
    applied: DESKTOP_MIGRATIONS.slice(0, appliedCount),
    pending: DESKTOP_MIGRATIONS.slice(appliedCount),
  };
}

export function runDesktopMigrations(
  db: DatabaseSync,
  options: {
    readonly plan?: DesktopMigrationPlan;
    readonly beforeMigrations?: (plan: DesktopMigrationPlan) => void;
  } = {},
): readonly string[] {
  const plan = options.plan ?? getDesktopMigrationPlan(db);
  if (plan.pending.length > 0) options.beforeMigrations?.(plan);
  const applied: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS desktop_schema_migrations (migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT",
    );
    for (const migration of plan.pending) {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO desktop_schema_migrations(migration_id,checksum,applied_at) VALUES(?,?,?)",
      ).run(migration.id, migration.checksum, new Date().toISOString());
      applied.push(migration.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* preserve original migration failure */
    }
    throw error;
  }
  return applied;
}
