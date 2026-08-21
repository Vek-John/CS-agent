/** Runtime capability and tuning contract for the browser-side cs-net head. */

export const CS_NET_THREAD_CANDIDATES = [1, 2, 4] as const;
export const CS_NET_BATCH_CANDIDATES = [1, 8, 16, 32, 64, 128] as const;
/** Current measured stable default on the supported M1 browser baseline. */
export const CS_NET_MEASURED_DEFAULT_BATCH = 16 as const;
/** Production analysis defaults; benchmark query parameters may override these internally. */
export const CS_NET_DEFAULT_PROVIDER = "webgpu-fp16" as const;
export const CS_NET_DEFAULT_BATCH_SIZE = 16 as const;

export type RuntimeThreadRequest = "auto" | 1 | 2 | 4;
export type RuntimeThreadCount = 1 | 2 | 4;

export interface RuntimeCapabilities {
  hardwareConcurrency: number;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  wasmThreads: boolean;
  wasmSimd: boolean;
}

export interface ResolvedRuntimeConfig {
  requestedThreads: RuntimeThreadRequest;
  actualThreads: RuntimeThreadCount;
  hardwareConcurrency: number;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  wasmThreads: boolean;
  wasmSimd: boolean;
  fallbackReason?: string;
  evidence: "wasm_threads_probe" | "single_thread_fallback" | "stable_default";
}

/** A shared-memory section is rejected by engines without the threads proposal. */
const SHARED_MEMORY_PROBE = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x04, 0x01, 0x03, 0x01, 0x01,
]);

/** A SIMD splat instruction is rejected by engines without fixed-width SIMD. */
const SIMD_PROBE = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x0b,
]);

function validates(bytes: Uint8Array): boolean {
  try {
    return typeof WebAssembly !== "undefined" && WebAssembly.validate(bytes as unknown as BufferSource);
  } catch {
    return false;
  }
}

function probeSharedMemory(): boolean {
  if (typeof SharedArrayBuffer === "undefined") return false;
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return memory.buffer instanceof SharedArrayBuffer && validates(SHARED_MEMORY_PROBE);
  } catch {
    return false;
  }
}

export function readRuntimeCapabilities(): RuntimeCapabilities {
  const hardwareConcurrency = Math.max(
    1,
    Math.floor(Number(globalThis.navigator?.hardwareConcurrency) || 1),
  );
  const crossOriginIsolated = globalThis.crossOriginIsolated === true;
  const sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
  const wasmThreads = crossOriginIsolated && sharedArrayBuffer && probeSharedMemory();
  const wasmSimd = validates(SIMD_PROBE);
  return {
    hardwareConcurrency,
    crossOriginIsolated,
    sharedArrayBuffer,
    wasmThreads,
    wasmSimd,
  };
}

function firstFallbackReason(capabilities: RuntimeCapabilities): string | undefined {
  if (!capabilities.crossOriginIsolated) return "crossOriginIsolated=false";
  if (!capabilities.sharedArrayBuffer) return "SharedArrayBuffer=false";
  if (!capabilities.wasmThreads) return "wasmThreadsProbe=false";
  return undefined;
}

export function resolveRuntimeConfig(
  requestedThreads: RuntimeThreadRequest,
  capabilities: RuntimeCapabilities,
): ResolvedRuntimeConfig {
  const fallbackReason = firstFallbackReason(capabilities);
  if (fallbackReason) {
    return {
      requestedThreads,
      actualThreads: 1,
      ...capabilities,
      fallbackReason,
      evidence: "single_thread_fallback",
    };
  }

  // The current measured stable baseline is four threads. Explicit 2/4
  // requests are used by the browser benchmark and rebuild the Worker. Auto
  // selects that measured candidate only after the same capability probe;
  // environments without the probe took the fallback branch above.
  const requested = requestedThreads === "auto"
    ? (capabilities.hardwareConcurrency >= 4 ? 4 : capabilities.hardwareConcurrency >= 2 ? 2 : 1)
    : requestedThreads;
  const bounded = Math.min(requested, Math.max(1, capabilities.hardwareConcurrency));
  const actualThreads: RuntimeThreadCount = bounded >= 4 ? 4 : bounded >= 2 ? 2 : 1;
  return {
    requestedThreads,
    actualThreads,
    ...capabilities,
    evidence: "wasm_threads_probe",
  };
}

export function defaultBatchSize(sampleCount: number, deviceMemory = 8): number {
  // The browser matrix measured 4 threads × 16 as the stable default. Keep
  // the same batch cap on smaller devices so memory pressure cannot silently
  // select a larger tensor; the actual sample count still clamps the tail.
  void deviceMemory;
  return Math.max(1, Math.min(sampleCount, CS_NET_MEASURED_DEFAULT_BATCH));
}

export interface BatchMeasurement {
  batchSize: number;
  inferenceMs: number;
  peakBatchBytes: number;
}

export function chooseFastestBatch(
  measurements: readonly BatchMeasurement[],
  fallback: number,
  maxBatchBytes: number,
): number {
  const viable = measurements
    .filter((measurement) => measurement.inferenceMs > 0)
    .filter((measurement) => measurement.peakBatchBytes <= maxBatchBytes)
    .sort((left, right) => left.inferenceMs - right.inferenceMs);
  return viable[0]?.batchSize ?? fallback;
}
