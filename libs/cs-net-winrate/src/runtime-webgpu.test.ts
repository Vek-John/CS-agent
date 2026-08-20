import { describe, expect, it } from "vitest";
import { createWebGpuFailureTelemetry } from "./runtime-webgpu";

describe("cs-net WebGPU PoC contract", () => {
  it("records an explicit failed capability gate without claiming GPU execution", async () => {
    const telemetry = await createWebGpuFailureTelemetry("WEBGPU_UNAVAILABLE:shader-f16", 7_239, 16);
    expect(telemetry.providerRequested).toBe("webgpu-fp16");
    expect(telemetry.providerActual).toBe("wasm-int8");
    expect(telemetry.fallbackDetection).toBe("FAILED");
    expect(telemetry.fallbackReason).toContain("shader-f16");
    expect(telemetry.ortSessionCreated).toBe(false);
    expect(telemetry.sampleCount).toBe(7_239);
  });
});
