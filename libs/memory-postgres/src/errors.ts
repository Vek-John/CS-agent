export class MemoryUserMismatchError extends Error {
  readonly code = "USER_MISMATCH" as const;

  constructor(message = "Memory user scope does not match the authenticated user") {
    super(message);
    this.name = "MemoryUserMismatchError";
  }
}

export class MemoryRowValidationError extends Error {
  readonly code = "INVALID_MEMORY_ROW" as const;
  readonly userId: string;

  constructor(userId: string, message = "PostgreSQL returned an invalid memory row") {
    super(message);
    this.name = "MemoryRowValidationError";
    this.userId = userId;
  }
}

/** Controlled failure used by MemoryService to select structured fallback. */
export class SemanticUnavailableError extends Error {
  readonly code = "SEMANTIC_UNAVAILABLE" as const;

  constructor(message = "Semantic memory search is unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SemanticUnavailableError";
  }
}

export class VectorUnavailableError extends SemanticUnavailableError {
  constructor(message = "The optional pgvector index is unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VectorUnavailableError";
  }
}

/** Configuration was not sufficient to construct a server-side database client. */
export class MemoryDatabaseConfigurationError extends Error {
  readonly code = "MEMORY_DATABASE_CONFIGURATION" as const;

  constructor(message = "A PostgreSQL connection string is required") {
    super(message);
    this.name = "MemoryDatabaseConfigurationError";
  }
}

/** A database driver was not available or a connection/query could not be completed. */
export class MemoryDatabaseConnectionError extends Error {
  readonly code: "MEMORY_DATABASE_CONNECTION" | "MEMORY_DATABASE_DRIVER" = "MEMORY_DATABASE_CONNECTION";
  readonly operation: string;

  constructor(operation: string, message = `PostgreSQL ${operation} failed`, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MemoryDatabaseConnectionError";
    this.operation = operation;
  }
}

/** The server-only pg driver could not be loaded in the current runtime. */
export class MemoryDatabaseDriverError extends MemoryDatabaseConnectionError {
  readonly code = "MEMORY_DATABASE_DRIVER" as const;

  constructor(options?: { cause?: unknown }) {
    super("driver", "The PostgreSQL driver is unavailable in this server runtime", options);
    this.name = "MemoryDatabaseDriverError";
  }
}
