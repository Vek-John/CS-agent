ALTER TABLE review_revisions
ADD COLUMN artifact_contract_version INTEGER NOT NULL DEFAULT 1
CHECK(artifact_contract_version IN (1,2));
