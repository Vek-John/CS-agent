import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getSqliteDatabaseOwner } from "@cs-coach/memory-sqlite/server";
import {
  DesktopReviewLibrary,
  ReviewLibraryError,
  installDesktopReviewLibrary,
  type LibraryStats,
} from "@cs-coach/review-library/server";
import type { DesktopRuntimeInit } from "./contracts";
import { installRuntimeProviderConfig, RuntimeStartupError } from "./contracts";
import {
  appSecurityHeaders,
  createRuntimeToken,
  DESKTOP_APP_ORIGIN_HEADER,
  DESKTOP_VIEWER_ORIGIN_HEADER,
  hasValidAdminAuthorization,
  hasValidSessionCookie,
  lockResponseSecurityHeaders,
  NEXT_NONCE_HEADER,
  writeJson,
} from "./security";
import { createViewerHandler } from "./viewer";
import { bindDesktopOriginPair, DesktopOriginBindError, IPV4_LOOPBACK } from "./origins";

export const ADMIN_HEALTH_PATH = "/_desktop/health";
export const ADMIN_SHUTDOWN_PATH = "/_desktop/shutdown";
export const ADMIN_BACKUP_PATH = "/_desktop/backup";
export const ADMIN_LIBRARY_STATS_PATH = "/_desktop/library/stats";
export const ADMIN_LIBRARY_ENTRIES_PATH = "/_desktop/library/entries";
export const ADMIN_LIBRARY_VERIFY_PATH = "/_desktop/library/verify";
export const ADMIN_LIBRARY_CLEAR_CACHE_PATH = "/_desktop/library/clear-cache";
export const ADMIN_LIBRARY_IMPACT_TOKEN_HEADER = "x-cs-agent-library-impact-token";
const ADMIN_LIBRARY_REVIEWS_PREFIX = "/_desktop/library/reviews/";
const ADMIN_LIBRARY_DEMOS_PREFIX = "/_desktop/library/demos/";
const BLOCKED_DESKTOP_DEMO_PATH = "/api/local-demo";
const UPDATE_QUIESCE_TIMEOUT_MS = 25_000;

type RuntimeHealth = "READY" | "DRAINING";

export interface NextHandlerContext {
  readonly init: DesktopRuntimeInit;
  readonly appOrigin: string;
  readonly viewerOrigin: string;
  readonly httpServer: Server;
}

export interface PreparedNextHandler {
  readonly handler: RequestListener;
  readonly close?: () => Promise<void> | void;
}

export interface DesktopRuntimeOptions {
  readonly prepareNextHandler?: (context: NextHandlerContext) => Promise<PreparedNextHandler>;
  readonly checkpointProbe?: () => Promise<boolean>;
  readonly sessionToken?: string;
  readonly adminToken?: string;
  readonly drainTimeoutMs?: number;
  readonly onAdminShutdown?: () => void;
  readonly createUpdateBackup?: () => Promise<DesktopUpdateBackupSummary>;
}

export interface DesktopUpdateBackupSummary {
  readonly schemaVersion: "desktop-runtime-backup.v1";
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly createdAt: string;
  readonly databaseSha256: string;
  readonly migrationCount: number;
}

export interface DesktopRuntimeReady {
  readonly schemaVersion: "desktop-runtime-ready.v2";
  readonly protocolVersion: "desktop-runtime-http.v2";
  readonly appOrigin: string;
  readonly viewerOrigin: string;
  readonly pid: number;
  readonly targetTriple: string;
  readonly nodeVersion: string;
  readonly checkpointBackend: "SQLITE";
  readonly recoverableAfterRefresh: true;
  readonly sessionToken: string;
  readonly adminToken: string;
}

export interface DesktopRuntimeController {
  readonly ready: DesktopRuntimeReady;
  readonly health: () => RuntimeHealth;
  readonly shutdown: () => Promise<void>;
}

async function closeServer(server: Server, timeoutMs: number): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);
    timer.unref?.();
    server.close(finish);
    server.closeIdleConnections?.();
  });
}

interface StandaloneLayout {
  readonly appRoot: string;
  readonly resourceRoot: string;
}

