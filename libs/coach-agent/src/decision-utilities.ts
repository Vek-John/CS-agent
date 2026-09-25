import type { DecisionResources, PlayerStateSample } from "@cs-coach/contracts";

// Explicit classes emitted by the current adapter and supported older state producers.
// Do not infer a class from item_id. Unknown classes can hide utility, so fail unknown.
const UTILITY_CLASSES = new Set(["UTILITY", "GRENADE"]);
const NON_UTILITY_CLASSES = new Set(["WEAPON", "KNIFE", "BOMB", "RIFLE", "PISTOL"]);
export const MAX_DIAGNOSTIC_UTILITY_COUNT = 64; // Transport bound, not a game carry limit.

/** An absent count is unknown; zero requires a complete, valid inventory. */
export function projectDecisionUtilityCount(
  state: Pick<PlayerStateSample, "inventory" | "missing_fields">,
): Pick<DecisionResources, "utilityCount"> {
  if (!Array.isArray(state.inventory) || state.inventory.length > 32 || !Array.isArray(state.missing_fields) ||
    state.missing_fields.some(field => typeof field !== "string" || field === "inventory" || field.startsWith("inventory.") || field.startsWith("inventory["))) return {};
  let count = 0;
  for (const item of state.inventory) {
    if (!item || typeof item.item_class !== "string" || !Number.isSafeInteger(item.count) || item.count < 0 || item.count > MAX_DIAGNOSTIC_UTILITY_COUNT) return {};
    const kind = item.item_class.toUpperCase();
    if (UTILITY_CLASSES.has(kind)) count += item.count;
    else if (!NON_UTILITY_CLASSES.has(kind)) return {};
    if (count > MAX_DIAGNOSTIC_UTILITY_COUNT) return {};
  }
  return { utilityCount: count };
}
