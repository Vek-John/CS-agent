import * as ort from "onnxruntime-web/webgpu";
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

export const CS_NET_WEBGPU_FP16_MODEL = "/models/cs-net/win-rate.fp16.onnx" as const;
export const CS_NET_WEBGPU_FP16_MODEL_SHA256 = "94ef9a19ff5e3d2e122e57fd0fb2a79c670f14746d79399c1352ab9b25742f63" as const;

export type WebGpuFallbackDetection = "PROVEN" | "UNKNOWN" | "FAILED";

export interface WebGpuCapabilitySnapshot {
  navigatorGpu: boolean;
  workerNavigatorGpu: boolean;
  adapterAvailable: boolean;
  deviceAvailable: boolean;
  shaderF16: boolean;
  adapterInfo: string;
  deviceInfo: string;
  deviceFeatures: readonly string[];
}

export interface WebGpuRuntimeTelemetry {
  schemaVersion: "cs-net-webgpu-telemetry.v1";
  providerRequested: "webgpu-fp16";
  providerActual: "webgpu-fp16" | "wasm-int8";
  precision: "FP16";
  modelSha256: string;
  onnxruntimeVersion: string;
  fetchMs: number;
  sessionCreateMs: number;
  warmupMs: number;
  featureBuildMs: number;
  tensorUploadMs: number;
  gpuInferenceMs: number;
  outputReadbackMs: number;
  serializationMs: number;
  totalMs: number;
  sampleCount: number;
  batchSize: number;
  samplesPerSecond: number;
  modelBytes: number;
  inputBytes: number;
  outputBytes: number;
  estimatedPeakGpuBytes: number;
  capability: WebGpuCapabilitySnapshot;
  ortSessionCreated: boolean;
  profileKernelCount: number;
  profileKernelMs: number;
  fallbackDetection: WebGpuFallbackDetection;
  fallbackReason: string;
}

export interface WebGpuRuntimeOptions {
  modelUrl?: string;
  selectedPlayerId?: string;
  signal?: AbortSignal;
  batchSize?: number;
  onProgress?: (progress: {
    phase: "downloading" | "inference" | "ready";
    completed: number;
    total: number;
    detail?: string;
  }) => void;
  onTelemetry?: (telemetry: WebGpuRuntimeTelemetry) => void;
}

interface LoadedWebGpuSession {
  session: ort.InferenceSession;
  capability: WebGpuCapabilitySnapshot;
  fetchMs: number;
  sessionCreateMs: number;
  modelBytes: number;
}

interface GpuAdapterLike {
  features: Iterable<string>;
  requestDevice(descriptor?: { requiredFeatures?: readonly string[] }): Promise<GpuDeviceLike>;
  requestAdapterInfo?: () => Promise<GpuInfoLike>;
  info?: GpuInfoLike;
}

interface GpuDeviceLike {
  features?: Iterable<string>;
  lost?: Promise<{ reason?: string; message?: string }>;
  adapterInfo?: GpuInfoLike;
}

interface GpuInfoLike {
  vendor?: unknown;
  architecture?: unknown;
  device?: unknown;
  description?: unknown;
}

interface GpuLike {
  requestAdapter(options?: { powerPreference?: "low-power" | "high-performance" }): Promise<GpuAdapterLike | null>;
}

interface ProfileEvent {
  startTime: number;
  endTime: number;
}

let sessionPromise: Promise<LoadedWebGpuSession> | undefined;
let sessionKey: string | undefined;
let profileEvents: ProfileEvent[] = [];

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("cs-net WebGPU inference aborted");
    error.name = "AbortError";
    throw error;
  }
}

function byteLength(value: unknown): number {
  return ArrayBuffer.isView(value) ? value.byteLength : 0;
}

