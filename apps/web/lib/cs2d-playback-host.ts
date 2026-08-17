import {
  commandEnvelope,
  isPlaybackEventEnvelope,
  type PlaybackCommand,
  type PlaybackEventEnvelope,
  type PlaybackStateEvent,
  type ReplayReadyEvent,
  type ReviewPlan
} from "@cs-coach/contracts";

export const DEFAULT_CS2D_HOST_URL = "http://localhost:5174/?host=1";

export interface Cs2dHostConfig {
  url: string;
  origin: string;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function cs2dHostConfig(
  raw = process.env.NEXT_PUBLIC_CS2D_HOST_URL,
  parentOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN || "http://localhost:3000"
): Cs2dHostConfig {
  const parsed = new URL(raw?.trim() || DEFAULT_CS2D_HOST_URL);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("cs2d host URL must use http or https.");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error("cs2d host must remain on localhost until the upstream license is clarified.");
  }
  const parent = new URL(parentOrigin);
  if (parent.protocol !== "http:" && parent.protocol !== "https:") {
    throw new Error("parent origin must use http or https.");
  }
  parsed.searchParams.set("host", "1");
  parsed.searchParams.set("parentOrigin", parent.origin);
  return { url: parsed.toString(), origin: parsed.origin };
}

export function acceptedPlaybackEvent(input: {
  data: unknown;
  eventOrigin: string;
  expectedOrigin: string;
  sourceMatches: boolean;
}): PlaybackEventEnvelope | undefined {
  if (!input.sourceMatches || input.eventOrigin !== input.expectedOrigin) return undefined;
  return isPlaybackEventEnvelope(input.data) ? input.data : undefined;
}

export function playbackCommandMessage(command: PlaybackCommand) {
  return commandEnvelope(command);
}

export const HOST_SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8] as const;

export type ReviewSegmentTone = "coach" | "skip" | "neutral";

export function reviewSegmentTone(
  mode: ReviewPlan["segments"][number]["mode"]
): ReviewSegmentTone {
  if (mode === "SKIP") return "skip";
  if (mode === "DEEP_DIVE" || mode === "HABIT_CHECK") return "coach";
  return "neutral";
}

export function reviewSegmentLabel(segment: ReviewPlan["segments"][number]): string {
  if (segment.mode === "DEEP_DIVE") return "深入讲解";
  if (segment.mode === "HABIT_CHECK") return "习惯复查";
  if (segment.mode === "SKIP") return "低价值片段";
  if (segment.mode === "OBSERVE") return "观察片段";
  return "普通比赛";
}

export function timelinePercent(value: number, min: number, max: number): number {
  if (![value, min, max].every(Number.isFinite) || max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

export interface TimelineRange {
  leftPercent: number;
  widthPercent: number;
}

export function timelineRange(
  start: number,
  end: number,
  min: number,
  max: number,
): TimelineRange {
  const leftPercent = timelinePercent(start, min, max);
  const endPercent = timelinePercent(end, min, max);
  return {
    leftPercent: Math.min(leftPercent, endPercent),
    widthPercent: Math.max(0, endPercent - leftPercent)
  };
}

export function clampCanonicalTick(value: number, min: number, max: number): number {
  if (![min, max].every(Number.isFinite)) return 0;
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  if (!Number.isFinite(value)) return lower;
  return Math.min(upper, Math.max(lower, value));
}

export function seekCanonicalBySeconds(
  currentTick: number,
  seconds: number,
  tickRate: number,
  min: number,
  max: number,
): number {
  const delta = Number.isFinite(seconds) && Number.isFinite(tickRate) && tickRate > 0
    ? seconds * tickRate
    : 0;
  return clampCanonicalTick(currentTick + delta, min, max);
}

export function adjacentRoundIndex(
  currentIndex: number,
  delta: number,
  roundCount: number,
): number {
  if (!Number.isInteger(roundCount) || roundCount <= 0) return -1;
  const base = Number.isInteger(currentIndex) ? currentIndex : 0;
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return Math.min(roundCount - 1, Math.max(0, base + step));
}


/**
 * Maps the compact bridge state to language a player can scan without exposing
 * parser coordinates. The canonical tick remains an internal seek coordinate.
 */
export function playbackPositionLabel(
  playback: PlaybackStateEvent | undefined,
  replay: ReplayReadyEvent | undefined,
): string {
  if (!playback || !replay) return "—";
  const round = replay.rounds[playback.roundIndex];
  if (!round) return "整场进度";
  const elapsed = Math.max(0, (playback.canonicalTick - round.startCanonicalTick) / replay.tickRate);
  const minutes = Math.floor(elapsed / 60);
  const seconds = Math.floor(elapsed % 60).toString().padStart(2, "0");
  const roundLabel = round.roundNumber > 0 ? `第 ${round.roundNumber} 回合` : "准备回合";
  return `${roundLabel} · ${minutes}:${seconds}`;
}


export interface ReviewPlaybackPosition {
  roundLabel: string;
  segment?: ReviewPlan["segments"][number];
}

/** Finds the plan coverage at the live bridge position for manual free viewing. */
export function reviewPositionAtTick(
  playback: PlaybackStateEvent | undefined,
  replay: ReplayReadyEvent | undefined,
  plan: ReviewPlan | undefined,
): ReviewPlaybackPosition {
  const tick = playback?.canonicalTick;
  const round = replay && Number.isFinite(tick)
    ? replay.rounds.find((candidate, index, rounds) =>
      tick! >= candidate.startCanonicalTick &&
      (tick! < candidate.endCanonicalTick || (index === rounds.length - 1 && tick! <= candidate.endCanonicalTick)),
    )
    : undefined;
  const segment = plan && Number.isFinite(tick)
    ? plan.segments.find((candidate) => tick! >= candidate.start_tick && tick! < candidate.end_tick)
    : undefined;
  const roundNumber = round?.roundNumber ?? segment?.round_number;
  return {
    roundLabel: roundNumber && roundNumber > 0 ? `第 ${roundNumber} 回合` : roundNumber === 0 ? "准备回合" : "比赛位置",
    segment,
  };
}
