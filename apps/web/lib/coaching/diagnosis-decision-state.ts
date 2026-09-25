import { projectDecisionResources } from "@cs-coach/coach-agent/client";
import type { DecisionResources, DecisionSnapshot, PlayerStateSample, RoundTimeline } from "@cs-coach/contracts";
import type { TeachingDiagnosisHostContext } from "./teaching-diagnosis-host";

const tick = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const bounded = (value: unknown, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const hasMissing = (fields: readonly string[], key: string) => fields.some(field => field === key || field.startsWith(`${key}.`) || field.startsWith(`${key}[`));

export function currentDiagnosisWindow(context: TeachingDiagnosisHostContext): { round: RoundTimeline; ageLimit: number } | undefined {
  const { timeline, cue, plan, selectedPlayerId } = context;
  if (!timeline || !selectedPlayerId || timeline.selected_player_id !== selectedPlayerId || !tick(cue.decision_tick) || !Number.isSafeInteger(timeline.tick_rate) || timeline.tick_rate <= 0) return;
  const segments = plan.segments.filter(segment => segment.id === cue.segment_id && segment.cue_ids.includes(cue.id));
  if (segments.length !== 1 || !Number.isSafeInteger(segments[0].round_number) || segments[0].round_number < 1) return;
  const rounds = timeline.rounds.filter(round => tick(round.start_tick) && tick(round.end_tick) && round.start_tick <= cue.decision_tick && cue.decision_tick < round.end_tick);
  if (rounds.length !== 1) return;
  const round = rounds[0];
  if (round.round_number !== segments[0].round_number || !tick(round.freeze_end_tick) || round.start_tick > round.freeze_end_tick || round.freeze_end_tick >= round.end_tick) return;
  // start_tick includes freeze time; end_tick belongs to the next round.
  return { round, ageLimit: Math.ceil(timeline.tick_rate / 2) };
}

type Window = NonNullable<ReturnType<typeof currentDiagnosisWindow>>;
export function currentDiagnosisSnapshot(context: TeachingDiagnosisHostContext, window: Window | undefined): DecisionSnapshot | undefined {
  const snapshot = context.material?.decisionSnapshot ?? context.cue.decisionSnapshot;
  if (!snapshot || !window || snapshot.selectedPlayerId !== context.selectedPlayerId || snapshot.roundNumber !== window.round.round_number || snapshot.decisionTick !== context.cue.decision_tick || snapshot.sampledAtTick === null || !tick(snapshot.sampledAtTick) || snapshot.sampledAtTick < window.round.start_tick || snapshot.sampledAtTick > context.cue.decision_tick || context.cue.decision_tick - snapshot.sampledAtTick > window.ageLimit || !Array.isArray(snapshot.missingFields) || !snapshot.missingFields.every(field => typeof field === "string") || snapshot.missingFields.includes("fresh_player_state")) return;
  return snapshot;
}

export function currentDiagnosisResources(context: TeachingDiagnosisHostContext, window: Window | undefined): DecisionResources | undefined {
  if (!window) return;
  const decisionTick = context.cue.decision_tick;
  let selected: PlayerStateSample | undefined;
  let duplicate = false;
  for (const state of context.timeline?.player_state_tracks ?? []) {
    if (state.player_id !== context.selectedPlayerId || !tick(state.tick) || state.tick < window.round.start_tick || state.tick > decisionTick) continue;
    if (!selected || state.tick > selected.tick) { selected = state; duplicate = false; }
    else if (state.tick === selected.tick) duplicate = true;
  }
  if (!selected || duplicate || decisionTick - selected.tick > window.ageLimit || selected.alive !== true || (selected.side !== "T" && selected.side !== "CT") || !Array.isArray(selected.missing_fields) || !selected.missing_fields.every(field => typeof field === "string")) return;
  if (context.timeline?.match_events?.some(event => event.event_type === "PLAYER_DEATH" && event.target_player_id === context.selectedPlayerId && tick(event.tick) && event.tick >= window.round.start_tick && event.tick <= decisionTick)) return;
  // Known raw zero HP contradicts alive=true even if a later snapshot conflicts.
  // A missing-field default zero is not evidence of death.
  if (selected.health === 0 && !hasMissing(selected.missing_fields, "health")) return;
  const missing = [...selected.missing_fields];
  const sourceSnapshot = context.material?.decisionSnapshot ?? context.cue.decisionSnapshot;
  if (sourceSnapshot) {
    const snapshot = currentDiagnosisSnapshot(context, window);
    const player = snapshot?.selectedPlayer.value;
    if (!snapshot || snapshot.sampledAtTick !== selected.tick || snapshot.selectedPlayer.boundary !== "OBSERVABLE" || !player || player.alive !== true || (player.side !== "T" && player.side !== "CT") || player.side !== selected.side) return;
    missing.push(...snapshot.missingFields);
    // Both views describe this exact sample. Unknown or conflicting snapshot fields
    // veto only that field; normalized raw defaults cannot override them.
    if (!bounded(player.health, 100) || player.health !== selected.health) missing.push("health");
    if (!bounded(player.armor, 100) || player.armor !== selected.armor) missing.push("armor");
    if (typeof player.helmet !== "boolean" || player.helmet !== selected.has_helmet) missing.push("helmet");
    if (!Array.isArray(player.grenades)) missing.push("inventory");
    if (!player.weapon || player.weapon !== selected.active_item?.item_id) missing.push("active_item.ammo_clip");
    if (!bounded(player.money, 10_000_000) || player.money !== selected.money) missing.push("money");
    if (!bounded(player.equipmentValue, 10_000_000) || player.equipmentValue !== selected.equipment_value) missing.push("equipment_value");
  }
  if (["alive", "side", "current_side", "fresh_player_state"].some(key => hasMissing(missing, key))) return;
  if (!Array.isArray(selected.fact_refs) || selected.fact_refs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 160)) return;
  const projected = projectDecisionResources({ ...selected, missing_fields: missing });
  delete projected.weaponAmmo;
  const currentItem = selected.active_item;
  if (!currentItem || hasMissing(missing, "active_item") || !Number.isSafeInteger(currentItem.entity_handle)) return projected;
  // Latest strictly prior frame only: no fallback through a missing/invalid newer sample.
  const prior = (context.timeline?.player_state_tracks ?? []).filter(state => state.player_id === context.selectedPlayerId
    && tick(state.tick) && state.tick >= window.round.start_tick && state.tick < decisionTick).sort((a, b) => b.tick - a.tick);
  const previous = prior[0];
  const ammo = previous?.active_item?.ammo_evidence;
  if (!previous || (prior[1] && prior[1].tick === previous.tick) || decisionTick - previous.tick > window.ageLimit
    || previous.alive !== true || previous.side !== selected.side || !ammo
    || ammo.sampled_at_tick !== previous.tick || previous.active_item?.item_id !== currentItem.item_id
    || ammo.weapon_handle !== currentItem.entity_handle) return projected;
  if (context.timeline?.match_events?.some(event =>
    ["WEAPON_FIRE", "RELOAD", "ITEM_PICKUP", "ITEM_DROP"].includes(event.event_type) && event.actor_player_id === context.selectedPlayerId
    && tick(event.tick) && event.tick > ammo.sampled_at_tick && event.tick <= decisionTick)) return projected;
  const known = projectDecisionResources(previous, decisionTick).weaponAmmo;
  if (known) projected.weaponAmmo = known;
  return projected;
}
