import type {
  MapAssetManifest,
  MatchEvent,
  MatchEventType,
  MatchPlayer,
  ObservableState,
  ObservationClaim,
  PlayerStateSample,
  Point2D,
  TeamSide,
  WorldPoint
} from "@cs-coach/contracts";
import { worldToNormalized } from "@cs-coach/map-semantics";

/**
 * Product-facing frame data for the isolated renderer PoC.
 *
 * The Pixi layer consumes this view model only. It never receives a parsed
 * bundle, raw PlayerStateSample, ObservableState, or parser event. Builders
 * below are the one-way boundary from parsed ground truth/observation data to
 * displayable facts.
 */
export type PlaybackPerspective = "OMNISCIENT" | "PLAYER_KNOWLEDGE";
export type FrameSide = TeamSide | "UNKNOWN";

export interface GroundTruthRound {
  round_number: number;
  start_tick: number;
  freeze_end_tick: number;
  end_tick: number;
  score_before: readonly [number, number];
  score_after: readonly [number, number];
  winner: TeamSide;
}

export interface KnowledgeFrameRound {
  round_number: number;
  start_tick: number;
  freeze_end_tick: number;
  score_before: readonly [number, number];
}

export type PlaybackFrameRound = KnowledgeFrameRound & Partial<Pick<
  GroundTruthRound,
  "end_tick" | "score_after" | "winner"
>>;

export interface GroundTruthProjectileSample {
  tick: number;
  world_position: WorldPoint;
}

export interface GroundTruthProjectileTrack {
  track_id: string;
  grenade_type?: string;
  item_id?: string;
  samples: readonly GroundTruthProjectileSample[];
  start_tick?: number;
  end_tick?: number;
  detonate_tick?: number;
  expire_tick?: number;
  area?: {
    center: WorldPoint;
    radius: number;
  };
  source_fact_refs: readonly string[];
}

/**
 * Parser output after the single .dem parse. This is deliberately narrower
 * than ReplayBundle and is the only input accepted by the frame builders.
 */
export interface GroundTruthReplaySource {
  bundle_id: string;
  demo_id: string;
  tick_rate: number;
  start_tick: number;
  end_tick: number;
  selected_player_id: string;
  players: readonly MatchPlayer[];
  rounds: readonly GroundTruthRound[];
  player_states_by_player: ReadonlyMap<string, readonly PlayerStateSample[]>;
  events: readonly MatchEvent[];
  projectile_tracks: readonly GroundTruthProjectileTrack[];
}

interface PlaybackSourceRefs {
  source_fact_refs: readonly string[];
  source_claim_ids: readonly string[];
}

export interface PlaybackFrameActor extends PlaybackSourceRefs {
  id: string;
  label: string;
  side: FrameSide;
  radar_position: Point2D;
  /** Heading in radar space; the builder has already applied map rotation/reflection. */
  radar_yaw?: number;
  status: "ALIVE" | "DEAD" | "UNKNOWN";
  health?: number;
  armor?: number;
  money?: number;
  active_item?: string;
  inventory: readonly string[];
  has_defuse_kit?: boolean;
  carries_c4?: boolean;
  source: "GROUND_TRUTH" | "SELF_STATE" | "DIRECT_VISION";
}

export interface PlaybackFrameProjectile extends PlaybackSourceRefs {
  id: string;
  label: string;
  radar_flight_points: readonly Point2D[];
  radar_current_position?: Point2D;
  radar_landing_position?: Point2D;
  radar_effect_area?: {
    center: Point2D;
    radius: number;
  };
}

export interface PlaybackFrameEffect extends PlaybackSourceRefs {
  id: string;
  kind: "EVENT";
  event_type: MatchEventType;
  radar_position?: Point2D;
}

export type PlaybackFrameEvidence =
  | {
      id: string;
      kind: "SOUND_DIRECTION" | "DAMAGE_DIRECTION";
      radar_origin: Point2D;
      radar_ray_end: Point2D;
      radar_left_end: Point2D;
      radar_right_end: Point2D;
      width_degrees: number;
      source_fact_refs: readonly string[];
      source_claim_ids: readonly string[];
    }
  | {
      id: string;
      kind: "AREA" | "LAST_KNOWN";
      radar_center: Point2D;
      radius: number;
      opacity?: number;
      source_fact_refs: readonly string[];
      source_claim_ids: readonly string[];
    };

