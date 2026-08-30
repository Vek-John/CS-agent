-- Optional derived semantic index.  This file is never required by the core
-- migration and deliberately has no approximate/HNSW index in v1.

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

CREATE INDEX IF NOT EXISTS memory_embeddings_v1_user_active_idx
  ON memory_embeddings_v1 (user_id, deleted_at, updated_at DESC);
