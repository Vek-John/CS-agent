import { describe, expect, it } from "vitest";
import {
  assertValidMapAssetManifest,
  collectMapAssetManifestIssues,
  loadMirageManifest,
  mirageAssetDownloadRequest,
  normalizedToRadar,
  radarToNormalized,
  radarToWorld,
  worldToNormalized,
  worldToRadar,
  MIRAGE_AWPY_DATA_TRANSFORM,
  MIRAGE_WORLD_TO_RADAR_AFFINE,
  MapAssetManifestValidationError,
  MapTransformError
} from "./index";

describe("Mirage MapSemantics", () => {
  it("loads a version-pinned awpy-data manifest without bundling a raster", () => {
    const manifest = loadMirageManifest();

    expect(manifest.map_name).toBe("de_mirage");
    expect(manifest.map_build_id).toBe("2000883");
    expect(manifest.raster_ref).toBe("awpy-data-cache://2000883/radars/de_mirage.png");
    expect(manifest.source_uri).toContain("github.com/pnxenopoulos/awpy-data");
    expect(manifest.rights_status).toBe("LOCALHOST_ONLY_REVIEW_REQUIRED");
    expect(MIRAGE_AWPY_DATA_TRANSFORM).toEqual({
      pos_x: -3230,
      pos_y: 1713,
      scale: 5,
      rotate: 0,
      zoom: 0
    });
    expect(manifest.layers[0]?.kind).toBe("RADAR");
    expect(mirageAssetDownloadRequest().expected_width).toBe(1024);
    expect(mirageAssetDownloadRequest().asset_path).toBe("radars/de_mirage.png");
  });

  it("matches fixed Mirage overview anchors", () => {
    expect(worldToRadar({ x: -3230, y: 1713, z: 0 }, MIRAGE_WORLD_TO_RADAR_AFFINE)).toEqual({
      x: 0,
      y: 0
    });
    expect(worldToRadar({ x: -2980, y: 1463, z: 128 }, MIRAGE_WORLD_TO_RADAR_AFFINE)).toEqual({
      x: 50,
      y: 50
    });
    expect(worldToRadar({ x: 0, y: 0, z: 0 }, MIRAGE_WORLD_TO_RADAR_AFFINE)).toEqual({
      x: 646,
      y: 342.6
    });
  });

  it("round-trips world/radar coordinates while preserving the requested Z plane", () => {
    const world = { x: -842.25, y: 1176.5, z: 96.75 };
    const radar = worldToRadar(world, MIRAGE_WORLD_TO_RADAR_AFFINE);
    const restored = radarToWorld(radar, MIRAGE_WORLD_TO_RADAR_AFFINE, world.z);

    expect(restored.x).toBeCloseTo(world.x, 10);
    expect(restored.y).toBeCloseTo(world.y, 10);
    expect(restored.z).toBe(world.z);
  });

  it("converts normalized coordinates at the renderer boundary", () => {
    const manifest = loadMirageManifest();
    const normalized = worldToNormalized({ x: 0, y: 0, z: 0 }, manifest);

    expect(normalized.x).toBeCloseTo(646 / 1024);
    expect(normalized.y).toBeCloseTo(342.6 / 1024);
    expect(radarToNormalized({ x: 0, y: 0 }, 1024, 1024)).toEqual({ x: 0, y: 0 });
    expect(normalizedToRadar({ x: 1, y: 1 }, 1024, 1024)).toEqual({ x: 1024, y: 1024 });
  });

  it("rejects malformed manifests and non-invertible transforms", () => {
    const manifest = loadMirageManifest();
    const malformed = { ...manifest, content_sha256: "not-a-hash" };

    expect(collectMapAssetManifestIssues(malformed)).toContain(
      "content_sha256 must be a 64-character hexadecimal SHA-256."
    );
    expect(() => assertValidMapAssetManifest(malformed)).toThrow(MapAssetManifestValidationError);
    expect(() => worldToRadar({ x: 0, y: 0, z: 0 }, [1, 0, 2, 0, 0, 0])).toThrow(
      MapTransformError
    );
    expect(() => normalizedToRadar({ x: 1.1, y: 0.5 }, 1024, 1024)).toThrow(MapTransformError);
  });
});
