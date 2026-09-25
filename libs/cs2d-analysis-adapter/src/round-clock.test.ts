import { describe, expect, it } from "vitest";
import type { ObservableState } from "@cs-coach/contracts";
import { buildDecisionSnapshot, buildObservableDecisionContext } from "./decision-context";
import type { Cs2dFrame, Cs2dRound } from "./index";
import { publicRoundClockFact, readRoundClock, type Cs2dRoundClockSample } from "./round-clock";

// These numeric clock fields are the small record returned by the native Demo
// probe. The surrounding roster/round and all mutations below are synthetic.
const probeSample: Cs2dRoundClockSample = {
  source: "SOURCE2_GAMERULES", sampledAtTick: 3081, serverTick: 7545,
  tickInterval: 0.015625, roundStartTimeSeconds: 97.265625,
  roundDurationSeconds: 115, roundsPlayed: 0,
  freeze: false, warmup: false, bombPlanted: false, roundWinStatus: 0,
  paused: false, totalPausedTicks: 0, pauseObserved: false, clockContinuous: true,
};

function fixture(clock: Cs2dRoundClockSample | undefined = probeSample): Cs2dRound {
  return {
    number: 1, freezeStartTick: 1000, startTick: 1760,
    decidedTick: 7000, endTick: 7100, postEndTick: 7200,
    scoreT: 0, scoreCt: 0, winner: "CT", events: [], grenadePaths: [],
    frames: [{ tick: 3081, t: 32.515625, clock, players: Array.from({ length: 10 }, (_, i) => ({
      steamId: `p${i}`, side: i < 5 ? "T" as const : "CT" as const,
      alive: true, health: 100, armor: 100, helmet: true, weapon: "ak47",
      money: 1000, equipValue: 3700, grenades: [], x: i * 100, y: 0, z: 0, yaw: 0,
    })) }],
  };
}

function snapshot(round = fixture(), decisionTick = 3081) {
  return buildDecisionSnapshot({ round, decisionTick, tickRate: 64,
    selectedPlayerId: "p0", snapshotId: "clock-boundary-test",
    rosterIds: Array.from({ length: 10 }, (_, i) => `p${i}`) });
}

function clockFor(patch: Partial<Cs2dRoundClockSample>) {
  const round = fixture({ ...probeSample, ...patch });
  return readRoundClock(round, round.frames[0], 3081, 64);
}

