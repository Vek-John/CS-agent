import { describe, expect, it } from "vitest";
import { loadMirageManifest, worldToNormalized } from "@cs-coach/map-semantics";
import { formatItem } from "../lib/item-display";
import {
  annotationPointToRadarPercent,
  annotationRadiusToRadarPercent
} from "../lib/replay-annotations";

describe("replay item display", () => {
  it("uses a friendly canonical name for USP-S", () => {
    expect(formatItem({ item_id: "usp_s", item_class: "weapon" })).toBe("USP-S");
  });

  it("uses the real unknown item_id instead of the generic item class", () => {
    expect(formatItem({ item_id: "zeus_x27", item_class: "weapon" })).toBe("Zeus X27");
    expect(formatItem({ item_id: "zeus_x27", item_class: "weapon" })).not.toBe("weapon");
  });

  it("only falls back to item_class when item_id is empty", () => {
    expect(formatItem({ item_id: "", item_class: "weapon" })).toBe("weapon");
  });

  it("converts WORLD annotations through the Mirage manifest", () => {
    const center = { x: -1200, y: 480, z: -64 };
    const manifest = loadMirageManifest({ raster_ref: "/test.png" });
    const normalized = worldToNormalized(center, manifest);

    expect(annotationPointToRadarPercent(center, "WORLD", manifest)).toEqual({
      x: normalized.x * 100,
      y: normalized.y * 100
    });
  });

  it("keeps RADAR_PERCENT annotations and radius unchanged", () => {
    const center = { x: 42, y: 58 };

    const manifest = loadMirageManifest({ raster_ref: "/test.png" });
    expect(annotationPointToRadarPercent(center, "RADAR_PERCENT", manifest)).toEqual(center);
    expect(annotationRadiusToRadarPercent(center, 9, "RADAR_PERCENT", manifest)).toBe(9);
  });

  it("derives a WORLD annotation radius from the transformed x-axis", () => {
    const manifest = loadMirageManifest({ raster_ref: "/test.png" });
    const center = { x: -1200, y: 480, z: -64 };
    const radius = 128;
    const normalizedCenter = worldToNormalized(center, manifest);
    const normalizedEdge = worldToNormalized({ x: center.x + radius, y: center.y, z: center.z }, manifest);

    expect(annotationRadiusToRadarPercent(center, radius, "WORLD", manifest)).toBeCloseTo(
      Math.hypot(normalizedEdge.x - normalizedCenter.x, normalizedEdge.y - normalizedCenter.y) * 100
    );
  });
});
