CREATE TABLE agent_checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  checkpoint_type TEXT NOT NULL,
  checkpoint_data BLOB NOT NULL,
  metadata_type TEXT NOT NULL,
  metadata_data BLOB NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
  created_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  UNIQUE(thread_id,checkpoint_ns,checkpoint_id)
) STRICT;
CREATE TABLE agent_checkpoint_writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  write_index INTEGER NOT NULL,
  channel TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_data BLOB NOT NULL,
  PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,write_index),
  FOREIGN KEY(thread_id,checkpoint_ns,checkpoint_id) REFERENCES agent_checkpoints(thread_id,checkpoint_ns,checkpoint_id) ON DELETE CASCADE
) STRICT;
