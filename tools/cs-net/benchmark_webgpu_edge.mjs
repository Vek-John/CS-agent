#!/usr/bin/env node

/**
 * Edge-only local WebGPU benchmark harness.
 *
 * The cs2d iframe owns the parsed Replay. The harness intercepts the normal
 * analysis request before it starts, keeps that Replay inside the iframe, and
 * runs the isolated provider Worker directly. No raw Replay crosses to Next.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = process.cwd();
const outputRoot = resolve(process.env.EDGE_OUTPUT_ROOT ?? ".local-data/acceptance-csnet-webgpu-fp16");
const demo = resolve(root, "demoTests/test_demo.dem");
const edgeExecutable = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const workerUrl = "http://localhost:5174/src/viewer/analysis/csNetWinRate.worker.ts?worker_file&type=module";
const requestedBatches = (process.env.EDGE_BATCHES ?? "16,32,64,128,256")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const repeats = Math.max(1, Number(process.env.EDGE_REPEATS ?? 4));
const skipFp32 = process.env.EDGE_SKIP_FP32 === "1";

const result = {
  browser: { channel: "msedge", executable: edgeExecutable, headless: false, ignoreSwiftShader: true },
  demo,
  startedAt: new Date().toISOString(),
  capability: null,
  parse: null,
  matrix: [],
  fp32Reference: null,
  parity: null,
  consoleErrors: [],
  pageErrors: [],
  notes: [],
};

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function percentile(values, p) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)];
}

function flattenTimeline(timeline) {
  return timeline.rounds.flatMap((round) => round.samples.map((sample) => ({ tick: sample.tick, probability: sample.probability })));
}

function parity(reference, candidate) {
  if (reference.length !== candidate.length) return { pass: false, reason: "sample_count_mismatch", reference: reference.length, candidate: candidate.length };
  const errors = reference.map((sample, index) => Math.abs(sample.probability - candidate[index].probability));
  const referenceDirection = Math.sign(reference.at(-1).probability - reference[0].probability);
  const candidateDirection = Math.sign(candidate.at(-1).probability - candidate[0].probability);
  return {
    pass: Math.max(...errors) <= 0.005 && errors.reduce((sum, value) => sum + value, 0) / errors.length <= 0.001 && referenceDirection === candidateDirection,
    sampleCount: reference.length,
    tickOrderEqual: reference.every((sample, index) => sample.tick === candidate[index].tick),
    maxAbsError: Math.max(...errors),
    meanAbsError: errors.reduce((sum, value) => sum + value, 0) / errors.length,
    p95AbsError: percentile(errors, 0.95),
    directionEqual: referenceDirection === candidateDirection,
  };
}

async function runWorker(page, replay, selectedPlayerId, provider, batchSize, repeats) {
  const frame = page.frames().find((candidate) => candidate.url().startsWith("http://localhost:5174"));
  if (!frame) throw new Error("cs2d iframe disappeared before isolated benchmark");
  return frame.evaluate(async ({ replay, selectedPlayerId, provider, batchSize, repeats, workerUrl }) => {
    const NativeWorker = window.__csnetWebGpuNativeWorker;
    if (!NativeWorker) throw new Error("native analysis Worker constructor was not captured");
    const worker = new NativeWorker(workerUrl, { type: "module" });
    let requestId = 1000;
    const rows = [];
    try {
    for (let repetition = 0; repetition < repeats; repetition += 1) {
      const currentRequestId = ++requestId;
      const started = performance.now();
      const row = await new Promise((resolve, reject) => {
        const telemetry = [];
        const timeout = setTimeout(() => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          reject(new Error(`worker timeout after 240000ms (${provider} batch ${batchSize} repetition ${repetition})`));
        }, 240000);
        const onError = (event) => {
          clearTimeout(timeout);
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          reject(new Error(`worker error: ${event.message || "unknown"}`));
        };
        const onMessage = (event) => {
          const message = event.data;
          if (message.requestId !== currentRequestId) return;
          if (message.type === "telemetry") telemetry.push(message.telemetry);
          if (message.type === "error") {
            clearTimeout(timeout);
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            reject(new Error(message.message));
          }
          if (message.type === "ready") {
            clearTimeout(timeout);
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            resolve({
              elapsedMs: performance.now() - started,
              telemetry,
                timeline: message.timeline,
              });
            }
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.postMessage({ requestId: currentRequestId, replay, selectedPlayerId, provider, batchSize });
      });
        rows.push({ repetition, ...row });
      }
    } finally {
      worker.terminate();
    }
    return rows;
  }, { replay, selectedPlayerId, provider, batchSize, repeats, workerUrl });
}

async function setFileInputFilesViaCdp(page, frame, filePath) {
  // Playwright refuses to stream a >50 MiB file into a browser connected over
  // CDP. DOM.setFileInputFiles sends the local path to the already-local Edge
  // process instead, without changing the product upload path.
  await frame.locator('input[type="file"]').waitFor({ state: "attached", timeout: 30000 });
  const client = await page.context().newCDPSession(page);
  const contexts = [];
  client.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context));
  await client.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const origin = new URL(frame.url()).origin;
  const context = contexts.find((candidate) => candidate.origin === origin && candidate.auxData?.type === "default");
  if (!context) throw new Error(`CDP_UPLOAD_CONTEXT_NOT_FOUND:${origin}`);
  const element = await client.send("Runtime.evaluate", {
    contextId: context.id,
    expression: "document.querySelector('input[type=file]')",
    returnByValue: false,
  });
  if (!element.result.objectId) throw new Error("CDP_UPLOAD_INPUT_NOT_FOUND");
  await client.send("DOM.setFileInputFiles", { objectId: element.result.objectId, files: [filePath] });
  await client.send("Runtime.releaseObject", { objectId: element.result.objectId }).catch(() => {});
  await client.detach().catch(() => {});
}

async function main() {
  await mkdir(outputRoot, { recursive: true });
  let browser;
  let benchmarkPage;
  try {
    browser = process.env.EDGE_CDP_URL
      ? await chromium.connectOverCDP(process.env.EDGE_CDP_URL)
      : await chromium.launch({
          channel: "msedge",
          headless: false,
          ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
          args: ["--use-angle=metal", "--disable-crash-reporter"],
        });
    result.browser.version = browser.version();
    // CDP-connected Edge exposes the existing default context most reliably;
    // an incognito context is not discoverable from a second CDP observer and
    // makes long-running Worker diagnostics opaque.
    const context = browser.contexts()[0];
    if (!context) throw new Error("EDGE_CDP_DEFAULT_CONTEXT_NOT_FOUND");
    await context.setDefaultTimeout(30000);
    await context.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.__csnetWebGpuNativeWorker = NativeWorker;
      window.__csnetWebGpuBench = { replay: null };
      window.Worker = function WorkerProxy(scriptURL, options) {
        const worker = new NativeWorker(scriptURL, options);
        if (!String(scriptURL).includes("csNetWinRate.worker")) return worker;
        const originalPostMessage = worker.postMessage.bind(worker);
        worker.postMessage = (message, transfer) => {
          if (message?.replay?.rounds) {
            window.__csnetWebGpuBench.replay = message.replay;
            // Suppress the automatic default INT8 run. The benchmark starts
            // isolated provider workers below with this same parsed Replay.
            return;
          }
          return originalPostMessage(message, transfer);
        };
        return worker;
      };
    });
    const page = await context.newPage();
    benchmarkPage = page;
    page.on("console", (message) => { if (message.type() === "error") result.consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => result.pageErrors.push(String(error)));
    await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => [...document.querySelectorAll("iframe")].some((element) => element.src.startsWith("http://localhost:5174")), null, { timeout: 30000 });
    const frame = page.frames().find((candidate) => candidate.url().startsWith("http://localhost:5174"));
    if (!frame) throw new Error("cs2d iframe not found");
    result.capability = {
      main: await page.evaluate(() => ({ crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined", navigatorGpu: Boolean(navigator.gpu) })),
      iframe: await frame.evaluate(() => ({ crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined", navigatorGpu: Boolean(navigator.gpu) })),
    };
    if (!result.capability.main.navigatorGpu || !result.capability.iframe.navigatorGpu) throw new Error("WEBGPU_UNAVAILABLE:main_or_iframe_navigator_gpu");
    const started = Date.now();
    await setFileInputFilesViaCdp(page, frame, demo);
    await frame.getByText("解析完成", { exact: false }).waitFor({ state: "visible", timeout: 180000 });
    const dog = frame.locator("button:visible").filter({ hasText: "Dog" }).first();
    await dog.click({ timeout: 30000 });
    await frame.waitForFunction(() => Boolean(window.__csnetWebGpuBench?.replay), null, { timeout: 30000 });
    const replay = await frame.evaluate(() => window.__csnetWebGpuBench.replay);
    const selectedPlayerId = replay.players.find((player) => player.name === "Dog")?.steamId ?? replay.players[5].steamId;
    result.parse = { elapsedMs: Date.now() - started, sampleCount: replay.rounds.reduce((sum, round) => sum + round.frames.length, 0), roundCount: replay.rounds.length, tickOrder: replay.rounds.flatMap((round) => round.frames.map((frame) => frame.tick)) };

    if (!skipFp32) {
      // FP32 is a parity reference, not the speed baseline. Use a larger
      // dynamic batch so the reference does not dominate the WebGPU matrix.
      const fp32Rows = await runWorker(page, replay, selectedPlayerId, "wasm-fp32", 128, 1);
      result.fp32Reference = { telemetry: fp32Rows[0].telemetry, timeline: flattenTimeline(fp32Rows[0].timeline) };
    } else {
      result.notes.push("FP32 WASM browser reference skipped in continuation; existing CPU parity artifact reused.");
    }
    for (const batchSize of requestedBatches) {
      const rows = await runWorker(page, replay, selectedPlayerId, "webgpu-fp16", batchSize, repeats);
      const telemetry = rows.flatMap((row) => row.telemetry);
      result.matrix.push({ batchSize, cold: rows[0], warm: rows.slice(1), telemetry });
      const failed = telemetry.find((item) => item.fallbackDetection === "FAILED" || item.providerActual === "wasm-int8");
      if (failed) {
        result.notes.push(`WebGPU fallback at batch ${batchSize}: ${failed.fallbackReason}`);
        break;
      }
    }
    const candidate = result.matrix[0]?.warm?.at(-1)?.timeline;
    if (candidate && result.fp32Reference) result.parity = parity(result.fp32Reference.timeline, flattenTimeline(candidate));
    result.screenshot = resolve(outputRoot, "edge-webgpu-final.png");
    await page.screenshot({ path: result.screenshot, fullPage: false });
  } catch (error) {
    result.status = "BLOCKED_OR_FAILED";
    result.error = error instanceof Error ? error.stack : String(error);
  } finally {
    result.finishedAt = new Date().toISOString();
    await writeFile(resolve(outputRoot, "edge-webgpu-benchmark.json"), `${JSON.stringify(result, null, 2)}\n`);
    if (benchmarkPage) await benchmarkPage.close().catch(() => {});
    if (browser) await browser.close();
    console.log(JSON.stringify(result, null, 2));
  }
}

main();
