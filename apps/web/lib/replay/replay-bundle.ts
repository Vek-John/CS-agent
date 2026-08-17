import type {
  GameAssetCatalog,
  MatchEvent,
  MatchPlayer,
  MatchTimeline,
  ObservableState,
  PlayerStateSample,
  PlayerTrack,
  ReviewPlan,
  RoundTimeline
} from "@cs-coach/contracts";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { loadLocalGameAssetCatalog } from "../assets/local-game-asset-catalog";

export const REPLAY_BUNDLE_URL = "/generated-data/test_demo.replay.json";

export type ReplayBundleStatus = "FIXTURE" | "LOADED" | "MISSING" | "INVALID";

export interface ReplayGrenadeTrack {
  id: string;
  item_id?: string;
  start_tick?: number;
  end_tick?: number;
  points?: readonly {
    tick: number;
    world_position: { x: number; y: number; z: number };
  }[];
  area?: {
    center: { x: number; y: number; z: number };
    radius: number;
  };
}

export interface ReplayViewModel {
  bundle_id: string;
  status: ReplayBundleStatus;
  source_kind: MatchTimeline["source_kind"];
  timeline: MatchTimeline;
  player_states: readonly PlayerStateSample[];
  events: readonly MatchEvent[];
  grenade_tracks: readonly ReplayGrenadeTrack[];
  observable_states: readonly ObservableState[];
  review_plan?: ReviewPlan;
  asset_catalog?: GameAssetCatalog;
  detail: string;
}

