import {
  InMemoryMemoryRepository,
  MemoryAuthorizationSchema,
  MemoryService,
  type MemoryAuthorization,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryRepository,
  type MemoryConsentState,
  type MemoryAuthorizationStore,
  type MemoryDeleteInput,
  type MemoryDiagnostic,
} from "@cs-coach/memory";
import {
  createNodePostgresPool,
  withSqlTransaction,
  PostgresMemoryAuthorizationStore,
  PostgresMemoryRepository,
  createHttpEmbeddingProvider,
  type PostgresPoolHandle,
  type SqlResult,
  type SqlExecutor,
} from "@cs-coach/memory-postgres/server";
import { parseMemoryEnabled } from "./feature-flag";
import { hmacSha256Base64Url } from "./principal";

export type MemoryStorageKind = "IN_MEMORY" | "POSTGRES" | "UNAVAILABLE" | "INJECTED";

class InMemoryAuthorizationStore implements MemoryAuthorizationStore {
  private readonly values = new Map<string, MemoryAuthorization>();

  async getAuthorization(userId: string): Promise<MemoryAuthorization | undefined> {
    const value = this.values.get(userId);
    return value ? { ...value } : undefined;
  }

  async setAuthorization(userId: string, input: MemoryAuthorization): Promise<void> {
    if (input.userId !== userId) throw new Error("USER_MISMATCH");
    const parsed = MemoryAuthorizationSchema.parse(input) as unknown as MemoryAuthorization;
    const current = this.values.get(userId);
    const incomingVersion = parsed.consentVersion ?? 0;
    const currentVersion = current?.consentVersion ?? 0;
    if (current && incomingVersion < currentVersion) throw Object.assign(new Error("MEMORY_AUTHORIZATION_CONFLICT"), { code: "MEMORY_AUTHORIZATION_CONFLICT" });
    if (current && incomingVersion === currentVersion &&
      (current.consent !== parsed.consent || current.memoryEnabled !== parsed.memoryEnabled)) {
      throw Object.assign(new Error("MEMORY_AUTHORIZATION_CONFLICT"), { code: "MEMORY_AUTHORIZATION_CONFLICT" });
    }
    this.values.set(userId, { ...parsed });
  }
}

/** A deliberately failing adapter for production-without-Postgres. */
class UnavailableMemoryRepository implements MemoryRepository {
  private fail(): never {
    throw new Error("MEMORY_PERSISTENCE_UNAVAILABLE");
  }

  async getMemoryVersion(): Promise<number> { return this.fail(); }
  async getRecordVersion(): Promise<MemoryRecord | undefined> { return this.fail(); }
  async getPreferences(): Promise<readonly MemoryRecord[]> { return this.fail(); }
  async findByLogicalKey(): Promise<MemoryRecord | undefined> { return this.fail(); }
  async appendEvent(): Promise<void> { return this.fail(); }
  async applyWriteDecision(): Promise<MemoryRecord | undefined> { return this.fail(); }
  async retrieveStructured(): Promise<readonly MemoryRecord[]> { return this.fail(); }
  async retrieveSemantic(): Promise<readonly MemoryRecord[]> { return this.fail(); }
  async getLearningThreads(): Promise<readonly import("@cs-coach/contracts").LearningThread[]> { return this.fail(); }
  async correctMemory(): Promise<MemoryRecord | undefined> { return this.fail(); }
  async deleteMemory(): Promise<MemoryRecord | undefined> { return this.fail(); }
  async listMemoryIdsForDeletion(): Promise<readonly string[]> { return this.fail(); }
  async listMemories(): Promise<readonly MemoryRecord[]> { return this.fail(); }
  async confirmMemory(): Promise<MemoryRecord | undefined> { return this.fail(); }
}

class UnavailableAuthorizationStore implements MemoryAuthorizationStore {
  async getAuthorization(): Promise<MemoryAuthorization | undefined> {
    throw new Error("MEMORY_PERSISTENCE_UNAVAILABLE");
  }

  async setAuthorization(): Promise<void> {
    throw new Error("MEMORY_PERSISTENCE_UNAVAILABLE");
  }
}

