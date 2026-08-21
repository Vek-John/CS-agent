import { describe, expect, it } from "vitest";
import {
  buildWebGpuSessionOptions,
  classifyWebGpuError,
  configureWebGpuAdapter,
  configureWebGpuProfiling,
  classifyWebGpuOrtWarnings,
  createWebGpuTerminalError,
  createWebGpuFailureTelemetry,
  decideWebGpuFailure,
  CS_NET_DEFAULT_BATCH_SIZE,
  CS_NET_DEFAULT_PROVIDER,
} from "./runtime-webgpu";

describe("cs-net WebGPU PoC contract", () => {
  it("records an explicit failed capability gate without claiming GPU execution", async () => {
    const telemetry = await createWebGpuFailureTelemetry("WEBGPU_UNAVAILABLE:shader-f16", 7_239, 16);
    expect(telemetry.providerRequested).toBe("webgpu-fp16");
    expect(telemetry.providerActual).toBe("unavailable");
    expect(telemetry.fallbackDetection).toBe("FAILED");
    expect(telemetry.fallbackReason).toContain("shader-f16");
    expect(telemetry.ortSessionCreated).toBe(false);
    expect(telemetry.sampleCount).toBe(7_239);
    expect(telemetry.ortWarningCount).toBe(0);
    expect(telemetry.ortWarnings).toEqual([]);
    expect(telemetry.fallbackReason).toContain("WEBGPU_FAILURE");
  });

  it("uses WebGPU FP16 batch 16 as the explicit default", () => {
    expect(CS_NET_DEFAULT_PROVIDER).toBe("webgpu-fp16");
    expect(CS_NET_DEFAULT_BATCH_SIZE).toBe(16);
  });

  it("classifies abort, cancellation, timeout, and ordinary failures from error fields", () => {
    const abort = new Error("request superseded");
    abort.name = "AbortError";
    expect(classifyWebGpuError({ name: abort.name, code: "ABORT_ERR", message: abort.message })).toBe("ABORTED");
    expect(classifyWebGpuError({ code: "REQUEST_CANCELLED", message: "request was cancelled" })).toBe("ABORTED");
    expect(classifyWebGpuError({ name: "TimeoutError", code: "DEADLINE", message: "inference timed out" })).toBe("TIMEOUT");
    expect(classifyWebGpuError({ message: "ordinary ORT session failure" })).toBe("FAILURE");
  });

  it("falls back only for an ordinary WebGPU failure", () => {
    expect(decideWebGpuFailure(new Error("GPU session creation failed"))).toMatchObject({
      kind: "FAILURE",
      code: "WEBGPU_FAILURE",
      shouldFallback: true,
    });
    expect(decideWebGpuFailure({ name: "TimeoutError", message: "deadline exceeded" }).shouldFallback).toBe(false);
    expect(decideWebGpuFailure({ name: "AbortError", message: "request superseded" }).shouldFallback).toBe(false);
    expect(createWebGpuTerminalError(decideWebGpuFailure({ name: "TimeoutError", message: "deadline exceeded" }))).toMatchObject({
      name: "TimeoutError",
      code: "WEBGPU_TIMEOUT",
    });
  });

  it("keeps timeout and abort telemetry terminal instead of relabeling it as fallback", async () => {
    const timeout = await createWebGpuFailureTelemetry("deadline exceeded", 12, 16, "TIMEOUT");
    const aborted = await createWebGpuFailureTelemetry("request superseded", 12, 16, "ABORTED");
    expect(timeout.providerActual).toBe("unavailable");
    expect(timeout.fallbackReason).toMatch(/^WEBGPU_TIMEOUT:/);
    expect(aborted.providerActual).toBe("unavailable");
    expect(aborted.fallbackReason).toMatch(/^WEBGPU_ABORTED:/);
  });

  it("classifies ORT shape assignment warnings separately from profiling availability", () => {
    expect(classifyWebGpuOrtWarnings(["Some nodes were not assigned to the preferred execution providers"])).toBe("KNOWN_CPU_SHAPE_OPS_FROM_ORT_WARNING");
    expect(classifyWebGpuOrtWarnings([])).toBe("UNKNOWN");
  });

  it("configures only an adapter and never writes a probed device", () => {
    const env: { adapter?: unknown } = {};
    const adapter = { features: new Set(["shader-f16"]) };
    configureWebGpuAdapter(adapter, env);
    expect(env.adapter).toBe(adapter);
    expect("device" in env).toBe(false);

    const options = buildWebGpuSessionOptions(false);
    expect(options.executionProviders).toEqual(["webgpu"]);
    expect(options).not.toHaveProperty("device");
    expect(options).not.toHaveProperty("enableProfiling");
  });

  it("lazily creates profiling when the ORT surface is writable", () => {
    const env: { profiling?: { ondata?: unknown } } = {};
    const setup = configureWebGpuProfiling(env, true, () => {});
    expect(setup).toEqual({ enabled: true, reason: "" });
    expect(env.profiling).toBeDefined();
  });

  it("keeps profiling optional when the ORT surface is read-only", () => {
    const env = Object.freeze({});
    const setup = configureWebGpuProfiling(env, true, () => {});
    expect(setup).toEqual({ enabled: false, reason: "WEBGPU_PROFILING_UNAVAILABLE:profiling" });
  });

  it("enables profiling only when the ondata surface accepts the callback", () => {
    const env: { profiling: { ondata?: unknown } } = { profiling: {} };
    const callback = () => {};
    expect(configureWebGpuProfiling(env, true, callback)).toEqual({ enabled: true, reason: "" });
    expect(env.profiling.ondata).toBe(callback);
    expect(buildWebGpuSessionOptions(true).enableProfiling).toBe(true);
  });

  it("records an unsupported profiling callback without failing the session path", () => {
    const env = { profiling: Object.freeze({}) };
    const setup = configureWebGpuProfiling(env, true, () => {});
    expect(setup.enabled).toBe(false);
    expect(setup.reason).toBe("WEBGPU_PROFILING_UNAVAILABLE:ondata");
  });
});