function standaloneLayout(runtimeRoot: string): StandaloneLayout {
  const candidates = [
    { appRoot: runtimeRoot, resourceRoot: runtimeRoot },
    { appRoot: path.join(runtimeRoot, "apps", "web"), resourceRoot: runtimeRoot },
    { appRoot: path.join(runtimeRoot, "standalone"), resourceRoot: path.join(runtimeRoot, "standalone") },
    { appRoot: path.join(runtimeRoot, "standalone", "apps", "web"), resourceRoot: path.join(runtimeRoot, "standalone") },
  ];
  const layout = candidates.find(({ appRoot }) => existsSync(path.join(appRoot, ".next", "required-server-files.json")));
  if (!layout) throw new Error("STANDALONE_LAYOUT_INVALID");
  return layout;
}

function tracedNextEntry(layout: StandaloneLayout): string {
  const pnpmRoot = path.join(layout.resourceRoot, "node_modules", ".pnpm");
  const pnpmCandidates = existsSync(pnpmRoot)
    ? readdirSync(pnpmRoot)
      .filter((entry) => entry.startsWith("next@"))
      .sort()
      .map((entry) => path.join(pnpmRoot, entry, "node_modules", "next"))
    : [];
  const candidates = [
    ...pnpmCandidates,
    path.join(layout.resourceRoot, "node_modules", ".pnpm", "node_modules", "next"),
    path.join(layout.appRoot, "node_modules", "next"),
  ];
  const validCandidates = candidates.filter((candidate) =>
    existsSync(path.join(candidate, "dist", "server", "next.js"))
      && existsSync(path.join(candidate, "dist", "server", "require-hook.js")));
  const nextRoot = validCandidates[0];
  if (!nextRoot) throw new Error("NEXT_INTERFACE_NOT_TRACED");
  return path.join(nextRoot, "dist", "server", "next.js");
}

/** Loads Next only from traced runtime resources; esbuild cannot bundle this dynamic require. */
export async function prepareStandaloneNextHandler(context: NextHandlerContext): Promise<PreparedNextHandler> {
  const layout = standaloneLayout(context.init.runtimeRoot);
  const appRoot = layout.appRoot;
  const requiredServerFiles = JSON.parse(readFileSync(path.join(appRoot, ".next", "required-server-files.json"), "utf8")) as { config?: Record<string, unknown> };
  const tracedConfig = requiredServerFiles.config ?? {};
  const config = {
    ...tracedConfig,
    outputFileTracingRoot: layout.resourceRoot,
    repoRoot: layout.resourceRoot,
    turbopack: {
      ...(typeof tracedConfig.turbopack === "object" && tracedConfig.turbopack !== null
        ? tracedConfig.turbopack as Record<string, unknown>
        : {}),
      root: layout.resourceRoot,
    },
  };
  const nextEntry = tracedNextEntry(layout);
  const runtimeRequire = createRequire(nextEntry);
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
  process.chdir(appRoot);
  const nextModule = runtimeRequire(nextEntry) as { default?: unknown } | ((options: unknown) => unknown);
  const nextFactory = (typeof nextModule === "function" ? nextModule : nextModule.default) as (options: unknown) => {
    prepare: () => Promise<void>;
    getRequestHandler: () => RequestListener;
    close?: () => Promise<void>;
  };
  if (typeof nextFactory !== "function") throw new Error("NEXT_INTERFACE_INVALID");
  const appUrl = new URL(context.appOrigin);
  const appPort = Number(appUrl.port);
  if (appUrl.protocol !== "http:" || appUrl.hostname !== IPV4_LOOPBACK || !Number.isInteger(appPort) || appPort < 1) {
    throw new Error("NEXT_APP_ORIGIN_INVALID");
  }
  const app = nextFactory({
    // We own the literal-loopback HTTP server and delegate every validated
    // request to Next. Its custom-server wrapper installs the full router
    // (including /_next/static); the internal NextServer constructor can
    // render app routes but does not provide that outer asset routing seam.
    customServer: true,
    dev: false,
    dir: appRoot,
    conf: config,
    quiet: true,
    hostname: appUrl.hostname,
    port: appPort,
    httpServer: context.httpServer,
  });
  await app.prepare();
  return { handler: app.getRequestHandler(), close: () => app.close?.() };
}

/**
 * Production persistence integration seam. Packaging places this module next
 * to the standalone root only after the SQLite saver has opened and verified
 * its schema. It must export `probeDesktopCheckpointBackend(init)`.
 */
