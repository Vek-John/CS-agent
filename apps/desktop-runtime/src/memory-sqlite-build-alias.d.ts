declare module "@cs-coach/memory-sqlite" {
  interface StatementSync {
    get(...params: unknown[]): unknown;
  }

  interface DatabaseSync {
    prepare(sql: string): StatementSync;
  }

  export class SqliteDatabaseOwner {
    readonly db: DatabaseSync;
    constructor(options: { path: string });
    close(): Promise<void>;
  }
}
