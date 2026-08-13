import type { GameAssetCatalog } from "@cs-coach/contracts";

export const LOCAL_GAME_ASSET_CATALOG_URL = "/generated-assets/items/catalog.json";

let cachedCatalog: GameAssetCatalog | undefined;

export function resetLocalGameAssetCatalogCacheForTests(): void {
  cachedCatalog = undefined;
}

function isCatalog(value: unknown): value is GameAssetCatalog {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GameAssetCatalog>;
  return typeof candidate.asset_version === "string"
    && Array.isArray(candidate.maps)
    && Array.isArray(candidate.item_icons)
    && typeof candidate.generated_at === "string"
    && typeof candidate.generation_manifest?.generator === "string";
}

export async function loadLocalGameAssetCatalog(): Promise<GameAssetCatalog | undefined> {
  if (cachedCatalog) return cachedCatalog;
  try {
    const response = await fetch(LOCAL_GAME_ASSET_CATALOG_URL, { cache: "no-store" });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (!isCatalog(payload)) return undefined;
    cachedCatalog = payload;
    return cachedCatalog;
  } catch {
    return undefined;
  }
}
