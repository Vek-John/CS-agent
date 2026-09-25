import type { DecisionResources, PlayerStateSample } from "@cs-coach/contracts";
import { projectDecisionUtilityCount } from "./decision-utilities";

/** Field availability only. The Host separately owns player/round/time/alive validation. */
export function projectDecisionResources(state: PlayerStateSample): DecisionResources {
  const evidenceRefs = Array.isArray(state.fact_refs) ? [...new Set(state.fact_refs.filter(ref => typeof ref === "string" && ref.trim() && ref.length <= 160))].slice(0, 32) : [];
  const result: DecisionResources = { evidenceRefs };
  if (!Array.isArray(state.missing_fields) || !state.missing_fields.every(field => typeof field === "string")) return result;
  const missing = (...keys: string[]) => state.missing_fields.some(field => keys.some(key => field === key || field.startsWith(`${key}.`) || field.startsWith(`${key}[`)));
  const bounded = (value: unknown, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
  if (!missing("health") && bounded(state.health, 100)) result.health = state.health;
  if (!missing("armor") && bounded(state.armor, 100)) result.armor = state.armor;
  if (!missing("helmet", "has_helmet") && typeof state.has_helmet === "boolean") result.hasHelmet = state.has_helmet;
  if (!missing("money") && bounded(state.money, 10_000_000)) result.money = state.money;
  if (!missing("equipment_value", "equipmentValue") && bounded(state.equipment_value, 10_000_000)) result.equipmentValue = state.equipment_value;
  return { ...result, ...projectDecisionUtilityCount(state) };
}