interface CloudflareContextLike {
  readonly env?: Record<string, unknown>;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

/** Read only the current request's platform context; never serialize it. */
function currentHyperdriveConnectionString(): string | undefined {
  const symbol = Symbol.for("__cloudflare-context__");
  const globalValue = globalThis as unknown as Record<PropertyKey, unknown>;
  const context = globalValue[symbol] as CloudflareContextLike | undefined;
  const env = context?.env;
  if (!env) return undefined;
  for (const key of ["HYPERDRIVE", "MEMORY_HYPERDRIVE", "MEMORY_DATABASE"]) {
    const binding = env[key];
    if (binding && typeof binding === "object" && !Array.isArray(binding)) {
      const value = (binding as { connectionString?: unknown }).connectionString;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  for (const key of ["HYPERDRIVE_CONNECTION_STRING", "MEMORY_HYPERDRIVE_CONNECTION_STRING"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function configuredMemoryDatabaseUrl(options: MemoryRuntimeOptions): string | undefined {
  return firstNonEmpty(
    options.databaseUrl,
    process.env.MEMORY_DATABASE_URL,
    process.env.DATABASE_URL,
    options.hyperdriveConnectionString,
    currentHyperdriveConnectionString(),
  );
}

function configuredEmbedding(options: MemoryRuntimeOptions): import("@cs-coach/memory").EmbeddingProvider | undefined {
  if (options.embedding) return options.embedding;
  const context = (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] as CloudflareContextLike | undefined;
  const contextValue = context?.env?.MEMORY_EMBEDDING_URL;
  const endpoint = firstNonEmpty(
    process.env.MEMORY_EMBEDDING_URL,
    typeof contextValue === "string" ? contextValue : undefined,
  );
  if (!endpoint) return undefined;
  const contextToken = context?.env?.MEMORY_EMBEDDING_TOKEN;
  const token = firstNonEmpty(
    process.env.MEMORY_EMBEDDING_TOKEN,
    process.env.MEMORY_EMBEDDING_API_KEY,
    typeof contextToken === "string" ? contextToken : undefined,
  );
  try {
    return createHttpEmbeddingProvider({
      endpoint,
      ...(token ? { token } : {}),
      model: process.env.MEMORY_EMBEDDING_MODEL,
    });
  } catch {
    // A malformed optional provider must leave structured memory available.
    return undefined;
  }
}

function databaseFailureReason(_error: unknown): string {
  // Deliberately avoid returning driver messages: they may include a host,
  // username, or connection string. Logs and JSON only receive this code.
  return "POSTGRES_UNAVAILABLE";
}

function productionMemoryDiagnosticSink(environment: string): ((diagnostic: MemoryDiagnostic) => void) | undefined {
  if (environment !== "production") return undefined;
  return (diagnostic) => {
    // Only bounded lifecycle metadata and opaque IDs enter the platform log;
    // memory text, event payloads and provider error messages never do.
    const safe = {
      type: diagnostic.type,
      userId: diagnostic.userId,
      ...(diagnostic.memoryId ? { memoryId: diagnostic.memoryId } : {}),
      ...(diagnostic.eventId ? { eventId: diagnostic.eventId } : {}),
      ...(diagnostic.operation ? { operation: diagnostic.operation } : {}),
      ...(diagnostic.action ? { action: diagnostic.action } : {}),
      ...(diagnostic.accepted !== undefined ? { accepted: diagnostic.accepted } : {}),
      ...(diagnostic.status ? { status: diagnostic.status } : {}),
      ...(diagnostic.source ? { source: diagnostic.source } : {}),
      ...(diagnostic.reason ? { reason: diagnostic.reason.slice(0, 80) } : {}),
    };
    try {
      console.info("[memory]", safe);
    } catch {
      // Observability must never affect the memory or coaching path.
    }
  };
}

/**
 * A synchronous construction seam for route handlers. The real pool is
 * created exactly once, on the first query, and all concurrent callers share
 * the same promise. This keeps route signatures synchronous without importing
 * or initializing pg in the module body.
 */
class LazyPostgresExecutor implements SqlExecutor {
  private handlePromise: Promise<PostgresPoolHandle> | undefined;
  private failureReasonValue: string | undefined;

  constructor(private readonly connectionString: string) {}

  private handle(): Promise<PostgresPoolHandle> {
    if (!this.handlePromise) {
      this.handlePromise = createNodePostgresPool({ connectionString: this.connectionString }).catch((error: unknown) => {
        this.failureReasonValue = databaseFailureReason(error);
        throw error;
      });
    }
    return this.handlePromise;
  }

  private markFailure(error: unknown): never {
    this.failureReasonValue ??= databaseFailureReason(error);
    throw error;
  }

  get failureReason(): string | undefined {
    return this.failureReasonValue;
  }

  get initialized(): boolean {
    return Boolean(this.handlePromise);
  }

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    try {
      return await (await this.handle()).executor.query<Row>(text, values);
    } catch (error) {
      return this.markFailure(error);
    }
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await withSqlTransaction((await this.handle()).executor, work);
    } catch (error) {
      return this.markFailure(error);
    }
  }

  async close(): Promise<void> {
    if (!this.handlePromise) return;
    try {
      await (await this.handlePromise).close();
    } catch (error) {
      this.markFailure(error);
    }
  }
}

export interface MemoryRuntimeOptions {
  readonly repository?: MemoryRepository;
  readonly executor?: SqlExecutor;
  readonly authorizationStore?: MemoryAuthorizationStore;
  readonly embedding?: import("@cs-coach/memory").EmbeddingProvider;
  readonly memoryEnabled?: boolean;
  readonly featureFlag?: boolean;
  /** Explicit DB URL override used by host adapters and tests. */
  readonly databaseUrl?: string;
  /** Current Cloudflare Hyperdrive connectionString supplied by a host. */
  readonly hyperdriveConnectionString?: string;
  readonly nodeEnv?: string;
  readonly degradedReason?: string;
  readonly allowTestPrincipal?: boolean;
  readonly onMemoryDeleted?: import("@cs-coach/memory").MemoryServiceOptions["onMemoryDeleted"];
  /** Optional structured diagnostic sink; production defaults to a bounded
   * platform logger that never receives memory content. */
  readonly onDiagnostic?: (diagnostic: MemoryDiagnostic) => void;
}

export interface MemoryRuntime {
  readonly service: MemoryService;
  readonly repository: MemoryRepository;
  readonly authorizationStore: MemoryAuthorizationStore;
  readonly featureEnabled: boolean;
  readonly storage: MemoryStorageKind;
  readonly durable: boolean;
  readonly degradedReason?: string;
  readonly allowTestPrincipal: boolean;
  getAuthorization(userId: string): Promise<MemoryAuthorization | undefined>;
  /** Durable consent read reserved for privacy deletion/cookie repair. It
   * intentionally remains available when the teaching feature flag is off. */
  getAuthorizationForDeletion(userId: string): Promise<MemoryAuthorization | undefined>;
  isAuthorized(userId: string): Promise<boolean>;
  canDelete(userId: string): Promise<boolean>;
  listMemoryIdsForDeletion(userId: string, limit?: number): Promise<readonly string[]>;
  list(userId: string, query?: MemoryQuery): Promise<readonly MemoryRecord[]>;
  getRecord(userId: string, memoryId: string): Promise<MemoryRecord | undefined>;
  setAuthorization(userId: string, input: unknown): Promise<MemoryAuthorization | undefined>;
  delete(userId: string, memoryId: string, input?: MemoryDeleteInput): Promise<MemoryRecord | undefined>;
  close(): Promise<void>;
}

/** Production callers must not present a volatile adapter as durable memory. */
export function memoryPersistenceUnavailable(runtime: Pick<MemoryRuntime, "storage" | "durable">): boolean {
  const degraded = "degradedReason" in runtime ? runtime.degradedReason : undefined;
  return runtime.storage === "UNAVAILABLE" || degraded === "POSTGRES_UNAVAILABLE" || (runtime.storage === "INJECTED" && !runtime.durable && process.env.NODE_ENV === "production");
}

function nodeEnv(options: MemoryRuntimeOptions): string {
  return options.nodeEnv ?? process.env.NODE_ENV ?? "development";
}

function cloudflareEnv(): Record<string, unknown> | undefined {
  const context = (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] as CloudflareContextLike | undefined;
  return context?.env;
}

/** Best-effort broadcast to the session DOs that have emitted this memory. */
async function notifyCloudflareMemoryOutboxes(notice: {
  userId: string;
  memoryId: string;
  logicalKey: string;
  sessionIds: readonly string[];
}): Promise<void> {
  const env = cloudflareEnv();
  const binding = env?.COACH_AGENT as {
    idFromName?: (name: string) => unknown;
    get?: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
  } | undefined;
  const endpoint = typeof env?.MEMORY_OUTBOX_INVALIDATOR_URL === "string"
    ? env.MEMORY_OUTBOX_INVALIDATOR_URL.trim()
    : "";
  const token = typeof env?.MEMORY_INTERNAL_TOKEN === "string" ? env.MEMORY_INTERNAL_TOKEN.trim() : "";
  const hmacSecret = typeof env?.MEMORY_INTERNAL_HMAC_SECRET === "string" ? env.MEMORY_INTERNAL_HMAC_SECRET.trim() : "";
  // Do not cap this fan-out: a user can have more than 64 historical session
  // DOs, and truncating the list leaves cached briefs/pending outboxes alive
  // after a user-wide erase. The repository already returns de-duplicated,
  // user-scoped IDs; send every one (the Worker/DO path remains individually
  // authenticated and bounded per request).
  const sessions = [...new Set(notice.sessionIds.filter((value): value is string => typeof value === "string" && value.length > 0))];
  const bodyFor = (sessionId: string) => JSON.stringify(notice.memoryId === "*"
    ? { sessionId, all: true }
    : { sessionId, memoryId: notice.memoryId, logicalKey: notice.logicalKey });
  const headersFor = async (body: string, extra: HeadersInit = {}): Promise<Headers> => {
    const headers = new Headers({ "content-type": "application/json", ...extra });
    if (token.length >= 16) {
      headers.set("x-memory-internal-token", token);
    } else if (hmacSecret.length >= 16) {
      const timestamp = String(Date.now());
      headers.set("x-memory-timestamp", timestamp);
      headers.set("x-memory-signature", await hmacSha256Base64Url(`${timestamp}.${body}`, hmacSecret));
    }
    return headers;
  };
  const sendOne = async (sessionId: string): Promise<void> => {
    if (!binding?.idFromName || !binding.get) {
      if (!endpoint || typeof fetch !== "function") {
        // In a production/Worker deployment, silently dropping a known
        // session invalidation would make the consent API claim immediate
        // zero-outbox semantics while leaving a live DO behind. The localhost
        // launcher explicitly selects a non-Cloudflare host, and this branch
        // has already proved that neither a binding nor an HTTP endpoint
        // exists. An empty platform context alone does not create a DO channel.
        const cloudflareDeployTarget = typeof env?.DEPLOY_TARGET === "string"
          ? env.DEPLOY_TARGET.trim().toLowerCase()
          : "";
        const processDeployTarget = process.env.DEPLOY_TARGET?.trim().toLowerCase() ?? "";
        const explicitLocalhostWithoutOutbox =
          processDeployTarget === "localhost" &&
          cloudflareDeployTarget !== "cloudflare";
        const strictDeployment = !explicitLocalhostWithoutOutbox && (process.env.NODE_ENV === "production" ||
          processDeployTarget === "cloudflare" || cloudflareDeployTarget === "cloudflare" ||
          (typeof process === "undefined" && env !== undefined));
        if (strictDeployment) throw new Error("OUTBOX_INVALIDATION_UNAVAILABLE");
        return;
      }
      const body = bodyFor(sessionId);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: await headersFor(body, {
          "x-cs-trusted-principal": notice.userId,
          "x-cs-memory-internal": "1",
        }),
        body,
      });
      if (!response.ok) throw new Error("OUTBOX_INVALIDATION_FAILED");
      return;
    }
    const stub = binding.get(binding.idFromName(sessionId));
    const body = bodyFor(sessionId);
    const response = await stub.fetch(new Request("https://memory.invalid/api/coaching/agent/memory-invalidate", {
      method: "POST",
      headers: await headersFor(body, {
        "x-cs-trusted-principal": notice.userId,
        "x-cs-memory-internal": "1",
        "x-memory-test-principal": notice.userId,
      }),
      body,
    }));
    if (!response.ok) throw new Error("OUTBOX_INVALIDATION_FAILED");
  };
  // Keep concurrency bounded for a large historical session set while still
  // delivering to every known DO (the former 64-session truncation was a
  // privacy hole).
  for (let index = 0; index < sessions.length; index += 16) {
    await Promise.all(sessions.slice(index, index + 16).map(sendOne));
  }
}

export function createMemoryRuntime(options: MemoryRuntimeOptions = {}): MemoryRuntime {
  const env = nodeEnv(options);
  const featureEnabled = options.memoryEnabled ?? options.featureFlag ?? parseMemoryEnabled();
  let repository = options.repository;
  let authorizationStore = options.authorizationStore;
  let storage: MemoryStorageKind;
  let durable = false;
  let degradedReason = options.degradedReason;
  let lazyExecutor: LazyPostgresExecutor | undefined;
  const databaseUrl = configuredMemoryDatabaseUrl(options);
  const embedding = configuredEmbedding(options);

  if (repository) {
    storage = options.executor ? "INJECTED" : "INJECTED";
    authorizationStore ??= new InMemoryAuthorizationStore();
    durable = Boolean(options.executor);
    if (!durable && env === "production") degradedReason ??= "INJECTED_STORAGE_IS_NOT_DECLARED_DURABLE";
  } else if (options.executor) {
    repository = new PostgresMemoryRepository({ executor: options.executor });
    authorizationStore ??= new PostgresMemoryAuthorizationStore(options.executor);
    storage = "POSTGRES";
    durable = true;
  } else if (databaseUrl) {
    lazyExecutor = new LazyPostgresExecutor(databaseUrl);
    repository = new PostgresMemoryRepository({ executor: lazyExecutor });
    authorizationStore ??= new PostgresMemoryAuthorizationStore(lazyExecutor);
    storage = "POSTGRES";
    durable = true;
  } else if (env === "production") {
    repository = new UnavailableMemoryRepository();
    authorizationStore ??= new UnavailableAuthorizationStore();
    storage = "UNAVAILABLE";
    durable = false;
    degradedReason ??= "POSTGRES_EXECUTOR_NOT_CONFIGURED";
  } else {
    repository = new InMemoryMemoryRepository();
    authorizationStore ??= new InMemoryAuthorizationStore();
    storage = "IN_MEMORY";
    durable = false;
    degradedReason ??= "LOCAL_IN_MEMORY_STORAGE";
  }

  const selectedRepository = repository;
  const selectedAuthorizationStore = authorizationStore;
  const service = new MemoryService({
    repository: selectedRepository,
    authorizationStore: selectedAuthorizationStore,
    memoryEnabled: featureEnabled,
    embedding,
    onMemoryDeleted: options.onMemoryDeleted ?? notifyCloudflareMemoryOutboxes,
    onDiagnostic: options.onDiagnostic ?? productionMemoryDiagnosticSink(env),
  });

  return {
    service,
    repository: selectedRepository,
    authorizationStore: selectedAuthorizationStore,
    featureEnabled,
    storage,
    durable,
    get degradedReason(): string | undefined {
      return lazyExecutor?.failureReason ?? degradedReason;
    },
    allowTestPrincipal: options.allowTestPrincipal ?? env === "test",
    async getAuthorization(userId: string): Promise<MemoryAuthorization | undefined> {
      if (!featureEnabled) return undefined;
      try {
        const value = await authorizationStore!.getAuthorization(userId);
        return value;
      } catch {
        return undefined;
      }
    },
    async getAuthorizationForDeletion(userId: string): Promise<MemoryAuthorization | undefined> {
      try {
        return await authorizationStore!.getAuthorization(userId);
      } catch {
        return undefined;
      }
    },
    async isAuthorized(userId: string): Promise<boolean> {
      if (!featureEnabled) return false;
      const value = await this.getAuthorization(userId);
      return Boolean(value && value.userId === userId && (value.memoryEnabled ?? value.featureFlag) &&
        value.consent === "GRANTED" && value.consentGranted !== false);
    },
    async canDelete(userId: string): Promise<boolean> {
      let value;
      if (featureEnabled) {
        value = await this.getAuthorization(userId);
      } else {
        // Deletion is the one privacy operation that remains available when
        // the teaching feature is disabled. Read the durable authorization
        // row directly, without enabling recall/write paths.
        try {
          value = await authorizationStore!.getAuthorization(userId);
        } catch {
          value = undefined;
        }
      }
      const enabled = Boolean(value?.memoryEnabled ?? value?.featureFlag);
      return Boolean(value && value.userId === userId && (
        (!featureEnabled && (value.consent === "GRANTED" || value.consent === "REVOKED")) ||
        value.consent === "REVOKED" ||
        (enabled && value.consent === "GRANTED" && value.consentGranted !== false)
      ));
    },
    async listMemoryIdsForDeletion(userId: string, limit = 100): Promise<readonly string[]> {
      if (!(await this.canDelete(userId))) return [];
      if (selectedRepository.listMemoryIdsForDeletion) {
        return selectedRepository.listMemoryIdsForDeletion(userId, Math.min(Math.max(0, Math.floor(limit)), 100));
      }
      // A custom adapter without the minimal erasure seam cannot safely
      // enumerate payload-bearing records after consent revocation.
      return [];
    },
    async list(userId: string, query?: MemoryQuery): Promise<readonly MemoryRecord[]> {
      if (!(await this.isAuthorized(userId))) return [];
      return selectedRepository.listMemories(userId, {
        ...(query ?? {}),
        includeDeleted: false,
        activeOnly: false,
        limit: Math.min(query?.limit ?? 25, 100),
      });
    },
    async getRecord(userId: string, memoryId: string): Promise<MemoryRecord | undefined> {
      if (!(await this.isAuthorized(userId)) || !selectedRepository.getRecordVersion) return undefined;
      return selectedRepository.getRecordVersion(userId, memoryId);
    },
    async setAuthorization(userId: string, input: unknown): Promise<MemoryAuthorization | undefined> {
      return service.setAuthorization(userId, input);
    },
    delete: (userId, memoryId, input) => service.delete(userId, memoryId, input),
    close: async () => {
      if (lazyExecutor) await lazyExecutor.close();
    },
  };
}

let singleton: MemoryRuntime | undefined;
let singletonKey: string | undefined;
let injectedRuntime: MemoryRuntime | undefined;

function closeRuntime(runtime: MemoryRuntime | undefined): void {
  if (!runtime || typeof runtime.close !== "function") return;
  void runtime.close().catch(() => undefined);
}

function environmentKey(): string {
  return `${process.env.NODE_ENV ?? "development"}|${process.env.MEMORY_ENABLED ?? ""}`;
}

export function getMemoryRuntime(): MemoryRuntime {
  if (injectedRuntime) return injectedRuntime;
  const key = environmentKey();
  if (!singleton || singletonKey !== key) {
    closeRuntime(singleton);
    singleton = createMemoryRuntime();
    singletonKey = key;
  }
  return singleton;
}

/** Test/host seam; application code should use getMemoryRuntime(). */
export function setMemoryRuntimeForTests(runtimeOrOptions: MemoryRuntime | MemoryRuntimeOptions): MemoryRuntime {
  closeRuntime(injectedRuntime);
  injectedRuntime = "service" in runtimeOrOptions ? runtimeOrOptions : createMemoryRuntime({ ...runtimeOrOptions, nodeEnv: "test", allowTestPrincipal: true });
  return injectedRuntime;
}

export function resetMemoryRuntimeForTests(): void {
  closeRuntime(singleton);
  closeRuntime(injectedRuntime);
  injectedRuntime = undefined;
  singleton = undefined;
  singletonKey = undefined;
}

export const resetMemoryRuntime = resetMemoryRuntimeForTests;

export function memoryConsent(value: MemoryAuthorization | undefined, fallback: MemoryConsentState = "UNKNOWN"): MemoryConsentState {
  return value?.consent ?? fallback;
}
