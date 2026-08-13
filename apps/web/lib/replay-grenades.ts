import type { MapAssetManifest, Point2D, WorldPoint } from "@cs-coach/contracts";
import { worldToNormalized } from "@cs-coach/map-semantics";
import { formatItem } from "./item-display";

export interface GrenadeTrackSample {
  tick: number;
  world_position: WorldPoint;
  sample_kind?: string;
}

/**
 * The web adapter accepts the stable Python names and the short-lived browser
 * mirror while the bundle boundary is being rolled forward. Renderer code
 * below only consumes this typed shape; it never derives a radius or a path
 * from a grenade name.
 */
export interface GrenadeTrackInput {
  track_id?: string;
  id?: string;
  grenade_type?: string;
  item_id?: string;
  samples?: readonly GrenadeTrackSample[];
  points?: readonly GrenadeTrackSample[];
  start_tick?: number;
  end_tick?: number;
  detonate_tick?: number;
  expire_tick?: number;
  area?: {
    center: WorldPoint;
    radius: number;
  };
}

export interface RenderedGrenadeArea {
  center: Point2D;
  radius: number;
}

export interface RenderedGrenadeTrack {
  id: string;
  label: string;
  flightPoints: readonly Point2D[];
  currentPoint?: Point2D;
  landingPoint?: Point2D;
  effectArea?: RenderedGrenadeArea;
}

function pointFromWorld(point: WorldPoint, manifest: MapAssetManifest): Point2D {
  return worldToNormalized(point, manifest);
}

function worldRadiusToNormalized(
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

function trackId(track: GrenadeTrackInput): string | undefined {
  return track.track_id?.trim() || track.id?.trim();
}

function trackSamples(track: GrenadeTrackInput): GrenadeTrackSample[] {
  return [...(track.samples ?? track.points ?? [])].sort((left, right) => left.tick - right.tick);
}

function flightEndTick(track: GrenadeTrackInput, points: readonly GrenadeTrackSample[]): number | undefined {
  return track.detonate_tick ?? points.at(-1)?.tick ?? track.end_tick;
}

function lifetimeEndTick(
  track: GrenadeTrackInput,
  points: readonly GrenadeTrackSample[],
  tickRate: number
): number | undefined {
  if (track.expire_tick !== undefined) return track.expire_tick;
  const terminalTick = track.end_tick ?? track.detonate_tick ?? points.at(-1)?.tick;
  // Instant-effect grenades have no expire event. Keep the parser-derived
  // terminal point visible briefly so a human can inspect the actual landing.
  return terminalTick === undefined ? undefined : terminalTick + Math.max(1, tickRate * 2);
}

const grenadeTypeLabels: Record<string, string> = {
  HE: "手雷",
  HEGRENADE: "手雷",
  FLASH: "闪光弹",
  FLASHBANG: "闪光弹",
  SMOKE: "烟雾弹",
  SMOKEGRENADE: "烟雾弹",
  MOLOTOV: "燃烧瓶",
  INCENDIARY: "燃烧弹",
  DECOY: "诱饵弹"
};

export function formatGrenadeType(track: Pick<GrenadeTrackInput, "grenade_type" | "item_id">): string {
  if (track.item_id?.trim()) {
    return formatItem({ item_id: track.item_id, item_class: "grenade" });
  }
  const type = track.grenade_type?.trim();
  if (!type) return "投掷物类型未知";
  return grenadeTypeLabels[type.toUpperCase().replace(/[\s-]+/g, "_")] ?? type.replace(/[_-]+/g, " ");
}

/**
 * Projects only the typed grenade fields that are available at this tick.
 * Flight paths stop at end_tick; after that, a short renderer lifetime keeps
 * the typed landing/effect evidence visible without leaving a full-match line
 * on the radar. No effect radius is invented when `area` is absent.
 */
export function renderGrenadeTrackAtTick(
  track: GrenadeTrackInput,
  tick: number,
  tickRate: number,
  manifest: MapAssetManifest
): RenderedGrenadeTrack | undefined {
  const id = trackId(track);
  const points = trackSamples(track);
  if (!id) return undefined;
  const firstTick = track.start_tick ?? points[0]?.tick;
  const endTick = flightEndTick(track, points);
  const lifetimeEnd = lifetimeEndTick(track, points, tickRate);
  if (firstTick !== undefined && tick < firstTick) return undefined;
  if (lifetimeEnd !== undefined && tick > lifetimeEnd) return undefined;

  const visiblePoints = points.filter((point) => point.tick <= tick);
  const lastVisible = visiblePoints.at(-1);
  const finalPoint = points.at(-1);
  if (!lastVisible && !finalPoint) return undefined;

  const isFlight = endTick === undefined || tick <= endTick;
  const label = formatGrenadeType(track);
  const flightPoints = isFlight
    ? visiblePoints.map((point) => pointFromWorld(point.world_position, manifest))
    : [];
  const currentPoint = isFlight && lastVisible
    ? pointFromWorld(lastVisible.world_position, manifest)
    : undefined;
  const landingPoint = !isFlight && finalPoint
    ? pointFromWorld(finalPoint.world_position, manifest)
    : undefined;
  const area = track.area;
  const effectArea = area && endTick !== undefined && tick >= endTick
    ? {
        center: pointFromWorld(area.center, manifest),
        radius: worldRadiusToNormalized(area.center, area.radius, manifest)
      }
    : undefined;

  return {
    id,
    label,
    flightPoints,
    currentPoint,
    landingPoint,
    effectArea
  };
}

export function renderGrenadeTracksAtTick(
  tracks: readonly GrenadeTrackInput[],
  tick: number,
  tickRate: number,
  manifest: MapAssetManifest
): RenderedGrenadeTrack[] {
  return tracks.flatMap((track) => {
    const rendered = renderGrenadeTrackAtTick(track, tick, tickRate, manifest);
    return rendered ? [rendered] : [];
  });
}
