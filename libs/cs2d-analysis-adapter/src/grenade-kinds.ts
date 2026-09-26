import type { Cs2dPlayerState } from "./index";

const KINDS = new Set(["HE", "Smoke", "Flash", "Molotov", "Decoy"]);
/** V1 proves a complete current type list, not the number of carried grenades. */
export function verifiedGrenadeKinds(state: Pick<Cs2dPlayerState, "grenades" | "grenadeInventoryVersion"> | undefined): readonly string[] | undefined {
  if (state?.grenadeInventoryVersion !== 1 || !Array.isArray(state.grenades) || state.grenades.length > KINDS.size ||
    state.grenades.some(kind => !KINDS.has(kind)) || new Set(state.grenades).size !== state.grenades.length) return undefined;
  return state.grenades;
}
