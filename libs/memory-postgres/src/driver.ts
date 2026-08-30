/**
 * Server-only PostgreSQL lifecycle adapters.
 *
 * This module is deliberately not re-exported from the browser-safe package
 * entrypoint. `pg` is loaded dynamically so a caller that only imports the
 * domain/repository contracts cannot pull a Node database driver into a web
 * bundle. The public driver interfaces are intentionally structural, which
 * also makes the lifecycle seam straightforward to smoke-test without a
 * live database.
 */

import type { ClientConfig, PoolConfig } from "pg";
import { createPgSqlExecutor, withSqlTransaction, type PgConnection, type PgQueryable, type SqlExecutor } from "./executor";
import {
  MemoryDatabaseConfigurationError,
  MemoryDatabaseConnectionError,
  MemoryDatabaseDriverError,
} from "./errors";

export interface MemoryDatabaseEnvironment {
  readonly [key: string]: string | undefined;
  readonly DATABASE_URL?: string;
  readonly MEMORY_DATABASE_URL?: string;
}

/** A minimal pg-compatible queryable used at the server boundary. */
export interface PgClientLike {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
  connect(): Promise<void>;
  end(): Promise<void>;
}

/** A checked-out node-postgres pool client. */
export interface PgPoolClientLike extends PgQueryable {
  release?: () => void;
  end?: () => Promise<void>;
}

/** A minimal node-postgres Pool surface needed by the adapter. */
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgPoolClientLike>;
  end(): Promise<void>;
}

/** Injectable shape used by tests; production code obtains this from `pg`. */
export interface PgModuleLike {
  readonly Pool: new (config?: unknown) => PgPoolLike;
  readonly Client: new (config?: unknown) => PgClientLike;
}

export interface NodePostgresPoolOptions {
  /** Explicit connection string. If omitted, MEMORY_DATABASE_URL wins over DATABASE_URL. */
  readonly connectionString?: string;
  readonly env?: MemoryDatabaseEnvironment;
  /** Additional PoolConfig values. Secrets are passed through and never logged. */
  readonly config?: PoolConfig;
  /** Internal test seam; production callers should leave this unset. */
  readonly pgModule?: PgModuleLike;
}

export interface HyperdriveClientOptions {
  /** Hyperdrive exposes this as `env.HYPERDRIVE.connectionString`. */
  readonly connectionString?: string;
  readonly hyperdrive?: { readonly connectionString?: string };
  readonly env?: MemoryDatabaseEnvironment;
  readonly config?: ClientConfig;
  /** Internal test seam; production callers should leave this unset. */
  readonly pgModule?: PgModuleLike;
}

export interface PostgresPoolHandle {
  readonly pool: PgPoolLike;
  readonly executor: SqlExecutor;
  /** Idempotently close the pool and wait for all checked-out clients. */
  readonly close: () => Promise<void>;
}

export interface HyperdriveClientHandle {
  readonly client: PgClientLike;
  readonly executor: SqlExecutor;
  /** Idempotently end the per-request client. */
  readonly close: () => Promise<void>;
}

let pgModulePromise: Promise<PgModuleLike> | undefined;

function normalizePgModule(module: unknown): PgModuleLike {
  const candidate = module as { Pool?: unknown; Client?: unknown; default?: { Pool?: unknown; Client?: unknown } };
  const source = candidate.Pool && candidate.Client ? candidate : candidate.default;
  if (!source || typeof source.Pool !== "function" || typeof source.Client !== "function") {
    throw new MemoryDatabaseDriverError();
  }
  return {
    Pool: source.Pool as PgModuleLike["Pool"],
    Client: source.Client as PgModuleLike["Client"],
  };
}

/** Load pg only from a server-side call path. */
export async function loadPgModule(): Promise<PgModuleLike> {
  if (!pgModulePromise) {
    pgModulePromise = import("pg")
      .then(normalizePgModule)
      .catch((error: unknown) => {
        pgModulePromise = undefined;
        if (error instanceof MemoryDatabaseDriverError) throw error;
        throw new MemoryDatabaseDriverError({ cause: error });
      });
  }
  return pgModulePromise;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

/** Resolve an explicit memory URL without ever echoing its value. */
export function resolveMemoryDatabaseUrl(env: MemoryDatabaseEnvironment = process.env): string {
  const connectionString = firstNonEmpty(env.MEMORY_DATABASE_URL, env.DATABASE_URL);
  if (!connectionString) {
    throw new MemoryDatabaseConfigurationError(
      "Set MEMORY_DATABASE_URL or DATABASE_URL before starting the PostgreSQL memory adapter",
    );
  }
  return connectionString;
}

function resolveHyperdriveConnectionString(options: HyperdriveClientOptions): string {
  const connectionString = firstNonEmpty(
    options.connectionString,
    options.hyperdrive?.connectionString,
    options.env?.MEMORY_DATABASE_URL,
    options.env?.DATABASE_URL,
  );
  if (!connectionString) {
    throw new MemoryDatabaseConfigurationError(
      "A Hyperdrive connectionString or MEMORY_DATABASE_URL/DATABASE_URL is required",
    );
  }
  return connectionString;
}

function toConnectionError(operation: string, error: unknown): MemoryDatabaseConnectionError {
  if (error instanceof MemoryDatabaseConnectionError) return error;
  return new MemoryDatabaseConnectionError(operation, `PostgreSQL ${operation} failed`, { cause: error });
}

function managedQueryable(queryable: PgQueryable): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      try {
        const result = await queryable.query(text, values);
        return result as { readonly rows: readonly Row[]; readonly rowCount?: number | null };
      } catch (error) {
        throw toConnectionError("query", error);
      }
    },
  };
}

