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
  state: CoachingSessionState
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
    return {
      commands: [
        { type: "setCamera", mode: "full" },
        { type: "setSpeed", speed: boundedSpeed(segment.playback_speed) },
        { type: "seekCanonicalTick", canonicalTick: state.current_tick },
        { type: "play" }
      ]
    };
  }

  if ((state.phase === "REVEALING" || state.phase === "REPLAYING") && cue) {
    return {
      commands: [
        { type: "setCamera", mode: "full" },
        { type: "setSpeed", speed: 1 },
        { type: "seekCanonicalTick", canonicalTick: cue.outcome_start_tick },
        { type: "play" }
      ]
    };
  }

  if (state.phase === "PAUSED_FOR_COACHING") {
    const cameraMode = cue && !state.revealed_cue_ids.includes(cue.id) ? "target" : "full";
    return {
      commands: [
        { type: "setCamera", mode: cameraMode },
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
    state.revealed_cue_ids.length
  ].join(":");
}
