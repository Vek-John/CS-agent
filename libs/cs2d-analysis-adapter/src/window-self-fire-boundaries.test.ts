import { expect, it } from "vitest";
import { windowSelfFire } from "./window-self-fire";
import { fireReplay, self, shot } from "./window-self-fire-fixtures";
const input = () => ({ round: fireReplay("HP_CHANGE").rounds[0], roundNumber: 1, startTick: 1064, endTick: 1760, selectedPlayerId: self, decisionTick: 1400, revealTick: 1408, aliveAtDecision: true });

it.each([1403, 1404])("rejects fire at/after a known death at %s without guessing event order", tick => {
  const f = input();
  const death = { type: "kill" as const, tick, t: 0, victimSteamId: self, attackerSteamId: "other", assisterSteamId: null, assistedFlash: false, weapon: "ak47", headshot: false, x: 0, y: 0, z: 0 };
  expect(windowSelfFire({ ...f, round: { ...f.round, events: [...f.round.events, death] } })).toBeUndefined();
});
it("accepts a strictly earlier shot but refuses sampled or hurt-reported death at its tick", () => {
  const f = input();
  expect(windowSelfFire(f)?.refs).toEqual(["cs2d-r1-event-1"]);
  expect(windowSelfFire({ ...f, round: { ...f.round, frames: [{ tick: 1404, t: 0, players: [{ ...f.round.frames[0].players[0], alive: false, health: 0 }] }] } })).toBeUndefined();
  expect(windowSelfFire({ ...f, round: { ...f.round, hurtEvents: [{ id: "fatal", victimSteamId: self, tick: 1404, reportedHealthAfter: 0 }] } })).toBeUndefined();
});
it("rejects unknown life and cross-round events and never reads tracer coordinates", () => {
  const f = input();
  expect(windowSelfFire({ ...f, aliveAtDecision: false })).toBeUndefined();
  expect(windowSelfFire({ ...f, startTick: 1500 })).toBeUndefined();
  const event = Object.defineProperty(shot(1404), "x", { get() { throw Error("TRACER_READ"); } });
  expect(windowSelfFire({ ...f, round: { ...f.round, events: [event] } })).toBeDefined();
});

it.each([NaN, 1404.5, -1])("rejects an attributed death with unusable time %s for either sampled or hurt sources", badTick => {
  const f = input();
  expect(windowSelfFire({ ...f, round: { ...f.round, frames: [{ tick: badTick, t: 0, players: [{ ...f.round.frames[0].players[0], alive: false, health: 0 }] }] } })).toBeUndefined();
  expect(windowSelfFire({ ...f, round: { ...f.round, hurtEvents: [{ id: "fatal", victimSteamId: self, tick: badTick, reportedHealthAfter: 0 }] } })).toBeUndefined();
});
