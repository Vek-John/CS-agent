import * as ort from "onnxruntime-web/wasm";
import {
  buildWinProbabilityTimeline,
  CS_NET_SOURCE,
  flattenFeatureBatch,
  type CsNetFeatureSample,
  type CsNetModelBatch,
  type CsNetModelInputs,
  type CsNetReplay,
  type WinProbabilityTimelineV1,
} from "./index";
import {
  readRuntimeCapabilities,
  resolveRuntimeConfig,
  type RuntimeCapabilities,
  type RuntimeThreadRequest,
  type RuntimeThreadCount,
} from "./runtime-config";

export type WinRateRuntimeProgressPhase =
  | "downloading"
  | "feature_build"
  | "warmup"
  | "tensor_prepare"
  | "inference"
  | "serialization"
  | "ready";

export interface WinRateRuntimeProgress {
  phase: WinRateRuntimeProgressPhase;
  completed: number;
  total: number;
  detail?: string;
}

export interface WinRateRuntimeTelemetry {
  schemaVersion: "cs-net-runtime-telemetry.v1";
  fetchMs: number;
  sessionCreateMs: number;
  warmupMs: number;
  featureBuildMs: number;
  tensorPrepareMs: number;
  inferenceMs: number;
  serializationMs: number;
  totalMs: number;
  sampleCount: number;
  threadsRequested: RuntimeThreadRequest;
  threadsActual: RuntimeThreadCount;
  threadsEvidence: "wasm_threads_probe" | "single_thread_fallback" | "stable_default";
  batchSize: number;
  requestedBatchSize: number;
  samplesPerSecond: number;
  peakBatchBytes: number;
  hardwareConcurrency: number;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  wasmThreads: boolean;
  wasmSimd: boolean;
  fallbackReason: string;
}

export interface WinRateRuntimeOptions {
  modelUrl?: string;
  selectedPlayerId?: string;
  signal?: AbortSignal;
  threads?: RuntimeThreadRequest;
  batchSize?: number;
  maxBatchBytes?: number;
  model?: Partial<WinProbabilityTimelineV1["model"]>;
  onProgress?: (progress: WinRateRuntimeProgress) => void;
  onTelemetry?: (telemetry: WinRateRuntimeTelemetry) => void;
}

interface LoadedSession {
  session: ort.InferenceSession;
  fetchMs: number;
  sessionCreateMs: number;
}

let sessionPromise: Promise<LoadedSession> | undefined;
let sessionKey: string | undefined;
let configuredThreadKey: string | undefined;