export interface PlaybackFrameBomb extends PlaybackSourceRefs {
  state: "PLANTING" | "PLANTED" | "DEFUSING" | "DEFUSED" | "DROPPED" | "CARRIED" | "UNKNOWN";
  radar_position?: Point2D;
  source_event_id?: string;
}

export type PlaybackAnnotation =
  | ({ id: string; kind: "POINT"; radar_point: Point2D; label?: string } & PlaybackSourceRefs)
  | ({ id: string; kind: "LINE"; radar_from: Point2D; radar_to: Point2D; label?: string } & PlaybackSourceRefs)
  | ({ id: string; kind: "AREA"; radar_center: Point2D; radius: number; label?: string } & PlaybackSourceRefs);

export interface PlaybackFrameDroppedWeapon extends PlaybackSourceRefs {
  id: string;
  item_id: string;
  radar_position: Point2D;
}

export interface PlaybackFrameViewModel {
  tick: number;
  tick_rate: number;
  perspective: PlaybackPerspective;
  selected_player_id: string;
  actors: readonly PlaybackFrameActor[];
  projectiles: readonly PlaybackFrameProjectile[];
  dropped_weapons: readonly PlaybackFrameDroppedWeapon[];
  effects: readonly PlaybackFrameEffect[];
  evidence: readonly PlaybackFrameEvidence[];
  annotations: readonly PlaybackAnnotation[];
  bomb?: PlaybackFrameBomb;
  round?: PlaybackFrameRound;
}

export interface PlaybackFrameBuildOptions {
  annotations?: readonly PlaybackAnnotation[];
}

/**
 * Already-observed input for the knowledge renderer. Deliberately contains no
 * player-state track, global event list, player roster, or grenade ground
 * truth. The observer adapter must prove/construct these slots first.
 */
export interface KnowledgeFrameInput {
  tick: number;
  tick_rate: number;
  selected_player_id: string;
  observable_state?: ObservableState;
  observer_known_state?: PlaybackFrameActor;
  observable_projectile_history?: readonly PlaybackFrameProjectile[];
  observable_effects?: readonly PlaybackFrameEffect[];
  observable_bomb?: PlaybackFrameBomb;
  observable_dropped_weapons?: readonly PlaybackFrameDroppedWeapon[];
  round?: KnowledgeFrameRound;
}

function pointFromWorld(point: WorldPoint, manifest: MapAssetManifest): Point2D {
  return worldToNormalized(point, manifest);
}

export function radarYawFromWorldYaw(
  point: WorldPoint,
  worldYaw: number,
  manifest: MapAssetManifest
): number {
  const headingRadians = (worldYaw * Math.PI) / 180;
  const radarOrigin = pointFromWorld(point, manifest);
  const radarHeading = pointFromWorld({
    x: point.x + Math.cos(headingRadians) * 100,
    y: point.y + Math.sin(headingRadians) * 100,
    z: point.z
  }, manifest);
  return normalizeDegrees(
    Math.atan2(radarHeading.y - radarOrigin.y, radarHeading.x - radarOrigin.x) * 180 / Math.PI
  );
}

const MAX_GROUND_TRUTH_INTERPOLATION_GAP = 48;

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function interpolateAngle(previous: number, next: number, progress: number): number {
  const delta = ((next - previous + 540) % 360) - 180;
  return normalizeDegrees(previous + delta * progress);
}

/** Minimal PoC-local sampler; it does not depend on the web renderer helper. */
export function sampleGroundTruthStateAtTick(
  samples: readonly PlayerStateSample[],
  playerId: string,
  tick: number
): PlayerStateSample | undefined {
  // GroundTruthReplaySource indexes and sorts one track per player exactly
  // once. Binary search keeps the per-Pixi-tick builder hot path O(log n)
  // instead of copying and sorting thousands of samples for every actor.
  if (samples.length === 0 || samples[0]?.player_id !== playerId) return undefined;
  if (tick < samples[0].tick) return undefined;
  if (tick >= samples[samples.length - 1].tick) return samples[samples.length - 1];
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].tick <= tick) low = middle + 1;
    else high = middle;
  }
  const previous = samples[low - 1];
  const next = samples[low];
  if (previous?.tick === tick) return previous;
  if (!previous || !next) return previous ?? next;
  const gap = next.tick - previous.tick;
  if (
    gap <= 0 ||
    gap > MAX_GROUND_TRUTH_INTERPOLATION_GAP ||
    previous.side !== next.side ||
    !previous.alive ||
    !next.alive
  ) {
    return previous;
  }
  const progress = (tick - previous.tick) / gap;
  return {
    ...previous,
    tick,
    world_position: {
      x: previous.world_position.x + (next.world_position.x - previous.world_position.x) * progress,
      y: previous.world_position.y + (next.world_position.y - previous.world_position.y) * progress,
      z: previous.world_position.z + (next.world_position.z - previous.world_position.z) * progress
    },
    yaw: interpolateAngle(previous.yaw, next.yaw, progress),
    pitch: previous.pitch + (next.pitch - previous.pitch) * progress
  };
}

