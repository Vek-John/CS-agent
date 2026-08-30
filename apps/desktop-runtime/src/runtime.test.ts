import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { DesktopRuntimeInit } from "./contracts";
import {
  ADMIN_BACKUP_PATH,
  ADMIN_HEALTH_PATH,
  ADMIN_SHUTDOWN_PATH,
  startDesktopRuntime,
} from "./runtime";
import {
  constantTimeTokenEqual,
  DESKTOP_APP_ORIGIN_HEADER,
  SESSION_COOKIE_NAME,
} from "./security";

async function requestRaw(origin: string, requestPath: string, host?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const target = new URL(origin);
  const hostname = target.hostname.startsWith("[") ? target.hostname.slice(1, -1) : target.hostname;
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname,
      port: target.port,
      method: "GET",
      path: requestPath,
      headers: host ? { host } : undefined,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once("error", reject);
    req.end();
  });
}

test("runtime owns two IPv4-only loopback ports with host-isolated browser origins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-runtime-test-"));
  const viewerRoot = path.join(root, "viewer");
  const outside = path.join(root, "outside.txt");
  await mkdir(path.join(viewerRoot, "assets"), { recursive: true });
  await writeFile(path.join(viewerRoot, "index.html"), "<!doctype html><title>viewer</title>");
  await writeFile(path.join(viewerRoot, "assets", "parser.wasm"), Buffer.from([0, 97, 115, 109]));
  await writeFile(outside, "secret");
  await symlink(outside, path.join(viewerRoot, "escape.txt"));

  const init: DesktopRuntimeInit = {
    schemaVersion: "desktop-runtime-init.v1",
    appVersion: "0.1.0",
    buildSha: "abc123",
    targetTriple: "aarch64-apple-darwin",
    dataDir: path.join(root, "data"),
    cacheDir: path.join(root, "cache"),
    logDir: path.join(root, "log"),
    runtimeRoot: path.join(root, "runtime"),
    viewerRoot,
    provider: { kind: "NONE", apiKey: null, baseUrl: null, model: null },
  };
  let nextClosed = false;
  let nextCalls = 0;
  let adminShutdownCompleted = false;
  let backupCalls = 0;
  let seenNonce = "";
  let seenAppOrigin = "";
  let seenInjectedAppOrigin = "";
  let seenViewerOrigin = "";
  let signalSlowStarted: (() => void) | undefined;
  let releaseSlow: (() => void) | undefined;
  const slowStarted = new Promise<void>((resolve) => { signalSlowStarted = resolve; });
  const slowRelease = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const runtime = await startDesktopRuntime(init, {
    drainTimeoutMs: 250,
    prepareNextHandler: async (context) => {
      seenAppOrigin = context.appOrigin;
      assert.match(context.appOrigin, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/u);
      return {
        handler: async (req, res) => {
          nextCalls += 1;
          if (req.url === "/slow") {
            signalSlowStarted?.();
            await slowRelease;
          }
          seenNonce = String(req.headers["x-nonce"] ?? "");
          seenInjectedAppOrigin = String(req.headers[DESKTOP_APP_ORIGIN_HEADER] ?? "");
          seenViewerOrigin = String(req.headers["x-cs-agent-viewer-origin"] ?? "");
          res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline'");
          res.setHeader("Access-Control-Allow-Origin", "*");
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString("utf8") }));
        },
        close: () => { nextClosed = true; },
      };
    },
    checkpointProbe: async () => true,
    onAdminShutdown: () => { adminShutdownCompleted = true; },
    createUpdateBackup: async () => {
      backupCalls += 1;
      return {
        schemaVersion: "desktop-runtime-backup.v1",
        databasePath: path.join(root, "backup.sqlite3"),
        manifestPath: path.join(root, "backup.sqlite3.manifest.json"),
        createdAt: "2026-08-30T00:00:00.000Z",
        databaseSha256: "a".repeat(64),
        migrationCount: 2,
      };
    },
  });

  try {
    assert.match(runtime.ready.appOrigin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(seenAppOrigin, runtime.ready.appOrigin);
    assert.match(runtime.ready.viewerOrigin, /^http:\/\/localhost:\d+$/u);
    assert.equal(runtime.ready.schemaVersion, "desktop-runtime-ready.v2");
    assert.equal(runtime.ready.protocolVersion, "desktop-runtime-http.v2");
    assert.notEqual(runtime.ready.appOrigin, runtime.ready.viewerOrigin);
    assert.equal(runtime.ready.sessionToken.length, 43);
    assert.equal(runtime.ready.adminToken.length, 43);
    assert.equal(runtime.ready.checkpointBackend, "SQLITE");
    assert.equal(runtime.ready.recoverableAfterRefresh, true);
    assert.equal(runtime.health(), "READY");
    assert.equal(process.env.DEPLOY_TARGET, "desktop");
    assert.equal(process.env.NEXT_PUBLIC_DEPLOY_TARGET, "desktop");
    assert.equal(process.env.MEMORY_ENABLED, "true");
    assert.equal(process.env.CS_AGENT_DESKTOP_DB_PATH, path.join(init.dataDir, "cs-agent.sqlite3"));
    assert.equal(process.env.NODE_ENV, "production");

    const unauthorized = await fetch(runtime.ready.appOrigin);
    assert.equal(unauthorized.status, 401);

    const appResponse = await fetch(`${runtime.ready.appOrigin}/desktop`, {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${runtime.ready.sessionToken}`,
        "content-type": "text/plain",
        [DESKTOP_APP_ORIGIN_HEADER]: "https://attacker.invalid",
      },
      body: "preserved-route-body",
    });
    assert.equal(appResponse.status, 200);
    assert.equal(nextCalls, 1);
    assert.deepEqual(await appResponse.json(), { method: "POST", body: "preserved-route-body" });
    assert.match(seenNonce, /^[A-Za-z0-9_-]+$/u);
    assert.equal(seenViewerOrigin, runtime.ready.viewerOrigin);
    assert.equal(seenInjectedAppOrigin, runtime.ready.appOrigin);
    const csp = appResponse.headers.get("content-security-policy") ?? "";
    assert.equal(csp.split(";").map((directive) => directive.trim())
      .includes(`frame-src ${runtime.ready.viewerOrigin}`), true);
    assert.equal(csp.split(";").map((directive) => directive.trim()).includes("frame-src http:"), false);
    assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9_-]+'/u);
    const scriptDirective = csp.split(";").find((directive) => directive.trim().startsWith("script-src")) ?? "";
    assert.doesNotMatch(scriptDirective, /unsafe-inline|unsafe-eval/u);
    assert.equal(
      csp.split(";").map((directive) => directive.trim()).includes("style-src 'self' 'unsafe-inline'"),
      true,
    );
    assert.equal(appResponse.headers.get("access-control-allow-origin"), null);
    assert.equal(appResponse.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(appResponse.headers.get("cross-origin-embedder-policy"), "require-corp");

    const viewer = await fetch(runtime.ready.viewerOrigin);
    assert.equal(viewer.status, 200);
    assert.equal(await viewer.text(), "<!doctype html><title>viewer</title>");
    assert.equal(viewer.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(
      (viewer.headers.get("content-security-policy") ?? "").includes(`frame-ancestors ${runtime.ready.appOrigin}`),
      true,
    );
    assert.equal(viewer.headers.get("cache-control"), "no-store");
    const viewerPort = new URL(runtime.ready.viewerOrigin).port;
    const numericViewerOrigin = `http://127.0.0.1:${viewerPort}`;
    assert.equal((await requestRaw(numericViewerOrigin, "/cs2d/", `localhost:${viewerPort}`)).status, 200);
    assert.equal((await requestRaw(numericViewerOrigin, "/cs2d/")).status, 421);
    const leakedCookie = await fetch(`${runtime.ready.viewerOrigin}/cs2d/`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${runtime.ready.sessionToken}` },
    });
    assert.equal(leakedCookie.status, 400);
    assert.equal(await leakedCookie.text(), "Session cookie forbidden");
    const oversizedLeakedCookie = await fetch(`${runtime.ready.viewerOrigin}/cs2d/`, {
      headers: { cookie: `padding=${"x".repeat(8192)}; ${SESSION_COOKIE_NAME}=x` },
    });
    assert.equal(oversizedLeakedCookie.status, 400);
    assert.equal(await oversizedLeakedCookie.text(), "Session cookie forbidden");
    assert.equal((await fetch(`${runtime.ready.viewerOrigin}/cs2d/`, {
      headers: { cookie: "unrelated_localhost_cookie=allowed" },
    })).status, 200);
    const wasm = await fetch(`${runtime.ready.viewerOrigin}/assets/parser.wasm`);
    assert.equal(wasm.headers.get("content-type"), "application/wasm");
    assert.equal((await wasm.arrayBuffer()).byteLength, 4);
    const prefixedWasm = await fetch(`${runtime.ready.viewerOrigin}/cs2d/assets/parser.wasm`);
    assert.equal(prefixedWasm.headers.get("content-type"), "application/wasm");
    assert.equal((await prefixedWasm.arrayBuffer()).byteLength, 4);
    assert.equal((await fetch(`${runtime.ready.viewerOrigin}/cs2d/`)).status, 200);
    assert.equal((await fetch(`${runtime.ready.viewerOrigin}/cs2d/sw.js`)).status, 404);
    assert.equal((await fetch(`${runtime.ready.viewerOrigin}/service-worker.js`)).status, 404);
    assert.equal((await requestRaw(runtime.ready.viewerOrigin, "/%2e%2e/outside.txt")).status, 400);
    assert.equal((await fetch(`${runtime.ready.viewerOrigin}/escape.txt`)).status, 400);
    assert.equal((await requestRaw(runtime.ready.viewerOrigin, "/", "attacker.example")).status, 421);

    const desktopDemo = await fetch(`${runtime.ready.appOrigin}/api/local-demo`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${runtime.ready.sessionToken}` },
      body: "raw-demo-must-not-reach-next",
    });
    assert.equal(desktopDemo.status, 404);
    assert.equal(nextCalls, 1);

    const originRejected = await fetch(`${runtime.ready.appOrigin}${ADMIN_HEALTH_PATH}`, {
      headers: { authorization: `Bearer ${runtime.ready.adminToken}`, origin: "http://127.0.0.1:1" },
    });
    assert.equal(originRejected.status, 403);
    const health = await fetch(`${runtime.ready.appOrigin}${ADMIN_HEALTH_PATH}`, {
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      schemaVersion: "desktop-runtime-health.v1",
      protocolVersion: "desktop-runtime-http.v2",
      status: "READY",
      activeRequests: 0,
      checkpointBackend: "SQLITE",
      recoverableAfterRefresh: true,
      pid: process.pid,
    });

    const wrongBackupMethod = await fetch(`${runtime.ready.appOrigin}${ADMIN_BACKUP_PATH}`, {
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(wrongBackupMethod.status, 405);
    const slowRequest = fetch(`${runtime.ready.appOrigin}/slow`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${runtime.ready.sessionToken}` },
    });
    await slowStarted;
    const backupRequest = fetch(`${runtime.ready.appOrigin}${ADMIN_BACKUP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(backupCalls, 0);
    const draining = await fetch(`${runtime.ready.appOrigin}/desktop`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${runtime.ready.sessionToken}` },
    });
    assert.equal(draining.status, 503);
    assert.deepEqual(await draining.json(), { code: "RUNTIME_DRAINING" });
    releaseSlow?.();
    assert.equal((await slowRequest).status, 200);
    const backup = await backupRequest;
    assert.equal(backup.status, 201);
    assert.deepEqual(await backup.json(), {
      schemaVersion: "desktop-runtime-backup.v1",
      databasePath: path.join(root, "backup.sqlite3"),
      manifestPath: path.join(root, "backup.sqlite3.manifest.json"),
      createdAt: "2026-08-30T00:00:00.000Z",
      databaseSha256: "a".repeat(64),
      migrationCount: 2,
    });
    assert.equal(backupCalls, 1);

    const shutdown = await fetch(`${runtime.ready.appOrigin}${ADMIN_SHUTDOWN_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(shutdown.status, 202);
    await runtime.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.health(), "DRAINING");
    assert.equal(nextClosed, true);
    assert.equal(adminShutdownCompleted, true);
    await assert.rejects(fetch(runtime.ready.appOrigin));
    await assert.rejects(fetch(runtime.ready.viewerOrigin));
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint probe is a fail-closed readiness gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-runtime-probe-"));
  const viewerRoot = path.join(root, "viewer");
  await mkdir(viewerRoot);
  await writeFile(path.join(viewerRoot, "index.html"), "ok");
  const init: DesktopRuntimeInit = {
    schemaVersion: "desktop-runtime-init.v1", appVersion: "1", buildSha: "a", targetTriple: "aarch64-apple-darwin",
    dataDir: path.join(root, "d"), cacheDir: path.join(root, "c"), logDir: path.join(root, "l"),
    runtimeRoot: path.join(root, "r"), viewerRoot,
    provider: { kind: "NONE", apiKey: null, baseUrl: null, model: null },
  };
  await assert.rejects(startDesktopRuntime(init, {
    checkpointProbe: async () => false,
    prepareNextHandler: async () => ({ handler: (_req, res) => res.end("ok") }),
  }), (error: unknown) => error instanceof Error && error.message === "CHECKPOINT_UNAVAILABLE");
  const runtime = await startDesktopRuntime(init, {
    checkpointProbe: async () => true,
    prepareNextHandler: async () => ({ handler: (_req, res) => res.end("ok") }),
  });
  try {
    assert.equal(runtime.health(), "READY");
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("constant-time comparison has fixed-length inputs and rejects altered tokens", () => {
  const token = "a".repeat(43);
  assert.equal(constantTimeTokenEqual(token, token), true);
  assert.equal(constantTimeTokenEqual("b", token), false);
  assert.equal(constantTimeTokenEqual(`${token.slice(0, 42)}b`, token), false);
});
