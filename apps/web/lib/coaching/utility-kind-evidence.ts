import type { Fact, PlayerStateSample, TrustedDecisionSemantics } from "@cs-coach/contracts";
import { projectDecisionUtilityCount } from "@cs-coach/coach-agent/decision-utilities";

const GRENADE_NAMES = new Map([
  ["HE", "高爆手雷"], ["Smoke", "烟雾弹"], ["Flash", "闪光弹"],
  ["Molotov", "燃烧弹"], ["Decoy", "诱饵弹"]
]);

/** Modern snapshots already enforce freshness; do not revive a rejected older track row. */
export function matchesDecisionState(state: PlayerStateSample, semantics: TrustedDecisionSemantics | undefined, decisionTick: number | undefined, decisionFacts: readonly Fact[] = []): boolean {
  const snapshot = semantics?.decisionSnapshot;
  // Legacy callers without a compact snapshot retain their existing presentation.
  if (!snapshot) return decisionTick === undefined || (Number.isSafeInteger(decisionTick) && Number.isSafeInteger(state.tick) && state.tick <= decisionTick);
  const evidence = snapshot.selectedPlayer;
  return evidence.boundary === "OBSERVABLE" && evidence.value !== null &&
    snapshot.selectedPlayerId === state.player_id && snapshot.sampledAtTick === state.tick &&
    Number.isSafeInteger(decisionTick) && snapshot.decisionTick === decisionTick && Number.isSafeInteger(state.tick) && state.tick <= decisionTick! &&
    evidence.evidenceRefs.some(ref => decisionFacts.some(fact => fact.id === ref && fact.source === "DEMO" && fact.availability === "DECISION" && fact.observed_by_player && fact.available_at_tick === state.tick));
}

/** Kinds can be known while physical counts are not; bind them to this exact sample. */
export function verifiedUtilityKindText(state: PlayerStateSample, semantics: TrustedDecisionSemantics | undefined, decisionTick: number | undefined, decisionFacts: readonly Fact[] = []): string | undefined {
  const snapshot = semantics?.decisionSnapshot;
  const evidence = snapshot?.selectedPlayer;
  const kinds = evidence?.value?.grenades;
  if (!snapshot || evidence?.boundary !== "OBSERVABLE" || !Array.isArray(kinds) || kinds.length === 0 ||
    kinds.length > GRENADE_NAMES.size || new Set(kinds).size !== kinds.length || !kinds.every(kind => GRENADE_NAMES.has(kind)) ||
    !state.missing_fields.includes("inventory.count") || state.missing_fields.some(field =>
      (field === "inventory" || field.startsWith("inventory.") || field.startsWith("inventory[")) && field !== "inventory.count") ||
    !matchesDecisionState(state, semantics, decisionTick, decisionFacts)) return undefined;
  return `${kinds.map(kind => GRENADE_NAMES.get(kind)).join("、")}（数量未知）`;
}

/** Return only a displayable inventory statement with this sample's canonical fact citations. */
export function verifiedDisplayedUtilityEvidence(state: PlayerStateSample, semantics: TrustedDecisionSemantics | undefined, decisionTick: number, decisionFacts: readonly Fact[]): { text: string; refs: readonly string[] } | undefined {
  const snapshot = semantics?.decisionSnapshot;
  if (!snapshot || !matchesDecisionState(state, semantics, decisionTick, decisionFacts)) return;
  const refs = [...new Set(snapshot.selectedPlayer.evidenceRefs.filter(ref => decisionFacts.some(fact => fact.id === ref && fact.source === "DEMO" && fact.availability === "DECISION" && fact.observed_by_player && fact.available_at_tick === state.tick)))];
  if (!refs.length) return;
  const count = projectDecisionUtilityCount(state).utilityCount;
  // Exact-count chips do not display kinds. Only a verified empty snapshot can repeat "no utility".
  if (count === 0 && Array.isArray(snapshot.selectedPlayer.value?.grenades) && snapshot.selectedPlayer.value.grenades.length === 0) return { text: "无道具", refs };
  if (count !== undefined) return;
  const text = verifiedUtilityKindText(state, semantics, decisionTick, decisionFacts);
  return text ? { text, refs } : undefined;
}
