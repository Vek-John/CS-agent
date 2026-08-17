import type { MatchEvent, MatchEventType, MatchTimeline, RoundTimeline } from "@cs-coach/contracts";
import { formatItem } from "../assets/item-display";

export const TRACK_WINDOW_SECONDS = 4;

const eventTypeLabels: Record<MatchEventType, string> = {
  ROUND_START: "回合开始",
  ROUND_END: "回合结束",
  PLAYER_SPAWN: "玩家出生",
  PLAYER_DEATH: "玩家阵亡",
  DAMAGE: "伤害",
  WEAPON_FIRE: "开火",
  RELOAD: "换弹",
  ITEM_PICKUP: "拾取道具",
  ITEM_DROP: "丢弃道具",
  GRENADE_THROW: "投掷物出手",
  GRENADE_DETONATE: "投掷物生效",
  UTILITY: "投掷物事件",
  BOMB_PLANT: "安装炸弹",
  BOMB_PICKUP: "拾取炸弹",
  BOMB_DROP: "掉落炸弹",
  BOMB_DEFUSE: "拆除炸弹",
  FOOTSTEP: "脚步",
  GUNSHOT: "枪声",
  OTHER: "其他事件"
};

export function formatEventType(eventType: MatchEventType): string {
  return eventTypeLabels[eventType] ?? eventType;
}

export function getTrackWindowTicks(
  tickRate: number,
  durationSeconds = TRACK_WINDOW_SECONDS
): number {
  return Math.max(1, Math.round(tickRate * durationSeconds));
}

export function windowedTrackSamples<T extends { tick: number }>(
  samples: readonly T[],
  tick: number,
  tickRate: number,
  durationSeconds = TRACK_WINDOW_SECONDS
): T[] {
  const startTick = tick - getTrackWindowTicks(tickRate, durationSeconds);
  return samples
    .filter((sample) => sample.tick >= startTick && sample.tick <= tick)
    .slice()
    .sort((left, right) => left.tick - right.tick);
}

export function roundAtTick(timeline: MatchTimeline, tick: number): RoundTimeline | undefined {
  const exact = timeline.rounds.find(
    (round) => tick >= round.start_tick && tick < round.end_tick
  );
  if (exact) return exact;

  const preceding = timeline.rounds
    .filter((round) => round.start_tick <= tick)
    .sort((left, right) => right.start_tick - left.start_tick)[0];
  return preceding ?? timeline.rounds[0];
}

export function formatMatchEvent(
  event: MatchEvent,
  displayNames: ReadonlyMap<string, string> = new Map()
): string {
  const actor = event.actor_player_id ? displayNames.get(event.actor_player_id) ?? event.actor_player_id : undefined;
  const target = event.target_player_id ? displayNames.get(event.target_player_id) ?? event.target_player_id : undefined;
  const participants = actor && target
    ? `${actor} → ${target}`
    : actor ?? target;
  const item = event.item_id
    ? ` · ${formatItem({ item_id: event.item_id, item_class: "item" })}`
    : "";
  return `${formatEventType(event.event_type)}${participants ? ` · ${participants}` : ""}${item}`;
}
