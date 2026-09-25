import type { Cs2dRound } from "./index";

export const MAX_WINDOW_FIRE_REFS = 3;
const tick = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Occurrence evidence only. Never inspect tracer coordinates, targets or media time. */
export function windowSelfFire(input: {
  round: Cs2dRound; roundNumber: number; startTick: number; endTick: number;
  selectedPlayerId: string; decisionTick: number; revealTick: number; aliveAtDecision: boolean;
}): { tick: number; refs: string[]; truncated: boolean } | undefined {
  const { round, roundNumber, startTick, endTick, selectedPlayerId, decisionTick, revealTick } = input;
  if (!selectedPlayerId.trim() || !input.aliveAtDecision || ![startTick, endTick, decisionTick, revealTick].every(tick)
    || decisionTick < startTick || decisionTick >= revealTick || revealTick >= endTick) return undefined;
  let deathTick = revealTick;
  for (const event of round.events ?? []) {
    if (event.type !== "kill" || event.victimSteamId !== selectedPlayerId) continue;
    // An attributed death with an unusable timestamp cannot establish a safe order.
    if (!tick(event.tick)) return undefined;
    if (event.tick >= startTick && event.tick <= revealTick) deathTick = Math.min(deathTick, event.tick);
  }
  for (const frame of round.frames ?? []) {
    const selfDead = frame.players.some(player => player.steamId === selectedPlayerId && (player.alive === false || player.health === 0));
    if (selfDead && !tick(frame.tick)) return undefined;
    if (selfDead && frame.tick >= startTick && frame.tick <= revealTick) deathTick = Math.min(deathTick, frame.tick);
  }
  for (const hurt of round.hurtEvents ?? []) {
    if (hurt.victimSteamId !== selectedPlayerId || hurt.reportedHealthAfter !== 0) continue;
    if (!tick(hurt.tick)) return undefined;
    if (hurt.tick >= startTick && hurt.tick <= revealTick) deathTick = Math.min(deathTick, hurt.tick);
  }
  const shots = (round.events ?? []).flatMap((event, index) => event.type === "shot" && event.shooterSteamId === selectedPlayerId && tick(event.tick)
    && event.tick > decisionTick && event.tick < revealTick && event.tick < deathTick
    ? [{ tick: event.tick, ref: `cs2d-r${roundNumber}-event-${index + 1}` }] : []);
  shots.sort((a, b) => a.tick - b.tick || a.ref.localeCompare(b.ref));
  const bounded = shots.slice(0, MAX_WINDOW_FIRE_REFS);
  return bounded.length ? { tick: bounded.at(-1)!.tick, refs: bounded.map(shot => shot.ref), truncated: shots.length > bounded.length } : undefined;
}