interface TracedCheckpointBridge {
  readonly probeDesktopCheckpointBackend?: (value: DesktopRuntimeInit) => Promise<boolean> | boolean;
  readonly createDesktopUpdateBackup?: (
    value: DesktopRuntimeInit,
  ) => Promise<DesktopUpdateBackupSummary> | DesktopUpdateBackupSummary;
}

function loadTracedCheckpointBridge(init: DesktopRuntimeInit): TracedCheckpointBridge | undefined {
  const modulePath = path.join(init.runtimeRoot, "desktop-checkpoint-probe.cjs");
  if (!existsSync(modulePath)) return undefined;
  try {
    const runtimeRequire = createRequire(path.join(init.runtimeRoot, "package.json"));
    return runtimeRequire(modulePath) as TracedCheckpointBridge;
  } catch {
    return undefined;
  }
}

async function probeTracedCheckpointBackend(init: DesktopRuntimeInit): Promise<boolean> {
  const bridge = loadTracedCheckpointBridge(init);
  if (typeof bridge?.probeDesktopCheckpointBackend !== "function") return false;
  try {
    return await bridge.probeDesktopCheckpointBackend(init) === true;
  } catch {
    return false;
  }
}

async function createTracedUpdateBackup(
  init: DesktopRuntimeInit,
): Promise<DesktopUpdateBackupSummary> {
  const bridge = loadTracedCheckpointBridge(init);
  if (typeof bridge?.createDesktopUpdateBackup !== "function") {
    throw new Error("BACKUP_INTERFACE_UNAVAILABLE");
  }
  const summary = await bridge.createDesktopUpdateBackup(init);
  if (summary.schemaVersion !== "desktop-runtime-backup.v1"
    || !path.isAbsolute(summary.databasePath)
    || !path.isAbsolute(summary.manifestPath)
    || !/^[a-f0-9]{64}$/u.test(summary.databaseSha256)
    || !Number.isInteger(summary.migrationCount)
    || summary.migrationCount < 1
    || !Number.isFinite(Date.parse(summary.createdAt))) {
    throw new Error("BACKUP_RESULT_INVALID");
  }
  return summary;
}

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function boundedAdminObjectId(value: string): string | undefined {
  return /^[A-Za-z0-9._:-]{1,160}$/u.test(value) ? value : undefined;
}

function dynamicLibraryAdminRoute(pathname: string):
  | { readonly kind: "REVIEW_DELETE"; readonly objectId: string }
  | { readonly kind: "DEMO_IMPACT" | "DEMO_DELETE"; readonly objectId: string }
  | undefined {
  if (pathname.startsWith(ADMIN_LIBRARY_REVIEWS_PREFIX)) {
    const objectId = boundedAdminObjectId(pathname.slice(ADMIN_LIBRARY_REVIEWS_PREFIX.length));
    return objectId ? { kind: "REVIEW_DELETE", objectId } : undefined;
  }
  if (!pathname.startsWith(ADMIN_LIBRARY_DEMOS_PREFIX)) return undefined;
  const suffix = pathname.slice(ADMIN_LIBRARY_DEMOS_PREFIX.length);
  if (suffix.endsWith("/impact")) {
    const objectId = boundedAdminObjectId(suffix.slice(0, -"/impact".length));
    return objectId ? { kind: "DEMO_IMPACT", objectId } : undefined;
  }
  const objectId = boundedAdminObjectId(suffix);
  return objectId ? { kind: "DEMO_DELETE", objectId } : undefined;
}

/**
 * One quiescence boundary for every request that can observe or mutate the
 * persisted Review Library. A request retires only after both its handler and
 * response stream settle, so backups cannot race a still-streaming Demo.
 */
export class RuntimeActivityTracker {
  #activeRequests = 0;

  get activeRequests(): number {
    return this.#activeRequests;
  }

  begin(response: ServerResponse): () => void {
    this.#activeRequests += 1;
    let handlerSettled = false;
    let responseSettled = response.writableFinished || response.destroyed;
    let retired = false;
    const retire = () => {
      if (retired || !handlerSettled || !responseSettled) return;
      retired = true;
      this.#activeRequests = Math.max(0, this.#activeRequests - 1);
    };
    const responseDone = () => {
      responseSettled = true;
      retire();
    };
    response.once("finish", responseDone);
    response.once("close", responseDone);
    return () => {
      handlerSettled = true;
      if (response.writableFinished || response.destroyed) responseSettled = true;
      retire();
    };
  }

