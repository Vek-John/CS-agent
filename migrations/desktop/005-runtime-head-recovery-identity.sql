ALTER TABLE review_runtime_heads ADD COLUMN recovery_artifact_id TEXT REFERENCES review_artifacts(artifact_id) ON DELETE CASCADE;
ALTER TABLE review_runtime_heads ADD COLUMN recovery_artifact_key TEXT;
ALTER TABLE review_runtime_heads ADD COLUMN recovery_artifact_revision INTEGER CHECK(recovery_artifact_revision IS NULL OR recovery_artifact_revision>=1);

UPDATE review_runtime_heads
SET recovery_artifact_id=(SELECT artifact_id FROM review_artifacts WHERE review_revision_id=review_runtime_heads.review_revision_id AND artifact_type='SESSION_RECOVERY' LIMIT 1),
    recovery_artifact_key=(SELECT artifact_key FROM review_artifacts WHERE review_revision_id=review_runtime_heads.review_revision_id AND artifact_type='SESSION_RECOVERY' LIMIT 1),
    recovery_artifact_revision=(SELECT artifact_revision FROM review_artifacts WHERE review_revision_id=review_runtime_heads.review_revision_id AND artifact_type='SESSION_RECOVERY' LIMIT 1)
WHERE (SELECT COUNT(*) FROM review_artifacts WHERE review_revision_id=review_runtime_heads.review_revision_id AND artifact_type='SESSION_RECOVERY')=1;

CREATE UNIQUE INDEX review_runtime_heads_recovery_artifact_idx
  ON review_runtime_heads(recovery_artifact_id)
  WHERE recovery_artifact_id IS NOT NULL;
