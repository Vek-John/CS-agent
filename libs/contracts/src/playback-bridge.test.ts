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
    expect(isPlaybackCommandEnvelope({ ...commandEnvelope({ type: "play" }), replay: {} })).toBe(false);
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "selectRound", roundIndex: -1 }))).toBe(false);
    expect(isPlaybackCommandEnvelope(commandEnvelope({ type: "setSpeed", speed: Number.NaN }))).toBe(false);
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
        schemaVersion: "cs2d-analysis-ready.v1",
        selectedPlayerId: "p1",
        message: "unsupported map"
      }
    })).toBe(true);
  });
});
