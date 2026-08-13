import type { PlayerStateSample } from "@cs-coach/contracts";

const MAX_INTERPOLATION_GAP_TICKS = 48;

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function interpolateShortestAngle(previous: number, next: number, progress: number): number {
  const delta = ((next - previous + 540) % 360) - 180;
  return normalizeDegrees(previous + delta * progress);
}

function interpolateNumber(previous: number, next: number, progress: number): number {
  return previous + (next - previous) * progress;
}

/**
 * Samples full PlayerStateSample facts for the omniscient renderer.
 * Continuous movement/orientation is interpolated only across a short,
 * same-side, alive interval. Every gameplay/discrete field remains a
 * previous-sample step hold so this helper cannot invent state transitions.
 */
export function sampleStateAtTick(
  samples: readonly PlayerStateSample[],
  playerId: string,
  tick: number
): PlayerStateSample | undefined {
  const ordered = samples
    .filter((sample) => sample.player_id === playerId)
    .slice()
    .sort((left, right) => left.tick - right.tick);
  if (ordered.length === 0) return undefined;

  const exact = ordered.find((sample) => sample.tick === tick);
  if (exact) return exact;
  if (tick < ordered[0].tick) return ordered[0];
  if (tick > ordered[ordered.length - 1].tick) return ordered[ordered.length - 1];

  let previous: PlayerStateSample | undefined;
  let next: PlayerStateSample | undefined;
  for (const sample of ordered) {
    if (sample.tick < tick) previous = sample;
    if (sample.tick > tick) {
      next = sample;
      break;
    }
  }
  if (!previous || !next) return previous ?? next;

  const gap = next.tick - previous.tick;
  const canInterpolate =
    previous.side === next.side &&
    previous.alive &&
    next.alive &&
    gap <= MAX_INTERPOLATION_GAP_TICKS;
  if (!canInterpolate || gap <= 0) return previous;

  const progress = (tick - previous.tick) / gap;
  return {
    ...previous,
    tick,
    world_position: {
      x: interpolateNumber(previous.world_position.x, next.world_position.x, progress),
      y: interpolateNumber(previous.world_position.y, next.world_position.y, progress),
      z: interpolateNumber(previous.world_position.z, next.world_position.z, progress)
    },
    yaw: interpolateShortestAngle(previous.yaw, next.yaw, progress),
    pitch: interpolateNumber(previous.pitch, next.pitch, progress)
  };
}
