CREATE TABLE app_users (
  user_id TEXT PRIMARY KEY,
  memory_enabled INTEGER NOT NULL DEFAULT 0 CHECK(memory_enabled IN (0,1)),
  consent TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(consent IN ('GRANTED','REVOKED','UNKNOWN')),
  consent_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  memory_deleted_at TEXT
) STRICT;
CREATE TABLE memory_records (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(user_id,memory_id),
  UNIQUE(user_id,logical_key)
) STRICT;
CREATE TABLE memory_revisions (
  user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(user_id,memory_id,revision),
  FOREIGN KEY(user_id,memory_id) REFERENCES memory_records(user_id,memory_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE user_preferences (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  preference_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  label TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,preference_key)
) STRICT;
CREATE TABLE learning_threads (
  user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  status TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  revision INTEGER NOT NULL,
  thread_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,memory_id,thread_id),
  UNIQUE(user_id,thread_id),
  FOREIGN KEY(user_id,memory_id) REFERENCES memory_records(user_id,memory_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE memory_events (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  target_memory_id TEXT,
  logical_key TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK(status IN ('POSTED','CONSUMED','RETRY','DEAD_LETTER')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  event_json TEXT NOT NULL,
  PRIMARY KEY(user_id,event_id),
  UNIQUE(user_id,idempotency_key)
) STRICT;
CREATE TABLE memory_write_receipts (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  memory_id TEXT,
  revision INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,idempotency_key)
) STRICT;
CREATE TABLE memory_cue_effects (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  cue_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  memory_id TEXT,
  producer_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,session_id,cue_id,logical_key,effect_type)
) STRICT;
CREATE TABLE memory_tombstones (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY(user_id,memory_id),
  UNIQUE(user_id,logical_key)
) STRICT;
CREATE TABLE memory_embeddings (
  user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  norm REAL NOT NULL,
  model TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  vector_blob BLOB NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(user_id,memory_id),
  FOREIGN KEY(user_id,memory_id) REFERENCES memory_records(user_id,memory_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE memory_observations (user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE, observation_id TEXT NOT NULL, memory_id TEXT, session_id TEXT NOT NULL, cue_id TEXT NOT NULL, taxonomy_code TEXT NOT NULL, demo_content_hash TEXT NOT NULL, source_ref_json TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,observation_id), UNIQUE(user_id,session_id,cue_id,taxonomy_code), FOREIGN KEY(user_id,memory_id) REFERENCES memory_records(user_id,memory_id) ON DELETE SET NULL) STRICT;
CREATE TABLE memory_evidence (user_id TEXT NOT NULL, memory_id TEXT NOT NULL, ref_key TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY(user_id,memory_id,ref_key), FOREIGN KEY(user_id,memory_id) REFERENCES memory_records(user_id,memory_id) ON DELETE CASCADE) STRICT;
CREATE INDEX memory_records_recall_idx ON memory_records(user_id,active,status,updated_at DESC);
CREATE INDEX memory_events_session_idx ON memory_events(user_id,session_id);
CREATE INDEX learning_threads_active_idx ON learning_threads(user_id,active,updated_at DESC);