function normalizedRadius(
  center: WorldPoint,
  radius: number,
  manifest: MapAssetManifest
): number {
  const normalizedCenter = pointFromWorld(center, manifest);
  const normalizedEdge = pointFromWorld({
    x: center.x + radius,
    y: center.y,
    z: center.z
  }, manifest);
  return Math.hypot(
    normalizedEdge.x - normalizedCenter.x,
    normalizedEdge.y - normalizedCenter.y
  );
}

function directionPoint(
  origin: WorldPoint,
  bearingDegrees: number,
  distance: number,
  manifest: MapAssetManifest
): Point2D {
  const radians = (bearingDegrees * Math.PI) / 180;
  return pointFromWorld({
    x: origin.x + Math.cos(radians) * distance,
    y: origin.y + Math.sin(radians) * distance,
    z: origin.z
  }, manifest);
}

function availableClaims(
  observableState: ObservableState | undefined,
  selectedPlayerId: string,
  tick: number
): readonly ObservationClaim[] {
  if (
    !observableState ||
    observableState.observer_player_id !== selectedPlayerId ||
    observableState.at_tick > tick
  ) {
    return [];
  }
  return (observableState?.claims ?? []).filter((claim) => (
    claim.evidence_tick <= tick &&
    claim.available_from_tick <= tick &&
    (claim.expires_at_tick === undefined || tick < claim.expires_at_tick)
  ));
}

function sampleForPlayer(
  source: GroundTruthReplaySource,
  playerId: string,
  tick: number
): PlayerStateSample | undefined {
  return sampleGroundTruthStateAtTick(source.player_states_by_player.get(playerId) ?? [], playerId, tick);
}

function actorFromSample(
  player: MatchPlayer | undefined,
  sample: PlayerStateSample,
  source: PlaybackFrameActor["source"]
): PlaybackFrameActor {
  return {
    id: sample.player_id,
    label: player?.display_name ?? sample.player_id,
    // The current sample is authoritative for side; MatchPlayer.side is only
    // initial metadata and can be stale after a half-side swap.
    side: sample.side,
    radar_position: { x: sample.world_position.x, y: sample.world_position.y },
    status: sample.alive ? "ALIVE" : "DEAD",
    health: sample.health,
    armor: sample.armor,
    money: sample.money,
    active_item: sample.active_item?.item_id,
    inventory: sample.inventory.map((item) => item.item_id),
    has_defuse_kit: sample.has_defuse_kit,
    carries_c4: sample.carries_c4,
    source,
    source_fact_refs: [...sample.fact_refs],
    source_claim_ids: []
  };
}

function normalizedActorFromSample(
  player: MatchPlayer | undefined,
  sample: PlayerStateSample,
  manifest: MapAssetManifest,
  source: PlaybackFrameActor["source"]
): PlaybackFrameActor {
  const radarOrigin = pointFromWorld(sample.world_position, manifest);
  return {
    ...actorFromSample(player, sample, source),
    radar_position: radarOrigin,
    radar_yaw: radarYawFromWorldYaw(sample.world_position, sample.yaw, manifest)
  };
}