const DEFAULT_MAX_BATCH_BYTES = 96 * 1024 * 1024;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function abortError(): Error {
  const error = new Error("cs-net inference aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function disposeValue(value: unknown): void {
  if (value && typeof value === "object" && "dispose" in value && typeof value.dispose === "function") {
    (value.dispose as () => void)();
  }
}

function disposeValues(values: Record<string, unknown>): void {
  for (const value of Object.values(values)) disposeValue(value);
}

function byteLength(value: unknown): number {
  return ArrayBuffer.isView(value) ? value.byteLength : 0;
}

function configureWasmAssets(): void {
  if (typeof location === "undefined") return;
  const basePath = location.pathname === "/cs2d" || location.pathname.startsWith("/cs2d/") ? "/cs2d/" : "/";
  const asset = (name: string) => new URL(`${basePath}${name}`, location.origin).toString();
  ort.env.wasm.wasmPaths = {
    mjs: asset("ort-wasm-simd-threaded.mjs"),
    wasm: asset("ort-wasm-simd-threaded.wasm"),
  };
}

function configureRuntime(config: ReturnType<typeof resolveRuntimeConfig>): void {
  // ORT reads this during the first WASM backend/session initialization. A
  // thread change in one Worker is deliberately rejected; callers switch
  // candidates by terminating and rebuilding the Worker/session.
  const key = `${config.actualThreads}|${config.wasmSimd ? "simd" : "scalar"}`;
  if (configuredThreadKey && configuredThreadKey !== key) {
    throw new Error("CS_NET_THREAD_SWITCH_REQUIRES_WORKER_RESTART");
  }
  configuredThreadKey = key;
  configureWasmAssets();
  ort.env.wasm.proxy = false;
  ort.env.wasm.simd = config.wasmSimd ? "fixed" : false;
  ort.env.wasm.numThreads = config.actualThreads;
}

function tensorInputs(batch: CsNetModelBatch, start: number, end: number): Record<string, ort.Tensor> {
  const inputs = {} as CsNetModelInputs;
  for (const key of Object.keys(batch.inputs) as (keyof CsNetModelInputs)[]) {
    inputs[key] = batch.inputs[key].slice(start, end) as never;
  }
  const chunk: CsNetModelBatch = { samples: batch.samples.slice(start, end), inputs };
  const flat = flattenFeatureBatch(chunk);
  const size = end - start;
  return {
    mlp1_f: new ort.Tensor("float32", flat.mlp1_f, [size, 31, 3]),
    mlp1_i: new ort.Tensor("int64", flat.mlp1_i, [size, 31]),
    mlp1_mask: new ort.Tensor("bool", flat.mlp1_mask, [size, 31]),
    mlp2_f: new ort.Tensor("float32", flat.mlp2_f, [size, 31, 14]),
    mlp2_mask: new ort.Tensor("bool", flat.mlp2_mask, [size, 31]),
    mlp3_f: new ort.Tensor("float32", flat.mlp3_f, [size, 31, 1]),
    mlp3_i: new ort.Tensor("int64", flat.mlp3_i, [size, 31]),
    mlp3_mask: new ort.Tensor("bool", flat.mlp3_mask, [size, 31]),
    mlp4_f: new ort.Tensor("float32", flat.mlp4_f, [size, 31, 4]),
    mlp4_mask: new ort.Tensor("bool", flat.mlp4_mask, [size, 31]),
    mlp5_f: new ort.Tensor("float32", flat.mlp5_f, [size, 31, 9, 13]),
    mlp5_i: new ort.Tensor("int64", flat.mlp5_i, [size, 31, 9]),
    mlp5_mask: new ort.Tensor("bool", flat.mlp5_mask, [size, 31, 9]),
    emb1_i: new ort.Tensor("int64", flat.emb1_i, [size, 31, 9]),
    emb1_mask: new ort.Tensor("bool", flat.emb1_mask, [size, 31, 9]),
    emb2_i: new ort.Tensor("int64", flat.emb2_i, [size, 31]),
    emb2_mask: new ort.Tensor("bool", flat.emb2_mask, [size, 31]),
    dead_mask: new ort.Tensor("bool", flat.dead_mask, [size, 31]),
    pad_mask: new ort.Tensor("bool", flat.pad_mask, [size, 31]),
  };
}

function sliceBatch(batch: CsNetModelBatch, start: number, end: number): CsNetModelBatch {
  const inputs = {} as CsNetModelInputs;
  for (const key of Object.keys(batch.inputs) as (keyof CsNetModelInputs)[]) {
    inputs[key] = batch.inputs[key].slice(start, end) as never;
  }
  return { samples: batch.samples.slice(start, end), inputs };
}

async function loadModel(
  url: string,
  config: ReturnType<typeof resolveRuntimeConfig>,
  options: WinRateRuntimeOptions,
): Promise<LoadedSession> {
  const key = `${url}|revision=${CS_NET_SOURCE.modelRevision}|asset=${CS_NET_SOURCE.assetSha256}|threads=${config.actualThreads}|simd=${config.wasmSimd ? "1" : "0"}`;
  if (sessionPromise && sessionKey === key) return sessionPromise;
  if (sessionPromise && sessionKey !== key) throw new Error("CS_NET_THREAD_SWITCH_REQUIRES_WORKER_RESTART");
  sessionKey = key;
  configureRuntime(config);
  sessionPromise = (async () => {
    throwIfAborted(options.signal);
    const fetchStarted = now();
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok) throw new Error(`胜率模型下载失败（${response.status}）。`);
    const total = Number(response.headers.get("content-length") ?? CS_NET_SOURCE.assetBytes);
    const reader = response.body?.getReader();
    let buffer: Uint8Array;
    if (!reader) {
      buffer = new Uint8Array(await response.arrayBuffer());
      options.onProgress?.({ phase: "downloading", completed: buffer.byteLength, total });
    } else {
      const chunks: Uint8Array[] = [];
      let completed = 0;
      for (;;) {
        throwIfAborted(options.signal);
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        completed += next.value.byteLength;
        options.onProgress?.({ phase: "downloading", completed, total });
      }
      buffer = new Uint8Array(completed);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    const fetchMs = now() - fetchStarted;
    throwIfAborted(options.signal);
    const sessionStarted = now();
    const session = await ort.InferenceSession.create(buffer, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    const sessionCreateMs = now() - sessionStarted;
    return { session, fetchMs, sessionCreateMs };
  })();
  try {
    return await sessionPromise;
  } catch (error) {
    sessionPromise = undefined;
    sessionKey = undefined;
    throw error;
  }
}

interface BatchRunResult {
  logits: number[];
  tensorPrepareMs: number;
  inferenceMs: number;
  peakBatchBytes: number;
  effectiveBatchSize: number;
}

async function runBatchOnce(
  session: ort.InferenceSession,
  batch: CsNetModelBatch,
  signal: AbortSignal | undefined,
  maxBatchBytes: number,
): Promise<BatchRunResult> {
  throwIfAborted(signal);
  if (batch.samples.length === 0) return { logits: [], tensorPrepareMs: 0, inferenceMs: 0, peakBatchBytes: 0, effectiveBatchSize: 0 };
  const prepareStarted = now();
  const tensors = tensorInputs(batch, 0, batch.samples.length);
  const peakBatchBytes = Object.values(tensors).reduce((total, tensor) => total + byteLength(tensor.data), 0);
  if (peakBatchBytes > maxBatchBytes) {
    disposeValues(tensors);
    throw new Error(`CS_NET_BATCH_MEMORY_LIMIT:${peakBatchBytes}`);
  }
  const tensorPrepareMs = now() - prepareStarted;
  let output: ort.InferenceSession.ReturnType | undefined;
  try {
    throwIfAborted(signal);
    const inferenceStarted = now();
    output = await session.run(tensors);
    const inferenceMs = now() - inferenceStarted;
    throwIfAborted(signal);
    const data = output.logit?.data;
    if (!data) throw new Error("胜率模型没有返回 logit 输出。");
    const logits = Array.from(data as ArrayLike<number>, Number);
    if (logits.length !== batch.samples.length) throw new Error(`CS_NET_OUTPUT_SAMPLE_MISMATCH:${logits.length}:${batch.samples.length}`);
    return { logits, tensorPrepareMs, inferenceMs, peakBatchBytes, effectiveBatchSize: batch.samples.length };
  } finally {
    disposeValues(tensors);
    if (output) disposeValues(output);
  }
}

/** Retry with smaller actual tensors when the model/backend rejects a batch dimension. */
async function runBatchWithFallback(
  session: ort.InferenceSession,
  batch: CsNetModelBatch,
  signal: AbortSignal | undefined,
  maxBatchBytes: number,
): Promise<BatchRunResult> {
  try {
    return await runBatchOnce(session, batch, signal, maxBatchBytes);
  } catch (error) {
    throwIfAborted(signal);
    if (batch.samples.length <= 1) throw error;
    const middle = Math.ceil(batch.samples.length / 2);
    const left = await runBatchWithFallback(session, sliceBatch(batch, 0, middle), signal, maxBatchBytes);
    const right = await runBatchWithFallback(session, sliceBatch(batch, middle, batch.samples.length), signal, maxBatchBytes);
    return {
      logits: [...left.logits, ...right.logits],
      tensorPrepareMs: left.tensorPrepareMs + right.tensorPrepareMs,
      inferenceMs: left.inferenceMs + right.inferenceMs,
      peakBatchBytes: Math.max(left.peakBatchBytes, right.peakBatchBytes),
      effectiveBatchSize: Math.max(left.effectiveBatchSize, right.effectiveBatchSize),
    };
  }
}

function isModelBatch(value: CsNetModelBatch | Iterable<CsNetModelBatch>): value is CsNetModelBatch {
  return typeof value === "object" && value !== null && "samples" in value && "inputs" in value;
}

export function resetWinRateRuntimeForWorkerRestart(): void {
  sessionPromise = undefined;
  sessionKey = undefined;
  configuredThreadKey = undefined;
}

export async function runWinRateInference(
  replay: CsNetReplay,
  source: CsNetModelBatch | Iterable<CsNetModelBatch>,
  options: WinRateRuntimeOptions = {},
): Promise<WinProbabilityTimelineV1> {
  const started = now();
  const capabilities: RuntimeCapabilities = readRuntimeCapabilities();
  const runtimeConfig = resolveRuntimeConfig(options.threads ?? "auto", capabilities);
  const loaded = await loadModel(options.modelUrl ?? CS_NET_SOURCE.assetUrl, runtimeConfig, options);
  const iterator = (isModelBatch(source) ? [source] : source)[Symbol.iterator]();
  const expectedSamples = replay.rounds.reduce((sum, round) => sum + round.frames.length, 0);
  const requestedBatchSize = Math.max(1, Math.floor(options.batchSize ?? 128));
  let featureBuildMs = 0;
  const nextBatch = (): IteratorResult<CsNetModelBatch> => {
    const featureStarted = now();
    const value = iterator.next();
    featureBuildMs += now() - featureStarted;
    return value;
  };
  let current = nextBatch();
  if (current.done) throw new Error("cs-net replay contains no inference samples.");

  // Warmup is a one-sample disposable run. Its output never enters the formal
  // sample/logit arrays, so it cannot duplicate the first sample or progress total.
  const warmupStarted = now();
  await runBatchWithFallback(loaded.session, sliceBatch(current.value, 0, 1), options.signal, options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES);
  const warmupMs = now() - warmupStarted;

  const samples: CsNetFeatureSample[] = [];
  const logits: number[] = [];
  let tensorPrepareMs = 0;
  let inferenceMs = 0;
  let peakBatchBytes = 0;
  let effectiveBatchSize = 1;
  while (!current.done) {
    throwIfAborted(options.signal);
    const result = await runBatchWithFallback(loaded.session, current.value, options.signal, options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES);
    samples.push(...current.value.samples);
    logits.push(...result.logits);
    tensorPrepareMs += result.tensorPrepareMs;
    inferenceMs += result.inferenceMs;
    peakBatchBytes = Math.max(peakBatchBytes, result.peakBatchBytes);
    effectiveBatchSize = Math.max(effectiveBatchSize, result.effectiveBatchSize);
    options.onProgress?.({
      phase: "inference",
      completed: samples.length,
      total: expectedSamples,
      detail: `正在计算整场胜率 · ${Math.round((samples.length / Math.max(1, expectedSamples)) * 100)}%`,
    });
    current = nextBatch();
  }
  if (samples.length !== expectedSamples || logits.length !== expectedSamples) throw new Error(`CS_NET_SAMPLE_COUNT_MISMATCH:${samples.length}:${expectedSamples}`);

  const timeline = buildWinProbabilityTimeline({ replay, selectedPlayerId: options.selectedPlayerId, samples, logits, model: options.model });
  const serializationStarted = now();
  JSON.stringify(timeline);
  const serializationMs = now() - serializationStarted;
  const totalMs = now() - started;
  const telemetry: WinRateRuntimeTelemetry = {
    schemaVersion: "cs-net-runtime-telemetry.v1",
    fetchMs: loaded.fetchMs,
    sessionCreateMs: loaded.sessionCreateMs,
    warmupMs,
    featureBuildMs,
    tensorPrepareMs,
    inferenceMs,
    serializationMs,
    totalMs,
    sampleCount: samples.length,
    threadsRequested: runtimeConfig.requestedThreads,
    threadsActual: runtimeConfig.actualThreads,
    threadsEvidence: runtimeConfig.evidence,
    batchSize: effectiveBatchSize,
    requestedBatchSize,
    samplesPerSecond: inferenceMs > 0 ? samples.length / (inferenceMs / 1000) : 0,
    peakBatchBytes,
    hardwareConcurrency: capabilities.hardwareConcurrency,
    crossOriginIsolated: capabilities.crossOriginIsolated,
    sharedArrayBuffer: capabilities.sharedArrayBuffer,
    wasmThreads: capabilities.wasmThreads,
    wasmSimd: capabilities.wasmSimd,
    fallbackReason: runtimeConfig.fallbackReason ?? "",
  };
  options.onTelemetry?.(telemetry);
  options.onProgress?.({ phase: "ready", completed: samples.length, total: samples.length, detail: "整场胜率计算完成" });
  return timeline;
}
