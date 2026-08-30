import type { SqlExecutor } from "./executor";
import { withSqlTransaction } from "./executor";

/** Stable IDs make migration ordering explicit without a migration table. */
export const CORE_MIGRATION_ID = "memory-core-001" as const;
export const VECTOR_MIGRATION_ID = "memory-vector-002" as const;
/** Adds the user-wide deletion marker to databases that already recorded core-001. */
export const USER_DELETE_MARKER_MIGRATION_ID = "memory-core-003" as const;

const MIGRATION_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS memory_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

/**
 * Keep this text in the package as well as migrations/memory/001_core.sql so
 * server deployments do not need to resolve a repository-relative path.
 */
export const CORE_MIGRATION_SQL = String.raw`
CREATE TABLE IF NOT EXISTS app_users (
  user_id TEXT PRIMARY KEY,
  memory_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  consent TEXT NOT NULL DEFAULT 'UNKNOWN',
  consent_version INTEGER,
  consent_updated_at TIMESTAMPTZ,
  memory_deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (consent IN ('GRANTED', 'REVOKED', 'UNKNOWN')),
  CHECK (consent_version IS NULL OR consent_version >= 0)
);
CREATE TABLE IF NOT EXISTS auth_identities (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider, subject),
  UNIQUE (provider, subject)
);
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  preference_key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  source TEXT NOT NULL,
  refs_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  label TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preference_key),
  CONSTRAINT user_preferences_value_object CHECK (jsonb_typeof(value_json) IN ('string', 'number', 'boolean'))
);
CREATE TABLE IF NOT EXISTS memory_records (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  scope TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  status TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL,
  content TEXT,
  summary TEXT,
  thread_id TEXT,
  claims_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  verdict_json JSONB,
  transfer_rule_json JSONB,
  preference_json JSONB,
  facts_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  inferences_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  advice_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  evidence_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  source_refs_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  demo_content_hashes_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  corrections_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  previous_revision_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  tombstone_json JSONB,
  limitations_json JSONB NOT NULL DEFAULT '[]'::JSONB,
  producer_version TEXT NOT NULL,
  last_idempotency_key TEXT NOT NULL,
  record_payload JSONB NOT NULL,
  PRIMARY KEY (user_id, memory_id),
  UNIQUE (user_id, logical_key),
  CHECK (revision > 0),
  CHECK (jsonb_typeof(record_payload) = 'object'),
  CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL AND tombstone_json IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS memory_record_revisions (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, memory_id, revision),
  FOREIGN KEY (user_id, memory_id) REFERENCES memory_records(user_id, memory_id) ON DELETE CASCADE,
  CHECK (revision > 0),
  CHECK (jsonb_typeof(record_payload) = 'object')
);
CREATE TABLE IF NOT EXISTS learning_threads (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  status TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL,
  thread_payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, memory_id, thread_id),
  UNIQUE (user_id, thread_id),
  FOREIGN KEY (user_id, memory_id) REFERENCES memory_records(user_id, memory_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(thread_payload) = 'object')
);
CREATE TABLE IF NOT EXISTS memory_observations (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cue_id TEXT NOT NULL,
  taxonomy_code TEXT NOT NULL,
  demo_content_hash TEXT NOT NULL,
  memory_id TEXT,
  source_ref_json JSONB,
  observation_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, observation_id),
  UNIQUE (user_id, session_id, cue_id, taxonomy_code),
  FOREIGN KEY (user_id, memory_id) REFERENCES memory_records(user_id, memory_id) ON DELETE SET NULL,
  CHECK (jsonb_typeof(observation_payload) = 'object')
);
CREATE TABLE IF NOT EXISTS memory_evidence_refs (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  demo_content_hash TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cue_id TEXT NOT NULL,
  source_ref_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, memory_id, namespace, ref_id, demo_content_hash),
  FOREIGN KEY (user_id, memory_id) REFERENCES memory_records(user_id, memory_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(source_ref_json) = 'object')
);
CREATE TABLE IF NOT EXISTS memory_events (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  demo_content_hash TEXT,
  proposal_id TEXT,
  target_memory_id TEXT,
  event_type TEXT NOT NULL,
  operation TEXT,
  idempotency_key TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  event_payload JSONB NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error_code TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED',
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, event_id),
  UNIQUE (user_id, idempotency_key),
  CHECK (jsonb_typeof(event_payload) IN ('object', 'array'))
);
CREATE TABLE IF NOT EXISTS memory_tombstones (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  deleted_revision INTEGER NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL,
  deleted_by TEXT NOT NULL,
  reason TEXT,
  last_idempotency_key TEXT NOT NULL,
  PRIMARY KEY (user_id, memory_id),
  UNIQUE (user_id, logical_key),
  CHECK (deleted_revision > 0)
);
CREATE TABLE IF NOT EXISTS memory_write_receipts (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  memory_id TEXT,
  revision INTEGER,
  result_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, idempotency_key),
  CHECK (revision IS NULL OR revision > 0)
);
CREATE INDEX IF NOT EXISTS memory_records_user_updated_idx ON memory_records (user_id, updated_at DESC, memory_id);
CREATE INDEX IF NOT EXISTS memory_records_user_status_idx ON memory_records (user_id, status, active);
CREATE INDEX IF NOT EXISTS memory_records_user_kind_idx ON memory_records (user_id, kind);
CREATE INDEX IF NOT EXISTS memory_record_revisions_user_memory_idx ON memory_record_revisions (user_id, memory_id, revision DESC);
CREATE INDEX IF NOT EXISTS learning_threads_user_active_idx ON learning_threads (user_id, active, updated_at DESC);
CREATE INDEX IF NOT EXISTS memory_observations_user_session_idx ON memory_observations (user_id, session_id, cue_id);
CREATE INDEX IF NOT EXISTS memory_evidence_refs_user_memory_idx ON memory_evidence_refs (user_id, memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_user_status_idx ON memory_events (user_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS memory_tombstones_user_deleted_idx ON memory_tombstones (user_id, deleted_at DESC);
ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS memory_deleted_at TIMESTAMPTZ;
`;

