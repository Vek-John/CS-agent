import { describe, expect, it } from "vitest";
import {
  chooseFastestBatch,
  defaultBatchSize,
  readRuntimeCapabilities,
  resolveRuntimeConfig,
} from "./runtime-config";

describe("cs-net runtime capability contract", () => {
  it("falls back to one thread when isolation or the probe is missing", () => {
    const result = resolveRuntimeConfig("auto", {
      hardwareConcurrency: 8,
      crossOriginIsolated: false,
      sharedArrayBuffer: false,
      wasmThreads: false,
      wasmSimd: true,
    });
    expect(result.actualThreads).toBe(1);
    expect(result.evidence).toBe("single_thread_fallback");
    expect(result.fallbackReason).toBe("crossOriginIsolated=false");
  });

  it("uses an explicit candidate only after a positive capability probe", () => {
    const result = resolveRuntimeConfig(4, {
      hardwareConcurrency: 4,
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      wasmThreads: true,
      wasmSimd: true,
    });
    expect(result.actualThreads).toBe(4);
    expect(result.evidence).toBe("wasm_threads_probe");
  });

  it("bounds explicit candidates by hardware concurrency", () => {
    expect(resolveRuntimeConfig(4, {
      hardwareConcurrency: 2,
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      wasmThreads: true,
      wasmSimd: true,
    }).actualThreads).toBe(2);
  });

  it("uses the measured four-thread candidate for auto after the positive probe", () => {
    const result = resolveRuntimeConfig("auto", {
      hardwareConcurrency: 8,
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      wasmThreads: true,
      wasmSimd: true,
    });
    expect(result.actualThreads).toBe(4);
    expect(result.evidence).toBe("wasm_threads_probe");
    expect(result.fallbackReason).toBeUndefined();
  });

  it("chooses the fastest viable measured batch using byte limits", () => {
    expect(chooseFastestBatch([
      { batchSize: 32, inferenceMs: 22, peakBatchBytes: 20 },
      { batchSize: 64, inferenceMs: 15, peakBatchBytes: 40 },
      { batchSize: 128, inferenceMs: 8, peakBatchBytes: 200 },
    ], 32, 100)).toBe(64);
  });

  it("keeps conservative defaults on low-memory devices", () => {
    expect(defaultBatchSize(1000, 2)).toBe(16);
    expect(defaultBatchSize(1000, 4)).toBe(16);
    expect(defaultBatchSize(1000, 16)).toBe(16);
    expect(defaultBatchSize(12, 16)).toBe(12);
  });

  it("detects SIMD independently from the thread gate", () => {
    expect(readRuntimeCapabilities().wasmSimd).toBe(true);
  });
});
