import type { ActiveItem, GameAssetCatalog, ItemIconManifest } from "@cs-coach/contracts";
import { lookupItemIconManifest } from "@cs-coach/contracts";
import { formatItem } from "./item-display";

export interface ItemPresentation {
  label: string;
  icon?: ItemIconManifest;
  iconRef?: string;
  fallbackReason?: "CATALOG_MISSING" | "ITEM_NOT_IN_CATALOG" | "ICON_NOT_LOCAL";
}

/**
 * Browser rendering may only consume a path that is already cached by the
 * web app. In particular, this intentionally rejects local-cache://, http(s),
 * data URLs, and any value derived from the parser item id.
 */
export function isLocalBrowserAssetRef(value: string | undefined): value is string {
  return Boolean(value && /^\/generated-assets\/items\/[a-z0-9_-]+\.(?:png|svg)$/.test(value));
}

export function resolveItemPresentation(
  catalog: GameAssetCatalog | undefined,
  item: ActiveItem | undefined
): ItemPresentation {
  const label = formatItem(item);
  if (!catalog) return { label, fallbackReason: "CATALOG_MISSING" };
  if (!item?.item_id.trim()) return { label, fallbackReason: "ITEM_NOT_IN_CATALOG" };

  const icon = lookupItemIconManifest(catalog, item.item_id);
  if (!icon) return { label, fallbackReason: "ITEM_NOT_IN_CATALOG" };
  if (!isLocalBrowserAssetRef(icon.raster_ref)) {
    return { label: icon.display_name || label, icon, fallbackReason: "ICON_NOT_LOCAL" };
  }

  return {
    label: icon.display_name || label,
    icon,
    iconRef: icon.raster_ref
  };
}
