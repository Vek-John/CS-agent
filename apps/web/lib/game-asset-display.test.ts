import { describe, expect, it } from "vitest";
import type { GameAssetCatalog } from "@cs-coach/contracts";
import { isLocalBrowserAssetRef, resolveItemPresentation } from "./game-asset-display";

const catalog: GameAssetCatalog = {
  asset_version: "cs2-items/test-1",
  maps: [],
  item_icons: [{
    canonical_item_id: "weapon_ak47",
    item_class: "rifle",
    display_name: "AK-47",
    aliases: ["ak47"],
    raster_ref: "/generated-assets/items/weapon_ak47.png",
    width: 128,
    height: 64,
    content_sha256: "a".repeat(64),
    source_uri: "valve-local-cache://cs2/items/weapon_ak47",
    rights_status: "LOCALHOST_ONLY"
  }],
  generated_at: "2026-08-13T00:00:00.000Z",
  generation_manifest: { generator: "test", generator_version: "1" }
};

describe("game asset display adapter", () => {
  it("uses a catalog-provided local raster ref and never derives the path", () => {
    expect(resolveItemPresentation(catalog, { item_id: "ak47", item_class: "rifle" })).toMatchObject({
      label: "AK-47",
      iconRef: "/generated-assets/items/weapon_ak47.png"
    });
  });

  it("keeps a text fallback when the catalog or item is unavailable", () => {
    expect(resolveItemPresentation(undefined, { item_id: "zeus_x27", item_class: "weapon" })).toMatchObject({
      label: "Zeus X27",
      fallbackReason: "CATALOG_MISSING"
    });
    expect(resolveItemPresentation(catalog, { item_id: "zeus_x27", item_class: "weapon" })).toMatchObject({
      label: "Zeus X27",
      fallbackReason: "ITEM_NOT_IN_CATALOG"
    });
  });

  it("rejects remote and scheme-based refs instead of rendering an unverified asset", () => {
    expect(isLocalBrowserAssetRef("https://example.test/icon.png")).toBe(false);
    expect(isLocalBrowserAssetRef("local-cache://items/icon.png")).toBe(false);
    expect(isLocalBrowserAssetRef("/generated-assets/items/icon.png")).toBe(true);
  });
});
