import type {
  MapAssetManifest,
  ObservableState,
  PlayerStateSample
} from "@cs-coach/contracts";
import { worldToNormalized } from "@cs-coach/map-semantics";
import type { ReplayViewModel } from "../replay-bundle";
import { radarYawFromWorldYaw, sampleGroundTruthStateAtTick } from "./playback-frame";
import type {
  GroundTruthProjectileSample,
  GroundTruthProjectileTrack,
  GroundTruthReplaySource,
  KnowledgeFrameInput,
  PlaybackFrameActor
} from "./playback-frame";

export interface ObservationBoundaryInput {
  selected_player_id: string;
  observable_states: readonly ObservableState[];
}

interface RawProjectileTrack {
  track_id?: unknown;
  id?: unknown;
  grenade_type?: unknown;
  item_id?: unknown;
  samples?: unknown;
  points?: unknown;
  start_tick?: unknown;
  end_tick?: unknown;
  detonate_tick?: unknown;
  expire_tick?: unknown;
  area?: unknown;
  fact_refs?: unknown;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isWorldPoint(value: unknown): value is { x: number; y: number; z: number } {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return isFiniteNumber(point.x) && isFiniteNumber(point.y) && isFiniteNumber(point.z);
}

function mapProjectileTrack(track: ReplayViewModel["grenade_tracks"][number]): GroundTruthProjectileTrack | undefined {
  const raw = track as unknown as RawProjectileTrack;
  const trackId = typeof raw.track_id === "string" && raw.track_id.trim()
    ? raw.track_id
    : typeof raw.id === "string" && raw.id.trim()
      ? raw.id
      : undefined;
  if (!trackId) return undefined;
  const rawSamples = Array.isArray(raw.samples) ? raw.samples : Array.isArray(raw.points) ? raw.points : [];
  const samples: GroundTruthProjectileSample[] = rawSamples.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const candidate = value as Record<string, unknown>;
    return isFiniteNumber(candidate.tick) && isWorldPoint(candidate.world_position)
      ? [{ tick: candidate.tick, world_position: candidate.world_position }]
      : [];
  }).sort((left, right) => left.tick - right.tick);
  if (samples.length === 0) return undefined;
  const rawArea = typeof raw.area === "object" && raw.area !== null ? raw.area as Record<string, unknown> : undefined;
  const area = rawArea && isWorldPoint(rawArea.center) && isFiniteNumber(rawArea.radius) && rawArea.radius >= 0
    ? { center: rawArea.center, radius: rawArea.radius }
    : undefined;
  return {
    track_id: trackId,
    grenade_type: typeof raw.grenade_type === "string" ? raw.grenade_type : undefined,
    item_id: typeof raw.item_id === "string" ? raw.item_id : undefined,
    samples,
    start_tick: isFiniteNumber(raw.start_tick) ? raw.start_tick : undefined,
    end_tick: isFiniteNumber(raw.end_tick) ? raw.end_tick : undefined,
    detonate_tick: isFiniteNumber(raw.detonate_tick) ? raw.detonate_tick : undefined,
    expire_tick: isFiniteNumber(raw.expire_tick) ? raw.expire_tick : undefined,
    area,
    source_fact_refs: Array.isArray(raw.fact_refs) ? raw.fact_refs.filter((value): value is string => typeof value === "string") : []
  };
}

/**
 * The web loader has already consumed the worker-produced ReplayBundle JSON.
 * This adapter indexes that one parsed result once; builders never fetch or
 * parse a .dem and Pixi never sees the ReplayViewModel.
 */
