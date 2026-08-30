import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MEMORY_MIGRATION_USAGE = `Usage: pnpm memory:migrate [--with-vector|--without-vector] [--dry-run] [--check-config]

Environment:
  MEMORY_DATABASE_URL  PostgreSQL connection string (preferred)
  DATABASE_URL         PostgreSQL connection string fallback
  MEMORY_WITH_VECTOR   1, true, or on to apply the optional pgvector migration

Options:
  --dry-run             Print the ordered migration selection without connecting
  --check-config        Validate localhost database configuration without connecting
`;

function isTruthy(value) {
  return ["1", "true", "on", "yes"].includes(value?.trim().toLowerCase());
}

function resolveConnectionConfig(env) {
  const preferred = env?.MEMORY_DATABASE_URL?.trim();
  if (preferred) return { connectionString: preferred, source: "MEMORY_DATABASE_URL" };
  const fallback = env?.DATABASE_URL?.trim();
  if (fallback) return { connectionString: fallback, source: "DATABASE_URL" };
  return undefined;
}

function validateConnectionConfig(config) {
  if (!config) return "Set MEMORY_DATABASE_URL or DATABASE_URL before running memory migrations";
  try {
    const parsed = new URL(config.connectionString);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      return `${config.source} must use a postgresql:// or postgres:// URL`;
    }
  } catch {
    return `${config.source} must be a valid PostgreSQL URL`;
  }
  return undefined;
}

/** Parse CLI arguments without loading the server-only TypeScript package. */
export function parseMemoryMigrationArgs(argv = [], env = {}) {
  let includeVector = isTruthy(env.MEMORY_WITH_VECTOR)
    || isTruthy(env.MEMORY_ENABLE_VECTOR)
    || isTruthy(env.MEMORY_ENABLE_PGVECTOR)
    || isTruthy(env.MEMORY_PGVECTOR);
  let help = false;
  let dryRun = false;
  let checkConfig = false;

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    } else if (arg === "--with-vector") {
      includeVector = true;
    } else if (arg === "--without-vector") {
      includeVector = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--check-config") {
      checkConfig = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown migration argument: ${arg}`);
    }
  }

  return { includeVector, help, dryRun, checkConfig };
}

function redactSecrets(message) {
  return message
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'`]+/gi, "[redacted-postgres-url]")
    .replace(/((?:password|pwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
}

function formatFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "MEMORY_MIGRATION_FAILED";
  const message = error instanceof Error && error.message ? redactSecrets(error.message) : "Migration failed";
  return `${code}: ${message}`;
}

/**
 * Execute the existing memory migration runner through the server-only
 * node-postgres factory. Dependencies are injectable for CLI contract tests.
 */
export async function runMemoryMigrationCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = (line) => console.log(line),
  stderr = (line) => console.error(line),
  createPool,
  runMigrations,
  getMigrationPlan,
} = {}) {
  let args;
  try {
    args = parseMemoryMigrationArgs(argv, env);
  } catch (error) {
    stderr(formatFailure(error));
    stderr(MEMORY_MIGRATION_USAGE);
    return 1;
  }

  if (args.help) {
    stdout(MEMORY_MIGRATION_USAGE);
    return 0;
  }

  const config = resolveConnectionConfig(env);
  if (args.checkConfig) {
    const configError = validateConnectionConfig(config);
    if (configError) {
      stderr(`MEMORY_DATABASE_CONFIGURATION: ${configError}`);
      return 1;
    }
    stdout(`Memory database configuration: ${config.source} (valid PostgreSQL URL)`);
    if (!args.dryRun) return 0;
  }

  if (args.dryRun) {
    try {
      const server = getMigrationPlan
        ? undefined
        : await import("@cs-coach/memory-postgres/server").catch(() => import("../libs/memory-postgres/src/server.ts"));
      const plan = (getMigrationPlan ?? server.getMemoryMigrationPlan)({ includeVector: args.includeVector });
      if (!args.checkConfig) {
        stdout(`Memory database configuration: ${config ? config.source : "absent"} (dry-run did not connect)`);
      }
      stdout(`Memory migration plan: ${plan.join(" -> ")}`);
      stdout("Dry run complete; no database connection opened");
      return 0;
    } catch (error) {
      stderr(formatFailure(error));
      return 1;
    }
  }

  // Check this before importing a .ts package so `node tools/migrate-memory.mjs`
  // reports a useful configuration error even when the tsx launcher is absent.
  const configError = validateConnectionConfig(config);
  if (configError) {
    stderr(`MEMORY_DATABASE_CONFIGURATION: ${configError}`);
    stderr(MEMORY_MIGRATION_USAGE);
    return 1;
  }

  let handle;
  let exitCode = 1;
  try {
    const server = createPool && runMigrations
      ? undefined
      : await import("@cs-coach/memory-postgres/server").catch(() => import("../libs/memory-postgres/src/server.ts"));
    const create = createPool ?? server.createNodePostgresPool;
    const run = runMigrations ?? server.runMemoryMigrations;
    handle = await create({ connectionString: config.connectionString, env });
    const applied = await run(handle.executor, { includeVector: args.includeVector });
    stdout(applied.length > 0
      ? `Memory migrations applied: ${applied.join(", ")}`
      : "Memory migrations already up to date");
    exitCode = 0;
  } catch (error) {
    stderr(formatFailure(error));
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        stderr(formatFailure(error));
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const exitCode = await runMemoryMigrationCli();
  process.exitCode = exitCode;
}