function managedPool(pool: PgPoolLike): PgQueryable {
  const base = managedQueryable(pool);
  return {
    ...base,
    async connect(): Promise<PgConnection> {
      try {
        const connection = await pool.connect();
        const query = managedQueryable(connection);
        return {
          ...query,
          // node-postgres pool clients release synchronously. Preserve that
          // contract so createPgSqlExecutor can release in its finally block.
          release: () => {
            if (connection.release) {
              connection.release();
              return;
            }
            // A compatible pool may expose only an end method. Keep the
            // executor's synchronous release contract while still ensuring
            // that this fallback connection is not left open.
            void connection.end?.().catch(() => undefined);
          },
        };
      } catch (error) {
        throw toConnectionError("connect", error);
      }
    },
  };
}

function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let closed = false;
  let closing: Promise<void> | undefined;
  return () => {
    if (closed) return closing ?? Promise.resolve();
    closed = true;
    closing = action().catch((error: unknown) => {
      throw toConnectionError("close", error);
    });
    return closing;
  };
}

/**
 * Create a process-level node-postgres pool and a real SqlExecutor.
 *
 * Pool construction is lazy with respect to the first network connection,
 * matching node-postgres semantics. Query and transaction connection failures
 * are wrapped in a stable MemoryDatabaseConnectionError; callers must close
 * the returned handle during process shutdown.
 */
export async function createNodePostgresPool(options: NodePostgresPoolOptions = {}): Promise<PostgresPoolHandle> {
  const connectionString = firstNonEmpty(options.connectionString, options.config?.connectionString)
    ?? resolveMemoryDatabaseUrl(options.env);
  const pg = options.pgModule ?? (await loadPgModule());
  let pool: PgPoolLike;
  try {
    pool = new pg.Pool({ ...options.config, connectionString });
  } catch (error) {
    throw toConnectionError("construct", error);
  }
  const executor = createPgSqlExecutor(managedPool(pool));
  return {
    pool,
    executor,
    close: onceAsync(() => pool.end()),
  };
}

/**
 * Create and connect a per-request pg Client for Cloudflare Hyperdrive.
 * Unlike a Pool, this handle owns one client and always ends it when closed.
 */
export async function createHyperdriveClient(options: HyperdriveClientOptions): Promise<HyperdriveClientHandle> {
  const connectionString = resolveHyperdriveConnectionString(options);
  const pg = options.pgModule ?? (await loadPgModule());
  let client: PgClientLike;
  try {
    client = new pg.Client({ ...options.config, connectionString });
  } catch (error) {
    throw toConnectionError("construct", error);
  }
  try {
    await client.connect();
  } catch (error) {
    // A failed connect still owns a client object. Best-effort end prevents a
    // partially initialized socket from surviving the request.
    try {
      await client.end();
    } catch {
      // Preserve the connection failure as the actionable error.
    }
    throw toConnectionError("connect", error);
  }
  const baseExecutor = createPgSqlExecutor(managedQueryable(client as unknown as PgQueryable));
  // A Hyperdrive Client is already connected and must not be connected again
  // for a transaction. Add the explicit transaction surface using that same
  // client while retaining withSqlTransaction's rollback behavior.
  const executor: SqlExecutor = {
    ...baseExecutor,
    transaction: (work) => withSqlTransaction(baseExecutor, work),
  };
  return {
    client,
    executor,
    close: onceAsync(() => client.end()),
  };
}

/** Run one operation with a process-level pool that is closed in all paths. */
export async function withNodePostgresExecutor<T>(
  options: NodePostgresPoolOptions,
  work: (executor: SqlExecutor) => Promise<T>,
): Promise<T> {
  const handle = await createNodePostgresPool(options);
  let failed = false;
  try {
    return await work(handle.executor);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      // Never hide the operation error behind a shutdown failure.
      if (!failed) throw closeError;
    }
  }
}

/** Run one request operation with a Hyperdrive client that is always ended. */
export async function withHyperdriveExecutor<T>(
  options: HyperdriveClientOptions,
  work: (executor: SqlExecutor) => Promise<T>,
): Promise<T> {
  const handle = await createHyperdriveClient(options);
  let failed = false;
  try {
    return await work(handle.executor);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (!failed) throw closeError;
    }
  }
}

// Descriptive aliases for callers that prefer the shorter pg/Hyperdrive names.
export const createPgPool = createNodePostgresPool;
export const createHyperdriveExecutor = createHyperdriveClient;