  async waitForIdle(timeoutMs = UPDATE_QUIESCE_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.#activeRequests > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.#activeRequests === 0;
  }
}

function createProtectedNextHandler(input: {
  next: RequestListener;
  sessionToken: string;
  adminToken: string;
  appOrigin: string;
  viewerOrigin: string;
  health: () => RuntimeHealth;
  setHealth: (health: RuntimeHealth) => void;
  requestShutdown: () => void;
  createUpdateBackup: () => Promise<DesktopUpdateBackupSummary>;
  reviewLibrary: DesktopReviewLibrary;
  activity: RuntimeActivityTracker;
}): RequestListener {
  let backupInProgress = false;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const expectedHost = new URL(input.appOrigin).host;
    if (req.headers.host !== expectedHost) return writeJson(res, 421, { code: "HOST_REJECTED" });
    const pathname = pathnameOf(req);
    const dynamicLibraryAdmin = dynamicLibraryAdminRoute(pathname);
    if (pathname === BLOCKED_DESKTOP_DEMO_PATH || pathname.startsWith(`${BLOCKED_DESKTOP_DEMO_PATH}/`)) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      return writeJson(res, 404, { code: "NOT_FOUND" });
    }
    if ([ADMIN_HEALTH_PATH, ADMIN_SHUTDOWN_PATH, ADMIN_BACKUP_PATH, ADMIN_LIBRARY_STATS_PATH, ADMIN_LIBRARY_ENTRIES_PATH, ADMIN_LIBRARY_VERIFY_PATH, ADMIN_LIBRARY_CLEAR_CACHE_PATH].includes(pathname) || dynamicLibraryAdmin) {
      if (!hasValidAdminAuthorization(req, input.adminToken)) return writeJson(res, 403, { code: "ADMIN_FORBIDDEN" });
      if (req.method !== "GET" && pathname === ADMIN_HEALTH_PATH) return writeJson(res, 405, { code: "METHOD_NOT_ALLOWED" });
      if (req.method !== "GET" && pathname === ADMIN_LIBRARY_STATS_PATH) return writeJson(res, 405, { code: "METHOD_NOT_ALLOWED" });
      if (req.method !== "GET" && pathname === ADMIN_LIBRARY_ENTRIES_PATH) return writeJson(res, 405, { code: "METHOD_NOT_ALLOWED" });
      if (dynamicLibraryAdmin?.kind === "DEMO_IMPACT" && req.method !== "GET") return writeJson(res, 405, { code: "METHOD_NOT_ALLOWED" });
      if ((dynamicLibraryAdmin?.kind === "REVIEW_DELETE" || dynamicLibraryAdmin?.kind === "DEMO_DELETE") && req.method !== "DELETE") return writeJson(res, 405, { code: "METHOD_NOT_ALLOWED" });
      if (req.method !== "POST" && (pathname === ADMIN_LIBRARY_VERIFY_PATH || pathname === ADMIN_LIBRARY_CLEAR_CACHE_PATH)) return writeJson(res, 405, { code: "METHOD_NOT_ALLOWED" });
      if (req.method !== "POST" && pathname === ADMIN_SHUTDOWN_PATH) return writeJson(res, 405, { code: "METHOD_NOT_ALLOWED" });
      if (req.method !== "POST" && pathname === ADMIN_BACKUP_PATH) return writeJson(res, 405, { code: "METHOD_NOT_ALLOWED" });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      if (pathname === ADMIN_HEALTH_PATH) {
        const status = input.health();
        return writeJson(res, 200, {
          schemaVersion: "desktop-runtime-health.v1",
          protocolVersion: "desktop-runtime-http.v2",
          status,
          activeRequests: input.activity.activeRequests,
          checkpointBackend: "SQLITE",
          recoverableAfterRefresh: status === "READY",
          pid: process.pid,
        });
      }
      if (pathname === ADMIN_LIBRARY_STATS_PATH) {
        if (input.health() !== "READY") return writeJson(res, 503, { code: "RUNTIME_DRAINING" });
        const finishActivity = input.activity.begin(res);
        try {
          const stats = await input.reviewLibrary.stats();
          if (!isLibraryStats(stats)) throw new Error("LIBRARY_STATS_INVALID");
          return writeJson(res, 200, stats);
        } catch {
          return writeJson(res, 503, { code: "LIBRARY_STATS_UNAVAILABLE" });
        } finally {
          finishActivity();
        }
      }
      if (pathname === ADMIN_LIBRARY_ENTRIES_PATH) {
        if (input.health() !== "READY") return writeJson(res, 503, { code: "RUNTIME_DRAINING" });
        const finishActivity = input.activity.begin(res);
        try {
          return writeJson(res, 200, await input.reviewLibrary.listLibraryEntries());
        } catch {
          return writeJson(res, 503, { code: "LIBRARY_ENTRIES_UNAVAILABLE" });
        } finally {
          finishActivity();
        }
      }
      if (dynamicLibraryAdmin?.kind === "DEMO_IMPACT") {
        if (input.health() !== "READY") return writeJson(res, 503, { code: "RUNTIME_DRAINING" });
        const finishActivity = input.activity.begin(res);
        try {
          return writeJson(
            res,
            200,
            await input.reviewLibrary.previewDemoDeletion(dynamicLibraryAdmin.objectId),
          );
        } catch (error) {
          return writeJson(
            res,
            error instanceof ReviewLibraryError && error.code === "DEMO_NOT_FOUND" ? 404 : 503,
            { code: error instanceof ReviewLibraryError ? error.code : "LIBRARY_IMPACT_UNAVAILABLE" },
          );
        } finally {
          finishActivity();
        }
      }
      if (dynamicLibraryAdmin?.kind === "REVIEW_DELETE") {
        if (input.health() !== "READY") return writeJson(res, 503, { code: "RUNTIME_DRAINING" });
        const finishActivity = input.activity.begin(res);
        try {
          return writeJson(res, 200, await input.reviewLibrary.deleteReview(dynamicLibraryAdmin.objectId));
        } catch (error) {
          return writeJson(
            res,
            error instanceof ReviewLibraryError && error.code === "REVIEW_NOT_FOUND" ? 404 : 503,
            { code: error instanceof ReviewLibraryError ? error.code : "LIBRARY_REVIEW_DELETE_FAILED" },
          );
        } finally {
          finishActivity();
        }
      }
      if (dynamicLibraryAdmin?.kind === "DEMO_DELETE") {
        if (input.health() !== "READY") return writeJson(res, 503, { code: "RUNTIME_DRAINING" });
        const rawImpactToken = req.headers[ADMIN_LIBRARY_IMPACT_TOKEN_HEADER];
        const impactToken =
          typeof rawImpactToken === "string" && /^[0-9a-f]{64}$/u.test(rawImpactToken)
            ? rawImpactToken
            : undefined;
        if (!impactToken) return writeJson(res, 400, { code: "INVALID_IMPACT_TOKEN" });
        const finishActivity = input.activity.begin(res);
        try {
          return writeJson(
            res,
            200,
            await input.reviewLibrary.deleteDemo(dynamicLibraryAdmin.objectId, { impactToken }),
          );
        } catch (error) {
          const status = error instanceof ReviewLibraryError && error.code === "DELETION_IMPACT_CHANGED"
            ? 409
            : error instanceof ReviewLibraryError && error.code === "DEMO_NOT_FOUND"
              ? 404
              : 503;
          return writeJson(res, status, {
            code: error instanceof ReviewLibraryError ? error.code : "LIBRARY_DEMO_DELETE_FAILED",
          });
        } finally {
          finishActivity();
        }
      }
      if (pathname === ADMIN_LIBRARY_VERIFY_PATH) {
        if (input.health() !== "READY") return writeJson(res, 503, { code: "RUNTIME_DRAINING" });
        const finishActivity = input.activity.begin(res);
        try {
          const result = await input.reviewLibrary.verify();
          return writeJson(res, 200, {
            schemaVersion: "review-library-verification-summary.v1",
            checkedDemos: result.checkedDemos,
            checkedArtifacts: result.checkedArtifacts,
            issueCount: result.issues.length,
          });
        } catch {
          return writeJson(res, 503, { code: "LIBRARY_VERIFY_UNAVAILABLE" });
        } finally {
          finishActivity();
        }
      }
      if (pathname === ADMIN_LIBRARY_CLEAR_CACHE_PATH) {
        if (input.health() !== "READY") return writeJson(res, 503, { code: "RUNTIME_DRAINING" });
        const finishActivity = input.activity.begin(res);
        try {
          return writeJson(res, 200, await input.reviewLibrary.clearRebuildableCache());
        } catch {
          return writeJson(res, 503, { code: "LIBRARY_CACHE_CLEANUP_UNAVAILABLE" });
        } finally {
          finishActivity();
        }
      }
      if (pathname === ADMIN_BACKUP_PATH) {
        if (backupInProgress || input.health() !== "READY") {
          return writeJson(res, 409, { code: "RUNTIME_NOT_IDLE" });
        }
        backupInProgress = true;
        input.setHealth("DRAINING");
        try {
          if (!await input.activity.waitForIdle()) throw new Error("RUNTIME_NOT_IDLE");
          return writeJson(res, 201, await input.createUpdateBackup());
        } catch {
          input.setHealth("READY");
          return writeJson(res, 503, { code: "BACKUP_FAILED" });
        } finally {
          backupInProgress = false;
        }
      }
      input.setHealth("DRAINING");
      writeJson(res, 202, { schemaVersion: "desktop-runtime-shutdown.v1", protocolVersion: "desktop-runtime-http.v2", accepted: true });
      input.requestShutdown();
      return;
    }

    if (!hasValidSessionCookie(req, input.sessionToken)) return writeJson(res, 401, { code: "SESSION_REQUIRED" });
    if (input.health() !== "READY") return writeJson(res, 503, { code: "RUNTIME_DRAINING" });
    req.headers[DESKTOP_APP_ORIGIN_HEADER] = input.appOrigin;

    const nonce = randomBytes(24).toString("base64url");
    const headers = appSecurityHeaders(nonce, input.viewerOrigin);
    req.headers[NEXT_NONCE_HEADER] = nonce;
    req.headers["content-security-policy"] = headers["Content-Security-Policy"];
    req.headers[DESKTOP_VIEWER_ORIGIN_HEADER] = input.viewerOrigin;
    lockResponseSecurityHeaders(res, headers);
    const finishActivity = input.activity.begin(res);
    try {
      await input.next(req, res);
    } catch {
      if (!res.headersSent) writeJson(res, 500, { code: "NEXT_REQUEST_FAILED" });
      else res.destroy();
    } finally {
      finishActivity();
    }
  };
}

