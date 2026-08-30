import { describe, expect, it } from "vitest";
import {
  createHyperdriveClient,
  createNodePostgresPool,
  MemoryDatabaseConfigurationError,
  MemoryDatabaseConnectionError,
  type PgClientLike,
  type PgModuleLike,
  type PgPoolClientLike,
  type PgPoolLike,
} from "./server";

type QueryCall = { readonly text: string; readonly values?: readonly unknown[] };

function result(rows: readonly Record<string, unknown>[] = []) {
  return { rows, rowCount: rows.length };
}

class FakePoolClient implements PgPoolClientLike {
  readonly calls: QueryCall[] = [];
  released = 0;
  shouldFail = false;

  async query(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values });
    if (this.shouldFail) throw new Error("socket closed");
    return result();
  }

  release() {
    this.released += 1;
  }
}

class FakePool implements PgPoolLike {
  readonly calls: QueryCall[] = [];
  readonly clients: FakePoolClient[] = [];
  ended = 0;
  shouldFailConnect = false;

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values });
    return result() as { rows: readonly Row[]; rowCount: number };
  }

  async connect() {
    if (this.shouldFailConnect) throw new Error("pool unavailable");
    const client = new FakePoolClient();
    this.clients.push(client);
    return client;
  }

  async end() {
    this.ended += 1;
  }
}

class FakeClient implements PgClientLike {
  readonly calls: QueryCall[] = [];
  connected = 0;
  ended = 0;
  shouldFailConnect = false;

  async connect() {
    this.connected += 1;
    if (this.shouldFailConnect) throw new Error("hyperdrive unavailable");
  }

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values });
    return result() as { rows: readonly Row[]; rowCount: number };
  }

  async end() {
    this.ended += 1;
  }
}

function fakePg(pool: FakePool, client: FakeClient): PgModuleLike {
  return {
    Pool: class {
      constructor() {
        return pool;
      }
    } as unknown as PgModuleLike["Pool"],
    Client: class {
      constructor() {
        return client;
      }
    } as unknown as PgModuleLike["Client"],
  };
}

describe("server-only PostgreSQL lifecycle adapters", () => {
  it("pins pool transactions to one checked-out client and releases/ends exactly once", async () => {
    const pool = new FakePool();
    const client = new FakeClient();
    const handle = await createNodePostgresPool({
      connectionString: "postgresql://user:secret@example.invalid/db",
      pgModule: fakePg(pool, client),
    });

    await expect(handle.executor.query("SELECT 1", ["value"])).resolves.toMatchObject({ rows: [] });
    await handle.executor.transaction?.(async (transaction) => {
      await transaction.query("SELECT 2");
      return "done";
    });

    expect(pool.calls.map(({ text }) => text)).toEqual(["SELECT 1"]);
    expect(pool.clients).toHaveLength(1);
    expect(pool.clients[0]?.calls.map(({ text }) => text)).toEqual(["BEGIN", "SELECT 2", "COMMIT"]);
    expect(pool.clients[0]?.released).toBe(1);

    await handle.close();
    await handle.close();
    expect(pool.ended).toBe(1);
  });

  it("rolls back and releases a pool client when transaction work fails", async () => {
    const pool = new FakePool();
    const handle = await createNodePostgresPool({
      connectionString: "postgresql://user:secret@example.invalid/db",
      pgModule: fakePg(pool, new FakeClient()),
    });

    await expect(
      handle.executor.transaction?.(async (transaction) => {
        await transaction.query("UPDATE memory_records SET active = false");
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    expect(pool.clients[0]?.calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      "UPDATE memory_records SET active = false",
      "ROLLBACK",
    ]);
    expect(pool.clients[0]?.released).toBe(1);
    await handle.close();
  });

  it("uses one connected Hyperdrive client for every transaction query and ends it", async () => {
    const pool = new FakePool();
    const client = new FakeClient();
    const handle = await createHyperdriveClient({
      hyperdrive: { connectionString: "postgresql://user:secret@hyperdrive.invalid/db" },
      pgModule: fakePg(pool, client),
    });

    expect(client.connected).toBe(1);
    await handle.executor.transaction?.(async (transaction) => {
      await transaction.query("SELECT 1");
      await transaction.query("SELECT 2");
    });
    expect(client.calls.map(({ text }) => text)).toEqual(["BEGIN", "SELECT 1", "SELECT 2", "COMMIT"]);
    await handle.close();
    await handle.close();
    expect(client.ended).toBe(1);
  });

  it("closes a partially connected Hyperdrive client and exposes a stable connection error", async () => {
    const pool = new FakePool();
    const client = new FakeClient();
    client.shouldFailConnect = true;
    await expect(
      createHyperdriveClient({ connectionString: "postgresql://user:secret@hyperdrive.invalid/db", pgModule: fakePg(pool, client) }),
    ).rejects.toBeInstanceOf(MemoryDatabaseConnectionError);
    expect(client.ended).toBe(1);
  });

  it("fails clearly when no database URL is configured", async () => {
    await expect(createNodePostgresPool({ env: {} })).rejects.toBeInstanceOf(MemoryDatabaseConfigurationError);
  });
});
