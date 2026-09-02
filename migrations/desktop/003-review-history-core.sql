CREATE TABLE demo_assets (
  demo_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  relative_path TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size>=8),
  map_name TEXT,
  match_started_at TEXT,
  match_duration_ms INTEGER CHECK(match_duration_ms IS NULL OR match_duration_ms>=0),
  status TEXT NOT NULL CHECK(status IN ('IMPORTING','READY','MISSING','CORRUPT')),
  imported_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  parser_version TEXT,
  last_verified_at TEXT
) STRICT;

CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY,
  demo_id TEXT NOT NULL REFERENCES demo_assets(demo_id) ON DELETE CASCADE,
  selected_player_id TEXT NOT NULL,
  selected_player_name TEXT NOT NULL,
  title TEXT NOT NULL,
  map_name TEXT,
  score_text TEXT,
  status TEXT NOT NULL CHECK(status IN ('PREPARING','READY','IN_PROGRESS','COMPLETED','FAILED','STALE')),
  active_revision_id TEXT,
  current_cue_id TEXT,
  current_playback_tick INTEGER CHECK(current_playback_tick IS NULL OR current_playback_tick>=0),
  completed_cue_count INTEGER NOT NULL DEFAULT 0 CHECK(completed_cue_count>=0),
  total_cue_count INTEGER NOT NULL DEFAULT 0 CHECK(total_cue_count>=0),
  created_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE review_revisions (
  review_revision_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id) ON DELETE CASCADE,
  analysis_version TEXT NOT NULL,
  graph_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_json TEXT NOT NULL CHECK(json_valid(model_json)),
  route_id TEXT,
  route_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PREPARING','READY','FAILED')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE review_artifacts (
  artifact_id TEXT PRIMARY KEY,
  review_revision_id TEXT NOT NULL REFERENCES review_revisions(review_revision_id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL CHECK(artifact_type IN ('ANALYSIS_BUNDLE','CANDIDATE_SET','REVIEW_PLAN','NARRATION_BUNDLE','CUE_CASE','DIAGNOSTIC_RESULT','TRANSFER_RULE','LEARNING_THREAD','SESSION_RECOVERY','SESSION_SUMMARY','TOOL_RESULT','USER_INTERACTION')),
  artifact_key TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL CHECK(artifact_revision>=1),
  schema_version TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum)=64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  storage_kind TEXT NOT NULL CHECK(storage_kind IN ('SQLITE_JSON','GZIP_FILE')),
  relative_path TEXT,
  json_payload TEXT CHECK(json_payload IS NULL OR json_valid(json_payload)),
  byte_size INTEGER NOT NULL CHECK(byte_size>=0),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK((storage_kind='SQLITE_JSON' AND relative_path IS NULL AND json_payload IS NOT NULL) OR (storage_kind='GZIP_FILE' AND relative_path IS NOT NULL AND json_payload IS NULL)),
  UNIQUE(review_revision_id,artifact_type,artifact_key,artifact_revision),
  UNIQUE(review_revision_id,idempotency_key)
) STRICT;

CREATE TABLE review_runtime_heads (
  review_id TEXT PRIMARY KEY REFERENCES reviews(review_id) ON DELETE CASCADE,
  review_revision_id TEXT NOT NULL REFERENCES review_revisions(review_revision_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  demo_id TEXT NOT NULL,
  demo_content_hash TEXT NOT NULL CHECK(length(demo_content_hash)=64 AND demo_content_hash NOT GLOB '*[^0-9a-f]*'),
  selected_player_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  route_hash TEXT NOT NULL,
  recovery_boundary TEXT NOT NULL CHECK(recovery_boundary IN ('ROUTE_START','CUE_PAUSED','WRAP_UP')),
  checkpoint_thread_id TEXT,
  checkpoint_namespace TEXT,
  checkpoint_id TEXT,
  current_cue_id TEXT,
  default_route_cursor INTEGER NOT NULL CHECK(default_route_cursor>=0),
  completed_cue_count INTEGER NOT NULL CHECK(completed_cue_count>=0),
  total_cue_count INTEGER NOT NULL CHECK(total_cue_count>=0),
  last_playback_tick INTEGER CHECK(last_playback_tick IS NULL OR last_playback_tick>=0),
  stable_progress_json TEXT NOT NULL CHECK(json_valid(stable_progress_json)),
  updated_at TEXT NOT NULL,
  CHECK(((checkpoint_thread_id IS NULL AND checkpoint_namespace IS NULL AND checkpoint_id IS NULL) OR (checkpoint_thread_id IS NOT NULL AND checkpoint_namespace IS NOT NULL AND checkpoint_id IS NOT NULL)) AND (recovery_boundary='ROUTE_START' OR checkpoint_id IS NOT NULL))
) STRICT;

CREATE TABLE library_import_jobs (
  job_id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  candidate_demo_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  expected_byte_length INTEGER NOT NULL CHECK(expected_byte_length>=8),
  temp_relative_path TEXT NOT NULL UNIQUE,
  final_relative_path TEXT,
  content_hash TEXT,
  byte_size INTEGER,
  status TEXT NOT NULL CHECK(status IN ('WRITING','PUBLISHING','COMPLETED','FAILED')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE library_artifact_jobs (
  job_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  review_revision_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL CHECK(artifact_revision>=1),
  schema_version TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum)=64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL,
  temp_relative_path TEXT NOT NULL UNIQUE,
  final_relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('WRITING','PUBLISHING','COMPLETED','FAILED')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE library_delete_jobs (
  job_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('REVIEW','DEMO')),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PREPARED','FILES_DELETED','COMPLETED','FAILED')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX reviews_history_idx ON reviews(last_opened_at DESC,review_id DESC);
CREATE INDEX reviews_demo_idx ON reviews(demo_id,created_at DESC);
CREATE INDEX review_revisions_review_idx ON review_revisions(review_id,created_at DESC);
CREATE INDEX review_artifacts_revision_idx ON review_artifacts(review_revision_id,artifact_type,artifact_key);
CREATE INDEX library_import_jobs_status_idx ON library_import_jobs(status,updated_at);
CREATE INDEX library_delete_jobs_status_idx ON library_delete_jobs(status,updated_at);
