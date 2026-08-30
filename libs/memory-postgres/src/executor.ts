/**
 * Vendor-neutral SQL seam.  The memory domain and this adapter do not import
 * `pg`, which keeps the package safe to use from a browser bundle.  A pg
 * Pool/Client can be adapted at the server boundary with createPgSqlExecutor.
 */
export interface SqlResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount?: number;
}

export interface SqlExecutor {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  /** A real transaction implementation should pin all queries to one client. */
  transaction?<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Explicit transaction alias for callers that want to type a pinned client. */
export type SqlTransaction = SqlExecutor;

export interface PgQueryResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PgQueryable {
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  connect?(): Promise<PgConnection>;
}

export interface PgConnection extends PgQueryable {
  release?: () => void;
}

function makeQuery(queryable: PgQueryable): SqlExecutor {
  return {
    async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
      const result = await queryable.query(text, values);
      return {
        rows: result.rows as readonly Row[],
        ...(result.rowCount === null || result.rowCount === undefined ? {} : { rowCount: result.rowCount }),
      };
    },
  };
}

/**
 * Adapt a pg Client or Pool without importing pg.  Pool transactions use a
 * checked-out client, so BEGIN/COMMIT/ROLLBACK cannot accidentally span pool
 * connections.  A single Client is also supported for tests and small jobs.
 */
export function createPgSqlExecutor(queryable: PgQueryable): SqlExecutor {
  const base = makeQuery(queryable);
  if (!queryable.connect) return base;

  return {
    ...base,
    async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      const connection = await queryable.connect!();
      const transactionExecutor = makeQuery(connection);
      try {
        await transactionExecutor.query("BEGIN");
        const value = await work(transactionExecutor);
        await transactionExecutor.query("COMMIT");
        return value;
      } catch (error) {
        try {
          await transactionExecutor.query("ROLLBACK");
        } catch {
          // Preserve the original database error; rollback is best effort.
        }
        throw error;
      } finally {
        connection.release?.();
      }
    },
  };
}

/**
 * Transaction helper used by the repository.  An injected executor can
 * provide a real transaction; the fallback is useful for a single dedicated
 * client and for contract-test executors.
 */
export async function withSqlTransaction<T>(executor: SqlExecutor, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  if (executor.transaction) return executor.transaction(work);
  await executor.query("BEGIN");
  try {
    const value = await work(executor);
    await executor.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await executor.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

export const createPostgresExecutor = createPgSqlExecutor;
