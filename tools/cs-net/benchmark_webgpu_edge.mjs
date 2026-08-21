#!/usr/bin/env node

/**
 * Single-controller Falcons WebGPU acceptance runner.
 *
 * The controller owns localhost, Edge, the page, and the analysis Workers.
 * Parsed Replay stays in the cs2d iframe; Node receives only bounded summaries
 * and telemetry. There is no attach-to-existing-browser path here.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = process.cwd();
const upstream = resolve(root, process.env.CS2D_UPSTREAM_DIR ?? ".local-data/upstream/cs2d");
const demo = resolve(root, "demoTests/spirit-vs-falcons-m2-mirage.dem");
const testDemo = resolve(root, "demoTests/test_demo.dem");
const outputRoot = resolve(root, ".local-data/acceptance-csnet-webgpu-fp16/falcons-batch16-final");
const edgeExecutable = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const cdpPort = 9333;
const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
const workerUrl = "http://localhost:5174/src/viewer/analysis/csNetWinRate.worker.ts?worker_file&type=module";
const fp16Model = resolve(upstream, "apps/app/public/models/cs-net/win-rate.fp16.onnx");
const fp16Wasm = resolve(upstream, "apps/app/public/ort-wasm-simd-threaded.asyncify.wasm");
const controllerDeadline = Date.now() + 10 * 60 * 1000;

const result = {
  schema: "cs-net-webgpu-fp16-falcons-controller/2",
  startedAt: new Date().toISOString(),
  fixture: { path: demo, bytes: null },
  controller: {
    cdpEndpoint,
    cdpPort,
    edgeExecutable,
    edgeArgs: null,
    edgePid: null,
    profile: null,
    browserVersion: null,
    services: {
      web: "pnpm --filter @cs-coach/web start --hostname localhost --port 3000",
      cs2d: "pnpm --dir .local-data/upstream/cs2d --filter cs2-demo-viewer dev --host localhost --port 5174",
    },
  },
  stages: [],
  testDemoSmoke: null,
  falconsParse: null,
  falconsInference: null,
  status: "RUNNING",
  error: null,
  cleanup: null,
};

let browser;
let page;
let context;
let edgeChild;
let edgeProfile;
const services = [];

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function boundedAppend(current, chunk, limit = 80_000) {
  const next = current + String(chunk);
  return next.length > limit ? next.slice(-limit) : next;
}

function errorRecord(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT:${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function writeJson(name, value) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(resolve(outputRoot, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function portIsOpen(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = `HTTP_${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`SERVICE_NOT_READY:${url}:${lastError}`);
}

function spawnOwned(label, command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const owned = { label, command, args, child, stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { owned.stdout = boundedAppend(owned.stdout, chunk); });
  child.stderr?.on("data", (chunk) => { owned.stderr = boundedAppend(owned.stderr, chunk); });
  services.push(owned);
  return owned;
}

async function stopOwned(owned) {
  if (!owned?.child || owned.child.exitCode !== null) return;
  try { owned.child.kill("SIGTERM"); } catch {}
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 4_000);
    owned.child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
  });
  if (owned.child.exitCode === null) {
    try { owned.child.kill("SIGKILL"); } catch {}
  }
}

async function launchServices() {
  const webEnv = { ...process.env, NEXT_PUBLIC_DEPLOY_TARGET: "localhost", NEXT_PUBLIC_CS2D_HOST_URL: "http://localhost:5174/?host=1" };
  const cs2d = spawnOwned("cs2d", "pnpm", ["--dir", upstream, "--filter", "cs2-demo-viewer", "dev", "--host", "localhost", "--port", "5174"]);
  const web = spawnOwned("web", "pnpm", ["--filter", "@cs-coach/web", "start", "--hostname", "localhost", "--port", "3000"], webEnv);
  await Promise.all([waitForHttp("http://localhost:5174/", 60_000), waitForHttp("http://localhost:3000/", 60_000)]).catch((error) => {
    error.serviceLogs = { cs2d: { stdout: cs2d.stdout, stderr: cs2d.stderr }, web: { stdout: web.stdout, stderr: web.stderr } };
    throw error;
  });
  return { web: { pid: web.child.pid, command: web.command, args: web.args }, cs2d: { pid: cs2d.child.pid, command: cs2d.command, args: cs2d.args } };
}

function cleanEdgeEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DYLD_/i.test(key) && !/(malloc|allocator)/i.test(key)));
}

async function launchEdge() {
  if (await portIsOpen(`${cdpEndpoint}/json/version`)) throw new Error(`CDP_PORT_ALREADY_IN_USE:${cdpPort}`);
  edgeProfile = await mkdtemp(resolve(tmpdir(), "cs-coach-edge-falcons-controller-"));
  const args = ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${edgeProfile}`, "--no-first-run", "--no-default-browser-check", "http://localhost:3000/"];
  result.controller.edgeArgs = args;
  result.controller.profile = edgeProfile;
  edgeChild = spawn(edgeExecutable, args, { cwd: root, env: cleanEdgeEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  edgeChild.stdout?.setEncoding("utf8");
  edgeChild.stderr?.setEncoding("utf8");
  edgeChild.stdout?.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk); });
  edgeChild.stderr?.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (edgeChild.exitCode !== null) throw new Error(`EDGE_EXITED:${edgeChild.exitCode}:stderr=${stderr}`);
    try {
      const response = await fetch(`${cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const version = await response.json();
        result.controller.browserVersion = version.Browser ?? null;
        result.controller.edgePid = edgeChild.pid;
        result.controller.devtools = { version, stdout, stderr };
        return;
      }
    } catch {}
    await sleep(250);
  }
  const error = new Error(`EDGE_CDP_TIMEOUT:stderr=${stderr}`);
  error.launchEvidence = { stdout, stderr, pid: edgeChild.pid, profile: edgeProfile, args };
  throw error;
}

async function addReplayCapture() {
  await context.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__csnetWebGpuNativeWorker = NativeWorker;
    window.__csnetWebGpuBench = { replay: null, capturedAt: null };
    window.Worker = function ReplayCaptureWorker(scriptUrl, options) {
      const worker = new NativeWorker(scriptUrl, options);
      if (!String(scriptUrl).includes("csNetWinRate.worker")) return worker;
      const originalPostMessage = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => {
        if (message?.replay?.rounds) {
          window.__csnetWebGpuBench.replay = message.replay;
          window.__csnetWebGpuBench.capturedAt = performance.now();
          return;
        }
        return originalPostMessage(message, transfer);
      };
      return worker;
    };
  });
}

async function waitForViewerFrame() {
  await page.waitForFunction(() => [...document.querySelectorAll("iframe")].some((element) => element.src.startsWith("http://localhost:5174")), null, { timeout: 45_000 });
  const frame = page.frames().find((candidate) => candidate.url().startsWith("http://localhost:5174"));
  if (!frame) throw new Error("CS2D_IFRAME_NOT_FOUND");
  return frame;
}

async function gpuDetails(target) {
  return target.evaluate(async () => {
    const gpu = navigator.gpu;
    const base = { crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined", navigatorGpu: Boolean(gpu), adapter: null, device: null, shaderF16: false, error: null };
    if (!gpu) return base;
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) return { ...base, error: "ADAPTER_UNAVAILABLE" };
      const features = [...adapter.features];
      const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
      let device = null;
      let deviceError = null;
      try { device = await adapter.requestDevice({ requiredFeatures: features.includes("shader-f16") ? ["shader-f16"] : [] }); } catch (error) { deviceError = String(error); }
      device?.destroy?.();
      return { ...base, adapter: { info, features }, device: device ? { features: [...device.features] } : null, shaderF16: features.includes("shader-f16"), error: deviceError };
    } catch (error) {
      return { ...base, error: String(error) };
    }
  });
}

async function workerGpuDetails(frame) {
  return frame.evaluate(() => new Promise((resolvePromise) => {
    const source = `self.onmessage=async()=>{try{const gpu=self.navigator&&self.navigator.gpu;if(!gpu){postMessage({navigatorGpu:false,error:'WORKER_NAVIGATOR_GPU_UNAVAILABLE'});return;}const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter){postMessage({navigatorGpu:true,adapter:false,error:'WORKER_ADAPTER_UNAVAILABLE'});return;}const features=[...adapter.features];const info=adapter.info??(adapter.requestAdapterInfo?await adapter.requestAdapterInfo():null);let device=null;let error=null;try{device=await adapter.requestDevice({requiredFeatures:features.includes('shader-f16')?['shader-f16']:[]});}catch(e){error=String(e);}device?.destroy?.();postMessage({navigatorGpu:true,adapter:true,device:Boolean(device),shaderF16:features.includes('shader-f16'),features,info,error});}catch(e){postMessage({navigatorGpu:true,error:String(e)});}}`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(url); resolvePromise({ navigatorGpu: false, error: "WORKER_GPU_PROBE_TIMEOUT" }); }, 15_000);
    worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolvePromise(event.data); };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolvePromise({ navigatorGpu: false, error: event.message || "WORKER_GPU_PROBE_ERROR" }); };
    worker.postMessage(null);
  }));
}

async function uploadDemo(frame, filePath) {
  await frame.locator('input[type="file"]').waitFor({ state: "attached", timeout: 30_000 });
  const session = await page.context().newCDPSession(page);
  const executionContexts = [];
  session.on("Runtime.executionContextCreated", ({ context: executionContext }) => executionContexts.push(executionContext));
  await session.send("Runtime.enable");
  await session.send("DOM.enable");
  await sleep(150);
  const frameOrigin = new URL(frame.url()).origin;
  const executionContext = executionContexts.find((candidate) => candidate.origin === frameOrigin && candidate.auxData?.type === "default");
  if (!executionContext) throw new Error(`CDP_UPLOAD_CONTEXT_NOT_FOUND:${frameOrigin}`);
  const evaluated = await session.send("Runtime.evaluate", { contextId: executionContext.id, expression: "document.querySelector('input[type=file]')", returnByValue: false });
  if (!evaluated.result.objectId) throw new Error("CDP_UPLOAD_INPUT_NOT_FOUND");
  await session.send("DOM.setFileInputFiles", { objectId: evaluated.result.objectId, files: [filePath] });
  await session.send("Runtime.releaseObject", { objectId: evaluated.result.objectId }).catch(() => {});
  await session.detach().catch(() => {});
}

async function waitForParse(frame) {
  await frame.getByText("解析完成", { exact: false }).waitFor({ state: "visible", timeout: 180_000 });
}

async function selectPlayer(frame, name) {
  await frame.locator("button:visible").filter({ hasText: name }).first().click({ timeout: 30_000 });
}

async function replaySummary(frame) {
  return frame.evaluate(() => {
    const replay = window.__csnetWebGpuBench?.replay;
    if (!replay) throw new Error("CAPTURED_REPLAY_UNAVAILABLE");
    let sampleCount = 0;
    let firstTick = null;
    let lastTick = null;
    let tickHash = 2166136261;
    for (const round of replay.rounds) for (const frame of round.frames) {
      sampleCount += 1;
      firstTick ??= frame.tick;
      lastTick = frame.tick;
      tickHash ^= frame.tick;
      tickHash = Math.imul(tickHash, 16777619) >>> 0;
    }
    return { players: replay.players.map((player) => ({ name: player.name, steamId: player.steamId })), playerCount: replay.players.length, roundCount: replay.rounds.length, sampleCount, firstTick, lastTick, tickHash: tickHash >>> 0 };
  });
}

async function memorySummary(frame) {
  const [pageMemory, frameMemory] = await Promise.all([
    page.evaluate(() => { const memory = performance.memory; return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : { available: false }; }).catch((error) => ({ error: String(error) })),
    frame.evaluate(() => { const memory = performance.memory; return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : { available: false }; }).catch((error) => ({ error: String(error) })),
  ]);
  return { page: pageMemory, iframe: frameMemory, worker: { available: false, reason: "Worker memory is not exposed by the browser API" } };
}

async function runWorker(frame, { sampleLimit = null, provider = "webgpu-fp16", batchSize = 16, repeats = 1, profile = false } = {}) {
  return frame.evaluate(async ({ workerUrl: sourceUrl, sampleLimit: limit, provider: requestedProvider, batchSize: requestedBatchSize, repeats: requestedRepeats, profile: requestedProfile }) => {
    const NativeWorker = window.__csnetWebGpuNativeWorker;
    const replay = window.__csnetWebGpuBench?.replay;
    if (!NativeWorker || !replay) throw new Error("BENCHMARK_WORKER_OR_REPLAY_UNAVAILABLE");
    let activeReplay = replay;
    if (limit !== null) {
      let remaining = limit;
      activeReplay = { ...replay, rounds: replay.rounds.map((round) => { const frames = remaining > 0 ? round.frames.slice(0, remaining) : []; remaining -= frames.length; return { ...round, frames }; }) };
    }
    const worker = new NativeWorker(sourceUrl, { type: "module" });
    let requestId = 7000;
    const rows = [];
    try {
      for (let repetition = 0; repetition < requestedRepeats; repetition += 1) {
        const currentRequestId = ++requestId;
        const started = performance.now();
        const row = await new Promise((resolvePromise, reject) => {
          const telemetry = [];
          const timer = setTimeout(() => { worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); reject(new Error(`WORKER_TIMEOUT:${requestedProvider}:batch${requestedBatchSize}`)); }, 240_000);
          const onError = (event) => { clearTimeout(timer); worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); reject(new Error(`WORKER_ERROR:${event.message || "unknown"}`)); };
          const onMessage = (event) => {
            const message = event.data;
            if (message.requestId !== currentRequestId) return;
            if (message.type === "telemetry") telemetry.push(message.telemetry);
            if (message.type === "error") { clearTimeout(timer); worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); reject(new Error(message.message)); return; }
            if (message.type !== "ready") return;
            clearTimeout(timer);
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            const samples = message.timeline.rounds.flatMap((round) => round.samples);
            let tickHash = 2166136261;
            for (const sample of samples) { tickHash ^= sample.tick; tickHash = Math.imul(tickHash, 16777619) >>> 0; }
            resolvePromise({ repetition, elapsedMs: performance.now() - started, telemetry, timelineSummary: { sampleCount: samples.length, roundCount: message.timeline.rounds.length, firstTick: samples[0]?.tick ?? null, lastTick: samples.at(-1)?.tick ?? null, tickHash: tickHash >>> 0 } });
          };
          worker.addEventListener("message", onMessage);
          worker.addEventListener("error", onError);
          worker.postMessage({ requestId: currentRequestId, replay: activeReplay, selectedPlayerId: activeReplay.players.find((player) => player.name === "NiKo")?.steamId ?? activeReplay.players[0]?.steamId, provider: requestedProvider, batchSize: requestedBatchSize, profile: requestedProfile });
        });
        rows.push(row);
      }
      return rows;
    } finally {
      worker.terminate();
    }
  }, { workerUrl, sampleLimit, provider, batchSize, repeats, profile });
}

function telemetrySummary(rows) {
  const telemetry = rows.flatMap((row) => row.telemetry ?? []);
  const last = telemetry.at(-1) ?? null;
  return { rows: rows.map((row) => ({ repetition: row.repetition, elapsedMs: row.elapsedMs, timelineSummary: row.timelineSummary, telemetry: row.telemetry })), lastTelemetry: last, providerActual: last?.providerActual ?? null, fallbackDetection: last?.fallbackDetection ?? null, ortWarningCount: last?.ortWarningCount ?? null };
}

function assertRealWebGpu(summary, stage) {
  if (summary.providerActual === "webgpu-fp16") return;
  const error = new Error(`${stage}_WEBGPU_RESULT_INVALID:${summary.providerActual ?? "missing"}`);
  error.details = summary;
  throw error;
}

async function runStage(name, timeoutMs, action) {
  const effectiveTimeout = Math.min(timeoutMs, Math.max(1_000, controllerDeadline - Date.now()));
  const started = Date.now();
  try {
    const value = await withTimeout(action(), effectiveTimeout, name);
    const record = { stage: name, status: "PASS", elapsedMs: Date.now() - started, ...value };
    result.stages.push(record);
    await writeJson(`stage-${name.toLowerCase()}.json`, record);
    return value;
  } catch (error) {
    const record = { stage: name, status: "FAIL", elapsedMs: Date.now() - started, error: errorRecord(error), details: error.details ?? null, serviceLogs: error.serviceLogs ?? null, launchEvidence: error.launchEvidence ?? null };
    result.stages.push(record);
    await writeJson(`stage-${name.toLowerCase()}.json`, record);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { stage: name });
  }
}

async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  if (edgeChild && edgeChild.exitCode === null) {
    try { edgeChild.kill("SIGTERM"); } catch {}
    await new Promise((resolvePromise) => { const timer = setTimeout(resolvePromise, 4_000); edgeChild.once("exit", () => { clearTimeout(timer); resolvePromise(); }); });
    if (edgeChild.exitCode === null) { try { edgeChild.kill("SIGKILL"); } catch {} }
  }
  for (const service of services.reverse()) await stopOwned(service);
  if (edgeProfile) await rm(edgeProfile, { recursive: true, force: true }).catch(() => {});
  result.cleanup = { edgePid: edgeChild?.pid ?? null, servicePids: services.map((service) => ({ label: service.label, pid: service.child.pid })), profileRemoved: edgeProfile ? true : null, portsAfter: { web: await portIsOpen("http://localhost:3000/"), cs2d: await portIsOpen("http://localhost:5174/"), cdp: await portIsOpen(`${cdpEndpoint}/json/version`) } };
}

async function main() {
  try {
    const [fixtureStat, modelStat, wasmStat] = await Promise.all([stat(demo), stat(fp16Model), stat(fp16Wasm)]);
    result.fixture.bytes = fixtureStat.size;
    await runStage("A", 90_000, async () => {
      if (await portIsOpen(`${cdpEndpoint}/json/version`)) throw new Error(`CDP_PORT_ALREADY_IN_USE:${cdpPort}`);
      const servicesInfo = await launchServices();
      return { files: { demo: { path: demo, bytes: fixtureStat.size }, fp16Model: { path: fp16Model, bytes: modelStat.size }, fp16Wasm: { path: fp16Wasm, bytes: wasmStat.size } }, ports: { cdp: "free", web: "ready", cs2d: "ready" }, services: servicesInfo };
    });

    await runStage("B", 90_000, async () => {
      await launchEdge();
      browser = await chromium.connectOverCDP(cdpEndpoint);
      context = browser.contexts()[0];
      if (!context) throw new Error("EDGE_DEFAULT_CONTEXT_MISSING");
      await context.setDefaultTimeout(30_000);
      await addReplayCapture();
      page = await context.newPage();
      await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      const frame = await waitForViewerFrame();
      const [mainGpu, iframeGpu, workerGpu] = await Promise.all([gpuDetails(page), gpuDetails(frame), workerGpuDetails(frame)]);
      if (!mainGpu.navigatorGpu || !iframeGpu.navigatorGpu || !workerGpu.navigatorGpu || !workerGpu.device || !iframeGpu.shaderF16) { const error = new Error("WEBGPU_CAPABILITY_GATE_FAILED"); error.details = { mainGpu, iframeGpu, workerGpu }; throw error; }
      return { edgeVersion: result.controller.browserVersion, pageUrl: page.url(), mainGpu, iframeGpu, workerGpu };
    });

    result.testDemoSmoke = await runStage("C", 120_000, async () => {
      const frame = await waitForViewerFrame();
      const started = Date.now();
      await uploadDemo(frame, testDemo);
      await waitForParse(frame);
      await selectPlayer(frame, "Dog");
      await frame.waitForFunction(() => Boolean(window.__csnetWebGpuBench?.replay), null, { timeout: 30_000 });
      const parsed = await replaySummary(frame);
      const rows = await runWorker(frame, { sampleLimit: 16, provider: "webgpu-fp16", batchSize: 16, repeats: 1, profile: false });
      const inference = telemetrySummary(rows);
      assertRealWebGpu(inference, "TEST_DEMO_SMOKE");
      if (rows[0]?.timelineSummary?.sampleCount !== 16) throw new Error(`TEST_DEMO_SMOKE_SAMPLE_COUNT:${rows[0]?.timelineSummary?.sampleCount}`);
      await page.screenshot({ path: resolve(outputRoot, "test-demo-batch16-smoke.png"), fullPage: false });
      return { parseMs: Date.now() - started, parsed, inference };
    });

    result.falconsParse = await runStage("D", 180_000, async () => {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      const frame = await waitForViewerFrame();
      const started = Date.now();
      await uploadDemo(frame, demo);
      await waitForParse(frame);
      await selectPlayer(frame, "NiKo");
      await frame.waitForFunction(() => Boolean(window.__csnetWebGpuBench?.replay), null, { timeout: 30_000 });
      const parsed = await replaySummary(frame);
      const parse = { fileBytes: result.fixture.bytes, parseMs: Date.now() - started, ...parsed, memory: await memorySummary(frame) };
      await page.screenshot({ path: resolve(outputRoot, "falcons-player-selected.png"), fullPage: false });
      return parse;
    });

    result.falconsInference = await runStage("E", 480_000, async () => {
      const frame = await waitForViewerFrame();
      const rows = await runWorker(frame, { sampleLimit: null, provider: "webgpu-fp16", batchSize: 16, repeats: 1, profile: true });
      const inference = telemetrySummary(rows);
      assertRealWebGpu(inference, "FALCONS_BATCH16");
      const timeline = rows[0]?.timelineSummary;
      if (!timeline || timeline.sampleCount !== result.falconsParse.sampleCount || timeline.firstTick !== result.falconsParse.firstTick || timeline.lastTick !== result.falconsParse.lastTick) throw new Error(`FALCONS_CANONICAL_SUMMARY_MISMATCH:${JSON.stringify({ timeline, parsed: result.falconsParse })}`);
      const value = { batchSize: 16, providerRequested: "webgpu-fp16", ...inference, timeline };
      await page.screenshot({ path: resolve(outputRoot, "falcons-batch16-final.png"), fullPage: false });
      return value;
    });
    result.status = "SUCCESS";
  } catch (error) {
    result.status = "FAILED";
    result.error = { stage: error.stage ?? null, message: errorRecord(error), details: error.details ?? null, serviceLogs: error.serviceLogs ?? null, launchEvidence: error.launchEvidence ?? null };
  } finally {
    await cleanup();
    result.finishedAt = new Date().toISOString();
    await writeJson("edge-falcons-batch16.json", result);
    console.log(JSON.stringify(result, null, 2));
  }
}

main();
