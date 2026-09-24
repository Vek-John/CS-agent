import type { Cs2dFrame, Cs2dGameEvent } from "./index";

/** A nomination heuristic over sampled self movement, not a visibility or tactical rule. */
export const RETURN_AND_FIRE_HEURISTIC = {
  version: "self-movement-fire.v1", maxPriorSeconds: 10, maxActionSeconds: 2,
  maxSampleGapSeconds: 0.25, departureUnits: 48, returnUnits: 24,
  maxHeightDifferenceUnits: 32, maxPriorShots: 32, maxIntervalSamples: 256,
  cooldownSeconds: 2
} as const;

export interface ReturnAndFireNomination {
  decisionTick: number;
  shotTick: number;
  priorShotTick: number;
  priorShotEventIndex: number;
  shotEventIndex: number;
  sampleTicks: readonly number[];
}

interface SelfSample { tick: number; valid: boolean; x: number; y: number; z: number }
interface Shot { tick: number; eventIndex: number }

/** Only explicit actor/tick and selected player's samples are accessed. Shot coordinates,
 * enemy positions, damage, deaths, winners and outcome labels are not inputs to this seam.
 * Missing/dead/duplicate self frames break continuity, rather than being interpolated away.
 */
export function nominateReturnAndFire(input: {
  frames: readonly Cs2dFrame[]; events: readonly Cs2dGameEvent[];
  selectedPlayerId: string; tickRate: number; startTick: number; endTick: number;
}): ReturnAndFireNomination[] {
  const h = RETURN_AND_FIRE_HEURISTIC;
  if (!Number.isFinite(input.tickRate) || input.tickRate <= 0 || input.tickRate > 1024) return [];
  const frames: SelfSample[] = [];
  for (const frame of input.frames) {
    if (!Number.isSafeInteger(frame?.tick)) return [];
    if (frame.tick < input.startTick || frame.tick >= input.endTick) continue;
    const selves = (Array.isArray(frame.players) ? frame.players : []).filter(p => p?.steamId === input.selectedPlayerId);
    const p = selves[0];
    const valid = selves.length === 1 && p?.alive === true && Number.isFinite(p.health) && p.health > 0 && [p.x, p.y, p.z].every(Number.isFinite);
    frames.push({ tick: frame.tick, valid, x: valid ? p.x : 0, y: valid ? p.y : 0, z: valid ? p.z : 0 });
  }
  frames.sort((a, b) => a.tick - b.tick);
  for (let i = 1; i < frames.length; i++) if (frames[i]!.tick === frames[i - 1]!.tick) {
    frames[i]!.valid = false; frames[i - 1]!.valid = false;
  }
  const shots: Shot[] = [];
  input.events.forEach((e, eventIndex) => {
    if (e?.type === "shot" && e.shooterSteamId === input.selectedPlayerId && Number.isSafeInteger(e.tick) && e.tick >= input.startTick && e.tick < input.endTick) shots.push({ tick: e.tick, eventIndex });
  });
  shots.sort((a, b) => a.tick - b.tick || a.eventIndex - b.eventIndex);
  const atOrBefore = (tick: number) => {
    let lo = 0, hi = frames.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (frames[mid]!.tick <= tick) lo = mid + 1; else hi = mid; }
    return lo - 1;
  };
  const maxGap = h.maxSampleGapSeconds * input.tickRate;
  const results: ReturnAndFireNomination[] = [];
  let priorShots: Shot[] = [];
  let cooldownUntil = -Infinity;
  for (const shot of shots) {
    priorShots = priorShots.filter(p => shot.tick - p.tick <= h.maxPriorSeconds * input.tickRate).slice(-h.maxPriorShots);
    const endIndex = atOrBefore(shot.tick), end = frames[endIndex];
    if (shot.tick >= cooldownUntil && end?.valid && shot.tick - end.tick <= maxGap) {
      for (let i = priorShots.length - 1; i >= 0; i--) {
        const prior = priorShots[i]!;
        if (prior.tick >= shot.tick) continue;
        const startIndex = atOrBefore(prior.tick), start = frames[startIndex];
        if (!start?.valid || prior.tick - start.tick > maxGap || endIndex - startIndex < 2 || endIndex - startIndex + 1 > h.maxIntervalSamples) continue;
        if (Math.hypot(end.x - start.x, end.y - start.y) > h.returnUnits) continue;
        let farthest = startIndex, distance = 0, continuous = true;
        for (let j = startIndex; j <= endIndex; j++) {
          const sample = frames[j]!;
          if (!sample.valid || Math.abs(sample.z - start.z) > h.maxHeightDifferenceUnits || j > startIndex && sample.tick - frames[j - 1]!.tick > maxGap) { continuous = false; break; }
          const d = Math.hypot(sample.x - start.x, sample.y - start.y);
          if (d >= distance) { distance = d; farthest = j; }
        }
        const turn = frames[farthest]!;
        if (!continuous || distance < h.departureUnits || farthest >= endIndex || turn.tick <= prior.tick || shot.tick - turn.tick > h.maxActionSeconds * input.tickRate) continue;
        results.push({ decisionTick: turn.tick, shotTick: shot.tick, priorShotTick: prior.tick, priorShotEventIndex: prior.eventIndex, shotEventIndex: shot.eventIndex, sampleTicks: frames.slice(startIndex, endIndex + 1).map(s => s.tick) });
        cooldownUntil = shot.tick + h.cooldownSeconds * input.tickRate;
        priorShots = [];
        break;
      }
    }
    // A new firing burst cannot reuse the already-nominated movement cycle.
    priorShots.push(shot);
  }
  return results;
}