function renderProjectiles(
  source: GroundTruthReplaySource,
  tick: number,
  manifest: MapAssetManifest
): PlaybackFrameProjectile[] {
  return source.projectile_tracks.flatMap((track): PlaybackFrameProjectile[] => {
    const samples = track.samples;
    if (samples.length === 0) return [];
    const firstTick = track.start_tick ?? samples[0]?.tick;
    const endTick = track.detonate_tick ?? track.end_tick ?? samples.at(-1)?.tick;
    const lifetimeEnd = track.expire_tick ?? (
      (track.end_tick ?? track.detonate_tick ?? samples.at(-1)?.tick) === undefined
        ? undefined
        : (track.end_tick ?? track.detonate_tick ?? samples.at(-1)?.tick)! + Math.max(1, source.tick_rate * 2)
    );
    if (firstTick !== undefined && tick < firstTick) return [];
    if (lifetimeEnd !== undefined && tick > lifetimeEnd) return [];
    const visible = samples.filter((sample) => sample.tick <= tick);
    const lastVisible = visible.at(-1);
    if (!lastVisible) return [];
    const finalSample = samples.at(-1);
    const inFlight = endTick === undefined || tick <= endTick;
    const label = track.item_id?.trim() || track.grenade_type?.trim() || "投掷物类型未知";
    const effectArea = track.area && endTick !== undefined && tick >= endTick
      ? {
          center: pointFromWorld(track.area.center, manifest),
          radius: normalizedRadius(track.area.center, track.area.radius, manifest)
        }
      : undefined;
    return [{
      id: track.track_id,
      label,
      radar_flight_points: inFlight
        ? visible.map((sample) => pointFromWorld(sample.world_position, manifest))
        : [],
      ...(inFlight && lastVisible
        ? { radar_current_position: pointFromWorld(lastVisible.world_position, manifest) }
        : {}),
      ...(!inFlight && finalSample
        ? { radar_landing_position: pointFromWorld(finalSample.world_position, manifest) }
        : {}),
      ...(effectArea ? { radar_effect_area: effectArea } : {}),
      source_fact_refs: [...track.source_fact_refs],
      source_claim_ids: []
    }];
  });
}

function renderRecentEvents(
  source: GroundTruthReplaySource,
  tick: number,
  manifest: MapAssetManifest
): PlaybackFrameEffect[] {
  const firstVisibleTick = tick - Math.max(1, Math.round(source.tick_rate * 4));
  return source.events
    .filter((event) => event.tick >= firstVisibleTick && event.tick <= tick)
    .map((event) => ({
      id: event.id,
      kind: "EVENT" as const,
      event_type: event.event_type,
      ...(event.world_origin ? { radar_position: pointFromWorld(event.world_origin, manifest) } : {}),
      source_fact_refs: [...event.fact_refs],
      source_claim_ids: []
    }));
}

function renderDroppedWeapons(
  source: GroundTruthReplaySource,
  tick: number,
  manifest: MapAssetManifest
): PlaybackFrameDroppedWeapon[] {
  return source.events.flatMap((event): PlaybackFrameDroppedWeapon[] => {
    if (event.event_type !== "ITEM_DROP" || event.tick > tick || !event.item_id || !event.world_origin) {
      return [];
    }
    return [{
      id: event.id,
      item_id: event.item_id,
      radar_position: pointFromWorld(event.world_origin, manifest),
      source_fact_refs: [...event.fact_refs],
      source_claim_ids: []
    }];
  });
}

function bombStateFromEvent(event: MatchEvent): PlaybackFrameBomb["state"] {
  const parserEvent = event.source_parser_event.toLowerCase();
  if (parserEvent.includes("beginplant")) return "PLANTING";
  if (parserEvent.includes("planted")) return "PLANTED";
  if (parserEvent.includes("begindefuse")) return "DEFUSING";
  if (parserEvent.includes("defused")) return "DEFUSED";
  if (event.event_type === "BOMB_DROP") return "DROPPED";
  if (event.event_type === "BOMB_PICKUP") return "CARRIED";
  return "UNKNOWN";
}

function renderBomb(
  source: GroundTruthReplaySource,
  tick: number,
  manifest: MapAssetManifest
): PlaybackFrameBomb | undefined {
  const bombEvents = source.events
    .filter((event) => (
      event.tick <= tick &&
      (event.event_type === "BOMB_PLANT" ||
        event.event_type === "BOMB_DEFUSE" ||
        event.event_type === "BOMB_DROP" ||
        event.event_type === "BOMB_PICKUP")
    ))
    .sort((left, right) => left.tick - right.tick);
  const event = bombEvents.at(-1);
  if (!event) return undefined;
  const state = bombStateFromEvent(event);
  return {
    state,
    ...(event.world_origin ? { radar_position: pointFromWorld(event.world_origin, manifest) } : {}),
    source_event_id: event.id,
    source_fact_refs: [...event.fact_refs],
    source_claim_ids: []
  };
}

function roundAtTick(
  source: GroundTruthReplaySource,
  tick: number
): GroundTruthRound | undefined {
  return source.rounds.find((round) => tick >= round.start_tick && tick < round.end_tick) ??
    source.rounds.filter((round) => round.start_tick <= tick).at(-1);
}