export function toGroundTruthReplaySource(view: ReplayViewModel): GroundTruthReplaySource {
  if (view.status !== "LOADED" || view.source_kind !== "PARSED_DEMO") {
    throw new Error("Pixi PoC requires a loaded PARSED_DEMO ReplayBundle; fixture data is not promoted to truth.");
  }

  const samplesByPlayer = new Map<string, PlayerStateSample[]>();
  for (const sample of view.player_states) {
    const samples = samplesByPlayer.get(sample.player_id) ?? [];
    samples.push(sample);
    samplesByPlayer.set(sample.player_id, samples);
  }
  for (const samples of samplesByPlayer.values()) {
    samples.sort((left, right) => left.tick - right.tick);
  }

  const projectileTracks = view.grenade_tracks.flatMap((track) => {
    const mapped = mapProjectileTrack(track);
    return mapped ? [mapped] : [];
  });

  return {
    bundle_id: view.bundle_id,
    demo_id: view.timeline.demo_id,
    tick_rate: view.timeline.tick_rate,
    start_tick: view.timeline.start_tick,
    end_tick: view.timeline.end_tick,
    selected_player_id: view.timeline.selected_player_id,
    players: view.timeline.players,
    rounds: view.timeline.rounds,
    player_states_by_player: samplesByPlayer,
    events: view.events,
    projectile_tracks: projectileTracks
  };
}

export function toObservationBoundaryInput(view: ReplayViewModel): ObservationBoundaryInput {
  return {
    selected_player_id: view.timeline.selected_player_id,
    observable_states: view.observable_states
  };
}

/**
 * Observer adapter for the PoC route. It creates the only safe self-state
 * slot from the selected player's own sample and passes no other ground truth
 * into buildKnowledgeFrame.
 */
export function toKnowledgeFrameInput(
  source: GroundTruthReplaySource,
  tick: number,
  observation: ObservationBoundaryInput,
  manifest: MapAssetManifest
): KnowledgeFrameInput {
  const player = source.players.find((candidate) => candidate.player_id === source.selected_player_id);
  const sample = sampleGroundTruthStateAtTick(
    source.player_states_by_player.get(source.selected_player_id) ?? [],
    source.selected_player_id,
    tick
  );
  const observerKnownState: PlaybackFrameActor | undefined = sample
    ? {
        id: sample.player_id,
        label: player?.display_name ?? sample.player_id,
        side: sample.side,
        radar_position: worldToNormalized(sample.world_position, manifest),
        radar_yaw: radarYawFromWorldYaw(sample.world_position, sample.yaw, manifest),
        status: sample.alive ? "ALIVE" : "DEAD",
        health: sample.health,
        armor: sample.armor,
        money: sample.money,
        active_item: sample.active_item?.item_id,
        inventory: sample.inventory.map((item) => item.item_id),
        has_defuse_kit: sample.has_defuse_kit,
        carries_c4: sample.carries_c4,
        source: "SELF_STATE",
        source_fact_refs: [...sample.fact_refs],
        source_claim_ids: []
      }
    : undefined;
  const observableState = observation.observable_states
    .filter((state) => state.observer_player_id === observation.selected_player_id && state.at_tick <= tick)
    .sort((left, right) => right.at_tick - left.at_tick)[0];
  if (observerKnownState) {
    const ownClaimIds = observableState?.claims
      .filter((claim) => claim.subject_ref === source.selected_player_id)
      .map((claim) => claim.id) ?? [];
    observerKnownState.source_claim_ids = ownClaimIds;
  }
  const groundTruthRound = source.rounds.find((candidate) => (
    tick >= candidate.start_tick && tick < candidate.end_tick
  )) ?? source.rounds.filter((candidate) => candidate.start_tick <= tick).at(-1);
  const round = groundTruthRound ? {
    round_number: groundTruthRound.round_number,
    start_tick: groundTruthRound.start_tick,
    freeze_end_tick: groundTruthRound.freeze_end_tick,
    score_before: groundTruthRound.score_before
  } : undefined;
  return {
    tick,
    tick_rate: source.tick_rate,
    selected_player_id: observation.selected_player_id,
    observable_state: observableState,
    observer_known_state: observerKnownState,
    round
  };
}
