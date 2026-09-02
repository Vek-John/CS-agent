import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import test from "node:test";
import { currentDesktopReviewLibrary } from "@cs-coach/review-library/server";
import type { DesktopRuntimeInit } from "./contracts";
import {
  ADMIN_BACKUP_PATH,
  ADMIN_HEALTH_PATH,
  ADMIN_LIBRARY_STATS_PATH,
  ADMIN_LIBRARY_ENTRIES_PATH,
  ADMIN_LIBRARY_IMPACT_TOKEN_HEADER,
  ADMIN_LIBRARY_VERIFY_PATH,
  ADMIN_LIBRARY_CLEAR_CACHE_PATH,
  ADMIN_SHUTDOWN_PATH,
  RuntimeActivityTracker,
  startDesktopRuntime,
} from "./runtime";
import {
  constantTimeTokenEqual,
  DESKTOP_APP_ORIGIN_HEADER,
  SESSION_COOKIE_NAME,
} from "./security";
import { VIEWER_LIBRARY_IMPORT_ID_HEADER } from "./viewer";

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

    const unauthorizedStats = await fetch(`${runtime.ready.appOrigin}${ADMIN_LIBRARY_STATS_PATH}`);
    assert.equal(unauthorizedStats.status, 403);
    const stats = await fetch(`${runtime.ready.appOrigin}${ADMIN_LIBRARY_STATS_PATH}`, {
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(stats.status, 200);
    assert.equal(stats.headers.get("cache-control"), "no-store");
    assert.deepEqual(await stats.json(), {
      schemaVersion: "review-library-stats.v1",
      demoCount: 0,
      reviewCount: 0,
      rawDemoBytes: 0,
      artifactBytes: 0,
      cacheBytes: 0,
      totalBytes: 0,
    });
    const verified = await fetch(`${runtime.ready.appOrigin}${ADMIN_LIBRARY_VERIFY_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), {
      schemaVersion: "review-library-verification-summary.v1",
      checkedDemos: 0,
      checkedArtifacts: 0,
      issueCount: 0,
    });
    const cleared = await fetch(`${runtime.ready.appOrigin}${ADMIN_LIBRARY_CLEAR_CACHE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), {
      schemaVersion: "review-library-cache-cleanup.v1",
      removedBytes: 0,
      cacheBytes: 0,
    });

    const library = currentDesktopReviewLibrary();
    assert.ok(library);
    const demoBytes = Buffer.concat([Buffer.from("PBDEMS2\0"), Buffer.alloc(64, 7)]);
    const expectedHash = createHash("sha256").update(demoBytes).digest("hex");
    const importCapability = library.issueImportCapability({
      objectId: "import_test",
      originalFilename: "match.dem",
      expectedByteLength: demoBytes.byteLength,
    });
    assert.equal((await requestRaw(runtime.ready.viewerOrigin, "/_desktop/library/import", "attacker.example")).status, 421);
    assert.equal((await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/import`)).status, 405);
    const queryTokenRejected = await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/import?token=forbidden`, {
      method: "POST",
      body: demoBytes,
    });
    assert.equal(queryTokenRejected.status, 400);
    const cookieRejected = await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/import`, {
      method: "POST",
      headers: {
        authorization: importCapability.authorization,
        cookie: "any_cookie=forbidden",
        "content-type": "application/octet-stream",
        [VIEWER_LIBRARY_IMPORT_ID_HEADER]: "import_test",
      },
      body: demoBytes,
    });
    assert.equal(cookieRejected.status, 400);
    const imported = await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/import`, {
      method: "POST",
      headers: {
        authorization: importCapability.authorization,
        "content-type": "application/octet-stream",
        [VIEWER_LIBRARY_IMPORT_ID_HEADER]: "import_test",
      },
      body: demoBytes,
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.headers.get("cache-control"), "no-store");
    assert.equal(imported.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(imported.headers.get("x-content-type-options"), "nosniff");
    const importResult = await imported.json() as Record<string, unknown>;
    assert.deepEqual({ ...importResult, demoId: "<opaque>" }, {
      schemaVersion: "desktop-library-import.v1",
      demoId: "<opaque>",
      contentHash: expectedHash,
      originalFilename: "match.dem",
      byteSize: demoBytes.byteLength,
      deduplicated: false,
      validationToken: importResult.validationToken,
    });
    assert.match(String(importResult.demoId), /^[A-Za-z0-9_-]{1,160}$/u);
    assert.match(String(importResult.validationToken), /^[A-Za-z0-9_-]{43}$/u);
    const reusedImportCapability = await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/import`, {
      method: "POST",
      headers: {
        authorization: importCapability.authorization,
        "content-type": "application/octet-stream",
        [VIEWER_LIBRARY_IMPORT_ID_HEADER]: "import_test",
      },
      body: demoBytes,
    });
    assert.equal([403, 409].includes(reusedImportCapability.status), true);

    const demoId = String(importResult.demoId);
    const finalized = await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/import/finalize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(importResult.validationToken)}`,
        "x-cs-agent-demo-id": demoId,
        "x-cs-agent-parse-outcome": "READY",
      },
    });
    assert.equal(finalized.status, 200);
    assert.deepEqual(await finalized.json(), {
      schemaVersion: "desktop-library-validation.v1",
      demoId,
      status: "READY",
    });
    const readCapability = library.issueViewerCapability({ demoId });
    assert.equal((await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/demo/demo_unregistered`, {
      headers: { authorization: readCapability.authorization },
    })).status, 403);
    assert.equal((await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/demo/${demoId}?token=forbidden`)).status, 400);
    const readWithCookie = await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/demo/${demoId}`, {
      headers: { authorization: readCapability.authorization, cookie: "any_cookie=forbidden" },
    });
    assert.equal(readWithCookie.status, 400);
    const read = await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/demo/${demoId}`, {
      headers: { authorization: readCapability.authorization },
    });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("content-type"), "application/octet-stream");
    assert.equal(read.headers.get("content-length"), String(demoBytes.byteLength));
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.equal(read.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), demoBytes);
    assert.equal([403, 409].includes((await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/demo/${demoId}`, {
      headers: { authorization: readCapability.authorization },
    })).status), true);
    assert.equal((await requestRaw(runtime.ready.viewerOrigin, "/_desktop/library/demo/%2e%2e%2fsecret")).status, 400);
    assert.equal((await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/demo/${demoId}`, { method: "POST" })).status, 405);

    const firstReview = await library.createReview({
      demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "Player A",
      title: "First local review",
      mapName: "Mirage",
      scoreText: "13:9",
    });
    const entries = await fetch(`${runtime.ready.appOrigin}${ADMIN_LIBRARY_ENTRIES_PATH}`, {
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(entries.status, 200);
    const entriesBody = await entries.json() as {
      schemaVersion: string;
      reviews: Array<Record<string, unknown>>;
      demos: Array<Record<string, unknown>>;
    };
    const reviewEntry = entriesBody.reviews[0];
    const demoEntry = entriesBody.demos[0];
    assert.deepEqual(Object.keys(entriesBody).sort(), ["demos", "reviews", "schemaVersion"]);
    assert.equal(entriesBody.schemaVersion, "review-library-entries.v1");
    assert.deepEqual(reviewEntry, {
      reviewId: firstReview.reviewId,
      demoId,
      originalFilename: "match.dem",
      selectedPlayerId: "player-a",
      selectedPlayerName: "Player A",
      title: "First local review",
      mapName: "Mirage",
      scoreText: "13:9",
      status: "PREPARING",
      completedCueCount: 0,
      totalCueCount: 0,
      createdAt: firstReview.createdAt,
      lastOpenedAt: firstReview.lastOpenedAt,
      demoStatus: "READY",
    });
    assert.deepEqual(
      Object.fromEntries(Object.entries(demoEntry).filter(([key]) => key !== "importedAt" && key !== "lastOpenedAt")),
      {
        demoId,
        originalFilename: "match.dem",
        byteSize: demoBytes.byteLength,
        status: "READY",
        reviewCount: 1,
      },
    );
    assert.match(String(demoEntry.importedAt), /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(String(demoEntry.lastOpenedAt), /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal("relativePath" in demoEntry, false);
    assert.equal("contentHash" in demoEntry, false);
    const impact = await fetch(`${runtime.ready.appOrigin}/_desktop/library/demos/${demoId}/impact`, {
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(impact.status, 200);
    const impactBody = await impact.json() as {
      impactToken: string;
      affectedReviewCount: number;
      affectedReviews: Array<{ reviewId: string }>;
    };
    assert.equal(impactBody.affectedReviewCount, 1);
    assert.deepEqual(impactBody.affectedReviews.map((item) => item.reviewId), [firstReview.reviewId]);
    assert.match(impactBody.impactToken, /^[0-9a-f]{64}$/u);
    const deleteWithoutImpact = await fetch(`${runtime.ready.appOrigin}/_desktop/library/demos/${demoId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(deleteWithoutImpact.status, 400);
    const reviewDeleted = await fetch(`${runtime.ready.appOrigin}/_desktop/library/reviews/${firstReview.reviewId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(reviewDeleted.status, 200);
    assert.deepEqual(await reviewDeleted.json(), {
      deleted: true,
      targetId: firstReview.reviewId,
      removedReviewCount: 1,
      removedDemo: false,
    });
    const secondReview = await library.createReview({
      demoId,
      selectedPlayerId: "player-b",
      selectedPlayerName: "Player B",
      title: "Second local review",
    });
    const currentImpact = await library.previewDemoDeletion(demoId);
    const thirdReview = await library.createReview({
      demoId,
      selectedPlayerId: "player-c",
      selectedPlayerName: "Player C",
      title: "Third local review",
    });
    const staleDelete = await fetch(`${runtime.ready.appOrigin}/_desktop/library/demos/${demoId}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${runtime.ready.adminToken}`,
        [ADMIN_LIBRARY_IMPACT_TOKEN_HEADER]: currentImpact.impactToken,
      },
    });
    assert.equal(staleDelete.status, 409);
    assert.deepEqual(await staleDelete.json(), { code: "DELETION_IMPACT_CHANGED" });
    const freshImpact = await library.previewDemoDeletion(demoId);
    assert.deepEqual(
      new Set(freshImpact.affectedReviews.map((item) => item.reviewId)),
      new Set([secondReview.reviewId, thirdReview.reviewId]),
    );
    const demoDeleted = await fetch(`${runtime.ready.appOrigin}/_desktop/library/demos/${demoId}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${runtime.ready.adminToken}`,
        [ADMIN_LIBRARY_IMPACT_TOKEN_HEADER]: freshImpact.impactToken,
      },
    });
    assert.equal(demoDeleted.status, 200);
    assert.deepEqual(await demoDeleted.json(), {
      deleted: true,
      targetId: demoId,
      removedReviewCount: 2,
      removedDemo: true,
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

test("backup drains in-flight Viewer imports and library deletes before touching SQLite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-runtime-quiescence-"));
  const viewerRoot = path.join(root, "viewer");
  await mkdir(viewerRoot, { recursive: true });
  await writeFile(path.join(viewerRoot, "index.html"), "viewer");
  const init: DesktopRuntimeInit = {
    schemaVersion: "desktop-runtime-init.v1",
    appVersion: "0.1.0",
    buildSha: "quiescence",
    targetTriple: "aarch64-apple-darwin",
    dataDir: path.join(root, "data"),
    cacheDir: path.join(root, "cache"),
    logDir: path.join(root, "log"),
    runtimeRoot: path.join(root, "runtime"),
    viewerRoot,
    provider: { kind: "NONE", apiKey: null, baseUrl: null, model: null },
  };
  let backupCalls = 0;
  const runtime = await startDesktopRuntime(init, {
    checkpointProbe: async () => true,
    prepareNextHandler: async () => ({ handler: (_req, res) => res.end("ok") }),
    createUpdateBackup: async () => {
      backupCalls += 1;
      throw new Error("intentional test rollback to READY");
    },
  });

  try {
    const library = currentDesktopReviewLibrary();
    assert.ok(library);
    const value = Buffer.concat([Buffer.from("PBDEMS2\0"), Buffer.alloc(128, 4)]);
    const capability = library.issueImportCapability({
      objectId: "quiescent_import",
      originalFilename: "quiescent.dem",
      expectedByteLength: value.byteLength,
    });
    let signalImportStarted!: () => void;
    let releaseImport!: () => void;
    const importStarted = new Promise<void>((resolve) => { signalImportStarted = resolve; });
    const importRelease = new Promise<void>((resolve) => { releaseImport = resolve; });
    async function* slowDemoBody() {
      yield value.subarray(0, 16);
      signalImportStarted();
      await importRelease;
      yield value.subarray(16);
    }
    const importRequest = fetch(`${runtime.ready.viewerOrigin}/_desktop/library/import`, {
      method: "POST",
      headers: {
        authorization: capability.authorization,
        "content-type": "application/octet-stream",
        "content-length": String(value.byteLength),
        [VIEWER_LIBRARY_IMPORT_ID_HEADER]: "quiescent_import",
      },
      body: Readable.from(slowDemoBody()),
      duplex: "half",
    } as unknown as RequestInit);
    await importStarted;
    const importBackup = fetch(`${runtime.ready.appOrigin}${ADMIN_BACKUP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(backupCalls, 0);
    const rejectedDuringImport = await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/import`);
    assert.equal(rejectedDuringImport.status, 503);
    assert.deepEqual(await rejectedDuringImport.json(), { code: "RUNTIME_DRAINING" });
    releaseImport();
    const imported = await importRequest;
    assert.equal(imported.status, 201);
    const importedBody = await imported.json() as { demoId: string; validationToken: string };
    assert.equal((await importBackup).status, 503);
    assert.equal(backupCalls, 1);
    assert.equal(runtime.health(), "READY");

    const finalized = await fetch(`${runtime.ready.viewerOrigin}/_desktop/library/import/finalize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${importedBody.validationToken}`,
        "x-cs-agent-demo-id": importedBody.demoId,
        "x-cs-agent-parse-outcome": "READY",
      },
    });
    assert.equal(finalized.status, 200);
    const review = await library.createReview({
      demoId: importedBody.demoId,
      selectedPlayerId: "player-quiescence",
      selectedPlayerName: "Player Quiescence",
      title: "Quiescence delete",
    });
    const mutableLibrary = library as unknown as {
      deleteReview: typeof library.deleteReview;
    };
    const originalDeleteReview = library.deleteReview.bind(library);
    let signalDeleteStarted!: () => void;
    let releaseDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { signalDeleteStarted = resolve; });
    const deleteRelease = new Promise<void>((resolve) => { releaseDelete = resolve; });
    mutableLibrary.deleteReview = async (reviewId) => {
      signalDeleteStarted();
      await deleteRelease;
      return originalDeleteReview(reviewId);
    };
    const deleteRequest = fetch(`${runtime.ready.appOrigin}/_desktop/library/reviews/${review.reviewId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    await deleteStarted;
    const deleteBackup = fetch(`${runtime.ready.appOrigin}${ADMIN_BACKUP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(backupCalls, 1);
    const rejectedDuringDelete = await fetch(`${runtime.ready.appOrigin}${ADMIN_LIBRARY_VERIFY_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.ready.adminToken}` },
    });
    assert.equal(rejectedDuringDelete.status, 503);
    assert.deepEqual(await rejectedDuringDelete.json(), { code: "RUNTIME_DRAINING" });
    releaseDelete();
    assert.equal((await deleteRequest).status, 200);
    assert.equal((await deleteBackup).status, 503);
    assert.equal(backupCalls, 2);
    assert.equal(runtime.health(), "READY");
    mutableLibrary.deleteReview = originalDeleteReview;
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

test("activity does not retire merely because response.end was called before finish", () => {
  const response = new EventEmitter() as EventEmitter & {
    writableEnded: boolean;
    writableFinished: boolean;
    destroyed: boolean;
  };
  response.writableEnded = true;
  response.writableFinished = false;
  response.destroyed = false;
  const tracker = new RuntimeActivityTracker();
  const finishHandler = tracker.begin(response as never);

  finishHandler();
  assert.equal(tracker.activeRequests, 1);
  response.writableFinished = true;
  response.emit("finish");
  assert.equal(tracker.activeRequests, 0);
});

test("constant-time comparison has fixed-length inputs and rejects altered tokens", () => {
  const token = "a".repeat(43);
  assert.equal(constantTimeTokenEqual(token, token), true);
  assert.equal(constantTimeTokenEqual("b", token), false);
  assert.equal(constantTimeTokenEqual(`${token.slice(0, 42)}b`, token), false);
});