function renderClaimEvidence(
  claims: readonly ObservationClaim[],
  manifest: MapAssetManifest
): PlaybackFrameEvidence[] {
  return claims.flatMap((claim): PlaybackFrameEvidence[] => {
    const spatial = claim.spatial_estimate;
    if (
      spatial.type === "DIRECTION_SECTOR" &&
      spatial.origin &&
      (claim.claim_type === "SOUND_SOURCE" || claim.claim_type === "DAMAGE_DIRECTION")
    ) {
      const halfWidth = spatial.width_degrees / 2;
      const origin = pointFromWorld(spatial.origin, manifest);
      // Direction evidence should be visible but restrained. max_distance is
      // only a confidence boundary, so render a short ray instead of a filled
      // audibility sector or the full threshold distance.
      const displayDistance = Math.max(160, Math.min(400, (spatial.max_distance ?? 640) * 0.35));
      return [{
        id: claim.id,
        kind: claim.claim_type === "SOUND_SOURCE" ? "SOUND_DIRECTION" : "DAMAGE_DIRECTION",
        radar_origin: origin,
        radar_ray_end: directionPoint(spatial.origin, spatial.bearing_degrees, displayDistance, manifest),
        radar_left_end: directionPoint(spatial.origin, spatial.bearing_degrees - halfWidth, displayDistance * 0.92, manifest),
        radar_right_end: directionPoint(spatial.origin, spatial.bearing_degrees + halfWidth, displayDistance * 0.92, manifest),
        width_degrees: spatial.width_degrees,
        source_fact_refs: [...claim.evidence_refs],
        source_claim_ids: [claim.id]
      }];
    }
    if (spatial.type === "AREA") {
      return [{
        id: claim.id,
        kind: "AREA",
        radar_center: pointFromWorld(spatial.center, manifest),
        radius: normalizedRadius(spatial.center, spatial.radius, manifest),
        opacity: Math.max(0.2, Math.min(0.62, claim.confidence)),
        source_fact_refs: [...claim.evidence_refs],
        source_claim_ids: [claim.id]
      }];
    }
    if (spatial.type === "LAST_KNOWN_POINT") {
      return [{
        id: claim.id,
        kind: "LAST_KNOWN",
        radar_center: pointFromWorld(spatial.point, manifest),
        radius: normalizedRadius(spatial.point, spatial.radius, manifest),
        opacity: Math.max(0.16, Math.min(0.7, claim.confidence * Math.pow(0.5, spatial.age_ticks / 256))),
        source_fact_refs: [...claim.evidence_refs],
        source_claim_ids: [claim.id]
      }];
    }
    return [];
  });
}

function renderDirectVisionActors(
  selectedPlayerId: string,
  claims: readonly ObservationClaim[],
  manifest: MapAssetManifest
): PlaybackFrameActor[] {
  return claims.flatMap((claim): PlaybackFrameActor[] => {
    if (
      (claim.claim_type !== "PLAYER_POSITION" && claim.claim_type !== "PLAYER_PRESENCE") ||
      claim.subject_resolution !== "EXACT_PLAYER" ||
      !claim.subject_ref ||
      claim.spatial_estimate.type !== "EXACT_POINT" ||
      (claim.source_type !== "DIRECT_VISION" && claim.source_type !== "SPOTTED") ||
      claim.subject_ref === selectedPlayerId
    ) {
      return [];
    }
    return [{
      id: `claim:${claim.id}`,
      label: "视觉确认",
      side: "UNKNOWN",
      radar_position: pointFromWorld(claim.spatial_estimate.point, manifest),
      status: "UNKNOWN",
      inventory: [],
      source: "DIRECT_VISION",
      source_fact_refs: [...claim.evidence_refs],
      source_claim_ids: [claim.id]
    }];
  });
}

function claimIdSet(claims: readonly ObservationClaim[]): Set<string> {
  return new Set(claims.map((claim) => claim.id));
}

function hasOnlyKnownClaims(
  sourceClaimIds: readonly string[],
  knownClaimIds: ReadonlySet<string>
): boolean {
  return sourceClaimIds.length > 0 && sourceClaimIds.every((id) => knownClaimIds.has(id));
}

function safeKnowledgeAnnotations(
  annotations: readonly PlaybackAnnotation[],
  knownClaimIds: ReadonlySet<string>
): PlaybackAnnotation[] {
  return annotations.filter((annotation) => (
    hasOnlyKnownClaims(annotation.source_claim_ids, knownClaimIds)
  ));
}

