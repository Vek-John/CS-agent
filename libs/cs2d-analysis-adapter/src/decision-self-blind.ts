import type { DecisionSnapshot } from "@cs-coach/contracts";
import type { Cs2dRound } from "./index";

/** Raw reports remain with Replay. Duration and thrower never enter teaching context. */
export interface Cs2dBlindEvent {
  readonly id?: string;
  readonly tick?: number;
  readonly blindEvidenceVersion?: number;
  readonly reportedDuration?: number;
  readonly steamId: string;
}
export const MAX_SELF_BLIND_EVENTS = 3;
const tick = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function decisionSelfBlindText(): string {
  return "决策前近期记录到本人受到闪光影响；不能据此确认当时是否仍受影响或具体视野。";
}
/** Prior occurrence only. Events after the sampled frame are valid, but not future events. */
export function decisionSelfBlindEvents(input: {
  round: Cs2dRound; selectedPlayerId: string; decisionTick: number; sampledAtTick: number | null; tickRate: number; alive: boolean;
}): NonNullable<DecisionSnapshot["selfBlindEvents"]> {
  const { round, selectedPlayerId, decisionTick, sampledAtTick, tickRate } = input;
  if (!input.alive || !selectedPlayerId.trim() || !tick(decisionTick) || !tick(sampledAtTick) || !tick(round.startTick) || !tick(round.decidedTick) ||
    decisionTick < round.startTick || decisionTick >= round.decidedTick || !Number.isFinite(tickRate) || tickRate <= 0 ||
    sampledAtTick > decisionTick || decisionTick - sampledAtTick > Math.ceil(tickRate / 2)) return [];
  const unsafeDeath = (at: unknown) => !tick(at) || (at >= round.startTick && at <= decisionTick);
  if ((round.events ?? []).some(event => event.type === "kill" && event.victimSteamId === selectedPlayerId && unsafeDeath(event.tick)) ||
    (round.frames ?? []).some(frame => frame.players.some(player => player.steamId === selectedPlayerId && (player.alive === false || player.health === 0)) && unsafeDeath(frame.tick)) ||
    (round.hurtEvents ?? []).some(event => event.victimSteamId === selectedPlayerId && event.reportedHealthAfter === 0 && unsafeDeath(event.tick))) return [];
  const reports = Array.isArray(round.blinds) ? round.blinds : [];
  const counts = new Map<string, number>();
  for (const report of reports) if (report && typeof report.id === "string") counts.set(report.id, (counts.get(report.id) ?? 0) + 1);
  return reports.flatMap(report => {
    if (!report || report.blindEvidenceVersion !== 1 || report.steamId !== selectedPlayerId || !tick(report.tick) ||
      typeof report.id !== "string" || report.id.length > 160 || !new RegExp(`^cs2d-blind-${report.tick}-[1-9][0-9]*$`).test(report.id) || counts.get(report.id) !== 1 ||
      typeof report.reportedDuration !== "number" || !Number.isFinite(report.reportedDuration) || report.reportedDuration <= 0 ||
      report.tick < round.startTick || report.tick >= decisionTick || report.tick < decisionTick - 10 * tickRate) return [];
    return [{ source: "DEMO_PLAYER_BLIND" as const, sourceRef: report.id, tick: report.tick }];
  }).sort((a, b) => a.tick - b.tick || a.sourceRef.localeCompare(b.sourceRef)).slice(-MAX_SELF_BLIND_EVENTS);
}
