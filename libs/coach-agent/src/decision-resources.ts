import type { DecisionResources, PlayerStateSample } from "@cs-coach/contracts";
import { projectDecisionUtilityCount } from "./decision-utilities";

/** Field availability only. The Host separately owns player/round/time/alive validation. */
export function projectDecisionResources(state: PlayerStateSample, decisionTick?: number): DecisionResources {
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
  const item = state.active_item;
  const ammo = item?.ammo_evidence;
  // Legacy rich input has no independently verified decision time: leave new ammo unknown.
  if (Number.isSafeInteger(decisionTick) && ammo && ammo.sampled_at_tick < decisionTick! && !missing("active_item") && item?.item_class === "WEAPON" && ammo?.source === "SOURCE2_ACTIVE_WEAPON" && ammo.phase === "TICK_END"
    && Number.isSafeInteger(ammo.sampled_at_tick) && (item.ammo_sampling_version === 2 ? ammo.version === 2 && ammo.sampled_at_tick < state.tick : ammo.version === undefined && ammo.sampled_at_tick === state.tick)
    && Number.isSafeInteger(ammo.weapon_handle) && ammo.weapon_handle > 0 && ammo.weapon_handle < 0xffffff
    && typeof ammo.fact_ref === "string" && ammo.fact_ref.length > 0 && ammo.fact_ref.length <= 160
    && item.item_id.length > 0 && item.item_id.length <= 96 && Number.isSafeInteger(item.ammo_clip) && bounded(item.ammo_clip, 255)) {
    result.weaponAmmo = { weapon: item.item_id, clip: item.ammo_clip, evidenceRefs: [ammo.fact_ref] };
  }
  return { ...result, ...projectDecisionUtilityCount(state) };
}
