import { describe, expect, it } from "vitest";
import {
  CORE_MIGRATION_ID,
  CORE_MIGRATION_SQL,
  getMemoryMigrationPlan,
  MEMORY_MIGRATIONS,
  USER_DELETE_MARKER_MIGRATION_ID,
  USER_DELETE_MARKER_MIGRATION_SQL,
  VECTOR_MIGRATION_ID,
  VECTOR_MIGRATION_SQL,
  runMemoryMigrations,
  type SqlExecutor,
} from "./index";

class MigrationExecutor implements SqlExecutor {
  readonly statements: string[] = [];
  readonly applied = new Set<string>();

  async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<{ rows: readonly Row[] }> {
    this.statements.push(text);
    if (text.startsWith("SELECT migration_id FROM memory_schema_migrations")) {
      const id = String(values[0] ?? "");
      return { rows: (this.applied.has(id) ? [{ migration_id: id }] : []) as unknown as readonly Row[] };
    }
    if (text.startsWith("INSERT INTO memory_schema_migrations")) this.applied.add(String(values[0] ?? ""));
    return { rows: [] };
  }
}

describe("memory PostgreSQL migrations", () => {
  it("contains a non-empty ordered core migration with no optional extension dependency", async () => {
    expect(CORE_MIGRATION_SQL.trim().length).toBeGreaterThan(100);
    expect(CORE_MIGRATION_SQL).not.toMatch(/\bvector\b/i);
    expect(CORE_MIGRATION_SQL).toContain("memory_enabled BOOLEAN NOT NULL DEFAULT FALSE");
    expect(CORE_MIGRATION_SQL).toContain("consent TEXT NOT NULL DEFAULT 'UNKNOWN'");
    expect(CORE_MIGRATION_SQL).toContain("consent_version INTEGER");
    expect(CORE_MIGRATION_SQL).toContain("consent_updated_at TIMESTAMPTZ");
    expect(CORE_MIGRATION_SQL).toContain("memory_deleted_at TIMESTAMPTZ");
    expect(CORE_MIGRATION_SQL).toContain("record_payload JSONB NOT NULL");
    expect(CORE_MIGRATION_SQL).not.toMatch(/\bprofile_(?:json|payload)\b/i);
    for (const table of [
      "app_users",
      "auth_identities",
      "user_preferences",
      "memory_records",
      "learning_threads",
      "memory_observations",
      "memory_evidence_refs",
      "memory_events",
      "memory_tombstones",
    ]) {
      expect(CORE_MIGRATION_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(CORE_MIGRATION_SQL).toMatch(/UNIQUE \(user_id, logical_key\)/);
    expect(CORE_MIGRATION_SQL).toMatch(/UNIQUE \(user_id, idempotency_key\)/);
    expect(CORE_MIGRATION_SQL).toMatch(/UNIQUE \(user_id, session_id, cue_id, taxonomy_code\)/);
    expect(CORE_MIGRATION_SQL).toMatch(/PRIMARY KEY \(user_id, memory_id, namespace, ref_id, demo_content_hash\)/);
    expect(VECTOR_MIGRATION_SQL).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(VECTOR_MIGRATION_SQL).not.toMatch(/hnsw/i);
    expect(USER_DELETE_MARKER_MIGRATION_SQL).toContain("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS memory_deleted_at TIMESTAMPTZ");
    expect(USER_DELETE_MARKER_MIGRATION_SQL).toContain("ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS last_error_code TEXT");
    expect(MEMORY_MIGRATIONS.map((migration) => migration.id)).toEqual([CORE_MIGRATION_ID, USER_DELETE_MARKER_MIGRATION_ID, VECTOR_MIGRATION_ID]);
    expect(getMemoryMigrationPlan()).toEqual([CORE_MIGRATION_ID, USER_DELETE_MARKER_MIGRATION_ID]);
    expect(getMemoryMigrationPlan({ includeVector: true })).toEqual([CORE_MIGRATION_ID, USER_DELETE_MARKER_MIGRATION_ID, VECTOR_MIGRATION_ID]);

    const executor = new MigrationExecutor();
    await expect(runMemoryMigrations(executor)).resolves.toEqual([CORE_MIGRATION_ID, USER_DELETE_MARKER_MIGRATION_ID]);
    await expect(runMemoryMigrations(executor, { includeVector: true })).resolves.toEqual([VECTOR_MIGRATION_ID]);
    expect(executor.statements.filter((statement) => statement === CORE_MIGRATION_SQL)).toHaveLength(1);
    expect(executor.statements.filter((statement) => statement === USER_DELETE_MARKER_MIGRATION_SQL)).toHaveLength(1);
    expect(executor.statements.filter((statement) => statement === VECTOR_MIGRATION_SQL)).toHaveLength(1);
    expect(executor.applied).toEqual(new Set([CORE_MIGRATION_ID, VECTOR_MIGRATION_ID, USER_DELETE_MARKER_MIGRATION_ID]));
    expect(executor.statements).toContain("BEGIN");
    expect(executor.statements).toContain("COMMIT");
  });

  it("applies the deletion marker when an existing ledger skips core-001", async () => {
    const executor = new MigrationExecutor();
    executor.applied.add(CORE_MIGRATION_ID);
    await expect(runMemoryMigrations(executor)).resolves.toEqual([USER_DELETE_MARKER_MIGRATION_ID]);
    expect(executor.statements).not.toContain(CORE_MIGRATION_SQL);
    expect(executor.statements).toContain(USER_DELETE_MARKER_MIGRATION_SQL);
    expect(executor.applied).toEqual(new Set([CORE_MIGRATION_ID, USER_DELETE_MARKER_MIGRATION_ID]));
  });

  it("keeps mandatory core and deletion-marker upgrades committed when opt-in pgvector is unavailable", async () => {
    const executor = new MigrationExecutor();
    const originalQuery = executor.query.bind(executor);
    executor.query = async <Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      if (text === VECTOR_MIGRATION_SQL) {
        executor.statements.push(text);
        throw Object.assign(new Error("extension vector is not available"), { code: "0A000" });
      }
      return originalQuery<Row>(text, values);
    };

    await expect(runMemoryMigrations(executor, { includeVector: true })).rejects.toMatchObject({ code: "0A000" });
    expect(executor.applied).toEqual(new Set([CORE_MIGRATION_ID, USER_DELETE_MARKER_MIGRATION_ID]));
    expect(executor.statements.slice(-2)).toEqual([VECTOR_MIGRATION_SQL, "ROLLBACK"]);
  });
});