interface RecordLike {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): RecordLike | undefined {
  return isRecord(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWorldPoint(value: unknown): boolean {
  const point = asRecord(value);
  return Boolean(point && isFiniteNumber(point.x) && isFiniteNumber(point.y) && isFiniteNumber(point.z));
}

function isMatchPlayer(value: unknown): value is MatchPlayer {
  const player = asRecord(value);
  return Boolean(
    player &&
      typeof player.player_id === "string" &&
      typeof player.display_name === "string" &&
      (player.side === "T" || player.side === "CT") &&
      typeof player.is_selected === "boolean"
  );
}

function isRound(value: unknown): value is RoundTimeline {
  const round = asRecord(value);
  return Boolean(
    round &&
      isFiniteNumber(round.round_number) &&
      isFiniteNumber(round.start_tick) &&
      isFiniteNumber(round.freeze_end_tick) &&
      isFiniteNumber(round.end_tick) &&
      Array.isArray(round.score_before) &&
      round.score_before.length === 2 &&
      Array.isArray(round.score_after) &&
      round.score_after.length === 2 &&
      (round.winner === "T" || round.winner === "CT")
  );
}

function isPlayerStateSample(value: unknown): value is PlayerStateSample {
  const sample = asRecord(value);
  return Boolean(
    sample &&
      typeof sample.player_id === "string" &&
      isFiniteNumber(sample.tick) &&
      (sample.side === "T" || sample.side === "CT") &&
      isWorldPoint(sample.world_position) &&
      isFiniteNumber(sample.yaw) &&
      isFiniteNumber(sample.pitch) &&
      typeof sample.alive === "boolean" &&
      isFiniteNumber(sample.health) &&
      isFiniteNumber(sample.armor) &&
      typeof sample.has_helmet === "boolean" &&
      Array.isArray(sample.inventory) &&
      Array.isArray(sample.fact_refs) &&
      Array.isArray(sample.missing_fields)
  );
}

function isObservableState(value: unknown): value is ObservableState {
  const state = asRecord(value);
  return Boolean(
    state &&
      typeof state.id === "string" &&
      typeof state.demo_id === "string" &&
      typeof state.timeline_version === "string" &&
      typeof state.observer_player_id === "string" &&
      isFiniteNumber(state.at_tick) &&
      typeof state.observation_version === "string" &&
      Array.isArray(state.claims) &&
      Array.isArray(state.limitations)
  );
}

function isReviewPlan(value: unknown): value is ReviewPlan {
  const plan = asRecord(value);
  return Boolean(
    plan &&
      typeof plan.id === "string" &&
      typeof plan.demo_id === "string" &&
      typeof plan.player_id === "string" &&
      typeof plan.status === "string" &&
      Array.isArray(plan.segments) &&
      Array.isArray(plan.cues) &&
      Array.isArray(plan.habit_clusters)
  );
}

function isAssetCatalog(value: unknown): value is GameAssetCatalog {
  const catalog = asRecord(value);
  return Boolean(
    catalog &&
      typeof catalog.asset_version === "string" &&
      Array.isArray(catalog.maps) &&
      Array.isArray(catalog.item_icons) &&
      typeof catalog.generated_at === "string" &&
      isRecord(catalog.generation_manifest)
  );
}

function isPlayerTrack(value: unknown): value is PlayerTrack {
  const track = asRecord(value);
  return Boolean(track && typeof track.player_id === "string" && Array.isArray(track.samples));
}

function isMatchEvent(value: unknown): value is MatchEvent {
  const event = asRecord(value);
  return Boolean(
    event &&
      typeof event.id === "string" &&
      isFiniteNumber(event.tick) &&
      typeof event.event_type === "string" &&
      isRecord(event.payload) &&
      typeof event.source_parser_event === "string" &&
      isFiniteNumber(event.fact_confidence) &&
      Array.isArray(event.fact_refs) &&
      Array.isArray(event.missing_fields)
  );
}

function isReplayGrenadeTrack(value: unknown): value is ReplayGrenadeTrack {
  const track = asRecord(value);
  if (!track || typeof track.id !== "string") return false;
  if (track.points !== undefined && !asArray(track.points).every((point) => {
    const candidate = asRecord(point);
    const world = candidate ? asRecord(candidate.world_position) : undefined;
    return Boolean(candidate && isFiniteNumber(candidate.tick) && isWorldPoint(world));
  })) return false;
  if (track.area !== undefined) {
    const area = asRecord(track.area);
    if (!area || !isWorldPoint(area.center) || !isFiniteNumber(area.radius) || area.radius < 0) return false;
  }
  return true;
}

function isMatchTimeline(value: unknown): value is MatchTimeline {
  const timeline = asRecord(value);
  return Boolean(
    timeline &&
      typeof timeline.id === "string" &&
      typeof timeline.demo_id === "string" &&
      timeline.source_kind === "PARSED_DEMO" &&
      timeline.map_name === "de_mirage" &&
      isFiniteNumber(timeline.tick_rate) &&
      isFiniteNumber(timeline.start_tick) &&
      isFiniteNumber(timeline.end_tick) &&
      typeof timeline.selected_player_id === "string" &&
      asArray(timeline.players).every(isMatchPlayer) &&
      asArray(timeline.tracks).every(isPlayerTrack) &&
      asArray(timeline.rounds).every(isRound) &&
      typeof timeline.timeline_version === "string"
  );
}

/**
 * The worker owns the ReplayBundle schema. This adapter intentionally accepts
 * only the stable MatchTimeline boundary and keeps any file-shape probing local
 * to the web app until the generated bundle is available.
 */
function extractTimeline(payload: RecordLike): MatchTimeline | undefined {
  const candidates = [
    payload.match_timeline,
    payload.timeline,
    asRecord(payload.replay)?.match_timeline,
    asRecord(payload.replay)?.timeline
  ];
  return candidates.find(isMatchTimeline);
}

function extractPlayerStates(payload: RecordLike, timeline: MatchTimeline): PlayerStateSample[] {
  const candidates = [
    timeline.player_state_tracks,
    payload.player_state_tracks,
    payload.playerStates,
    asRecord(payload.replay)?.player_state_tracks
  ];
  return candidates.flatMap(asArray).filter(isPlayerStateSample);
}

function extractEvents(payload: RecordLike, timeline: MatchTimeline): MatchEvent[] {
  const candidates = [
    payload.events,
    timeline.match_events,
    asRecord(payload.replay)?.events
  ];
  return candidates.flatMap(asArray).filter(isMatchEvent);
}

function extractGrenadeTracks(payload: RecordLike): ReplayGrenadeTrack[] {
  const candidates = [
    payload.grenade_tracks,
    payload.grenadeTracks,
    asRecord(payload.replay)?.grenade_tracks
  ];
  return candidates.flatMap(asArray).filter(isReplayGrenadeTrack);
}

function extractObservableStates(payload: RecordLike): ObservableState[] {
  const candidates = [
    payload.observable_states,
    payload.observableStates,
    payload.observation_states,
    asRecord(payload.replay)?.observable_states
  ];
  return candidates.flatMap(asArray).filter(isObservableState);
}

function extractReviewPlan(payload: RecordLike): ReviewPlan | undefined {
  const candidates = [
    payload.review_plan,
    payload.reviewPlan,
    asRecord(payload.replay)?.review_plan,
    asRecord(payload.replay)?.reviewPlan
  ];
  return candidates.find(isReviewPlan);
}

function extractAssetCatalog(payload: RecordLike): GameAssetCatalog | undefined {
  const candidates = [payload.asset_catalog, payload.assetCatalog, asRecord(payload.assets)?.catalog];
  return candidates.find(isAssetCatalog);
}

export function createFixtureReplayView(): ReplayViewModel {
  const timeline = createSyntheticMirageTimeline();
  return {
    bundle_id: timeline.demo_id,
    status: "FIXTURE",
    source_kind: "SYNTHETIC_FIXTURE",
    timeline,
    player_states: [],
    events: [],
    grenade_tracks: [],
    observable_states: [],
    review_plan: createFixtureReviewPlan(timeline),
    detail: "当前是 AI 带看合成夹具；没有把夹具坐标或文本标记为真实 Demo/tick。"
  };
}

export function adaptReplayBundle(payload: unknown): ReplayViewModel {
  const record = asRecord(payload);
  const timeline = record ? extractTimeline(record) : undefined;
  if (!record || !timeline) {
    throw new Error("ReplayBundle 中没有可用的 PARSED_DEMO MatchTimeline。");
  }

  const events = extractEvents(record, timeline);
  const timelineWithEvents: MatchTimeline = { ...timeline, match_events: events };

  return {
    bundle_id: typeof record.bundle_id === "string" ? record.bundle_id : timeline.demo_id,
    status: "LOADED",
    source_kind: "PARSED_DEMO",
    timeline: timelineWithEvents,
    player_states: extractPlayerStates(record, timelineWithEvents),
    events,
    grenade_tracks: extractGrenadeTracks(record),
    observable_states: extractObservableStates(record),
    review_plan: extractReviewPlan(record),
    asset_catalog: extractAssetCatalog(record),
    detail: extractReviewPlan(record)
      ? "真实 ReplayBundle 已加载；可用字段按 bundle 提供。"
      : "真实 ReplayBundle 已加载；ReviewPlan 尚未生成，当前只显示回放，不展示 AI 结论。"
  };
}

function missingBundleView(status: "MISSING" | "INVALID", detail: string): ReplayViewModel {
  return { ...createFixtureReplayView(), status, detail };
}

export async function loadReplayBundle(url = REPLAY_BUNDLE_URL): Promise<ReplayViewModel> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 404) {
      return missingBundleView(
        "MISSING",
        `未找到 ${url}。请重新选择 Demo，或确认生成文件仍存在。`
      );
    }
    if (!response.ok) {
      return missingBundleView(
        "INVALID",
        `ReplayBundle 请求失败（HTTP ${response.status}）。请确认 localhost 静态资源可读取 ${url}。`
      );
    }
    const view = adaptReplayBundle(await response.json());
    if (view.asset_catalog) return view;
    const localCatalog = await loadLocalGameAssetCatalog();
    return localCatalog ? { ...view, asset_catalog: localCatalog } : view;
  } catch (error) {
    return missingBundleView(
      "INVALID",
      `ReplayBundle 无法解析，当前保留合成夹具。请检查 ${url} 是否为有效 JSON；${
        error instanceof Error ? error.message : "未知错误"
      }`
    );
  }
}
