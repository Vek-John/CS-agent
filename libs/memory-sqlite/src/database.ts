import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  getDesktopMigrationPlan,
  runDesktopMigrations,
  type DesktopMigrationPlan,
} from "./migrations";
import { createPreMigrationBackup } from "./backup";

export interface SqliteDatabaseOptions {
  path?: string;
  beforeMigrations?: (
    db: DatabaseSync,
    path: string,
    plan: DesktopMigrationPlan,
  ) => void;
}

export class SqliteDatabaseOwner {
  readonly path: string;
  readonly db: DatabaseSync;
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  constructor(options: SqliteDatabaseOptions = {}) {
    const configured = options.path ?? process.env.CS_AGENT_DESKTOP_DB_PATH;
    if (!configured || !isAbsolute(configured))
      throw new Error("CS_AGENT_DESKTOP_DB_PATH_REQUIRED_ABSOLUTE");
    this.path = resolve(configured);
    const preexisting = existsSync(this.path) && statSync(this.path).size > 0;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      const plan = getDesktopMigrationPlan(this.db);
      if (preexisting && plan.pending.length > 0) {
        const beforeMigrations =
          options.beforeMigrations ??
          ((db: DatabaseSync, path: string, pending: DesktopMigrationPlan) => {
            createPreMigrationBackup(db, path, pending);
          });
        beforeMigrations(this.db, this.path, plan);
      }
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000",
      );
      runDesktopMigrations(this.db, { plan });
      const integrity = this.db
        .prepare("PRAGMA integrity_check")
        .all() as Array<Record<string, unknown>>;
      if (
        integrity.length !== 1 ||
        String(Object.values(integrity[0])[0]).toLowerCase() !== "ok"
      )
        throw new Error("SQLITE_INTEGRITY_CHECK_FAILED");
      if (this.db.prepare("PRAGMA foreign_key_check").all().length > 0)
        throw new Error("SQLITE_FOREIGN_KEY_CHECK_FAILED");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  enqueueWrite<T>(work: (db: DatabaseSync) => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error("SQLITE_DATABASE_CLOSED"));
    const result = this.writeTail.then(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const value = work(this.db);
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* preserve original write failure */
        }
        throw error;
      }
    });
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async drain(): Promise<void> {
    await this.writeTail;
  }
  async close(): Promise<void> {
    await this.drain();
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

const owners = new Map<string, SqliteDatabaseOwner>();
export function getSqliteDatabaseOwner(
  options: SqliteDatabaseOptions = {},
): SqliteDatabaseOwner {
  const configured = options.path ?? process.env.CS_AGENT_DESKTOP_DB_PATH;
  if (!configured || !isAbsolute(configured))
    throw new Error("CS_AGENT_DESKTOP_DB_PATH_REQUIRED_ABSOLUTE");
  const path = resolve(configured);
  const existing = owners.get(path);
  if (existing && !existing.isClosed) return existing;
  if (existing?.isClosed) owners.delete(path);
  const owner = new SqliteDatabaseOwner({ ...options, path });
  owners.set(path, owner);
  return owner;
}

export async function closeSqliteDatabaseOwnersForTests(): Promise<void> {
  const values = [...owners.values()];
  owners.clear();
  await Promise.all(values.map((owner) => owner.close()));
}
