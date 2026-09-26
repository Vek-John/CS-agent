import type { GameAssetCatalog } from "@cs-coach/contracts";
import { Bomb, CircleDollarSign, Crosshair, Heart, MapPin, PackageOpen, Shield } from "lucide-react";
import type { CoachingStatusChip } from "../../lib/coaching/cs2d-coaching-view";
import { resolveItemPresentation } from "../../lib/assets/game-asset-display";

function CoachingStatusGlyph({ chip, catalog }: { chip: CoachingStatusChip; catalog?: GameAssetCatalog }) {
  if (chip.kind === "weapon" && chip.item) {
    const presentation = resolveItemPresentation(catalog, chip.item);
    if (presentation.iconRef) return <img src={presentation.iconRef} alt="" aria-hidden="true" />;
  }
  if (chip.kind === "location") return <MapPin aria-hidden="true" />;
  if (chip.kind === "health") return <Heart aria-hidden="true" />;
  if (chip.kind === "armor") return <Shield aria-hidden="true" />;
  if (chip.kind === "utility") return <PackageOpen aria-hidden="true" />;
  if (chip.kind === "money") return <CircleDollarSign aria-hidden="true" />;
  if (chip.kind === "objective") return <Bomb aria-hidden="true" />;
  return <Crosshair aria-hidden="true" />;
}

function coachingStatusText(chip: CoachingStatusChip, catalog?: GameAssetCatalog): string {
  if (chip.kind !== "weapon" || !chip.item) return chip.text;
  return resolveItemPresentation(catalog, chip.item).label;
}

/** Shared production status list, also rendered directly in SSR regressions. */
export function CoachingStatusList({ chips, catalog }: { chips: readonly CoachingStatusChip[]; catalog?: GameAssetCatalog }) {
  return <ul className="cs2d-coaching-status-list">
    {chips.map((chip, index) => <li key={`${chip.kind}-${index}`}>
      <CoachingStatusGlyph chip={chip} catalog={catalog} />
      <span>{coachingStatusText(chip, catalog)}</span>
    </li>)}
  </ul>;
}
