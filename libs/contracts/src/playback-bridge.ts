/** Compact control plane between the Next coaching shell and the cs2d iframe. */
export const PLAYBACK_BRIDGE_CHANNEL = "cs2d-playback-bridge.v1" as const;

export interface PlaybackPlayerSummary {
  playerId: string;
  displayName: string;
  startSide: "T" | "CT";
}
export interface PlaybackRoundSummary {
  roundIndex: number;
  roundNumber: number;
  startCanonicalTick: number;
  endCanonicalTick: number;
}
export interface ReplayReadyEvent {
  type: "REPLAY_READY";
  schemaVersion: "cs2d-replay-ready.v1";
  map: string;
  tickRate: number;
  startCanonicalTick: number;
  endCanonicalTick: number;
  roundCount: number;
  rounds: readonly PlaybackRoundSummary[];
  players: readonly PlaybackPlayerSummary[];
  freezeSkipped: true;
}
export interface PlayerSelectedEvent {
  type: "PLAYER_SELECTED";
  playerId: string;
  displayName: string;
  side: "T" | "CT";
  selectionIndex: number;
}
export interface PlaybackStateEvent {
  type: "PLAYBACK_STATE";
  roundIndex: number;
  canonicalTick: number;
  playing: boolean;
  speed: number;
}
export interface AnalysisReadyEvent {
  type: "ANALYSIS_READY";
  schemaVersion: "cs2d-analysis-ready.v1";
  selectedPlayerId: string;
  /** Strictly validated adapter output; the raw Replay never crosses the iframe. */
  bundleJson: string;
}
export interface AnalysisFailedEvent {
  type: "ANALYSIS_FAILED";
  schemaVersion: "cs2d-analysis-failed.v1";
  selectedPlayerId: string;
  message: string;
}
export interface AnalysisProgressEvent {
  type: "ANALYSIS_PROGRESS";
  schemaVersion: "cs2d-analysis-progress.v1";
  selectedPlayerId: string;
  phase: "downloading" | "inference" | "unavailable";
  completed: number;
  total: number;
  detail: string;
}
export interface AnalysisWasmTelemetry {
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
  threadsRequested: "auto" | 1 | 2 | 4;
  threadsActual: 1 | 2 | 4;
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
export interface AnalysisWebGpuTelemetry {
  schemaVersion: "cs-net-webgpu-telemetry.v1";
  providerRequested: "webgpu-fp16";
  providerActual: "webgpu-fp16" | "wasm-int8" | "unavailable";
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
  capability: {
    navigatorGpu: boolean;
    workerNavigatorGpu: boolean;
    adapterAvailable: boolean;
    deviceAvailable: boolean;
    shaderF16: boolean;
    adapterInfo: string;
    deviceInfo: string;
    deviceFeatures: readonly string[];
  };
  ortSessionCreated: boolean;
  profileKernelCount: number;
  profileKernelMs: number;
  ortWarningCount: number;
  ortWarnings: readonly string[];
  fallbackDetection: "PROVEN" | "UNKNOWN" | "FAILED" | "KNOWN_CPU_SHAPE_OPS_FROM_ORT_WARNING";
  fallbackReason: string;
}
export type AnalysisTelemetry = AnalysisWasmTelemetry | AnalysisWebGpuTelemetry;
export interface AnalysisTelemetryEvent {
  type: "ANALYSIS_TELEMETRY";
  schemaVersion: "cs2d-analysis-telemetry.v1";
  selectedPlayerId: string;
  telemetry: AnalysisTelemetry;
}
export type PlaybackBridgeEvent =
  | ReplayReadyEvent
  | PlayerSelectedEvent
  | PlaybackStateEvent
  | AnalysisReadyEvent
  | AnalysisProgressEvent
  | AnalysisTelemetryEvent
  | AnalysisFailedEvent;
export type PlaybackCameraMode = "full" | "target";

export type PlaybackCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "seekCanonicalTick"; canonicalTick: number }
  | { type: "selectRound"; roundIndex: number }
  | { type: "setSpeed"; speed: number }
  | { type: "setCamera"; mode: PlaybackCameraMode };

