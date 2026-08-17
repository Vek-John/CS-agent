import type { ActiveItem } from "@cs-coach/contracts";

function formatUnknownItemId(itemId: string): string {
  const trimmed = itemId.trim();
  if (!trimmed) return "";
  const withoutWeaponPrefix = trimmed.replace(/^weapon[_-]/i, "");
  const friendly = withoutWeaponPrefix.replace(/[_-]+/g, " ").trim();
  return friendly.replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

export function formatItem(item: ActiveItem | undefined): string {
  if (!item) return "未知";
  const key = item.item_id.trim().toLowerCase().replace(/[-\s]+/g, "_");
  const codeNativeLabels: Record<string, string> = {
    ak47: "AK-47",
    weapon_ak47: "AK-47",
    m4a1: "M4A1-S",
    weapon_m4a1: "M4A1-S",
    m4a1_silencer: "M4A1-S",
    weapon_m4a1_silencer: "M4A1-S",
    m4a4: "M4A4",
    weapon_m4a4: "M4A4",
    awp: "AWP",
    weapon_awp: "AWP",
    glock: "Glock-18",
    weapon_glock: "Glock-18",
    usp_silencer: "USP-S",
    weapon_usp_silencer: "USP-S",
    usp_s: "USP-S",
    weapon_usp_s: "USP-S",
    deagle: "沙漠之鹰",
    weapon_deagle: "沙漠之鹰",
    knife: "匕首",
    weapon_knife: "匕首",
    hegrenade: "手雷",
    flashbang: "闪光弹",
    smokegrenade: "烟雾弹",
    molotov: "燃烧瓶",
    incgrenade: "燃烧弹",
    decoy: "诱饵弹",
    c4: "C4"
  };
  if (codeNativeLabels[key]) return codeNativeLabels[key];
  if (item.item_id.trim()) return formatUnknownItemId(item.item_id) || "未知物品";
  return item.item_class || "未知物品";
}
