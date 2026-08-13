import { describe, expect, it } from "vitest";
import {
  assertValidGameAssetCatalog,
  collectGameAssetCatalogIssues,
  lookupItemIconManifest,
  resolveCanonicalItemId,
  type GameAssetCatalog
} from "./index";

const catalog: GameAssetCatalog = {
  game_build_id: "2000883",
  asset_version: "assets/1.0.0",
  maps: [],
  item_icons: [
    {
      canonical_item_id: "weapon_ak47",
      item_class: "RIFLE",
      display_name: "AK-47",
      aliases: ["AK47", "weapon_ak47", "ak-47"],
      raster_ref: "local-cache://items/weapon_ak47.png",
      width: 64,
      height: 64,
      content_sha256: "a".repeat(64),
      source_uri: "https://example.invalid/asset-metadata",
      rights_status: "LOCALHOST_ONLY_REVIEW_REQUIRED"
    }
  ],
  generated_at: "2026-08-12T00:00:00.000Z",
  generation_manifest: {
    generator: "test",
    generator_version: "1.0.0"
  }
};

describe("GameAssetCatalog", () => {
  it("resolves parser aliases to canonical IDs and manifests", () => {
    expect(resolveCanonicalItemId(catalog, "AK-47")).toBe("weapon_ak47");
    expect(resolveCanonicalItemId(catalog, "weapon_ak47")).toBe("weapon_ak47");
    expect(lookupItemIconManifest(catalog, "AK47")?.raster_ref).toBe(
      "local-cache://items/weapon_ak47.png"
    );
    expect(resolveCanonicalItemId(catalog, "untrusted/raw-name")).toBeUndefined();
  });

  it("validates hashes and alias collisions without touching the network", () => {
    expect(assertValidGameAssetCatalog(catalog)).toBe(catalog);
    const invalid = structuredClone(catalog);
    invalid.item_icons[0].content_sha256 = "not-a-hash";
    invalid.item_icons = [
      ...invalid.item_icons,
      {
        ...catalog.item_icons[0],
        canonical_item_id: "weapon_m4a1",
        aliases: ["AK47", "weapon_ak47"]
      }
    ];

    const issues = collectGameAssetCatalogIssues(invalid);
    expect(issues.join(" ")).toContain("invalid content_sha256");
    expect(issues.join(" ")).toContain("claimed by both");
    expect(issues.join(" ")).toContain("collides with canonical item ID weapon_ak47");
  });
});
