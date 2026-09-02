import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const READY_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const EXPORT_MAX_BYTES = 2 * 1024 * 1024;
const MANAGED_DEMO_BYTES = Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(64, 0x2a)]);
const MANAGED_DEMO_HASH = createHash("sha256").update(MANAGED_DEMO_BYTES).digest("hex");
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const realDemoPath = join(repoRoot, "demoTests/test_demo.dem");
const realDemoHash = "84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2";
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
const appPath = join(repoRoot, "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/CS Agent Coach.app");
const preparedMode = process.argv.includes("--prepared");
const webkitMode = process.argv.includes("--webkit");
const webkitDemoMode = process.argv.includes("--webkit-demo");
const snapshotFlagIndex = process.argv.indexOf("--snapshot");
const snapshotPath = snapshotFlagIndex >= 0 ? process.argv[snapshotFlagIndex + 1] : undefined;
const snapshotRoot = join(repoRoot, ".local-data", "ui-qa");
if (snapshotFlagIndex >= 0 && (
  !snapshotPath
  || !isAbsolute(snapshotPath)
  || dirname(snapshotPath) !== snapshotRoot
  || extname(snapshotPath).toLowerCase() !== ".png"
)) {
  throw new Error(`--snapshot requires an absolute .png directly inside ${snapshotRoot}`);
}
const contents = preparedMode ? join(repoRoot, "apps/desktop/src-tauri") : join(appPath, "Contents");
const binary = preparedMode
  ? join(contents, "binaries", "cs-agent-runtime-aarch64-apple-darwin")
  : join(contents, "MacOS", "cs-agent-runtime");
const resourceBase = preparedMode ? contents : join(contents, "Resources");
const runtimeRoot = join(resourceBase, "resources", "runtime-root");
const viewerRoot = join(resourceBase, "resources", "viewer-root");
const temporaryRoot = await mkdtemp(join(tmpdir(), "cs-agent-real-sidecar-"));
const historyCoordinationPath = join(temporaryRoot, "history-seed.status");
const dataDir = join(temporaryRoot, "data");
const cacheDir = join(temporaryRoot, "cache");
const logDir = join(temporaryRoot, "log");
await Promise.all([dataDir, cacheDir, logDir].map((path) => mkdir(path, { mode: 0o700 })));
if (snapshotPath) await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });

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

async function importManagedFixture(
  run,
  requestId,
  originalFilename = "permission-model-smoke.dem",
  expectedStoredFilename = originalFilename,
) {
  const capability = await sessionFetch(run, "/api/review-history/import-capability", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId,
      originalFilename,
      byteSize: MANAGED_DEMO_BYTES.byteLength,
    }),
  });
  if (capability.status !== 200) {
    throw new Error(`managed Demo capability returned ${capability.status}`);
  }
  const capabilityBody = await boundedJson(capability, "managed Demo capability");
  if (capabilityBody.requestId !== requestId
    || typeof capabilityBody.capabilityToken !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(capabilityBody.capabilityToken)) {
    throw new Error("managed Demo capability schema invalid");
  }
  const imported = await fetch(`${run.message.viewerOrigin}/_desktop/library/import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${capabilityBody.capabilityToken}`,
      "content-type": "application/octet-stream",
      "x-cs-agent-import-id": requestId,
    },
    body: MANAGED_DEMO_BYTES,
  });
  if (imported.status !== 201) {
    const rejected = await imported.text();
    throw new Error(`managed Demo import returned ${imported.status}:${rejected.slice(0, 120)}`);
  }
  const result = await boundedJson(imported, "managed Demo import");
  if (result.schemaVersion !== "desktop-library-import.v1"
    || result.originalFilename !== expectedStoredFilename
    || result.byteSize !== MANAGED_DEMO_BYTES.byteLength
    || result.contentHash !== MANAGED_DEMO_HASH
    || typeof result.demoId !== "string") {
    throw new Error("managed Demo import schema invalid");
  }
  if (result.validationToken !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(result.validationToken)) {
      throw new Error("managed Demo validation token invalid");
    }
    const finalized = await fetch(`${run.message.viewerOrigin}/_desktop/library/import/finalize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${result.validationToken}`,
        "x-cs-agent-demo-id": result.demoId,
        "x-cs-agent-parse-outcome": "READY",
      },
    });
    const finalizedBody = await boundedJson(finalized, "managed Demo validation");
    if (finalized.status !== 200 || finalizedBody.demoId !== result.demoId || finalizedBody.status !== "READY") {
      throw new Error("managed Demo validation failed");
    }
  }
  return result;
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

