-- Incremental upgrade for databases whose ledger already contains
-- memory-core-001 from before the user-wide deletion marker was introduced.
-- Safe for both empty/upgraded environments when executed after 001.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS memory_deleted_at TIMESTAMPTZ;
ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS last_error_code TEXT;
