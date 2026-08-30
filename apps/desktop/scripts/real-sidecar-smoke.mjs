import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const READY_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const EXPORT_MAX_BYTES = 2 * 1024 * 1024;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const appPath = join(repoRoot, "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/CS Agent Coach.app");
const preparedMode = process.argv.includes("--prepared");
const webkitMode = process.argv.includes("--webkit");
const webkitDemoMode = process.argv.includes("--webkit-demo");
const contents = preparedMode ? join(repoRoot, "apps/desktop/src-tauri") : join(appPath, "Contents");
const binary = preparedMode
  ? join(contents, "binaries", "cs-agent-runtime-aarch64-apple-darwin")
  : join(contents, "MacOS", "cs-agent-runtime");
const resourceBase = preparedMode ? contents : join(contents, "Resources");
const runtimeRoot = join(resourceBase, "resources", "runtime-root");
const viewerRoot = join(resourceBase, "resources", "viewer-root");
const temporaryRoot = await mkdtemp(join(tmpdir(), "cs-agent-real-sidecar-"));
const dataDir = join(temporaryRoot, "data");
const cacheDir = join(temporaryRoot, "cache");
const logDir = join(temporaryRoot, "log");
await Promise.all([dataDir, cacheDir, logDir].map((path) => mkdir(path, { mode: 0o700 })));

const permissionArguments = [runtimeRoot, viewerRoot, dataDir, cacheDir, logDir]
  .map((path) => `--allow-fs-read=${path}`)
  .concat([dataDir, cacheDir, logDir].map((path) => `--allow-fs-write=${path}`));
if (permissionArguments.some((argument) => argument.includes("*"))) {
  throw new Error("wildcard filesystem permission is forbidden");
}

let active;

function timeoutAfter(milliseconds, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
  });
}

async function startSidecar(stage) {
  if (active) throw new Error("sidecar controller attempted concurrent startup");
  const child = spawn(binary, [
    "--permission",
    ...permissionArguments,
    "--jitless",
    join(runtimeRoot, "runtime.cjs"),
  ], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  active = { child, exited, stage, stderr: "" };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (active?.child === child) active.stderr = `${active.stderr}${chunk}`.slice(-2_000);
  });
  child.stdin.end(`${JSON.stringify({
    schemaVersion: "desktop-runtime-init.v1",
    appVersion: "0.1.0",
    buildSha: `smoke-${stage}`,
    targetTriple: "aarch64-apple-darwin",
    dataDir,
    cacheDir,
    logDir,
    runtimeRoot,
    viewerRoot,
    provider: { kind: "NONE", apiKey: null, baseUrl: null, model: null },
  })}\n`);

  const readyLine = new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(buffer.slice(0, newline));
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!buffer.includes("\n")) {
        reject(new Error(`${stage} sidecar exited code=${code} signal=${signal} stderr=${active?.stderr.trim() || "<empty>"}`));
      }
    });
  });
  const line = await Promise.race([readyLine, timeoutAfter(READY_TIMEOUT_MS, `${stage} protocol timeout`)]);
  const message = JSON.parse(line);
  if (message.schemaVersion !== "desktop-runtime-ready.v2"
    || message.protocolVersion !== "desktop-runtime-http.v2") {
    throw new Error(`${stage} readiness ${String(message.code ?? "UNKNOWN")}`);
  }
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d*$/u.test(message.appOrigin)
    || !/^http:\/\/localhost:[1-9]\d*$/u.test(message.viewerOrigin)
    || new URL(message.appOrigin).port === new URL(message.viewerOrigin).port) {
    throw new Error(`${stage} readiness origin pair invalid`);
  }
  if (message.sessionToken.length !== 43 || message.adminToken.length !== 43) {
    throw new Error(`${stage} readiness token length invalid`);
  }
  return { stage, child, exited, message };
}

