import { describe, expect, it } from "vitest";
import type { PlayerStateSample } from "@cs-coach/contracts";
import { sampleStateAtTick } from "./replay-sampling";

function makeSample(overrides: Partial<PlayerStateSample> = {}): PlayerStateSample {
  return {
    player_id: "p1",
    tick: 0,
    side: "T",
    world_position: { x: 0, y: 10, z: 20 },
    yaw: 30,
    pitch: 4,
    alive: true,
    health: 100,
    armor: 50,
    has_helmet: true,
    money: 2400,
    active_item: { item_id: "weapon_ak47", item_class: "rifle" },
    inventory: [{ item_id: "flashbang", item_class: "grenade", count: 1 }],
    has_defuse_kit: false,
    carries_c4: false,
    fact_refs: ["previous-fact"],
    missing_fields: [],
    ...overrides
  };
}

describe("omniscient PlayerStateSample sampling", () => {
  it("returns exact samples and holds the first/last sample at the boundaries", () => {
    const first = makeSample({ tick: 0 });
    const last = makeSample({ tick: 48, world_position: { x: 48, y: 58, z: 68 } });
    const samples = [first, last];

    expect(sampleStateAtTick(samples, "p1", 0)).toBe(first);
    expect(sampleStateAtTick(samples, "p1", -1)).toBe(first);
    expect(sampleStateAtTick(samples, "p1", 48)).toBe(last);
    expect(sampleStateAtTick(samples, "p1", 80)).toBe(last);
  });

  it("linearly interpolates position and pitch at the midpoint", () => {
    const previous = makeSample({ tick: 0, world_position: { x: 0, y: 10, z: 20 }, pitch: 4 });
    const next = makeSample({ tick: 24, world_position: { x: 24, y: 34, z: 44 }, pitch: 14 });
    const sample = sampleStateAtTick([previous, next], "p1", 12);

    expect(sample).toMatchObject({
      tick: 12,
      world_position: { x: 12, y: 22, z: 32 },
      pitch: 9
    });
  });

  it.each([
    [359, 1],
    [1, 359]
  ])("interpolates yaw along the shortest path from %i° to %i°", (previousYaw, nextYaw) => {
    const previous = makeSample({ tick: 0, yaw: previousYaw });
    const next = makeSample({ tick: 24, yaw: nextYaw });
    expect(sampleStateAtTick([previous, next], "p1", 12)?.yaw).toBe(0);
  });

  it("step-holds discrete state from the previous sample", () => {
    const previous = makeSample({
      tick: 0,
      health: 91,
      armor: 33,
      has_helmet: false,
      money: 1200,
      active_item: { item_id: "usp_s", item_class: "pistol" },
      inventory: [],
      has_defuse_kit: true,
      carries_c4: true,
      fact_refs: ["previous-fact"],
      missing_fields: ["equipment_value"]
    });
    const next = makeSample({
      tick: 24,
      health: 12,
      armor: 0,
      has_helmet: true,
      money: 900,
      active_item: { item_id: "awp", item_class: "rifle" },
      inventory: [{ item_id: "smokegrenade", item_class: "grenade", count: 1 }],
      has_defuse_kit: false,
      carries_c4: false,
      fact_refs: ["next-fact"],
      missing_fields: []
    });
    const sample = sampleStateAtTick([previous, next], "p1", 12);

    expect(sample).toBeDefined();
    expect(sample?.health).toBe(previous.health);
    expect(sample?.armor).toBe(previous.armor);
    expect(sample?.has_helmet).toBe(previous.has_helmet);
    expect(sample?.money).toBe(previous.money);
    expect(sample?.active_item).toBe(previous.active_item);
    expect(sample?.inventory).toBe(previous.inventory);
    expect(sample?.has_defuse_kit).toBe(previous.has_defuse_kit);
    expect(sample?.carries_c4).toBe(previous.carries_c4);
    expect(sample?.fact_refs).toBe(previous.fact_refs);
    expect(sample?.missing_fields).toBe(previous.missing_fields);
  });

  it.each([
    ["death", { alive: false }, {}],
    ["side change", { side: "CT" as const }, {}],
    ["large gap", {}, { tick: 49 }]
  ])("does not interpolate across a %s", (_label, nextOverrides, timingOverrides) => {
    const previous = makeSample({ tick: 0 });
    const next = makeSample({ tick: 24, ...timingOverrides, ...nextOverrides, world_position: { x: 24, y: 34, z: 44 } });
    const sample = sampleStateAtTick([previous, next], "p1", 12);

    expect(sample).toBe(previous);
  });
});
