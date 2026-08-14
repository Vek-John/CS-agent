import { describe, expect, it } from "vitest";
import { PLAYBACK_BRIDGE_CHANNEL } from "@cs-coach/contracts";
import {
  acceptedPlaybackEvent,
  cs2dHostConfig,
  playbackCommandMessage
} from "./cs2d-playback-host";

const event = {
  channel: PLAYBACK_BRIDGE_CHANNEL,
  direction: "event",
  payload: {
    type: "PLAYBACK_STATE",
    roundIndex: 0,
    canonicalTick: 640,
    playing: false,
    speed: 1
  }
} as const;

describe("cs2d localhost host boundary", () => {
  it("normalizes the host flag and origin", () => {
    expect(cs2dHostConfig("http://localhost:5174/path?x=1", "http://localhost:3000/review")).toEqual({
      url: "http://localhost:5174/path?x=1&host=1&parentOrigin=http%3A%2F%2Flocalhost%3A3000",
      origin: "http://localhost:5174"
    });
    expect(() => cs2dHostConfig("file:///tmp/index.html")).toThrow(/http/);
    expect(() => cs2dHostConfig(undefined, "file:///tmp/parent.html")).toThrow(/parent origin/);
    expect(() => cs2dHostConfig("https://replay.example.com/")).toThrow(/localhost/);
  });
  it("requires both iframe source and exact origin", () => {
    expect(acceptedPlaybackEvent({ data: event, eventOrigin: "http://localhost:5174", expectedOrigin: "http://localhost:5174", sourceMatches: true })).toEqual(event);
    expect(acceptedPlaybackEvent({ data: event, eventOrigin: "http://127.0.0.1:5174", expectedOrigin: "http://localhost:5174", sourceMatches: true })).toBeUndefined();
    expect(acceptedPlaybackEvent({ data: event, eventOrigin: "http://localhost:5174", expectedOrigin: "http://localhost:5174", sourceMatches: false })).toBeUndefined();
  });
  it("sends compact command envelopes only", () => {
    const message = playbackCommandMessage({ type: "seekCanonicalTick", canonicalTick: 4096 });
    expect(message).toEqual({ channel: PLAYBACK_BRIDGE_CHANNEL, direction: "command", payload: { type: "seekCanonicalTick", canonicalTick: 4096 } });
    expect(JSON.stringify(message)).not.toMatch(/replay|frames|events/i);
  });
});
