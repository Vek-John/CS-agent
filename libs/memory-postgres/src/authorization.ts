import {
  MemoryAuthorizationSchema,
  type MemoryAuthorization,
  type MemoryAuthorizationStore,
} from "@cs-coach/memory";
import type { SqlExecutor } from "./executor";
import { withSqlTransaction } from "./executor";
import { MemoryUserMismatchError, MemoryRowValidationError } from "./errors";

export class MemoryAuthorizationConflictError extends Error {
  readonly code = "MEMORY_AUTHORIZATION_CONFLICT" as const;

  constructor() {
    super("MEMORY_AUTHORIZATION_CONFLICT");
    this.name = "MemoryAuthorizationConflictError";
  }
}

/** PostgreSQL-backed anonymous-principal consent store. */
export class PostgresMemoryAuthorizationStore implements MemoryAuthorizationStore {
  private readonly executor: SqlExecutor;

  constructor(executor: SqlExecutor) {
    this.executor = executor;
  }

  async getAuthorization(userId: string): Promise<MemoryAuthorization | undefined> {
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT user_id, memory_enabled, consent, consent_version, consent_updated_at
         FROM app_users
        WHERE user_id = $1
        LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (String(row.user_id ?? row.userId ?? "") !== userId) {
      throw new MemoryUserMismatchError();
    }
    const updated = row.consent_updated_at ?? row.consentUpdatedAt;
    const parsed = MemoryAuthorizationSchema.safeParse({
      userId,
      memoryEnabled: row.memory_enabled === true || row.memory_enabled === "true",
      consent: row.consent,
      ...(row.consent_version === undefined || row.consent_version === null ? {} : { consentVersion: Number(row.consent_version) }),
      ...(updated === undefined || updated === null ? {} : { updatedAt: updated instanceof Date ? updated.toISOString() : String(updated) }),
    });
    if (!parsed.success) throw new MemoryRowValidationError(userId, "PostgreSQL returned invalid memory authorization");
    return parsed.data as unknown as MemoryAuthorization;
  }

  async setAuthorization(userId: string, input: MemoryAuthorization): Promise<void> {
    const parsed = MemoryAuthorizationSchema.parse(input) as unknown as MemoryAuthorization;
    if (parsed.userId !== userId) throw new MemoryUserMismatchError();
    const enabled = parsed.memoryEnabled ?? parsed.featureFlag ?? false;
    const version = parsed.consentVersion ?? 0;
    const updatedAt = parsed.updatedAt ?? new Date().toISOString();
    await withSqlTransaction(this.executor, async (tx) => {
      const result = await tx.query<{ user_id: string }>(
        `INSERT INTO app_users (user_id, memory_enabled, consent, consent_version, consent_updated_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT (user_id) DO UPDATE SET
           memory_enabled=EXCLUDED.memory_enabled, consent=EXCLUDED.consent,
           consent_version=EXCLUDED.consent_version, consent_updated_at=EXCLUDED.consent_updated_at,
           updated_at=EXCLUDED.updated_at
         WHERE app_users.consent_version IS NULL
            OR EXCLUDED.consent_version > app_users.consent_version
            OR (EXCLUDED.consent_version = app_users.consent_version
                AND app_users.consent = EXCLUDED.consent
                AND app_users.memory_enabled = EXCLUDED.memory_enabled)
         RETURNING user_id`,
        [userId, enabled, parsed.consent, version, updatedAt],
      );
      if (result.rows[0]) return;
      // The conflict clause deliberately returns no row for a stale state.
      // Read the locked current value only to distinguish an idempotent retry
      // from a genuinely out-of-order consent update; never overwrite it.
      const current = await tx.query<{ user_id: string; consent?: string; memory_enabled?: boolean | string; consent_version?: number | string | null }>(
        "SELECT user_id, consent, memory_enabled, consent_version FROM app_users WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      const row = current.rows[0];
      if (row && String(row.consent ?? "") === parsed.consent &&
        (row.memory_enabled === true || row.memory_enabled === "true") === Boolean(enabled) &&
        Number(row.consent_version ?? 0) === version) return;
      throw new MemoryAuthorizationConflictError();
    });
  }
}

export const PostgresAuthorizationStore = PostgresMemoryAuthorizationStore;
