import type { DecisionSnapshot, PlayerStateSample, RoundTimeline } from "@cs-coach/contracts";
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

export function currentDiagnosisState(context: TeachingDiagnosisHostContext, window: Window | undefined): PlayerStateSample | undefined {
  if (!window) return;
  const decisionTick = context.cue.decision_tick;
  let selected: PlayerStateSample | undefined;
  let duplicate = false;
  for (const state of context.timeline?.player_state_tracks ?? []) {
    if (state.player_id !== context.selectedPlayerId || !tick(state.tick) || state.tick < window.round.start_tick || state.tick > decisionTick) continue;
    if (!selected || state.tick > selected.tick) { selected = state; duplicate = false; }
    else if (state.tick === selected.tick) duplicate = true;
  }
  if (!selected || duplicate || decisionTick - selected.tick > window.ageLimit || selected.alive !== true || (selected.side !== "T" && selected.side !== "CT") || !bounded(selected.health, 100) || selected.health === 0 || !bounded(selected.armor, 100) || typeof selected.has_helmet !== "boolean" || !Array.isArray(selected.missing_fields) || !selected.missing_fields.every(field => typeof field === "string")) return;
  if (context.timeline?.match_events?.some(event => event.event_type === "PLAYER_DEATH" && event.target_player_id === context.selectedPlayerId && tick(event.tick) && event.tick >= window.round.start_tick && event.tick <= decisionTick)) return;
  const missing = [...selected.missing_fields];
  const sourceSnapshot = context.material?.decisionSnapshot ?? context.cue.decisionSnapshot;
  if (sourceSnapshot) {
    const snapshot = currentDiagnosisSnapshot(context, window);
    const player = snapshot?.selectedPlayer.value;
    if (!snapshot || snapshot.sampledAtTick !== selected.tick || snapshot.selectedPlayer.boundary !== "OBSERVABLE" || !player || player.alive !== true || !bounded(player.health, 100) || !bounded(player.armor, 100) || typeof player.helmet !== "boolean") return;
    missing.push(...snapshot.missingFields);
    if (player.grenades === null) missing.push("inventory");
    if (player.money === null) missing.push("money");
    if (player.equipmentValue === null) missing.push("equipment_value");
  }
  if (["health", "armor", "helmet", "has_helmet", "alive", "side", "current_side", "fresh_player_state"].some(key => hasMissing(missing, key))) return;
  if (!Array.isArray(selected.inventory) || selected.inventory.length > 32 || selected.inventory.some(item => !item || !bounded(item.count, Number.MAX_VALUE)) || !Array.isArray(selected.fact_refs) || selected.fact_refs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 160)) return;
  // Optional unknowns are omitted, never backfilled or clamped into factual zeros.
  const state = { ...selected, missing_fields: missing, fact_refs: selected.fact_refs.slice(0, 32) };
  if (hasMissing(missing, "money") || !bounded(state.money, 10_000_000)) delete state.money;
  if (hasMissing(missing, "equipment_value") || hasMissing(missing, "equipmentValue") || !bounded(state.equipment_value, 10_000_000)) delete state.equipment_value;
  return state;
}
