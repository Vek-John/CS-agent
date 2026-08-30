import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { MemoryService } from "@cs-coach/memory";
import {
  CORE_MIGRATION_ID,
  CORE_MIGRATION_SQL,
  PostgresMemoryAuthorizationStore,
  PostgresMemoryRepository,
  USER_DELETE_MARKER_MIGRATION_ID,
  runMemoryMigrations,
  type SqlExecutor,
  withSqlTransaction,
} from "./server";

const liveEnabled = process.env.RUN_POSTGRES_TESTS === "1";
const configuredUrl = process.env.MEMORY_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();

function quotedTestSchema(): string {
  const schema = `memory_smoke_${randomUUID().replaceAll("-", "")}`;
  if (!/^memory_smoke_[a-f0-9]+$/.test(schema)) throw new Error("invalid generated smoke schema");
  return `"${schema}"`;
}

function clientExecutor(client: Client): SqlExecutor {
  const base: SqlExecutor = {
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      const result = await client.query(text, [...values]);
      return {
        rows: result.rows as readonly Row[],
        ...(result.rowCount === null ? {} : { rowCount: result.rowCount }),
      };
    },
  };
  return {
    ...base,
    transaction: (work) => withSqlTransaction(base, work),
  };
}

async function withIsolatedSchema(
  client: Client,
  work: (executor: SqlExecutor) => Promise<void>,
): Promise<void> {
  const schema = quotedTestSchema();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  let failed = false;
  try {
    await work(clientExecutor(client));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
    }
  }
}

async function withLiveClient(work: (client: Client) => Promise<void>): Promise<void> {
  expect(configuredUrl, "MEMORY_DATABASE_URL or DATABASE_URL is required when RUN_POSTGRES_TESTS=1").toBeTruthy();
  if (!configuredUrl) return;
  const client = new Client({
    connectionString: configuredUrl,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    query_timeout: 20_000,
    application_name: "cs-coach-memory-smoke",
  });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}

describe.skipIf(!liveEnabled)("real PostgreSQL memory migration smoke (opt-in)", () => {
  it("migrates an empty core-only schema and round-trips/deletes PROFILE via record_payload", async () => {
    await withLiveClient(async (client) => withIsolatedSchema(client, async (executor) => {
      await expect(runMemoryMigrations(executor)).resolves.toEqual([
        CORE_MIGRATION_ID,
        USER_DELETE_MARKER_MIGRATION_ID,
      ]);

      const columns = await executor.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'memory_records'`,
      );
      const columnNames = columns.rows.map((row) => row.column_name);
      expect(columnNames).toContain("record_payload");
      expect(columnNames).not.toContain("profile_json");
      await expect(executor.query("SELECT to_regclass('memory_embeddings_v1') AS table_name"))
        .resolves.toMatchObject({ rows: [{ table_name: null }] });

      const repository = new PostgresMemoryRepository({ executor, vectorAvailable: false });
      const authorizationStore = new PostgresMemoryAuthorizationStore(executor);
      const service = new MemoryService({ repository, authorizationStore, memoryEnabled: true });
      const userId = `profile-smoke-${randomUUID()}`;
      await service.setAuthorization(userId, {
        userId,
        memoryEnabled: true,
        consent: "GRANTED",
        consentVersion: 1,
        updatedAt: "2026-08-30T00:00:00.000Z",
      });
      const saved = await service.setProfile(userId, {
        role: "support",
        preferredMap: "Mirage",
        learningGoal: "提高补枪时机",
      });
      expect(saved.record?.profile).toEqual({
        role: "support",
        preferredMap: "Mirage",
        learningGoal: "提高补枪时机",
      });
      await expect(service.getProfile(userId)).resolves.toEqual(saved.record?.profile);
      if (!saved.record) throw new Error("PROFILE smoke record was not persisted");
      await expect(service.delete(userId, saved.record.memoryId, { reason: "smoke cleanup" }))
        .resolves.toMatchObject({ status: "DELETED" });
      await expect(service.getProfile(userId)).resolves.toBeUndefined();
    }));
  }, 60_000);

  it("upgrades a ledgered legacy core-001 schema without re-running core", async () => {
    await withLiveClient(async (client) => withIsolatedSchema(client, async (executor) => {
      await executor.query(CORE_MIGRATION_SQL);
      await executor.query("ALTER TABLE app_users DROP COLUMN memory_deleted_at");
      await executor.query("ALTER TABLE memory_events DROP COLUMN last_error_code");
      await executor.query(`CREATE TABLE memory_schema_migrations (
        migration_id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await executor.query("INSERT INTO memory_schema_migrations (migration_id) VALUES ($1)", [CORE_MIGRATION_ID]);

      await expect(runMemoryMigrations(executor)).resolves.toEqual([USER_DELETE_MARKER_MIGRATION_ID]);
      const upgraded = await executor.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND ((table_name = 'app_users' AND column_name = 'memory_deleted_at')
              OR (table_name = 'memory_events' AND column_name = 'last_error_code'))
          ORDER BY table_name, column_name`,
      );
      expect(upgraded.rows).toEqual([
        { table_name: "app_users", column_name: "memory_deleted_at" },
        { table_name: "memory_events", column_name: "last_error_code" },
      ]);
      await expect(runMemoryMigrations(executor)).resolves.toEqual([]);
    }));
  }, 60_000);
});
