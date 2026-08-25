import type {
  CoachingSessionState,
  PlaybackCommand,
  ReviewPlan
} from "@cs-coach/contracts";
import {
  getCurrentCue,
  getCurrentSegment,
  type SessionAction
} from "@cs-coach/session";

export interface GuidedPlaybackDirective {
  commands: readonly PlaybackCommand[];
  automaticAction?: SessionAction;
}

export interface GuidedSeekGate {
  epoch: number;
  targetTick: number;
  minTick: number;
  maxTick: number;
}

const DEFAULT_TICK_RATE = 64;

/**
 * A seek command and its first state event are asynchronous across the iframe.
 * Allow a small frame/playback landing window, but never let the previous
 * position jump the session past a decision or outcome boundary.
 */
export function createGuidedSeekGate(
  epoch: number,
  targetTick: number,
  tickRate = DEFAULT_TICK_RATE
): GuidedSeekGate {
  const rate = Number.isFinite(tickRate) && tickRate > 0 ? tickRate : DEFAULT_TICK_RATE;
  const frameSamplingWindow = Math.ceil(rate / 8);
  const playbackWindow = Math.ceil(rate / 16);
  const tolerance = Math.max(2, frameSamplingWindow + playbackWindow);
  return {
    epoch,
    targetTick,
    minTick: targetTick - tolerance,
    maxTick: targetTick + tolerance
  };
}

export function isGuidedSeekLanding(
  gate: GuidedSeekGate,
  canonicalTick: number
): boolean {
  return Number.isFinite(canonicalTick) &&
    canonicalTick >= gate.minTick &&
    canonicalTick <= gate.maxTick;
}

function preRollTick(
  segment: NonNullable<ReturnType<typeof getCurrentSegment>>,
  cue: NonNullable<ReturnType<typeof getCurrentCue>>,
  tickRate: number
): number {
  const oneSecond = Number.isFinite(tickRate) && tickRate > 0
    ? Math.round(tickRate)
    : DEFAULT_TICK_RATE;
  return Math.max(segment.start_tick, cue.decision_tick - oneSecond);
}

function boundedSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.max(0.25, Math.min(16, speed));
}

/**
 * Converts one deterministic coaching state transition into control-plane
 * commands for the existing cs2d player. It never emits Replay/frame data.
 */
export function guidedPlaybackDirective(
  plan: ReviewPlan,
  state: CoachingSessionState,
  tickRate = DEFAULT_TICK_RATE
): GuidedPlaybackDirective {
  const segment = getCurrentSegment(plan, state);
  const cue = getCurrentCue(plan, state);

  if (state.phase === "SKIPPING" && segment) {
    return {
      commands: [
        { type: "setCamera", mode: "full" },
        { type: "pause" },
        { type: "seekCanonicalTick", canonicalTick: segment.end_tick }
      ],
      automaticAction: { type: "SKIP_SEGMENT" }
    };
  }

  if (state.phase === "PLAYING" && segment) {
    const cue = getCurrentCue(plan, state);
    return {
      commands: [
        { type: "setCamera", mode: "full" },
        { type: "setSpeed", speed: boundedSpeed(segment.playback_speed) },
        {
          type: "seekCanonicalTick",
          canonicalTick: cue ? preRollTick(segment, cue, tickRate) : state.current_tick
        },
        { type: "play" }
      ]
    };
  }

  if ((state.phase === "REVEALING" || state.phase === "REPLAYING") && cue && segment) {
    return {
      commands: [
        { type: "setCamera", mode: "target" },
        { type: "setSpeed", speed: 1 },
        {
          type: "seekCanonicalTick",
          canonicalTick: state.phase === "REPLAYING"
            ? preRollTick(segment, cue, tickRate)
            : cue.outcome_start_tick
        },
        { type: "play" }
      ]
    };
  }

  if (state.phase === "PAUSED_FOR_COACHING") {
    return {
      commands: [
        { type: "setCamera", mode: cue ? "target" : "full" },
        { type: "pause" },
        { type: "seekCanonicalTick", canonicalTick: state.current_tick }
      ]
    };
  }

  return {
    commands: [
      { type: "setCamera", mode: "full" },
      { type: "pause" },
      { type: "seekCanonicalTick", canonicalTick: state.current_tick }
    ]
  };
}

/** A stable key that changes only when cs2d needs a new directive. */
export function guidedTransitionKey(state: CoachingSessionState): string {
  return [
    state.phase,
    state.current_segment_index,
    state.current_cue_id ?? "-",
    state.manual_cue_visit?.visit_id ?? "default",
    state.revealed_cue_ids.length
  ].join(":");
}
