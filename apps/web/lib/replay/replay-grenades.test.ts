import { describe, expect, it } from "vitest";
import { loadMirageManifest, worldToNormalized } from "@cs-coach/map-semantics";
import type { ReplayGrenadeTrack } from "./replay-bundle";
import { formatGrenadeType, renderGrenadeTrackAtTick, type GrenadeTrackInput } from "./replay-grenades";

const manifest = loadMirageManifest({ raster_ref: "/test.png" });

function track(overrides: Partial<ReplayGrenadeTrack> = {}): ReplayGrenadeTrack {
  return {
    id: "grenade-1",
    item_id: "smokegrenade",
    start_tick: 100,
    end_tick: 124,
    points: [
      { tick: 100, world_position: { x: -1000, y: 400, z: -64 } },
      { tick: 112, world_position: { x: -900, y: 450, z: -64 } },
      { tick: 124, world_position: { x: -800, y: 500, z: -64 } }
    ],
    ...overrides
  };
}

describe("typed grenade track renderer", () => {
  it("renders the flight polyline and current point only through the typed end tick", () => {
    const rendered = renderGrenadeTrackAtTick(track(), 112, 64, manifest);
    expect(rendered?.flightPoints).toHaveLength(2);
    expect(rendered?.currentPoint).toEqual(worldToNormalized({ x: -900, y: 450, z: -64 }, manifest));
    expect(rendered?.landingPoint).toBeUndefined();
  });

  it("uses the supplied area center and radius after the typed landing tick", () => {
    const area = { center: { x: -800, y: 500, z: -64 }, radius: 160 };
    const rendered = renderGrenadeTrackAtTick(track({ area }), 130, 64, manifest);
    const center = worldToNormalized(area.center, manifest);
    const edge = worldToNormalized({ x: area.center.x + area.radius, y: area.center.y, z: area.center.z }, manifest);

    expect(rendered?.flightPoints).toEqual([]);
    expect(rendered?.landingPoint).toEqual(center);
    expect(rendered?.effectArea?.center).toEqual(center);
    expect(rendered?.effectArea?.radius).toBeCloseTo(Math.hypot(edge.x - center.x, edge.y - center.y));
  });

  it("expires old tracks and does not invent an effect area", () => {
    expect(renderGrenadeTrackAtTick(track(), 300, 64, manifest)).toBeUndefined();
    expect(renderGrenadeTrackAtTick(track(), 130, 64, manifest)?.effectArea).toBeUndefined();
  });

  it("keeps an instant grenade landing visible briefly after its parser terminal tick", () => {
    const rendered = renderGrenadeTrackAtTick(track(), 130, 64, manifest);

    expect(rendered?.flightPoints).toEqual([]);
    expect(rendered?.landingPoint).toEqual(
      worldToNormalized({ x: -800, y: 500, z: -64 }, manifest)
    );
    expect(renderGrenadeTrackAtTick(track(), 300, 64, manifest)).toBeUndefined();
  });

  it("accepts the stable track_id/grenade_type/samples lifecycle fields", () => {
    const stableTrack: GrenadeTrackInput = {
      track_id: "stable-grenade-1",
      grenade_type: "SMOKE",
      start_tick: 100,
      end_tick: 160,
      detonate_tick: 124,
      expire_tick: 160,
      samples: track().points
    };

    const inFlight = renderGrenadeTrackAtTick(stableTrack, 112, 64, manifest);
    const landed = renderGrenadeTrackAtTick(stableTrack, 140, 64, manifest);
    expect(formatGrenadeType(stableTrack)).toBe("烟雾弹");
    expect(inFlight?.flightPoints).toHaveLength(2);
    expect(landed?.flightPoints).toEqual([]);
    expect(landed?.landingPoint).toEqual(worldToNormalized({ x: -800, y: 500, z: -64 }, manifest));
    expect(landed?.effectArea).toBeUndefined();
    expect(renderGrenadeTrackAtTick(stableTrack, 161, 64, manifest)).toBeUndefined();
  });
});