function isLibraryStats(value: unknown): value is LibraryStats {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["artifactBytes", "cacheBytes", "demoCount", "rawDemoBytes", "reviewCount", "schemaVersion", "totalBytes"].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]) &&
    record.schemaVersion === "review-library-stats.v1" &&
    expected.filter((key) => key !== "schemaVersion").every((key) => typeof record[key] === "number" && Number.isSafeInteger(record[key]) && (record[key] as number) >= 0) &&
    record.totalBytes === (record.rawDemoBytes as number) + (record.artifactBytes as number) + (record.cacheBytes as number);
}

export async function startDesktopRuntime(
  init: DesktopRuntimeInit,
  options: DesktopRuntimeOptions = {},
): Promise<DesktopRuntimeController> {
  installRuntimeProviderConfig(init.provider);
  process.env.DEPLOY_TARGET = "desktop";
  process.env.NEXT_PUBLIC_DEPLOY_TARGET = "desktop";
  process.env.MEMORY_ENABLED = "true";
  process.env.CS_AGENT_DESKTOP_DB_PATH = path.join(init.dataDir, "cs-agent.sqlite3");
  Object.assign(process.env, { NODE_ENV: "production" });
  let databaseOwner: ReturnType<typeof getSqliteDatabaseOwner> | undefined;
  const sessionToken = options.sessionToken ?? createRuntimeToken();
  const adminToken = options.adminToken ?? createRuntimeToken();
  let health: RuntimeHealth = "READY";
  const runtimeHealth = () => health;
  const activity = new RuntimeActivityTracker();
  let appOrigin: string | undefined;
  let viewerOrigin: string | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let preparedNext: PreparedNextHandler | undefined;
  const drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
  const viewerServer = createServer();
  const appServer = createServer();
  let startupStage: "VIEWER" | "NEXT" | "APP" = "VIEWER";

  try {
    const owner = getSqliteDatabaseOwner({ path: process.env.CS_AGENT_DESKTOP_DB_PATH });
    databaseOwner = owner;
    const library = new DesktopReviewLibrary({ owner, dataRoot: init.dataDir });
    await library.initialize();
    installDesktopReviewLibrary(library);
    const viewerHandler = await createViewerHandler(
      init.viewerRoot,
      () => appOrigin,
      () => viewerOrigin ? new URL(viewerOrigin).host : undefined,
      {
        isReady: () => runtimeHealth() === "READY",
        begin: (response) => activity.begin(response),
      },
    );
    viewerServer.on("request", viewerHandler);

    // Bind both sockets before Next is initialized so its absolute
    // Request URLs use the real OS-assigned origin. Until the protected Next
    // handler is ready, the unguessable loopback port fails closed with 503.
    const notReadyHandler: RequestListener = (_req, res) => {
      res.statusCode = 503;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "close");
      res.end("Not ready");
    };
    appServer.on("request", notReadyHandler);
    const origins = await bindDesktopOriginPair(appServer, viewerServer);
    appOrigin = origins.appOrigin;
    viewerOrigin = origins.viewerOrigin;

    startupStage = "NEXT";
    preparedNext = await (options.prepareNextHandler ?? prepareStandaloneNextHandler)({
      init,
      appOrigin,
      viewerOrigin,
      httpServer: appServer,
    });
    const shutdown = async () => {
      if (shutdownPromise) return shutdownPromise;
      health = "DRAINING";
      shutdownPromise = (async () => {
        await Promise.all([closeServer(appServer, drainTimeoutMs), closeServer(viewerServer, drainTimeoutMs)]);
        // A closed socket is not proof that its async handler has finished its
        // final Saga/SQLite work. Give aborted streams one more drain window;
        // fail closed rather than closing the shared database under a handler.
        if (!await activity.waitForIdle(drainTimeoutMs)) {
          throw new Error("RUNTIME_DRAIN_TIMEOUT");
        }
        await preparedNext?.close?.();
        installDesktopReviewLibrary(undefined);
        await owner.close();
      })();
      return shutdownPromise;
    };
    let shutdownQueued = false;
    appServer.removeListener("request", notReadyHandler);
    appServer.on("request", createProtectedNextHandler({
      next: preparedNext.handler,
      sessionToken,
      adminToken,
      appOrigin,
      viewerOrigin,
      health: runtimeHealth,
      setHealth: (value) => { health = value; },
      requestShutdown: () => {
        if (shutdownQueued) return;
        shutdownQueued = true;
        setImmediate(() => void shutdown().finally(() => options.onAdminShutdown?.()));
      },
      createUpdateBackup: options.createUpdateBackup ?? (() => createTracedUpdateBackup(init)),
      reviewLibrary: library,
      activity,
    }));
    const checkpointAvailable = await (options.checkpointProbe
      ? options.checkpointProbe().catch(() => false)
      : probeTracedCheckpointBackend(init));
    if (!checkpointAvailable) throw new RuntimeStartupError("CHECKPOINT_UNAVAILABLE");

    return {
      ready: {
        schemaVersion: "desktop-runtime-ready.v2",
        protocolVersion: "desktop-runtime-http.v2",
        appOrigin,
        viewerOrigin,
        pid: process.pid,
        targetTriple: init.targetTriple,
        nodeVersion: process.version.replace(/^v/u, ""),
        checkpointBackend: "SQLITE",
        recoverableAfterRefresh: true,
        sessionToken,
        adminToken,
      },
      health: runtimeHealth,
      shutdown,
    };
  } catch (error) {
    await Promise.all([closeServer(appServer, drainTimeoutMs), closeServer(viewerServer, drainTimeoutMs)]);
    await preparedNext?.close?.();
    installDesktopReviewLibrary(undefined);
    await databaseOwner?.close();
    if (error instanceof RuntimeStartupError) throw error;
    if (error instanceof DesktopOriginBindError) {
      throw new RuntimeStartupError(error.stage === "VIEWER"
        ? "VIEWER_START_FAILED"
        : "RUNTIME_START_FAILED");
    }
    throw new RuntimeStartupError(startupStage === "VIEWER"
      ? "VIEWER_START_FAILED"
      : startupStage === "NEXT"
        ? "NEXT_START_FAILED"
        : "RUNTIME_START_FAILED");
  }
}
