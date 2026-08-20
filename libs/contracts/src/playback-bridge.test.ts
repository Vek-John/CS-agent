import { describe, expect, it } from "vitest";
import {
  PLAYBACK_BRIDGE_CHANNEL,
  commandEnvelope,
  isPlaybackCommandEnvelope,
  isPlaybackEventEnvelope
} from "./playback-bridge";

const ready = {
  channel: PLAYBACK_BRIDGE_CHANNEL,
  direction: "event",
  payload: {
    type: "REPLAY_READY",
    schemaVersion: "cs2d-replay-ready.v1",
    map: "de_mirage",
    tickRate: 64,
    startCanonicalTick: 10,
    endCanonicalTick: 1000,
    roundCount: 1,
    rounds: [{ roundIndex: 0, roundNumber: 1, startCanonicalTick: 10, endCanonicalTick: 1000 }],
    players: [{ playerId: "p1", displayName: "Player", startSide: "T" }],
    freezeSkipped: true
  }
} as const;

describe("cs2d playback bridge", () => {
  it("accepts only the compact event schema", () => {
    expect(isPlaybackEventEnvelope(ready)).toBe(true);
    expect(isPlaybackEventEnvelope({ ...ready, payload: { ...ready.payload, frames: [] } })).toBe(false);
    expect(JSON.stringify(ready)).not.toMatch(/\"(?:replay|frames|events)\"/i);
  });
  it("validates every command and rejects additional data", () => {
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "play" }))).toBe(true);
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "pause" }))).toBe(true);
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "seekCanonicalTick", canonicalTick: 123 }))).toBe(true);
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "selectRound", roundIndex: 2 }))).toBe(true);
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "setSpeed", speed: 8 }))).toBe(true);
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "setCamera", mode: "full" }))).toBe(true);
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "setCamera", mode: "target" }))).toBe(true);
    expect(isPlaybackCommandEnvelope({ ...commandEnvelope({ type: "play" }), replay: {} })).toBe(false);
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "selectRound", roundIndex: -1 }))).toBe(false);
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "setSpeed", speed: Number.NaN }))).toBe(false);
    expect(isPlaybackCommandEnvelope({
      channel: PLAYBACK_BRIDGE_CHANNEL,
      direction: "command",
      payload: { type: "setCamera", mode: "follow" }
    })).toBe(false);
    expect(isPlaybackCommandEnvelope({
      ...commandEnvelope({ type: "setCamera", mode: "full" }),
      payload: { type: "setCamera", mode: "full", playerId: "p1" }
    })).toBe(false);
  });
  it("rejects malformed event summaries", () => {
    expect(isPlaybackEventEnvelope({ ...ready, payload: { ...ready.payload, roundCount: 2 } })).toBe(false);
    expect(isPlaybackEventEnvelope({ ...ready, payload: { ...ready.payload, players: [] } })).toBe(false);
    expect(isPlaybackEventEnvelope({ ...ready, payload: { ...ready.payload, tickRate: 0 } })).toBe(false);
  });
  it("accepts only bounded analysis results and rejects raw Replay fields", () => {
    const analysis = {
      channel: PLAYBACK_BRIDGE_CHANNEL,
      direction: "event",
      payload: {
        type: "ANALYSIS_READY",
        schemaVersion: "cs2d-analysis-ready.v1",
        selectedPlayerId: "p1",
        bundleJson: "{\"demo_id\":\"d1\"}"
      }
    } as const;
    expect(isPlaybackEventEnvelope(analysis)).toBe(true);
    expect(isPlaybackEventEnvelope({
      ...analysis,
      payload: { ...analysis.payload, rawReplay: {} }
    })).toBe(false);
    expect(isPlaybackEventEnvelope({
      channel: PLAYBACK_BRIDGE_CHANNEL,
      direction: "event",
      payload: {
        type: "ANALYSIS_FAILED",
        schemaVersion: "cs2d-analysis-failed.v1",
        selectedPlayerId: "p1",
        message: "unsupported map"
      }
    })).toBe(true);
    expect(isPlaybackEventEnvelope({
      channel: PLAYBACK_BRIDGE_CHANNEL,
      direction: "event",
      payload: {
        type: "ANALYSIS_FAILED",
        schemaVersion: "cs2d-analysis-ready.v1",
        selectedPlayerId: "p1",
        message: "unsupported map"
      }
    })).toBe(false);
  });

  it("accepts real model progress phases without allowing Replay payloads", () => {
    const progress = {
      channel: PLAYBACK_BRIDGE_CHANNEL,
      direction: "event",
      payload: {
        type: "ANALYSIS_PROGRESS",
        schemaVersion: "cs2d-analysis-progress.v1",
        selectedPlayerId: "p1",
        phase: "inference",
        completed: 42,
        total: 128,
        detail: "42/128"
      }
    } as const;
    expect(isPlaybackEventEnvelope(progress)).toBe(true);
    expect(isPlaybackEventEnvelope({ ...progress, payload: { ...progress.payload, replay: {} } })).toBe(false);
    expect(isPlaybackEventEnvelope({ ...progress, payload: { ...progress.payload, phase: "ready" } })).toBe(false);
  });

  it("accepts bounded runtime telemetry without accepting raw model inputs", () => {
    const telemetry = {
      schemaVersion: "cs-net-runtime-telemetry.v1",
      fetchMs: 1, sessionCreateMs: 2, warmupMs: 3, featureBuildMs: 4,
      tensorPrepareMs: 5, inferenceMs: 6, serializationMs: 7, totalMs: 8,
      sampleCount: 9, threadsRequested: "auto", threadsActual: 1,
      threadsEvidence: "single_thread_fallback", batchSize: 8,
      requestedBatchSize: 8, samplesPerSecond: 1, peakBatchBytes: 1024,
      hardwareConcurrency: 8, crossOriginIsolated: false,
      sharedArrayBuffer: false, wasmThreads: false, wasmSimd: true,
      fallbackReason: "crossOriginIsolated=false"
    } as const;
    const event = {
      channel: PLAYBACK_BRIDGE_CHANNEL,
      direction: "event",
      payload: {
        type: "ANALYSIS_TELEMETRY",
        schemaVersion: "cs2d-analysis-telemetry.v1",
        selectedPlayerId: "p1",
        telemetry
      }
    } as const;
    expect(isPlaybackEventEnvelope(event)).toBe(true);
    expect(isPlaybackEventEnvelope({
      ...event,
      payload: { ...event.payload, telemetry: { ...telemetry, rawReplay: {} } }
    })).toBe(false);
  });

  it("accepts WebGPU FP16 telemetry with explicit unknown purity", () => {
    const telemetry = {
      schemaVersion: "cs-net-webgpu-telemetry.v1",
      providerRequested: "webgpu-fp16",
      providerActual: "webgpu-fp16",
      precision: "FP16",
      modelSha256: "94ef9a19ff5e3d2e122e57fd0fb2a79c670f14746d79399c1352ab9b25742f63",
      onnxruntimeVersion: "1.27.0",
      fetchMs: 1, sessionCreateMs: 2, warmupMs: 3, featureBuildMs: 4,
      tensorUploadMs: 5, gpuInferenceMs: 6, outputReadbackMs: 7,
      serializationMs: 8, totalMs: 9, sampleCount: 10, batchSize: 16,
      samplesPerSecond: 1, modelBytes: 20, inputBytes: 21, outputBytes: 22,
      estimatedPeakGpuBytes: 23,
      capability: {
        navigatorGpu: true, workerNavigatorGpu: true, adapterAvailable: true,
        deviceAvailable: true, shaderF16: true, adapterInfo: "adapter",
        deviceInfo: "device", deviceFeatures: ["shader-f16"],
      },
      ortSessionCreated: true, profileKernelCount: 1, profileKernelMs: 0.5,
      fallbackDetection: "UNKNOWN", fallbackReason: "",
    } as const;
    const event = {
      channel: PLAYBACK_BRIDGE_CHANNEL,
      direction: "event",
      payload: {
        type: "ANALYSIS_TELEMETRY",
        schemaVersion: "cs2d-analysis-telemetry.v1",
        selectedPlayerId: "p1",
        telemetry,
      },
    } as const;
    expect(isPlaybackEventEnvelope(event)).toBe(true);
    expect(isPlaybackEventEnvelope({
      ...event,
      payload: { ...event.payload, telemetry: { ...telemetry, fallbackDetection: "not-proven" } },
    })).toBe(false);
  });
});