async function seedReviewHistoryFixture(run) {
  const scriptPath = join(repoRoot, "apps/web/scripts/seed-review-history-smoke.ts");
  const child = spawn(process.execPath, [tsxCli, scriptPath], {
    cwd: repoRoot,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8 * 1024); });
  child.stdin.end(JSON.stringify({
    appOrigin: run.message.appOrigin,
    sessionToken: run.message.sessionToken,
    demoContentHash: realDemoHash,
  }));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let result;
  try {
    result = await Promise.race([
      exited,
      timeoutAfter(30_000, "history fixture seed timeout"),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
    throw error;
  }
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`history fixture seed failed: ${stderr.trim() || "UNKNOWN"}`);
  }
  const summary = JSON.parse(stdout);
  if (summary.ok !== true
    || typeof summary.reviewId !== "string"
    || typeof summary.revisionId !== "string"
    || !(summary.cueCount > 0)) {
    throw new Error("history fixture seed summary invalid");
  }
  return summary;
}

async function runWebKitSmoke(run) {
  if (webkitDemoMode) {
    const observedHash = execFileSync("/usr/bin/shasum", ["-a", "256", realDemoPath], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    }).trim().split(/\s+/u)[0];
    if (observedHash !== realDemoHash) throw new Error("real Demo fixture hash changed");
  }
  const wasmName = (await readdir(join(viewerRoot, "assets")))
    .find((name) => /^demo_parser_bg-[A-Za-z0-9_-]+\.wasm$/u.test(name));
  if (!wasmName) throw new Error("WKWebView smoke parser WASM missing");
  const swiftPath = join(repoRoot, "apps/desktop/scripts/webkit-loopback-smoke.swift");
  const child = spawn("/usr/bin/xcrun", ["swift", swiftPath], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const sidecarRssKiB = () => {
    try {
      const value = execFileSync("/bin/ps", ["-o", "rss=", "-p", String(run.child.pid)], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      }).trim();
      return Number(value) || 0;
    } catch {
      return 0;
    }
  };
  let importBaselineSidecarRssKiB;
  let importPeakSidecarRssKiB;
  let importWindowOpen = false;
  let importWindowClosed = false;
  let historySeedPromise;
  let historySeedFailure;
  let historySeedSummary;
  const sampleImportRss = () => {
    if (!importWindowOpen || importWindowClosed) return;
    importPeakSidecarRssKiB = Math.max(importPeakSidecarRssKiB ?? 0, sidecarRssKiB());
  };
  const rssSampler = webkitDemoMode ? setInterval(sampleImportRss, 20) : undefined;
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
  let stderrLines = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4 * 1024);
    stderrLines += chunk;
    for (;;) {
      const newline = stderrLines.indexOf("\n");
      if (newline < 0) break;
      const line = stderrLines.slice(0, newline);
      stderrLines = stderrLines.slice(newline + 1);
      if (line.startsWith("webkit:trace ")) {
        process.stdout.write(`TRACE ${line.slice("webkit:trace ".length)}\n`);
      }
      if (line === "webkit:trace MANAGED_IMPORT_TRANSPORT_START") {
        importBaselineSidecarRssKiB = sidecarRssKiB();
        importPeakSidecarRssKiB = importBaselineSidecarRssKiB;
        importWindowOpen = true;
        importWindowClosed = false;
      } else if (line === "webkit:trace MANAGED_IMPORT_TRANSPORT_END") {
        sampleImportRss();
        importWindowClosed = true;
      } else if (line === "webkit:trace MANAGED_REVIEW_ROW") {
        if (webkitDemoMode && !historySeedPromise) {
          historySeedPromise = seedReviewHistoryFixture(run)
            .then(async (summary) => {
              historySeedSummary = summary;
              await writeFile(historyCoordinationPath, "READY", { mode: 0o600 });
            })
            .catch(async (error) => {
              historySeedFailure = error;
              const code = (error instanceof Error ? error.message : "SEED_FAILED")
                .replace(/[^A-Za-z0-9:._-]/gu, "_")
                .slice(0, 160);
              await writeFile(historyCoordinationPath, `ERROR:${code}`, { mode: 0o600 });
            });
        }
      }
    }
  });
  child.stdin.end(JSON.stringify({
    appOrigin: run.message.appOrigin,
    viewerOrigin: run.message.viewerOrigin,
    sessionToken: run.message.sessionToken,
    wasmPath: `/cs2d/assets/${wasmName}`,
    demoPath: webkitDemoMode ? realDemoPath : null,
    snapshotPath: snapshotPath ?? null,
    coordinationPath: webkitDemoMode ? historyCoordinationPath : null,
  }));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let result;
  try {
    result = await Promise.race([
      exited,
      timeoutAfter(webkitDemoMode ? 215_000 : 60_000, "WKWebView smoke timeout"),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
    throw error;
  } finally {
    if (rssSampler) clearInterval(rssSampler);
    sampleImportRss();
  }
  if (historySeedPromise) await historySeedPromise;
  if (historySeedFailure) throw historySeedFailure;
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`WKWebView smoke failed: ${stderr.trim() || "UNKNOWN"}`);
  }
  if (!stdout.trim()) {
    throw new Error(`WKWebView smoke produced no summary: ${stderr.trim() || "UNKNOWN"}`);
  }
  let summary;
  try {
    summary = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`WKWebView smoke summary invalid: ${error instanceof Error ? error.message : "UNKNOWN"}; stderr=${stderr.trim() || "<empty>"}`);
  }
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
      || !(summary.demo?.canvasCount > 0)
      || summary.demo?.managedImport !== true
      || summary.demo?.reviewPersisted !== true
      || summary.demo?.seededHistoryFixture !== true
      || summary.history?.restored !== true
      || summary.history?.providerCallCount !== 0
      || summary.history?.providerResourceCount !== 0
      || summary.history?.positionVisible !== true
      || historySeedSummary?.ok !== true)) {
    throw new Error("WKWebView Demo smoke returned an invalid summary");
  }
  process.stdout.write("PASS WKWebView IPv4 localhost, cookie isolation, assets, Worker and WASM\n");
  process.stdout.write(`PASS runtime identity binary=${binary} pid=${run.child.pid} target=${run.message.targetTriple} node=${run.message.nodeVersion} build=smoke-${run.stage}\n`);
  if (snapshotPath) process.stdout.write(`PASS WKWebView app snapshot ${snapshotPath}\n`);
  if (webkitDemoMode) {
    process.stdout.write("PASS production /desktop managed Demo import, real parser, player selection, Review persistence and Canvas stage\n");
    process.stdout.write(`PASS validator-backed deterministic history fixture review=${historySeedSummary.reviewId} revision=${historySeedSummary.revisionId} cues=${historySeedSummary.cueCount}\n`);
    process.stdout.write(`PASS production history click restored ${summary.history.progress}; generation-provider fetch/resource calls=0; observed API calls=${JSON.stringify(summary.history.allApiFetch)}; audit=${summary.history.auditSource}\n`);
  }
  if (webkitDemoMode) {
    const demoByteSize = (await stat(realDemoPath)).size;
    if (!importWindowOpen || !importWindowClosed
      || !Number.isInteger(importBaselineSidecarRssKiB)
      || !Number.isInteger(importPeakSidecarRssKiB)) {
      throw new Error("managed Demo import RSS window was not observed");
    }
    const rssDeltaBytes = Math.max(0, importPeakSidecarRssKiB - importBaselineSidecarRssKiB) * 1024;
    if (rssDeltaBytes >= demoByteSize) {
      throw new Error(`managed Demo import RSS delta ${rssDeltaBytes} exceeded streaming bound ${demoByteSize}`);
    }
    process.stdout.write(`PASS managed Demo import sidecar RSS delta ${rssDeltaBytes} bytes < ${demoByteSize}-byte file (XHR send→sidecar publish response)\n`);
  }
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
  const firstManagedImport = await importManagedFixture(first, "managed_import_first");
  if (firstManagedImport.deduplicated !== false) throw new Error("first managed Demo import unexpectedly deduplicated");
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
  const secondManagedImport = await importManagedFixture(
    second,
    "managed_import_second",
    "同内容不同文件名.dem",
    firstManagedImport.originalFilename,
  );
  if (secondManagedImport.demoId !== firstManagedImport.demoId
    || secondManagedImport.contentHash !== firstManagedImport.contentHash
    || secondManagedImport.deduplicated !== true) {
    throw new Error("managed Demo identity did not survive the sidecar restart");
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
  process.stdout.write("PASS real sidecar two-start SQLite persistence, managed Demo import/dedupe, memory export/delete, UI/viewer/backup, route gate and graceful shutdown\n");
} finally {
  await stopActiveSidecar();
  await rm(temporaryRoot, { recursive: true, force: true });
}