async function sha256Hex(buffer: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WEBGPU_MODEL_HASH_UNAVAILABLE:crypto.subtle");
  const digest = await subtle.digest("SHA-256", buffer as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function disposeValue(value: unknown): void {
  if (value && typeof value === "object" && "dispose" in value && typeof value.dispose === "function") {
    (value.dispose as () => void)();
  }
}

function disposeValues(values: Record<string, unknown>): void {
  for (const value of Object.values(values)) disposeValue(value);
}

function infoText(value: GpuInfoLike | undefined): string {
  if (!value) return "unavailable";
  return [value.vendor, value.architecture, value.device, value.description]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .join("/") || "available";
}

async function inspectWebGpu(): Promise<{ capability: WebGpuCapabilitySnapshot; adapter?: GpuAdapterLike; device?: GpuDeviceLike }> {
  const navigatorValue = globalThis.navigator as Navigator & { gpu?: GpuLike };
  const gpu = navigatorValue?.gpu;
  const base = {
    navigatorGpu: Boolean(gpu),
    workerNavigatorGpu: Boolean(gpu),
    adapterAvailable: false,
    deviceAvailable: false,
    shaderF16: false,
    adapterInfo: "unavailable",
    deviceInfo: "unavailable",
    deviceFeatures: [] as string[],
  };
  if (!gpu) return { capability: base };
  const adapter = (await gpu.requestAdapter({ powerPreference: "high-performance" })) as GpuAdapterLike | null;
  if (!adapter) return { capability: base };
  const features = [...adapter.features];
  const adapterInfo = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : undefined);
  const shaderF16 = features.includes("shader-f16");
  const capability = { ...base, adapterAvailable: true, shaderF16, adapterInfo: infoText(adapterInfo), deviceFeatures: features };
  if (!shaderF16) return { capability, adapter };
  const requiredFeatures = ["shader-f16"];
  if (features.includes("timestamp-query")) requiredFeatures.push("timestamp-query");
  if (features.includes("subgroups")) requiredFeatures.push("subgroups");
  const device = await adapter.requestDevice({ requiredFeatures });
  capability.deviceAvailable = Boolean(device);
  capability.deviceInfo = infoText(device.adapterInfo);
  capability.deviceFeatures = [...(device.features ?? adapter.features)];
  return { capability, adapter, device };
}

function configureWebGpuWasmAssets(): void {
  if (typeof location === "undefined") return;
  const basePath = location.pathname === "/cs2d" || location.pathname.startsWith("/cs2d/") ? "/cs2d/" : "/";
  const asset = (name: string) => new URL(`${basePath}${name}`, location.origin).toString();
  // The WebGPU package uses ORT's matching asyncify WASM module for graph and
  // runtime plumbing. These assets are prepared only by the local PoC script.
  ort.env.wasm.wasmPaths = {
    mjs: asset("ort-wasm-simd-threaded.asyncify.mjs"),
    wasm: asset("ort-wasm-simd-threaded.asyncify.wasm"),
  };
}

export async function readWebGpuCapabilities(): Promise<WebGpuCapabilitySnapshot> {
  try {
    return (await inspectWebGpu()).capability;
  } catch {
    const navigatorValue = globalThis.navigator as Navigator & { gpu?: GpuLike };
    return {
      navigatorGpu: Boolean(navigatorValue?.gpu),
      workerNavigatorGpu: Boolean(navigatorValue?.gpu),
      adapterAvailable: false,
      deviceAvailable: false,
      shaderF16: false,
      adapterInfo: "error",
      deviceInfo: "error",
      deviceFeatures: [],
    };
  }
}

export async function createWebGpuFailureTelemetry(
  reason: string,
  sampleCount: number,
  batchSize: number,
): Promise<WebGpuRuntimeTelemetry> {
  return {
    schemaVersion: "cs-net-webgpu-telemetry.v1",
    providerRequested: "webgpu-fp16",
    providerActual: "wasm-int8",
    precision: "FP16",
    modelSha256: CS_NET_WEBGPU_FP16_MODEL_SHA256,
    onnxruntimeVersion: ort.env.versions.web ?? "unknown",
    fetchMs: 0,
    sessionCreateMs: 0,
    warmupMs: 0,
    featureBuildMs: 0,
    tensorUploadMs: 0,
    gpuInferenceMs: 0,
    outputReadbackMs: 0,
    serializationMs: 0,
    totalMs: 0,
    sampleCount,
    batchSize,
    samplesPerSecond: 0,
    modelBytes: 0,
    inputBytes: 0,
    outputBytes: 0,
    estimatedPeakGpuBytes: 0,
    capability: await readWebGpuCapabilities(),
    ortSessionCreated: false,
    profileKernelCount: 0,
    profileKernelMs: 0,
    fallbackDetection: "FAILED",
    fallbackReason: reason.slice(0, 240),
  };
}

function tensorInputs(batch: CsNetModelBatch): Record<string, ort.Tensor> {
  const inputs = {} as CsNetModelInputs;
  for (const key of Object.keys(batch.inputs) as (keyof CsNetModelInputs)[]) {
    inputs[key] = batch.inputs[key] as never;
  }
  const flat = flattenFeatureBatch({ samples: batch.samples, inputs });
  const size = batch.samples.length;
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

function profileDurationMs(): number {
  return profileEvents.reduce((total, event) => total + Math.max(0, event.endTime - event.startTime) / 1_000_000, 0);
}

async function loadWebGpuModel(url: string, batchSize: number, options: WebGpuRuntimeOptions): Promise<LoadedWebGpuSession> {
  const key = `${url}|revision=${CS_NET_SOURCE.modelRevision}|asset=fp16|batch=${batchSize}`;
  if (sessionPromise && sessionKey === key) return sessionPromise;
  if (sessionPromise && sessionKey !== key) throw new Error("CS_NET_WEBGPU_SESSION_RESTART_REQUIRED");
  sessionKey = key;
  sessionPromise = (async () => {
    throwIfAborted(options.signal);
    const inspected = await inspectWebGpu();
    if (!inspected.capability.navigatorGpu) throw new Error("WEBGPU_UNAVAILABLE:navigator.gpu");
    if (!inspected.capability.adapterAvailable) throw new Error("WEBGPU_UNAVAILABLE:adapter");
    if (!inspected.capability.shaderF16) throw new Error("WEBGPU_UNAVAILABLE:shader-f16");
    if (!inspected.capability.deviceAvailable || !inspected.device) throw new Error("WEBGPU_UNAVAILABLE:device");

    const fetchStarted = now();
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok) throw new Error(`WEBGPU_MODEL_FETCH_FAILED:${response.status}`);
    const modelBytes = Number(response.headers.get("content-length") ?? 0);
    const buffer = new Uint8Array(await response.arrayBuffer());
    const fetchMs = now() - fetchStarted;
    throwIfAborted(options.signal);
    if (await sha256Hex(buffer) !== CS_NET_WEBGPU_FP16_MODEL_SHA256) {
      throw new Error("WEBGPU_MODEL_SHA256_MISMATCH");
    }

    profileEvents = [];
    configureWebGpuWasmAssets();
    // ORT 1.27 leaves the optional profiling object undefined, while older
    // builds expose it eagerly. Initialize the optional surface before the
    // WebGPU session is created so profiling never turns a valid GPU into a
    // spurious WASM fallback.
    const webgpuEnv = ort.env.webgpu as typeof ort.env.webgpu & {
      profiling?: {
        mode?: "default" | "disabled";
        ondata?: (data: ProfileEvent) => void;
      };
    };
    webgpuEnv.profiling ??= {};
    webgpuEnv.profiling.mode = "default";
    webgpuEnv.profiling.ondata = (data) => {
      profileEvents.push({ startTime: data.startTime, endTime: data.endTime });
    };
    ort.env.webgpu.device = inspected.device as never;
    const sessionStarted = now();
    const session = await ort.InferenceSession.create(buffer, {
      executionProviders: [{ name: "webgpu", device: inspected.device as never, validationMode: "full" }],
      graphOptimizationLevel: "all",
      enableProfiling: true,
      preferredOutputLocation: "cpu",
    });
    const sessionCreateMs = now() - sessionStarted;
    return {
      session,
      capability: inspected.capability,
      fetchMs,
      sessionCreateMs,
      modelBytes: modelBytes || buffer.byteLength,
    };
  })();
  try {
    return await sessionPromise;
  } catch (error) {
    sessionPromise = undefined;
    sessionKey = undefined;
    throw error;
  }
}

interface BatchResult {
  logits: number[];
  tensorUploadMs: number;
  gpuInferenceMs: number;
  outputReadbackMs: number;
  inputBytes: number;
  outputBytes: number;
}

async function runBatch(session: ort.InferenceSession, batch: CsNetModelBatch, signal?: AbortSignal): Promise<BatchResult> {
  throwIfAborted(signal);
  const tensorStarted = now();
  const tensors = tensorInputs(batch);
  const inputBytes = Object.values(tensors).reduce((total, tensor) => total + byteLength(tensor.data), 0);
  const tensorUploadStarted = now();
  let output: ort.InferenceSession.ReturnType | undefined;
  try {
    const profileBeforeMs = profileDurationMs();
    session.startProfiling();
    output = await session.run(tensors);
    const runWallMs = now() - tensorUploadStarted;
    session.endProfiling();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfAborted(signal);
    const data = output.logit?.data;
    if (!data) throw new Error("WEBGPU_OUTPUT_MISSING:logit");
    const outputBytes = byteLength(data);
    const readbackStarted = now();
    const logits = Array.from(data as ArrayLike<number>, Number);
    const outputReadbackMs = now() - readbackStarted;
    if (logits.length !== batch.samples.length) throw new Error(`WEBGPU_OUTPUT_SAMPLE_MISMATCH:${logits.length}:${batch.samples.length}`);
    const gpuInferenceMs = Math.max(0, profileDurationMs() - profileBeforeMs);
    return {
      logits,
      tensorUploadMs: Math.max(0, runWallMs - gpuInferenceMs),
      gpuInferenceMs,
      outputReadbackMs,
      inputBytes,
      outputBytes,
    };
  } finally {
    disposeValues(tensors);
    if (output) disposeValue(output);
    void tensorStarted;
  }
}

export function resetWebGpuRuntimeForWorkerRestart(): void {
  sessionPromise = undefined;
  sessionKey = undefined;
  profileEvents = [];
}

export async function runWebGpuFp16Inference(
  replay: CsNetReplay,
  source: Iterable<CsNetModelBatch>,
  options: WebGpuRuntimeOptions = {},
): Promise<WinProbabilityTimelineV1> {
  const started = now();
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 16));
  const loaded = await loadWebGpuModel(
    options.modelUrl ?? CS_NET_WEBGPU_FP16_MODEL,
    batchSize,
    options,
  );
  const iterator = source[Symbol.iterator]();
  const expectedSamples = replay.rounds.reduce((sum, round) => sum + round.frames.length, 0);
  let featureBuildMs = 0;
  const nextBatch = (): IteratorResult<CsNetModelBatch> => {
    const featureStarted = now();
    const value = iterator.next();
    featureBuildMs += now() - featureStarted;
    return value;
  };
  let current = nextBatch();
  if (current.done) throw new Error("cs-net replay contains no inference samples.");
  const warmupStarted = now();
  await runBatch(loaded.session, sliceBatch(current.value, 0, 1), options.signal);
  const warmupMs = now() - warmupStarted;

  const samples: CsNetFeatureSample[] = [];
  const logits: number[] = [];
  let tensorUploadMs = 0;
  let gpuInferenceMs = 0;
  let outputReadbackMs = 0;
  let inputBytes = 0;
  let outputBytes = 0;
  profileEvents = [];
  while (!current.done) {
    throwIfAborted(options.signal);
    const result = await runBatch(loaded.session, current.value, options.signal);
    samples.push(...current.value.samples);
    logits.push(...result.logits);
    tensorUploadMs += result.tensorUploadMs;
    gpuInferenceMs += result.gpuInferenceMs;
    outputReadbackMs += result.outputReadbackMs;
    inputBytes = Math.max(inputBytes, result.inputBytes);
    outputBytes = Math.max(outputBytes, result.outputBytes);
    options.onProgress?.({
      phase: "inference",
      completed: samples.length,
      total: expectedSamples,
      detail: `正在计算整场胜率 · ${Math.round((samples.length / Math.max(1, expectedSamples)) * 100)}%`,
    });
    current = nextBatch();
  }
  if (samples.length !== expectedSamples || logits.length !== expectedSamples) {
    throw new Error(`WEBGPU_SAMPLE_COUNT_MISMATCH:${samples.length}:${expectedSamples}`);
  }
  const timeline = buildWinProbabilityTimeline({
    replay,
    selectedPlayerId: options.selectedPlayerId,
    samples,
    logits,
    model: {
      revision: `${CS_NET_SOURCE.modelRevision}-fp16`,
      assetUrl: options.modelUrl ?? CS_NET_WEBGPU_FP16_MODEL,
      assetSha256: CS_NET_WEBGPU_FP16_MODEL_SHA256,
      assetBytes: loaded.modelBytes,
      quantization: "FP16",
    },
  });
  const serializationStarted = now();
  JSON.stringify(timeline);
  const serializationMs = now() - serializationStarted;
  const totalMs = now() - started;
  const profileKernelMs = profileDurationMs();
  const telemetry: WebGpuRuntimeTelemetry = {
    schemaVersion: "cs-net-webgpu-telemetry.v1",
    providerRequested: "webgpu-fp16",
    providerActual: "webgpu-fp16",
    precision: "FP16",
    modelSha256: CS_NET_WEBGPU_FP16_MODEL_SHA256,
    onnxruntimeVersion: ort.env.versions.web ?? "unknown",
    fetchMs: loaded.fetchMs,
    sessionCreateMs: loaded.sessionCreateMs,
    warmupMs,
    featureBuildMs,
    tensorUploadMs,
    gpuInferenceMs,
    outputReadbackMs,
    serializationMs,
    totalMs,
    sampleCount: samples.length,
    batchSize,
    samplesPerSecond: gpuInferenceMs > 0 ? samples.length / (gpuInferenceMs / 1000) : 0,
    modelBytes: loaded.modelBytes,
    inputBytes,
    outputBytes,
    estimatedPeakGpuBytes: loaded.modelBytes + inputBytes + outputBytes,
    capability: loaded.capability,
    ortSessionCreated: true,
    profileKernelCount: profileEvents.length,
    profileKernelMs,
    fallbackDetection: "UNKNOWN",
    fallbackReason: "",
  };
  options.onTelemetry?.(telemetry);
  options.onProgress?.({ phase: "ready", completed: samples.length, total: samples.length, detail: "整场胜率计算完成" });
  return timeline;
}