describe("public round clock at the decision boundary", () => {
  it("uses the observed server time domain and carries the probe record into public teaching facts", () => {
    const value = snapshot();
    expect(value.clock).toMatchObject({ boundary: "OBSERVABLE", evidenceRefs: ["cs2d-r1-clock-3081"],
      value: { phase: "LIVE", elapsedSeconds: 20.625, remainingSeconds: 94.375 } });
    expect(value.missingFields).not.toContain("round_timer");
    const state: ObservableState = { id: "obs", demo_id: "fixture", timeline_version: "test",
      observer_player_id: "p0", at_tick: 3081, observation_version: "test", claims: [], limitations: [] };
    const context = buildObservableDecisionContext(value, state);
    expect(context.publicFacts).toContain("决策前最近采样的回合剩余时间约95秒。");
    expect(JSON.stringify(context)).not.toMatch(/serverTick|tickInterval|roundStartTimeSeconds|7545|97\.265625/);
    expect(value.pressureChecks.find(check => check.code === "objectiveAllowsDelay")).toMatchObject({
      status: "UNVERIFIABLE", missingFields: expect.arrayContaining(["line_of_sight", "safe_reachable_cover"]),
    });
  });

  it("does not change the decision clock when later outcomes, kills, planting or samples change", () => {
    const round = fixture();
    const changed: Cs2dRound = { ...round, endTick: 8000, decidedTick: 7900, winner: "T",
      events: [
        { type: "kill", tick: 3082, t: 33, attackerSteamId: "p5", victimSteamId: "p0",
          assisterSteamId: null, assistedFlash: false, weapon: "ak47", headshot: true, x: 0, y: 0, z: 0 },
        { type: "bomb_planted", tick: 3100, t: 34, playerSteamId: "p1" },
      ],
      frames: [...round.frames, { ...round.frames[0], tick: 3082,
        clock: { ...probeSample, sampledAtTick: 3082, roundDurationSeconds: 999 } }],
    };
    expect(snapshot(changed)).toEqual(snapshot(round));
  });

  it("rejects unavailable, future, mismatched, stale or previous-round samples", () => {
    const round = fixture();
    const frame = round.frames[0];
    const cases: [Cs2dRound, Cs2dFrame | undefined, number][] = [
      [round, undefined, 3081],
      [round, { ...frame, clock: undefined }, 3081],
      [round, frame, 3080],
      [round, { ...frame, clock: { ...probeSample, sampledAtTick: 3080 } }, 3081],
      [round, frame, 3114],
      [{ ...round, number: 2, freezeStartTick: 3082 }, frame, 3082],
    ];
    for (const [current, sampleFrame, decisionTick] of cases) {
      const result = readRoundClock(current, sampleFrame, decisionTick, 64);
      expect(result.value?.remainingSeconds).toBeNull();
      expect(publicRoundClockFact(result)).toBeUndefined();
    }
    const legacy = snapshot({ ...round, frames: [{ ...frame, clock: undefined }] });
    expect(legacy.missingFields).toContain("round_timer");
    expect(legacy.pressureChecks[0].status).toBe("UNVERIFIABLE");
  });

  it.each([
    ["freeze", { freeze: true }, "FREEZE"],
    ["warmup", { warmup: true }, "UNKNOWN"],
    ["unconfirmed freeze", { freeze: null }, "UNKNOWN"],
    ["round ended", { roundWinStatus: 1 }, "POST_ROUND"],
    ["planted bomb", { bombPlanted: true }, "LIVE"],
    ["unconfirmed bomb", { bombPlanted: null }, "LIVE"],
    ["pause", { paused: true }, "LIVE"],
    ["unconfirmed pause", { paused: null }, "LIVE"],
    ["earlier observed pause", { pauseObserved: true }, "LIVE"],
    ["nonzero paused ticks", { totalPausedTicks: 64 }, "LIVE"],
    ["unknown paused ticks", { totalPausedTicks: null }, "LIVE"],
    ["discontinuous server clock", { clockContinuous: false }, "LIVE"],
    ["round mismatch", { roundsPlayed: 1 }, "UNKNOWN"],
  ] as const)("keeps %s outside the normal live countdown", (_name, patch, phase) => {
    const clock = clockFor(patch);
    expect(clock.value).toEqual({ phase, elapsedSeconds: null, remainingSeconds: null });
    expect(publicRoundClockFact(clock)).toBeUndefined();
  });

  it("invalidates a still-fresh clock when planting occurs between its sample and the decision", () => {
    const round: Cs2dRound = { ...fixture(), events: [
      { type: "bomb_planted", tick: 3082, t: 33, playerSteamId: "p1" },
    ] };
    expect(snapshot(round, 3081).clock.value?.remainingSeconds).toBe(94.375);
    const afterPlant = snapshot(round, 3083);
    expect(afterPlant.clock.value?.remainingSeconds).toBeNull();
    expect(afterPlant.bomb.value).toMatchObject({ state: "PLANTED", remainingSeconds: null });
    expect(publicRoundClockFact(afterPlant.clock)).toBeUndefined();
  });

  it.each([
    ["missing server tick", { serverTick: undefined }],
    ["sentinel server tick", { serverTick: 0xffff_ffff }],
    ["fractional server tick", { serverTick: 7545.5 }],
    ["negative server tick", { serverTick: -1 }],
    ["missing interval", { tickInterval: null }],
    ["invalid interval", { tickInterval: Number.NaN }],
    ["zero interval", { tickInterval: 0 }],
    ["missing duration", { roundDurationSeconds: null }],
    ["zero duration", { roundDurationSeconds: 0 }],
    ["missing start", { roundStartTimeSeconds: null }],
    ["future start", { roundStartTimeSeconds: 120 }],
    ["negative start", { roundStartTimeSeconds: -1 }],
    ["elapsed beyond duration", { roundStartTimeSeconds: 0 }],
    ["exactly expired", { roundStartTimeSeconds: 2.890625 }],
  ] as const)("preserves unknown for %s instead of manufacturing zero seconds", (_name, patch) => {
    const clock = clockFor(patch as Partial<Cs2dRoundClockSample>);
    expect(clock.value?.remainingSeconds).toBeNull();
    expect(publicRoundClockFact(clock)).toBeUndefined();
  });

  it("describes positive subsecond time without rounding it to zero", () => {
    const clock = clockFor({ roundStartTimeSeconds: 3.390625 });
    expect(clock.value?.remainingSeconds).toBe(0.5);
    expect(publicRoundClockFact(clock)).toBe("决策前最近采样的回合剩余时间不足1秒。");
    expect(publicRoundClockFact({ ...clock, boundary: "APPLICABILITY_ONLY" })).toBeUndefined();
  });
});