export interface PlaybackEventEnvelope {
  channel: typeof PLAYBACK_BRIDGE_CHANNEL;
  direction: "event";
  payload: PlaybackBridgeEvent;
}
export interface PlaybackCommandEnvelope {
  channel: typeof PLAYBACK_BRIDGE_CHANNEL;
  direction: "command";
  payload: PlaybackCommand;
}
export type PlaybackBridgeEnvelope = PlaybackEventEnvelope | PlaybackCommandEnvelope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function safeIndex(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 0;
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isSide(value: unknown): value is "T" | "CT" {
  return value === "T" || value === "CT";
}
function isTelemetry(value: unknown): value is AnalysisTelemetry {
  if (!isRecord(value)) return false;
  if (value.schemaVersion === "cs-net-runtime-telemetry.v1") {
    const numeric = ["fetchMs", "sessionCreateMs", "warmupMs", "featureBuildMs", "tensorPrepareMs", "inferenceMs", "serializationMs", "totalMs", "sampleCount", "batchSize", "requestedBatchSize", "samplesPerSecond", "peakBatchBytes", "hardwareConcurrency"];
    return exactKeys(value, ["schemaVersion", ...numeric, "threadsRequested", "threadsActual", "threadsEvidence", "crossOriginIsolated", "sharedArrayBuffer", "wasmThreads", "wasmSimd", "fallbackReason"]) &&
      numeric.every((key) => finite(value[key]) && (value[key] as number) >= 0) &&
      (value.threadsRequested === "auto" || value.threadsRequested === 1 || value.threadsRequested === 2 || value.threadsRequested === 4) &&
      (value.threadsActual === 1 || value.threadsActual === 2 || value.threadsActual === 4) &&
      (value.threadsEvidence === "wasm_threads_probe" || value.threadsEvidence === "single_thread_fallback" || value.threadsEvidence === "stable_default") &&
      typeof value.crossOriginIsolated === "boolean" && typeof value.sharedArrayBuffer === "boolean" && typeof value.wasmThreads === "boolean" && typeof value.wasmSimd === "boolean" &&
      typeof value.fallbackReason === "string" && value.fallbackReason.length <= 128;
  }
  if (value.schemaVersion === "cs-net-webgpu-telemetry.v1") {
    const numeric = ["fetchMs", "sessionCreateMs", "warmupMs", "featureBuildMs", "tensorUploadMs", "gpuInferenceMs", "outputReadbackMs", "serializationMs", "totalMs", "sampleCount", "batchSize", "samplesPerSecond", "modelBytes", "inputBytes", "outputBytes", "estimatedPeakGpuBytes", "profileKernelCount", "profileKernelMs", "ortWarningCount"];
    const capability = value.capability;
    return exactKeys(value, ["schemaVersion", "providerRequested", "providerActual", "precision", "modelSha256", "onnxruntimeVersion", ...numeric, "capability", "ortSessionCreated", "ortWarnings", "fallbackDetection", "fallbackReason"]) &&
      numeric.every((key) => finite(value[key]) && (value[key] as number) >= 0) &&
      value.providerRequested === "webgpu-fp16" && (value.providerActual === "webgpu-fp16" || value.providerActual === "wasm-int8" || value.providerActual === "unavailable") && value.precision === "FP16" &&
      typeof value.modelSha256 === "string" && value.modelSha256.length <= 128 && typeof value.onnxruntimeVersion === "string" && value.onnxruntimeVersion.length <= 64 &&
      isRecord(capability) && exactKeys(capability, ["navigatorGpu", "workerNavigatorGpu", "adapterAvailable", "deviceAvailable", "shaderF16", "adapterInfo", "deviceInfo", "deviceFeatures"]) &&
      typeof capability.navigatorGpu === "boolean" && typeof capability.workerNavigatorGpu === "boolean" && typeof capability.adapterAvailable === "boolean" && typeof capability.deviceAvailable === "boolean" && typeof capability.shaderF16 === "boolean" &&
      typeof capability.adapterInfo === "string" && capability.adapterInfo.length <= 256 && typeof capability.deviceInfo === "string" && capability.deviceInfo.length <= 256 &&
      Array.isArray(capability.deviceFeatures) && capability.deviceFeatures.every((item) => typeof item === "string" && item.length <= 64) &&
      typeof value.ortSessionCreated === "boolean" && Array.isArray(value.ortWarnings) && value.ortWarnings.length <= 32 && value.ortWarnings.every((warning) => typeof warning === "string" && warning.length <= 512) &&
      (value.fallbackDetection === "PROVEN" || value.fallbackDetection === "UNKNOWN" || value.fallbackDetection === "FAILED" || value.fallbackDetection === "KNOWN_CPU_SHAPE_OPS_FROM_ORT_WARNING") && typeof value.fallbackReason === "string" && value.fallbackReason.length <= 512;
  }
  return false;
}
function isPlayer(value: unknown): value is PlaybackPlayerSummary {
  return isRecord(value) && exactKeys(value, ["playerId", "displayName", "startSide"]) &&
    nonEmpty(value.playerId) && nonEmpty(value.displayName) && isSide(value.startSide);
}
function isRound(value: unknown): value is PlaybackRoundSummary {
  return isRecord(value) && exactKeys(value, ["roundIndex", "roundNumber", "startCanonicalTick", "endCanonicalTick"]) &&
    safeIndex(value.roundIndex) && Number.isInteger(value.roundNumber) &&
    finite(value.startCanonicalTick) && finite(value.endCanonicalTick) && value.endCanonicalTick >= value.startCanonicalTick;
}
function isEvent(value: unknown): value is PlaybackBridgeEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "REPLAY_READY") {
    if (!exactKeys(value, ["type", "schemaVersion", "map", "tickRate", "startCanonicalTick", "endCanonicalTick", "roundCount", "rounds", "players", "freezeSkipped"])) return false;
    return value.schemaVersion === "cs2d-replay-ready.v1" && nonEmpty(value.map) && finite(value.tickRate) && value.tickRate > 0 &&
      finite(value.startCanonicalTick) && finite(value.endCanonicalTick) && value.endCanonicalTick >= value.startCanonicalTick &&
      safeIndex(value.roundCount) && Array.isArray(value.rounds) && value.rounds.length === value.roundCount && value.rounds.every(isRound) &&
      Array.isArray(value.players) && value.players.length > 0 && value.players.length <= 64 && value.players.every(isPlayer) &&
      value.freezeSkipped === true;
  }
  if (value.type === "PLAYER_SELECTED") {
    return exactKeys(value, ["type", "playerId", "displayName", "side", "selectionIndex"]) &&
      nonEmpty(value.playerId) && nonEmpty(value.displayName) && isSide(value.side) && safeIndex(value.selectionIndex);
  }
  if (value.type === "PLAYBACK_STATE") {
    return exactKeys(value, ["type", "roundIndex", "canonicalTick", "playing", "speed"]) && safeIndex(value.roundIndex) &&
      finite(value.canonicalTick) && typeof value.playing === "boolean" && finite(value.speed) && value.speed > 0 && value.speed <= 16;
  }
  if (value.type === "ANALYSIS_READY") {
    return exactKeys(value, ["type", "schemaVersion", "selectedPlayerId", "bundleJson"]) &&
      value.schemaVersion === "cs2d-analysis-ready.v1" && nonEmpty(value.selectedPlayerId) &&
      nonEmpty(value.bundleJson) && value.bundleJson.length <= 32 * 1024 * 1024;
  }
  if (value.type === "ANALYSIS_FAILED") {
    return exactKeys(value, ["type", "schemaVersion", "selectedPlayerId", "message"]) &&
      value.schemaVersion === "cs2d-analysis-failed.v1" && nonEmpty(value.selectedPlayerId) &&
      nonEmpty(value.message) && value.message.length <= 512;
  }
  if (value.type === "ANALYSIS_PROGRESS") {
    return exactKeys(value, ["type", "schemaVersion", "selectedPlayerId", "phase", "completed", "total", "detail"]) &&
      value.schemaVersion === "cs2d-analysis-progress.v1" && nonEmpty(value.selectedPlayerId) &&
      (value.phase === "downloading" || value.phase === "inference" || value.phase === "unavailable") &&
      finite(value.completed) && value.completed >= 0 && finite(value.total) && value.total >= 0 &&
      typeof value.detail === "string" && value.detail.length <= 256;
  }
  if (value.type === "ANALYSIS_TELEMETRY") {
    return exactKeys(value, ["type", "schemaVersion", "selectedPlayerId", "telemetry"]) &&
      value.schemaVersion === "cs2d-analysis-telemetry.v1" && nonEmpty(value.selectedPlayerId) && isTelemetry(value.telemetry);
  }
  return false;
}

