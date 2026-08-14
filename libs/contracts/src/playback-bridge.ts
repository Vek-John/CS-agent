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
  schemaVersion: "cs2d-analysis-ready.v1";
  selectedPlayerId: string;
  message: string;
}
export type PlaybackBridgeEvent =
  | ReplayReadyEvent
  | PlayerSelectedEvent
  | PlaybackStateEvent
  | AnalysisReadyEvent
  | AnalysisFailedEvent;
export type PlaybackCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "seekCanonicalTick"; canonicalTick: number }
  | { type: "selectRound"; roundIndex: number }
  | { type: "setSpeed"; speed: number };

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
      value.schemaVersion === "cs2d-analysis-ready.v1" && nonEmpty(value.selectedPlayerId) &&
      nonEmpty(value.message) && value.message.length <= 512;
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
