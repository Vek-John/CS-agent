CREATE TABLE memory_opportunity_claims (
  user_id TEXT NOT NULL,
  demo_content_hash TEXT NOT NULL CHECK(length(demo_content_hash)=64 AND demo_content_hash NOT GLOB '*[^0-9a-f]*'),
  selected_player_id TEXT NOT NULL,
  stable_cue_source_id TEXT NOT NULL,
  taxonomy_code TEXT NOT NULL,
  first_analysis_evidence_revision TEXT NOT NULL,
  latest_analysis_evidence_revision TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code)
) STRICT;

CREATE TABLE memory_opportunity_evidence (
  user_id TEXT NOT NULL,
  demo_content_hash TEXT NOT NULL,
  selected_player_id TEXT NOT NULL,
  stable_cue_source_id TEXT NOT NULL,
  taxonomy_code TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  analysis_evidence_revision TEXT NOT NULL,
  source_review_id TEXT,
  source_review_revision_id TEXT,
  source_artifact_id TEXT,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  availability TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(availability IN ('AVAILABLE','DELETED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,evidence_key),
  FOREIGN KEY(user_id,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code)
    REFERENCES memory_opportunity_claims(user_id,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE memory_evidence_tombstones (
  user_id TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  demo_content_hash TEXT NOT NULL CHECK(length(demo_content_hash)=64 AND demo_content_hash NOT GLOB '*[^0-9a-f]*'),
  selected_player_id TEXT NOT NULL,
  stable_cue_source_id TEXT NOT NULL,
  taxonomy_code TEXT NOT NULL,
  source_review_id TEXT,
  source_review_revision_id TEXT,
  source_artifact_id TEXT,
  deleted_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(user_id,evidence_key)
) STRICT;

CREATE INDEX memory_opportunity_demo_idx ON memory_opportunity_claims(user_id,demo_content_hash,selected_player_id);
CREATE INDEX memory_opportunity_evidence_review_idx ON memory_opportunity_evidence(source_review_id,availability);
CREATE INDEX memory_evidence_tombstones_review_idx ON memory_evidence_tombstones(source_review_id,deleted_at);