export function isPlaybackCommandEnvelope(value: unknown): value is PlaybackCommandEnvelope {
  if (!isRecord(value) || !exactKeys(value, ["channel", "direction", "payload"]) || value.channel !== PLAYBACK_BRIDGE_CHANNEL || value.direction !== "command") return false;
  const payload = value.payload;
  if (!isRecord(payload) || typeof payload.type !== "string") return false;
  if (payload.type === "play" || payload.type === "pause") return exactKeys(payload, ["type"]);
  if (payload.type === "seekCanonicalTick") return exactKeys(payload, ["type", "canonicalTick"]) && finite(payload.canonicalTick);
  if (payload.type === "selectRound") return exactKeys(payload, ["type", "roundIndex"]) && safeIndex(payload.roundIndex);
  if (payload.type === "setSpeed") return exactKeys(payload, ["type", "speed"]) && finite(payload.speed) && payload.speed > 0 && payload.speed <= 16;
  if (payload.type === "setCamera") return exactKeys(payload, ["type", "mode"]) && (payload.mode === "full" || payload.mode === "target");
  return false;
}

export function isPlaybackEventEnvelope(value: unknown): value is PlaybackEventEnvelope {
  return isRecord(value) && exactKeys(value, ["channel", "direction", "payload"]) &&
    value.channel === PLAYBACK_BRIDGE_CHANNEL && value.direction === "event" && isEvent(value.payload);
}
export function eventEnvelope(payload: PlaybackBridgeEvent): PlaybackEventEnvelope {
  return { channel: PLAYBACK_BRIDGE_CHANNEL, direction: "event", payload };
}
export function commandEnvelope(payload: PlaybackCommand): PlaybackCommandEnvelope {
  return { channel: PLAYBACK_BRIDGE_CHANNEL, direction: "command", payload };
}
