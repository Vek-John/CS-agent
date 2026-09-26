import type { DecisionSnapshot } from "@cs-coach/contracts";
import type { Cs2dRound } from "./index";

export const MAX_DECISION_SELF_FIRE_EVENTS = 3;
const tick = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Prior occurrence only; never infer a target, hit, line of sight or intent. */
export function decisionSelfFireEvents(input: {
  round: Cs2dRound; selectedPlayerId: string; decisionTick: number; sampledAtTick: number | null;
  tickRate: number; alive: boolean;
}): NonNullable<DecisionSnapshot["selfFireEvents"]> {
  const { round, selectedPlayerId, decisionTick, sampledAtTick, tickRate } = input;
  if (!input.alive || !selectedPlayerId.trim() || !tick(decisionTick) || !tick(sampledAtTick) ||
    !tick(round.startTick) || !tick(round.decidedTick) || decisionTick < round.startTick || decisionTick >= round.decidedTick ||
    !Number.isFinite(tickRate) || tickRate <= 0 || sampledAtTick > decisionTick || decisionTick - sampledAtTick > Math.ceil(tickRate / 2)) return [];
  const unsafeDeath = (at: unknown) => !tick(at) || (at >= round.startTick && at <= decisionTick);
  if ((round.events ?? []).some(event => event.type === "kill" && event.victimSteamId === selectedPlayerId && unsafeDeath(event.tick)) ||
    (round.frames ?? []).some(frame => frame.players.some(player => player.steamId === selectedPlayerId && (player.alive === false || player.health === 0)) && unsafeDeath(frame.tick)) ||
    (round.hurtEvents ?? []).some(event => event.victimSteamId === selectedPlayerId && event.reportedHealthAfter === 0 && unsafeDeath(event.tick))) return [];
  return (round.events ?? []).flatMap((event, index) => event.type === "shot" && event.shooterSteamId === selectedPlayerId && tick(event.tick) &&
    event.tick >= round.startTick && event.tick >= decisionTick - tickRate * 10 && event.tick < decisionTick && event.tick <= sampledAtTick
    ? [{ source: "DEMO_WEAPON_FIRE" as const, sourceRef: `cs2d-r${round.number}-event-${index + 1}`, tick: event.tick }] : [])
    .sort((a, b) => a.tick - b.tick || a.sourceRef.localeCompare(b.sourceRef)).slice(-MAX_DECISION_SELF_FIRE_EVENTS);
}

export function decisionSelfFireText(): string {
  return "决策前近期记录到本人开火。";
}
