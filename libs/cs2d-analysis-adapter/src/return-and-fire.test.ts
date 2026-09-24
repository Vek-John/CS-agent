import { describe, expect, it } from "vitest";
import { nominateReturnAndFire } from "./return-and-fire";
import type { Cs2dFrame, Cs2dShotEvent } from "./index";

// Author-created path regression; these arbitrary ticks are not parsed Demo ticks.
function fixture() {
  const frames: Cs2dFrame[] = Array.from({ length: 25 }, (_, i) => ({ tick: 64 + i * 8, t: 0, players: [{
    steamId: "self", x: i <= 8 ? i * 8 : Math.max(0, 128 - i * 8), y: 0, z: 0,
    alive: true, health: 100, yaw: 0, side: "T", weapon: "AK-47", money: 0, equipValue: 0, armor: 0
  }] }));
  const shot = (tick: number): Cs2dShotEvent => ({ type: "shot", shooterSteamId: "self", tick, t: 0, x: 99999, y: -99999, yaw: 0 });
  return { frames, events: [shot(64), shot(192)], selectedPlayerId: "self", tickRate: 64, startTick: 64, endTick: 300 };
}

describe("sampled self return-and-fire nomination", () => {
  it("uses self frames and explicit shots, not tracer coordinates, and keeps strict windows", () => {
    const f = fixture(); const [a] = nominateReturnAndFire(f);
    expect(a).toMatchObject({ decisionTick: 128, shotTick: 192, priorShotTick: 64, priorShotEventIndex: 0, shotEventIndex: 1 });
    expect(a!.sampleTicks).toEqual(f.frames.filter(s => s.tick <= 192).map(s => s.tick));
    f.events[1] = { ...f.events[1]!, x: 0, y: 0 };
    expect(nominateReturnAndFire(f)).toEqual([a]);
  });
  it.each(["other", "missing", "null"])("does not attribute %s actors by location", kind => {
    const f = fixture(); f.events = f.events.map(e => ({ ...e, shooterSteamId: kind === "other" ? "other" : kind === "null" ? null : undefined }));
    expect(nominateReturnAndFire(f)).toEqual([]);
  });
  it.each(["stationary", "no-return", "height", "dead", "unknown", "gap", "stale-endpoint", "duplicate"])("rejects %s path evidence", kind => {
    const f = fixture();
    if (kind === "stationary") f.frames = f.frames.map(s => ({ ...s, players: s.players.map(p => ({ ...p, x: 0 })) }));
    if (kind === "no-return") f.frames = f.frames.map((s, i) => ({ ...s, players: s.players.map(p => ({ ...p, x: i * 8 })) }));
    if (kind === "height") f.frames[5] = { ...f.frames[5]!, players: f.frames[5]!.players.map(p => ({ ...p, z: 33 })) };
    if (kind === "dead") f.frames[5] = { ...f.frames[5]!, players: f.frames[5]!.players.map(p => ({ ...p, alive: false, health: 0 })) };
    if (kind === "unknown") f.frames[5] = { ...f.frames[5]!, players: [] };
    if (kind === "gap") f.frames.splice(4, 3);
    if (kind === "stale-endpoint") f.frames = f.frames.filter(s => s.tick < 176 || s.tick > 192);
    if (kind === "duplicate") f.frames.push(f.frames[5]!);
    expect(nominateReturnAndFire(f)).toEqual([]);
  });
  it("rejects a return taking over two seconds and a prior shot over ten seconds away", () => {
    const f = fixture(); f.events[1] = { ...f.events[1]!, tick: 264 };
    expect(nominateReturnAndFire(f)).toEqual([]);
    const stretched = fixture(); stretched.endTick = 800;
    stretched.frames = Array.from({ length: 89 }, (_, i) => {
      const tick = 64 + i * 8;
      return { ...stretched.frames[0]!, tick, players: stretched.frames[0]!.players.map(p => ({ ...p, x: tick <= 640 ? 0 : tick <= 704 ? tick - 640 : 768 - tick })) };
    });
    stretched.events[1] = { ...stretched.events[1]!, tick: 768 };
    expect(nominateReturnAndFire(stretched)).toEqual([]);
    stretched.events[0] = { ...stretched.events[0]!, tick: 128 };
    expect(nominateReturnAndFire(stretched)).toHaveLength(1); // exactly ten seconds is allowed
  });
  it("never reads hidden player positions or shot tracer positions", () => {
    const f = fixture();
    f.frames = f.frames.map(frame => ({ ...frame, players: [...frame.players, Object.defineProperty({ ...frame.players[0]!, steamId: "hidden-enemy" }, "x", { get() { throw new Error("hidden position read"); } })] }));
    f.events = f.events.map(event => Object.defineProperty({ ...event }, "x", { get() { throw new Error("tracer position read"); } }));
    expect(nominateReturnAndFire(f)).toHaveLength(1);
  });
  it("emits once for a return then firing burst and is independent of future state", () => {
    const f = fixture(); f.events.push({ ...f.events[1]!, tick: 200 }, { ...f.events[1]!, tick: 208 });
    const before = nominateReturnAndFire(f); expect(before).toHaveLength(1);
    f.frames = f.frames.map(s => s.tick <= 208 ? s : ({ ...s, players: s.players.map(p => ({ ...p, alive: false, health: 0, x: 500 })) }));
    expect(nominateReturnAndFire(f)).toEqual(before);
  });
  it("requires a complete same-round sequence and ignores frames outside the action interval", () => {
    const f = fixture(); expect(nominateReturnAndFire({ ...f, startTick: 100 })).toEqual([]);
    f.frames.push({ tick: 280, t: 0, players: [] });
    expect(nominateReturnAndFire(f)).toHaveLength(1);
  });
});
