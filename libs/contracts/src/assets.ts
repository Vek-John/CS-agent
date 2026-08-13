import type { MapAssetManifest, MapAssetRightsStatus } from "./map";

export interface ItemIconManifest {
  canonical_item_id: string;
  item_class: string;
  display_name: string;
  aliases: readonly string[];
  raster_ref: string;
  width: number;
  height: number;
  content_sha256: string;
  source_uri: string;
  rights_status: MapAssetRightsStatus;
}

export interface AssetGenerationManifest {
  generator: string;
  generator_version: string;
  source_revision?: string;
}

export interface GameAssetCatalog {
  game_build_id?: string;
  asset_version: string;
  maps: readonly MapAssetManifest[];
  item_icons: readonly ItemIconManifest[];
  generated_at: string;
  generation_manifest: AssetGenerationManifest;
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function collectGameAssetCatalogIssues(catalog: GameAssetCatalog): string[] {
  const issues: string[] = [];
  if (!catalog.asset_version?.trim()) issues.push("asset_version is required.");
  if (!Array.isArray(catalog.maps)) issues.push("maps must be an array.");
  if (!Array.isArray(catalog.item_icons)) issues.push("item_icons must be an array.");
  if (Number.isNaN(Date.parse(catalog.generated_at))) {
    issues.push("generated_at must be an ISO date-time.");
  }
  if (!catalog.generation_manifest?.generator?.trim()) {
    issues.push("generation_manifest.generator is required.");
  }
  if (!catalog.generation_manifest?.generator_version?.trim()) {
    issues.push("generation_manifest.generator_version is required.");
  }

  const mapIds = new Set<string>();
  for (const map of catalog.maps ?? []) {
    if (!map.map_name?.trim()) issues.push("every catalog map needs a map_name.");
    if (mapIds.has(map.map_name)) issues.push(`duplicate catalog map ${map.map_name}.`);
    mapIds.add(map.map_name);
  }

  const canonicalIds = new Map<string, string>();
  for (const icon of catalog.item_icons ?? []) {
    const canonicalKey = normalizeLookupKey(icon.canonical_item_id);
    if (canonicalIds.has(canonicalKey)) {
      issues.push(`duplicate canonical item ID ${icon.canonical_item_id}.`);
    }
    canonicalIds.set(canonicalKey, icon.canonical_item_id);
  }

  const aliasOwners = new Map<string, string>();
  for (const icon of catalog.item_icons ?? []) {
    if (!icon.canonical_item_id?.trim()) issues.push("every item icon needs canonical_item_id.");
    if (!icon.item_class?.trim()) {
      issues.push(`item ${icon.canonical_item_id || "<unknown>"} needs item_class.`);
    }
    if (!icon.display_name?.trim()) {
      issues.push(`item ${icon.canonical_item_id || "<unknown>"} needs display_name.`);
    }
    if (!icon.raster_ref?.trim()) {
      issues.push(`item ${icon.canonical_item_id || "<unknown>"} needs raster_ref.`);
    }
    if (!Number.isInteger(icon.width) || icon.width <= 0) {
      issues.push(`item ${icon.canonical_item_id || "<unknown>"} width must be positive.`);
    }
    if (!Number.isInteger(icon.height) || icon.height <= 0) {
      issues.push(`item ${icon.canonical_item_id || "<unknown>"} height must be positive.`);
    }
    if (!isSha256(icon.content_sha256)) {
      issues.push(`item ${icon.canonical_item_id || "<unknown>"} has an invalid content_sha256.`);
    }
    if (!icon.source_uri?.trim()) {
      issues.push(`item ${icon.canonical_item_id || "<unknown>"} needs source_uri.`);
    }
    if (!icon.rights_status?.trim()) {
      issues.push(`item ${icon.canonical_item_id || "<unknown>"} needs rights_status.`);
    }

    for (const alias of icon.aliases ?? []) {
      const aliasKey = normalizeLookupKey(alias);
      if (!aliasKey) {
        issues.push(`item ${icon.canonical_item_id} contains an empty alias.`);
        continue;
      }
      const previousOwner = aliasOwners.get(aliasKey);
      if (previousOwner && previousOwner !== icon.canonical_item_id) {
        issues.push(`alias ${alias} is claimed by both ${previousOwner} and ${icon.canonical_item_id}.`);
      }
      aliasOwners.set(aliasKey, icon.canonical_item_id);
      const canonicalOwner = canonicalIds.get(aliasKey);
      if (canonicalOwner && canonicalOwner !== icon.canonical_item_id) {
        issues.push(`alias ${alias} collides with canonical item ID ${canonicalOwner}.`);
      }
    }
  }
  return issues;
}

export function assertValidGameAssetCatalog(catalog: GameAssetCatalog): GameAssetCatalog {
  const issues = collectGameAssetCatalogIssues(catalog);
  if (issues.length > 0) {
    throw new Error(`GameAssetCatalog validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  }
  return catalog;
}

export function resolveCanonicalItemId(
  catalog: GameAssetCatalog,
  parserItemName: string
): string | undefined {
  const lookupKey = normalizeLookupKey(parserItemName);
  if (!lookupKey) return undefined;
  const icon = catalog.item_icons.find(
    (candidate) =>
      normalizeLookupKey(candidate.canonical_item_id) === lookupKey ||
      candidate.aliases.some((alias) => normalizeLookupKey(alias) === lookupKey)
  );
  return icon?.canonical_item_id;
}

export function lookupItemIconManifest(
  catalog: GameAssetCatalog,
  parserItemName: string
): ItemIconManifest | undefined {
  const canonicalId = resolveCanonicalItemId(catalog, parserItemName);
  return catalog.item_icons.find((icon) => icon.canonical_item_id === canonicalId);
}
