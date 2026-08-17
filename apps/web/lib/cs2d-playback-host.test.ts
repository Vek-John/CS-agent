import { describe, expect, it } from "vitest";
import { PLAYBACK_BRIDGE_CHANNEL, type ReviewPlan } from "@cs-coach/contracts";
import {
  acceptedPlaybackEvent,
  adjacentRoundIndex,
  cs2dHostConfig,
  HOST_SPEED_OPTIONS,
  playbackCommandMessage,
  playbackPositionLabel,
  reviewPositionAtTick,
  reviewSegmentLabel,
  reviewSegmentTone,
  seekCanonicalBySeconds,
  timelinePercent,
  timelineRange
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


  it("maps bridge position to round time without exposing canonical coordinates", () => {
    const replay = {
      type: "REPLAY_READY",
      schemaVersion: "cs2d-replay-ready.v1",
      map: "de_mirage",
      tickRate: 64,
      startCanonicalTick: 100,
      endCanonicalTick: 5000,
      roundCount: 2,
      rounds: [
        { roundIndex: 0, roundNumber: 1, startCanonicalTick: 100, endCanonicalTick: 2500 },
        { roundIndex: 1, roundNumber: 2, startCanonicalTick: 2600, endCanonicalTick: 5000 }
      ],
      players: [{ playerId: "p1", displayName: "Player", startSide: "T" }],
      freezeSkipped: true
    } as const;
    expect(playbackPositionLabel({ type: "PLAYBACK_STATE", roundIndex: 1, canonicalTick: 2920, playing: false, speed: 1 }, replay)).toBe("第 2 回合 · 0:05");
    expect(playbackPositionLabel(undefined, replay)).toBe("—");
  });
  it("maps a manual seek to the current round and ReviewPlan segment", () => {
    const replay = {
      type: "REPLAY_READY",
      schemaVersion: "cs2d-replay-ready.v1",
      map: "de_mirage",
      tickRate: 64,
      startCanonicalTick: 100,
      endCanonicalTick: 5000,
      roundCount: 2,
      rounds: [
        { roundIndex: 0, roundNumber: 1, startCanonicalTick: 100, endCanonicalTick: 2500 },
        { roundIndex: 1, roundNumber: 2, startCanonicalTick: 2600, endCanonicalTick: 5000 }
      ],
      players: [{ playerId: "p1", displayName: "Player", startSide: "T" }],
      freezeSkipped: true
    } as const;
    const plan = {
      id: "plan-1",
      segments: [{
        id: "segment-2", round_number: 2, start_tick: 2600, end_tick: 5000, mode: "WATCH",
        reason_code: "ORDINARY_PLAY", display_reason: "普通比赛内容", playback_speed: 1, cue_ids: [], expandable: false
      }],
      cues: [], habits: [], generated_at: "now", generation_manifest: {}
    } as never;
    const boundary = reviewPositionAtTick({ type: "PLAYBACK_STATE", roundIndex: 1, canonicalTick: 2500, playing: false, speed: 1 }, replay, plan);
    expect(boundary.roundLabel).toBe("比赛位置");
    const position = reviewPositionAtTick({ type: "PLAYBACK_STATE", roundIndex: 1, canonicalTick: 3000, playing: false, speed: 1 }, replay, plan);
    expect(position.roundLabel).toBe("第 2 回合");
    expect(position.segment?.display_reason).toBe("普通比赛内容");
  });

  it("sends compact command envelopes only", () => {
    const message = playbackCommandMessage({ type: "seekCanonicalTick", canonicalTick: 4096 });
    expect(message).toEqual({ channel: PLAYBACK_BRIDGE_CHANNEL, direction: "command", payload: { type: "seekCanonicalTick", canonicalTick: 4096 } });
    expect(JSON.stringify(message)).not.toMatch(/replay|frames|events/i);
  });

  it("maps ReviewPlan segments onto a bounded, player-facing timeline", () => {
    const segment = {
      id: "coach-1",
      round_number: 3,
      start_tick: 200,
      end_tick: 300,
      mode: "DEEP_DIVE",
      reason_code: "COACH_DECISION_POINT",
      display_reason: "关键接触前暂停",
      playback_speed: 1,
      cue_ids: ["cue-1"],
      expandable: false
    } satisfies ReviewPlan["segments"][number];

    expect(reviewSegmentTone(segment.mode)).toBe("coach");
    expect(reviewSegmentTone("HABIT_CHECK")).toBe("coach");
    expect(reviewSegmentTone("SKIP")).toBe("skip");
    expect(reviewSegmentTone("BRIEF")).toBe("neutral");
    expect(reviewSegmentLabel(segment)).toBe("深入讲解");
    expect(reviewSegmentLabel({ ...segment, mode: "SKIP" })).toBe("低价值片段");
    expect(timelinePercent(250, 100, 500)).toBe(37.5);
    expect(timelinePercent(-10, 0, 100)).toBe(0);
    expect(timelinePercent(120, 0, 100)).toBe(100);
    expect(timelinePercent(10, 10, 10)).toBe(0);
  });

  it("maps round and segment durations to proportional timeline ranges", () => {
    expect(timelineRange(100, 300, 100, 900)).toEqual({ leftPercent: 0, widthPercent: 25 });
    expect(timelineRange(300, 700, 100, 900)).toEqual({ leftPercent: 25, widthPercent: 50 });
    expect(timelineRange(0, 1000, 100, 900)).toEqual({ leftPercent: 0, widthPercent: 100 });
  });

  it("clamps fifteen-second seeks to the parsed match bounds", () => {
    expect(seekCanonicalBySeconds(640, -15, 64, 100, 5000)).toBe(100);
    expect(seekCanonicalBySeconds(4900, 15, 64, 100, 5000)).toBe(5000);
    expect(seekCanonicalBySeconds(640, 15, 64, 100, 5000)).toBe(1600);
  });

  it("clamps adjacent round navigation without producing invalid indexes", () => {
    expect(adjacentRoundIndex(0, -1, 9)).toBe(0);
    expect(adjacentRoundIndex(8, 1, 9)).toBe(8);
    expect(adjacentRoundIndex(4, -1, 9)).toBe(3);
    expect(adjacentRoundIndex(0, 1, 0)).toBe(-1);
  });

  it("exposes the complete host speed scale", () => {
    expect(HOST_SPEED_OPTIONS).toEqual([0.25, 0.5, 1, 2, 4, 8]);
  });
});
