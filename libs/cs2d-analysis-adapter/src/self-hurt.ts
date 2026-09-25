import type { DecisionSnapshot } from "@cs-coach/contracts";
import type { Cs2dRound } from "./index";

/** Raw event reports stay with Replay; none of these damage values imply actual HP loss. */
export interface Cs2dHurtEvent {
  readonly id: string;
  readonly tick: number;
  readonly victimSteamId: string | null;
  readonly reportedHealthDamage?: number | null;
  readonly reportedArmorDamage?: number | null;
  readonly reportedHealthAfter?: number | null;
  readonly reportedArmorAfter?: number | null;
}
export const MAX_SELF_HURT_EVENTS = 3;
export const SELF_HURT_WINDOW_SECONDS = 10;

export function firstSelfDeathTick(round: Cs2dRound, selectedPlayerId: string): number | undefined {
  return round.events?.filter(event => event.type === "kill" && event.victimSteamId === selectedPlayerId &&
    Number.isSafeInteger(event.tick) && event.tick >= round.freezeStartTick).map(event => event.tick).sort((a, b) => a - b)[0];
}

/** Deduplicate event identity, never by damage amount or the 8Hz health delta. */
export function selfHurtEvents(round: Cs2dRound, selectedPlayerId: string): Cs2dHurtEvent[] {
  const death = firstSelfDeathTick(round, selectedPlayerId);
  const seen = new Set<string>();
  return (round.hurtEvents ?? []).filter(event => {
    if (!event || typeof event.id !== "string" || !event.id.trim() || event.id.length > 160 ||
      event.victimSteamId !== selectedPlayerId || !Number.isSafeInteger(event.tick) ||
      event.tick < round.freezeStartTick || event.tick >= round.postEndTick || (death !== undefined && event.tick > death) || seen.has(event.id)) return false;
    seen.add(event.id); return true;
  }).sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
}

export function decisionSelfHurtEvents(round: Cs2dRound, selectedPlayerId: string, decisionTick: number, tickRate: number, alive: boolean): NonNullable<DecisionSnapshot["selfHurtEvents"]> {
  const death = firstSelfDeathTick(round, selectedPlayerId);
  if (!alive || death !== undefined && death <= decisionTick || !Number.isFinite(tickRate) || tickRate <= 0) return [];
  return selfHurtEvents(round, selectedPlayerId)
    .filter(event => event.tick < decisionTick && event.tick >= decisionTick - SELF_HURT_WINDOW_SECONDS * tickRate && event.reportedHealthAfter !== 0)
    .slice(-MAX_SELF_HURT_EVENTS).reverse()
    .map(event => ({ source: "DEMO_PLAYER_HURT", sourceRef: event.id, tick: event.tick }));
}

export function selfHurtFactText(): string {
  return "决策前已记录到你本人受击；具体伤害来源、方向和实际扣血量尚不能仅凭该事件确认。";
}
