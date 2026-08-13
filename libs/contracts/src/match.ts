import type { Direction, WorldPoint } from "./geometry";

export interface ActiveItem {
  item_id: string;
  item_class: string;
  ammo_clip?: number;
  ammo_reserve?: number;
}

export interface InventoryItem extends ActiveItem {
  count: number;
}

export interface PlayerStateSample {
  player_id: string;
  tick: number;
  side: "T" | "CT";
  world_position: WorldPoint;
  yaw: number;
  pitch: number;
  velocity?: Direction;
  alive: boolean;
  health: number;
  armor: number;
  has_helmet: boolean;
  money?: number;
  equipment_value?: number;
  active_item?: ActiveItem;
  inventory: readonly InventoryItem[];
  has_defuse_kit?: boolean;
  carries_c4?: boolean;
  fact_refs: readonly string[];
  missing_fields: readonly string[];
}

export type MatchEventType =
  | "ROUND_START"
  | "ROUND_END"
  | "PLAYER_SPAWN"
  | "PLAYER_DEATH"
  | "DAMAGE"
  | "WEAPON_FIRE"
  | "RELOAD"
  | "ITEM_PICKUP"
  | "ITEM_DROP"
  | "GRENADE_THROW"
  | "GRENADE_DETONATE"
  | "UTILITY"
  | "BOMB_PLANT"
  | "BOMB_PICKUP"
  | "BOMB_DROP"
  | "BOMB_DEFUSE"
  | "FOOTSTEP"
  | "GUNSHOT"
  | "OTHER";

export interface MatchEvent {
  id: string;
  tick: number;
  event_type: MatchEventType;
  actor_player_id?: string;
  target_player_id?: string;
  world_origin?: WorldPoint;
  item_id?: string;
  payload: Readonly<Record<string, unknown>>;
  source_parser_event: string;
  fact_confidence: number;
  fact_refs: readonly string[];
  missing_fields: readonly string[];
}