function safeKnowledgeEffects(
  effects: readonly PlaybackFrameEffect[],
  knownClaimIds: ReadonlySet<string>
): PlaybackFrameEffect[] {
  return effects.filter((effect) => hasOnlyKnownClaims(effect.source_claim_ids, knownClaimIds));
}

function safeKnowledgeProjectiles(
  projectiles: readonly PlaybackFrameProjectile[],
  knownClaimIds: ReadonlySet<string>
): PlaybackFrameProjectile[] {
  return projectiles.filter((projectile) => hasOnlyKnownClaims(projectile.source_claim_ids, knownClaimIds));
}

function safeKnowledgeDroppedWeapons(
  weapons: readonly PlaybackFrameDroppedWeapon[],
  knownClaimIds: ReadonlySet<string>
): PlaybackFrameDroppedWeapon[] {
  return weapons.filter((weapon) => hasOnlyKnownClaims(weapon.source_claim_ids, knownClaimIds));
}

function safeKnowledgeBomb(
  bomb: PlaybackFrameBomb | undefined,
  knownClaimIds: ReadonlySet<string>
): PlaybackFrameBomb | undefined {
  return bomb && hasOnlyKnownClaims(bomb.source_claim_ids, knownClaimIds) ? bomb : undefined;
}

function safeObserverActor(
  actor: PlaybackFrameActor | undefined,
  knownClaimIds: ReadonlySet<string>
): PlaybackFrameActor[] {
  if (!actor) return [];
  return [{
    ...actor,
    source_claim_ids: (actor.source_claim_ids ?? []).filter((id) => knownClaimIds.has(id)),
    source_fact_refs: actor.source_fact_refs ?? []
  }];
}

function safeKnowledgeRound(round: KnowledgeFrameRound | undefined): KnowledgeFrameRound | undefined {
  if (!round) return undefined;
  return {
    round_number: round.round_number,
    start_tick: round.start_tick,
    freeze_end_tick: round.freeze_end_tick,
    score_before: [...round.score_before] as [number, number]
  };
}

export function buildOmniscientFrame(
  source: GroundTruthReplaySource,
  tick: number,
  manifest: MapAssetManifest,
  options: PlaybackFrameBuildOptions = {}
): PlaybackFrameViewModel {
  const actors = source.players.flatMap((player) => {
    const sample = sampleForPlayer(source, player.player_id, tick);
    return sample ? [normalizedActorFromSample(player, sample, manifest, "GROUND_TRUTH")] : [];
  });
  return {
    tick,
    tick_rate: source.tick_rate,
    perspective: "OMNISCIENT",
    selected_player_id: source.selected_player_id,
    actors,
    projectiles: renderProjectiles(source, tick, manifest),
    dropped_weapons: renderDroppedWeapons(source, tick, manifest),
    effects: renderRecentEvents(source, tick, manifest),
    evidence: [],
    annotations: options.annotations ?? [],
    bomb: renderBomb(source, tick, manifest),
    round: roundAtTick(source, tick)
  };
}

export function buildKnowledgeFrame(
  input: KnowledgeFrameInput,
  manifest: MapAssetManifest,
  options: PlaybackFrameBuildOptions = {}
): PlaybackFrameViewModel {
  const claims = availableClaims(input.observable_state, input.selected_player_id, input.tick);
  const knownClaimIds = claimIdSet(claims);
  const selfActor = safeObserverActor(input.observer_known_state, knownClaimIds);
  return {
    tick: input.tick,
    tick_rate: input.tick_rate,
    perspective: "PLAYER_KNOWLEDGE",
    selected_player_id: input.selected_player_id,
    actors: [...selfActor, ...renderDirectVisionActors(input.selected_player_id, claims, manifest)],
    // No raw grenade track is observable just because it exists in ground
    // truth. A future observable utility claim can add a typed evidence slot.
    projectiles: safeKnowledgeProjectiles(input.observable_projectile_history ?? [], knownClaimIds),
    dropped_weapons: safeKnowledgeDroppedWeapons(input.observable_dropped_weapons ?? [], knownClaimIds),
    effects: safeKnowledgeEffects(input.observable_effects ?? [], knownClaimIds),
    evidence: renderClaimEvidence(claims, manifest),
    annotations: safeKnowledgeAnnotations(options.annotations ?? [], knownClaimIds),
    bomb: safeKnowledgeBomb(input.observable_bomb, knownClaimIds),
    round: safeKnowledgeRound(input.round)
  };
}