export const VECTOR_MIGRATION_SQL = String.raw`
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS memory_embeddings_v1 (
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  embedding vector NOT NULL,
  embedding_dimension INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, memory_id),
  FOREIGN KEY (user_id, memory_id) REFERENCES memory_records(user_id, memory_id) ON DELETE CASCADE,
  CHECK (embedding_dimension > 0 AND embedding_dimension <= 4096),
  CHECK (source_revision > 0)
);
CREATE INDEX IF NOT EXISTS memory_embeddings_v1_user_active_idx ON memory_embeddings_v1 (user_id, deleted_at, updated_at DESC);
`;

/**
 * This remains a separate migration even though the current core SQL contains
 * the column.  Existing installations may already have ledgered core-001
 * before the marker was added, so re-running core SQL is not sufficient.
 */
export const USER_DELETE_MARKER_MIGRATION_SQL = String.raw`
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS memory_deleted_at TIMESTAMPTZ;
ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS last_error_code TEXT;
`;

export interface MemoryMigration {
  readonly id: typeof CORE_MIGRATION_ID | typeof VECTOR_MIGRATION_ID | typeof USER_DELETE_MARKER_MIGRATION_ID;
  readonly sql: string;
  readonly optional?: boolean;
  readonly requires?: readonly string[];
}

export const MEMORY_MIGRATIONS: readonly MemoryMigration[] = [
  { id: CORE_MIGRATION_ID, sql: CORE_MIGRATION_SQL },
  { id: USER_DELETE_MARKER_MIGRATION_ID, sql: USER_DELETE_MARKER_MIGRATION_SQL, requires: [CORE_MIGRATION_ID] },
  // Keep the mandatory deletion-marker backfill ahead of the optional vector
  // extension. If pgvector installation fails, an upgraded database must
  // still have the privacy deletion boundary installed.
  { id: VECTOR_MIGRATION_ID, sql: VECTOR_MIGRATION_SQL, optional: true, requires: [CORE_MIGRATION_ID] },
];

export interface RunMemoryMigrationsOptions {
  /** Defaults to core only; vector extension is always opt-in. */
  readonly includeVector?: boolean;
}

/** Ordered migration IDs selected for this invocation, without touching PostgreSQL. */
export function getMemoryMigrationPlan(
  options: RunMemoryMigrationsOptions = {},
): readonly MemoryMigration["id"][] {
  return MEMORY_MIGRATIONS
    .filter((migration) => !migration.optional || options.includeVector === true)
    .map((migration) => migration.id);
}

export async function runMemoryMigrations(
  executor: SqlExecutor,
  options: RunMemoryMigrationsOptions = {},
): Promise<readonly string[]> {
  const selectedIds = new Set(getMemoryMigrationPlan(options));
  const selected = MEMORY_MIGRATIONS.filter((migration) => selectedIds.has(migration.id));
  const applied: string[] = [];
  await executor.query(MIGRATION_LEDGER_SQL);
  for (const migration of selected) {
    if (!migration.sql.trim()) throw new Error(`EMPTY_MIGRATION:${migration.id}`);
    const didApply = await withSqlTransaction(executor, async (tx) => {
      // Serialize concurrent runners and make each migration + ledger write an
      // atomic unit. The migration SQL remains idempotent for operators who
      // execute the checked-in file directly.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('cs-coach-memory-migrations', 0))");
      const existing = await tx.query<{ migration_id: string }>(
        "SELECT migration_id FROM memory_schema_migrations WHERE migration_id = $1 LIMIT 1",
        [migration.id],
      );
      if (existing.rows.length > 0) return false;
      await tx.query(migration.sql);
      await tx.query(
        "INSERT INTO memory_schema_migrations (migration_id) VALUES ($1) ON CONFLICT (migration_id) DO NOTHING",
        [migration.id],
      );
      return true;
    });
    if (didApply) applied.push(migration.id);
  }
  return applied;
}

export const migrateMemoryDatabase = runMemoryMigrations;
export const applyMemoryMigrations = runMemoryMigrations;
export const CORE_SCHEMA_SQL = CORE_MIGRATION_SQL;
export const VECTOR_SCHEMA_SQL = VECTOR_MIGRATION_SQL;