function sessionHeaders(run, extra = {}) {
  return {
    cookie: `cs_agent_runtime=${run.message.sessionToken}`,
    origin: run.message.appOrigin,
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

async function sessionFetch(run, pathname, init = {}) {
  return fetch(`${run.message.appOrigin}${pathname}`, {
    ...init,
    headers: sessionHeaders(run, init.headers),
  });
}

async function boundedJson(response, label, maxBytes = 64 * 1024) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeded response bound`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function gracefulShutdown(run) {
  const shutdown = await fetch(`${run.message.appOrigin}/_desktop/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${run.message.adminToken}` },
  });
  if (shutdown.status !== 202) throw new Error(`${run.stage} shutdown returned ${shutdown.status}`);
  const result = await Promise.race([run.exited, timeoutAfter(SHUTDOWN_TIMEOUT_MS, `${run.stage} graceful shutdown timeout`)]);
  if (result.code !== 0 || result.signal !== null) throw new Error(`${run.stage} sidecar did not exit cleanly`);
  if (active?.child === run.child) active = undefined;
}

async function runWebKitSmoke(run) {
  const wasmName = (await readdir(join(viewerRoot, "assets")))
    .find((name) => /^demo_parser_bg-[A-Za-z0-9_-]+\.wasm$/u.test(name));
  if (!wasmName) throw new Error("WKWebView smoke parser WASM missing");
  const swiftPath = join(repoRoot, "apps/desktop/scripts/webkit-loopback-smoke.swift");
  const child = spawn("/usr/bin/xcrun", ["swift", swiftPath], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4 * 1024); });
  child.stdin.end(JSON.stringify({
    appOrigin: run.message.appOrigin,
    viewerOrigin: run.message.viewerOrigin,
    sessionToken: run.message.sessionToken,
    wasmPath: `/cs2d/assets/${wasmName}`,
    demoPath: webkitDemoMode ? join(repoRoot, "demoTests/test_demo.dem") : null,
  }));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let result;
  try {
    result = await Promise.race([exited, timeoutAfter(60_000, "WKWebView smoke timeout")]);
  } catch (error) {
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
    throw error;
  }
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`WKWebView smoke failed: ${stderr.trim() || "UNKNOWN"}`);
  }
  const summary = JSON.parse(stdout);
  if (summary.ok !== true
    || summary.app?.origin !== run.message.appOrigin
    || summary.viewer?.origin !== run.message.viewerOrigin
    || summary.viewer?.workerOk !== true
    || summary.viewer?.crossOriginIsolated !== true
    || summary.viewer?.sharedArrayBuffer !== true) {
    throw new Error("WKWebView smoke returned an invalid summary");
  }
  if (webkitDemoMode
    && (summary.demo?.parsed !== true
      || typeof summary.demo?.selectedPlayer !== "string"
      || summary.demo.selectedPlayer.length === 0
      || !(summary.demo?.canvasCount > 0))) {
    throw new Error("WKWebView Demo smoke returned an invalid summary");
  }
  process.stdout.write("PASS WKWebView IPv4 localhost, cookie isolation, assets, Worker and WASM\n");
  if (webkitDemoMode) process.stdout.write("PASS WKWebView real Demo parse, player selection and Canvas stage\n");
}

async function stopActiveSidecar() {
  const running = active;
  if (!running) return;
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill("SIGTERM");
    const terminated = await Promise.race([
      running.exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!terminated && running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill("SIGKILL");
      await Promise.race([running.exited, timeoutAfter(2_000, "sidecar kill timeout")]).catch(() => undefined);
    }
  }
  active = undefined;
}

function assertPublicExport(value, raw) {
  if (value?.schemaVersion !== "memory-export.v1" || !Array.isArray(value.records) || !Array.isArray(value.events)) {
    throw new Error("memory export schema invalid");
  }
  const forbiddenKeys = new Set(["userId", "idempotencyKey", "producerVersion", "eventJson", "payload", "payloadRef", "internal"]);
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (forbiddenKeys.has(key)) throw new Error(`memory export leaked ${key}`);
      stack.push(child);
    }
  }
  if (/"userId"|"idempotencyKey"|"eventJson"|"payloadRef"/u.test(raw)) {
    throw new Error("memory export leaked internal payload text");
  }
}

try {
  const first = await startSidecar("first");
  const cookie = `cs_agent_runtime=${first.message.sessionToken}`;
  const desktop = await fetch(`${first.message.appOrigin}/desktop`, { headers: { cookie } });
  if (desktop.status !== 200) throw new Error(`desktop smoke returned ${desktop.status}`);
  const csp = desktop.headers.get("content-security-policy") ?? "";
  if (!/script-src 'self' 'nonce-[A-Za-z0-9_-]+'/u.test(csp)) throw new Error("desktop CSP nonce missing");
  if (!csp.split(";").map((directive) => directive.trim()).includes(`frame-src ${first.message.viewerOrigin}`)
    || csp.split(";").map((directive) => directive.trim()).includes("frame-src http:")) {
    throw new Error("desktop CSP did not pin the exact viewer origin");
  }
  const desktopHtml = await desktop.text();
  const renderedDesktopHtml = desktopHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gu, "");
  if (!renderedDesktopHtml.includes("请选择本地 Demo")
    || renderedDesktopHtml.includes("正在连接本地回放")) {
    throw new Error("desktop SSR did not start in the ready-for-Demo state");
  }
  const responseNonce = /script-src 'self' 'nonce-([A-Za-z0-9_-]+)'/u.exec(csp)?.[1];
  const scriptTags = desktopHtml.match(/<script\b[^>]*>/gu) ?? [];
  if (!responseNonce || scriptTags.length === 0
    || scriptTags.some((tag) => !tag.includes(`nonce="${responseNonce}"`))) {
    throw new Error("desktop scripts were not bound to the response CSP nonce");
  }
  const iframeSource = /<iframe\b[^>]*\bsrc="([^"]+)"/u.exec(desktopHtml)?.[1]?.replaceAll("&amp;", "&");
  const iframeUrl = iframeSource ? new URL(iframeSource) : undefined;
  if (!iframeUrl
    || iframeUrl.origin !== first.message.viewerOrigin
    || iframeUrl.searchParams.get("host") !== "1"
    || iframeUrl.searchParams.get("parentOrigin") !== first.message.appOrigin) {
    throw new Error("desktop HTML did not bind the runtime-owned viewer origin");
  }
  const cssPaths = [...desktopHtml.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/gu)].map((match) => match[1]);
  const scriptPaths = [...desktopHtml.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/gu)].map((match) => match[1]);
  if (cssPaths.length === 0 || scriptPaths.length === 0) {
    throw new Error("desktop HTML did not reference production CSS and JavaScript");
  }
  for (const [label, assetPath, expectedType] of [
    ...cssPaths.map((assetPath) => ["CSS", assetPath, "text/css"]),
    ...scriptPaths.map((assetPath) => ["JavaScript", assetPath, "application/javascript"]),
  ]) {
    const asset = await sessionFetch(first, assetPath);
    if (asset.status !== 200) throw new Error(`desktop ${label} asset returned ${asset.status}`);
    if (!(asset.headers.get("content-type") ?? "").includes(expectedType)) {
      throw new Error(`desktop ${label} asset content type invalid`);
    }
    if ((await asset.arrayBuffer()).byteLength === 0) throw new Error(`desktop ${label} asset was empty`);
  }
  const viewer = await fetch(first.message.viewerOrigin);
  if (viewer.status !== 200) throw new Error(`viewer smoke returned ${viewer.status}`);
  const viewerHtml = await viewer.text();
  const forbiddenViewerCookie = await fetch(`${first.message.viewerOrigin}/cs2d/`, {
    headers: { cookie },
  });
  if (forbiddenViewerCookie.status !== 400
    || await forbiddenViewerCookie.text() !== "Session cookie forbidden") {
    throw new Error("viewer did not reject the App session cookie");
  }
  const viewerAssetPaths = [
    ...viewerHtml.matchAll(/(?:src|href)="(\/cs2d\/assets\/[^"]+)"/gu),
  ].map((match) => match[1]);
  if (viewerAssetPaths.length === 0) throw new Error("viewer HTML did not reference bundled assets");
  for (const assetPath of new Set(viewerAssetPaths)) {
    const asset = await fetch(`${first.message.viewerOrigin}${assetPath}`, { method: "HEAD" });
    if (asset.status !== 200 || Number(asset.headers.get("content-length") ?? 0) <= 0) {
      throw new Error(`viewer asset unavailable: ${assetPath}`);
    }
  }
  if (webkitMode || webkitDemoMode) await runWebKitSmoke(first);
  const blockedDemo = await sessionFetch(first, "/api/local-demo", { method: "POST", body: "must-not-reach-next" });
  if (blockedDemo.status !== 404) throw new Error("desktop raw Demo route was not blocked");
  const initialStatus = await sessionFetch(first, "/api/memory/status");
  if (initialStatus.status !== 200) throw new Error(`initial memory status returned ${initialStatus.status}`);
  const initialMemory = await boundedJson(initialStatus, "initial memory status");
  if (initialMemory.storage !== "SQLITE" || initialMemory.durable !== true) throw new Error("desktop memory is not durable SQLite");
  const consent = await sessionFetch(first, "/api/memory/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  const consentBody = await boundedJson(consent, "memory consent");
  if (consent.status !== 200) {
    throw new Error(`memory consent returned ${consent.status}:${String(consentBody.reason ?? consentBody.error ?? "UNKNOWN")}`);
  }
  if (consentBody.accepted !== true || consentBody.enabled !== true || consentBody.consent !== "GRANTED" || consentBody.storage !== "SQLITE") {
    throw new Error("memory consent was not durably granted");
  }
  const exported = await sessionFetch(first, "/api/memory/export");
  if (exported.status !== 200) throw new Error(`memory export returned ${exported.status}`);
  const exportBytes = new Uint8Array(await exported.arrayBuffer());
  if (exportBytes.byteLength === 0 || exportBytes.byteLength > EXPORT_MAX_BYTES) throw new Error("memory export violated the 2 MiB response bound");
  const exportText = new TextDecoder().decode(exportBytes);
  assertPublicExport(JSON.parse(exportText), exportText);
  const backup = await fetch(`${first.message.appOrigin}/_desktop/backup`, {
    method: "POST",
    headers: { authorization: `Bearer ${first.message.adminToken}` },
  });
  if (backup.status !== 201) throw new Error(`backup smoke returned ${backup.status}`);
  const backupSummary = await boundedJson(backup, "backup");
  if (backupSummary.schemaVersion !== "desktop-runtime-backup.v1") throw new Error("backup smoke returned an invalid schema");
  await gracefulShutdown(first);

  const second = await startSidecar("second");
  const persistedStatus = await sessionFetch(second, "/api/memory/status");
  if (persistedStatus.status !== 200) throw new Error(`persisted memory status returned ${persistedStatus.status}`);
  const persisted = await boundedJson(persistedStatus, "persisted memory status");
  if (persisted.storage !== "SQLITE" || persisted.durable !== true || persisted.enabled !== true
    || persisted.consent !== "GRANTED" || !Number.isInteger(persisted.consentVersion)) {
    throw new Error("SQLite consent did not survive the sidecar restart");
  }
  const deleted = await sessionFetch(second, "/api/memory", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (deleted.status !== 200) throw new Error(`memory delete-all returned ${deleted.status}`);
  const deleteBody = await boundedJson(deleted, "memory delete-all");
  if (deleteBody.accepted !== true || !Number.isInteger(deleteBody.deleted) || typeof deleteBody.limited !== "boolean") {
    throw new Error("memory delete-all did not return a successful bounded summary");
  }
  await gracefulShutdown(second);
  process.stdout.write("PASS real sidecar two-start SQLite persistence, memory export/delete, UI/viewer/backup, route gate and graceful shutdown\n");
} finally {
  await stopActiveSidecar();
  await rm(temporaryRoot, { recursive: true, force: true });
}
