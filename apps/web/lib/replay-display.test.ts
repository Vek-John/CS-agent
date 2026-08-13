import { describe, expect, it } from "vitest";
import type { MatchEvent, MatchTimeline } from "@cs-coach/contracts";
import {
  formatEventType,
  formatMatchEvent,
  roundAtTick,
  windowedTrackSamples
} from "./replay-display";

const timeline = {
  start_tick: 0,
  end_tick: 256,
  rounds: [
    {
      round_number: 1,
      start_tick: 0,
      freeze_end_tick: 32,
      end_tick: 96,
      score_before: [0, 0],
      score_after: [1, 0],
      winner: "T"
    },
    {
      round_number: 2,
      start_tick: 128,
      freeze_end_tick: 160,
      end_tick: 224,
      score_before: [1, 0],
      score_after: [1, 1],
      winner: "CT"
    }
  ]
} as unknown as MatchTimeline;

describe("replay display helpers", () => {
  it("keeps only a short, ordered trajectory window", () => {
    const samples = [0, 64, 128, 192, 256].map((tick) => ({ tick }));

    expect(windowedTrackSamples(samples, 192, 64).map((sample) => sample.tick)).toEqual([0, 64, 128, 192]);
    expect(windowedTrackSamples(samples, 192, 64, 1).map((sample) => sample.tick)).toEqual([128, 192]);
  });

  it("resolves round HUD data without inventing a round in a boundary gap", () => {
    expect(roundAtTick(timeline, 48)?.round_number).toBe(1);
    expect(roundAtTick(timeline, 112)?.round_number).toBe(1);
    expect(roundAtTick(timeline, 180)?.round_number).toBe(2);
  });

  it("uses code-native event labels and player names", () => {
    const event: MatchEvent = {
      id: "event-1",
      tick: 12,
      event_type: "PLAYER_DEATH",
      actor_player_id: "p1",
      target_player_id: "p2",
      payload: {},
      source_parser_event: "player_death",
      fact_confidence: 1,
      fact_refs: [],
      missing_fields: []
    };

    expect(formatEventType("GRENADE_DETONATE")).toBe("投掷物生效");
    expect(formatMatchEvent(event, new Map([["p1", "Alpha"], ["p2", "Bravo"]]))).toBe("玩家阵亡 · Alpha → Bravo");
  });
});
