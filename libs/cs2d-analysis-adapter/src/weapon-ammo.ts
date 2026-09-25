import type { ActiveItem } from "@cs-coach/contracts";

export interface Cs2dWeaponAmmo {
  readonly source: "SOURCE2_ACTIVE_WEAPON";
  readonly phase: "TICK_END";
  readonly sampledAtTick: number;
  readonly weapon: string;
  readonly weaponHandle: number;
  readonly clip: number;
}

const FIREARMS = new Set(["Deagle", "R8 Revolver", "Dual Berettas", "Five-SeveN", "Glock-18", "USP-S", "P2000", "P250", "Tec-9", "CZ75-Auto", "MP5-SD", "MP7", "MP9", "MAC-10", "UMP-45", "P90", "PP-Bizon", "AK-47", "Galil AR", "SCAR-20", "G3SG1", "SSG 08", "AWP", "AUG", "SG 553", "FAMAS", "M4A4", "M4A1-S", "Nova", "MAG-7", "Sawed-Off", "XM1014", "Negev", "M249"]);

/** Independent tick-end evidence; never silently attach it to the tick-start state ref. */
export function normalizeWeaponAmmo(raw: Cs2dWeaponAmmo | undefined, weapon: string, tick: number, factRef: string, alive: boolean): Partial<ActiveItem> {
  if (!raw || !alive || raw.source !== "SOURCE2_ACTIVE_WEAPON" || raw.phase !== "TICK_END"
    || !Number.isSafeInteger(raw.sampledAtTick) || raw.sampledAtTick < 0 || raw.sampledAtTick !== tick
    || raw.weapon !== weapon || !FIREARMS.has(weapon)
    || !Number.isSafeInteger(raw.weaponHandle) || raw.weaponHandle <= 0 || raw.weaponHandle >= 0xffffff
    || !Number.isSafeInteger(raw.clip) || raw.clip < 0 || raw.clip > 255) return {};
  return { ammo_clip: raw.clip, ammo_evidence: { source: raw.source, phase: raw.phase,
    sampled_at_tick: raw.sampledAtTick, weapon_handle: raw.weaponHandle, fact_ref: `${factRef}-weapon-ammo-end` } };
}
