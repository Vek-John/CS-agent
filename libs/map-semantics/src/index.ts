import type {
  MapAssetLayer,
  MapAssetManifest,
  MapAssetSourceKind,
  NormalizedPoint,
  RadarPoint,
  WorldPoint,
  WorldToRadarAffine
} from "@cs-coach/contracts";

export const MAP_SEMANTICS_VERSION = "map-semantics/1.0.0";

export class MapTransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MapTransformError";
  }
}

export class MapAssetManifestValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`MapAssetManifest validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "MapAssetManifestValidationError";
    this.issues = issues;
  }
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new MapTransformError(`${label} must be finite.`);
  }
}

function assertWorldPoint(point: WorldPoint): void {
  assertFiniteNumber(point.x, "world point x");
  assertFiniteNumber(point.y, "world point y");
  assertFiniteNumber(point.z, "world point z");
}

function assertRadarPoint(point: RadarPoint): void {
  assertFiniteNumber(point.x, "radar point x");
  assertFiniteNumber(point.y, "radar point y");
}

function affineDeterminant(affine: WorldToRadarAffine): number {
  return affine[0] * affine[3] - affine[2] * affine[1];
}

function assertAffine(affine: WorldToRadarAffine): void {
  if (affine.length !== 6 || affine.some((coefficient) => !Number.isFinite(coefficient))) {
    throw new MapTransformError("world_to_radar_affine must contain six finite coefficients.");
  }
  if (Math.abs(affineDeterminant(affine)) < Number.EPSILON) {
    throw new MapTransformError("world_to_radar_affine must be invertible.");
  }
}

export function worldToRadar(
  worldPoint: WorldPoint,
  affine: WorldToRadarAffine
): RadarPoint {
  assertWorldPoint(worldPoint);
  assertAffine(affine);
  const [a, b, c, d, e, f] = affine;
  return {
    x: a * worldPoint.x + c * worldPoint.y + e,
    y: b * worldPoint.x + d * worldPoint.y + f
  };
}

/**
 * Inverts the X/Y projection. A radar image has no Z dimension, so callers
 * provide the Z plane they want to restore; it defaults to the ground plane.
 */
export function radarToWorld(
  radarPoint: RadarPoint,
  affine: WorldToRadarAffine,
  z = 0
): WorldPoint {
  assertRadarPoint(radarPoint);
  assertFiniteNumber(z, "world point z");
  assertAffine(affine);
  const [a, b, c, d, e, f] = affine;
  const determinant = affineDeterminant(affine);
  const translatedX = radarPoint.x - e;
  const translatedY = radarPoint.y - f;
  return {
    x: (d * translatedX - c * translatedY) / determinant,
    y: (-b * translatedX + a * translatedY) / determinant,
    z
  };
}

export function radarToNormalized(
  radarPoint: RadarPoint,
  width: number,
  height: number
): NormalizedPoint {
  assertRadarPoint(radarPoint);
  assertFiniteNumber(width, "radar width");
  assertFiniteNumber(height, "radar height");
  if (width <= 0 || height <= 0) {
    throw new MapTransformError("radar dimensions must be positive.");
  }
  return { x: radarPoint.x / width, y: radarPoint.y / height };
}

export function normalizedToRadar(
  normalizedPoint: NormalizedPoint,
  width: number,
  height: number
): RadarPoint {
  assertFiniteNumber(normalizedPoint.x, "normalized point x");
  assertFiniteNumber(normalizedPoint.y, "normalized point y");
  assertFiniteNumber(width, "radar width");
  assertFiniteNumber(height, "radar height");
  if (width <= 0 || height <= 0) {
    throw new MapTransformError("radar dimensions must be positive.");
  }
  if (
    normalizedPoint.x < 0 ||
    normalizedPoint.x > 1 ||
    normalizedPoint.y < 0 ||
    normalizedPoint.y > 1
  ) {
    throw new MapTransformError("normalized coordinates must be within [0, 1].");
  }
  return { x: normalizedPoint.x * width, y: normalizedPoint.y * height };
}

export function worldToNormalized(
  worldPoint: WorldPoint,
  manifest: MapAssetManifest
): NormalizedPoint {
  return radarToNormalized(
    worldToRadar(worldPoint, manifest.world_to_radar_affine),
    manifest.width,
    manifest.height
  );
}

export function normalizedToWorld(
  normalizedPoint: NormalizedPoint,
  manifest: MapAssetManifest,
  z = 0
): WorldPoint {
  return radarToWorld(
    normalizedToRadar(normalizedPoint, manifest.width, manifest.height),
    manifest.world_to_radar_affine,
    z
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isHttpUri(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/\S+$/i.test(value);
}

export function collectMapAssetManifestIssues(manifest: MapAssetManifest): string[] {
  const issues: string[] = [];
  if (!manifest.map_name?.trim()) issues.push("map_name is required.");
  if (!manifest.asset_version?.trim()) issues.push("asset_version is required.");
  if (!manifest.raster_ref?.trim()) issues.push("raster_ref is required.");
  if (!Number.isInteger(manifest.width) || manifest.width <= 0) {
    issues.push("width must be a positive integer.");
  }
  if (!Number.isInteger(manifest.height) || manifest.height <= 0) {
    issues.push("height must be a positive integer.");
  }
  if (!isSha256(manifest.content_sha256)) {
    issues.push("content_sha256 must be a 64-character hexadecimal SHA-256.");
  }
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    issues.push("layers must contain at least one layer.");
  }
  const layerIds = new Set<string>();
  for (const layer of manifest.layers ?? []) {
    if (!layer.id?.trim()) issues.push("every layer needs an id.");
    if (layerIds.has(layer.id)) issues.push(`duplicate layer id ${layer.id}.`);
    layerIds.add(layer.id);
  }
  if (!Array.isArray(manifest.world_to_radar_affine) || manifest.world_to_radar_affine.length !== 6) {
    issues.push("world_to_radar_affine must contain six coefficients.");
  } else if (manifest.world_to_radar_affine.some((coefficient) => !Number.isFinite(coefficient))) {
    issues.push("world_to_radar_affine coefficients must be finite.");
  } else if (Math.abs(affineDeterminant(manifest.world_to_radar_affine)) < Number.EPSILON) {
    issues.push("world_to_radar_affine must be invertible.");
  }
  if (!Array.isArray(manifest.floor_rules)) issues.push("floor_rules must be an array.");
  if (!isHttpUri(manifest.source_uri)) issues.push("source_uri must be an http(s) URI.");
  if (!manifest.source_revision?.trim()) issues.push("source_revision is required.");
  if (!manifest.source_kind?.trim()) issues.push("source_kind is required.");
  if (!manifest.rights_status?.trim()) issues.push("rights_status is required.");
  if (!manifest.redistribution_policy?.trim()) {
    issues.push("redistribution_policy is required.");
  }
  if (!manifest.authorization_basis?.trim()) {
    issues.push("authorization_basis is required.");
  }
  if (manifest.acquired_at !== undefined && Number.isNaN(Date.parse(manifest.acquired_at))) {
    issues.push("acquired_at must be an ISO date-time when present.");
  }
  if (manifest.world_bounds) {
    const { min, max } = manifest.world_bounds;
    for (const axis of ["x", "y", "z"] as const) {
      if (min[axis] > max[axis]) issues.push(`world_bounds min.${axis} exceeds max.${axis}.`);
    }
  }
  return issues;
}

export function validateMapAssetManifest(manifest: MapAssetManifest): string[] {
  return collectMapAssetManifestIssues(manifest);
}

export function isValidMapAssetManifest(manifest: MapAssetManifest): boolean {
  return validateMapAssetManifest(manifest).length === 0;
}

export function assertValidMapAssetManifest(manifest: MapAssetManifest): MapAssetManifest {
  const issues = validateMapAssetManifest(manifest);
  if (issues.length > 0) throw new MapAssetManifestValidationError(issues);
  return manifest;
}

export interface VersionPinnedMapAssetSource {
  provider: "awpy-data";
  release_key: number;
  release_uri: string;
  asset_uri: string;
  asset_path: string;
  local_cache_ref: string;
  expected_sha256: string;
  width: number;
  height: number;
  source_kind: MapAssetSourceKind;
  authorization_basis: string;
}

export interface MapAssetDownloadRequest {
  source_uri: string;
  /** Path inside the pinned archive/release asset, when source_uri is an archive. */
  asset_path: string;
  local_cache_ref: string;
  expected_sha256: string;
  expected_width: number;
  expected_height: number;
}

export interface MaterializedMapAssetMetadata {
  local_cache_ref: string;
  sha256: string;
  width: number;
  height: number;
  acquired_at: string;
}

/**
 * Boundary for a future localhost downloader. Network and filesystem policy
 * stay outside this pure package; an implementation must verify the returned
 * bytes against the manifest before exposing them to a renderer.
 */
export interface MapAssetDownloadPort {
  download(request: MapAssetDownloadRequest): Promise<MaterializedMapAssetMetadata>;
}

export function collectMaterializedMapAssetIssues(
  manifest: MapAssetManifest,
  materialized: MaterializedMapAssetMetadata
): string[] {
  const issues: string[] = [];
  if (materialized.local_cache_ref !== manifest.raster_ref) {
    issues.push("materialized asset does not match manifest raster_ref.");
  }
  if (materialized.sha256.toLowerCase() !== manifest.content_sha256.toLowerCase()) {
    issues.push("materialized asset SHA-256 does not match manifest content_sha256.");
  }
  if (materialized.width !== manifest.width || materialized.height !== manifest.height) {
    issues.push("materialized asset dimensions do not match the manifest.");
  }
  if (Number.isNaN(Date.parse(materialized.acquired_at))) {
    issues.push("materialized asset acquired_at must be an ISO date-time.");
  }
  return issues;
}

export function assertMaterializedMapAsset(
  manifest: MapAssetManifest,
  materialized: MaterializedMapAssetMetadata
): MaterializedMapAssetMetadata {
  const issues = collectMaterializedMapAssetIssues(manifest, materialized);
  if (issues.length > 0) throw new MapAssetManifestValidationError(issues);
  return materialized;
}

export const MIRAGE_AWPY_DATA_RELEASE = 2000883;

/** Raw transform metadata retained alongside the derived affine coefficients. */
export interface RadarTransformMetadata {
  pos_x: number;
  pos_y: number;
  scale: number;
  rotate: number;
  zoom: number;
}

export const MIRAGE_AWPY_DATA_TRANSFORM: RadarTransformMetadata = {
  pos_x: -3230,
  pos_y: 1713,
  scale: 5,
  rotate: 0,
  zoom: 0
};

export const MIRAGE_AWPY_DATA_SOURCE: VersionPinnedMapAssetSource = {
  provider: "awpy-data",
  release_key: MIRAGE_AWPY_DATA_RELEASE,
  release_uri: "https://github.com/pnxenopoulos/awpy-data/releases/tag/2000883",
  asset_uri:
    "https://github.com/pnxenopoulos/awpy-data/releases/download/2000883/images.zip",
  asset_path: "radars/de_mirage.png",
  local_cache_ref: "awpy-data-cache://2000883/radars/de_mirage.png",
  expected_sha256: "c8032f6c83ffca63c0a20ebdcc598a0e1aa618efd746e381e2db26f33a4a964f",
  width: 1024,
  height: 1024,
  source_kind: "AWPY_DATA_RELEASE",
  authorization_basis: "AWPY_DATA_LOCAL_CACHE_WITH_DISTRIBUTION_REVIEW_PENDING"
};

/**
 * Mirage overview metadata from awpy-data 2000883. The image itself is not
 * committed here; a localhost adapter materializes it at local_cache_ref.
 */
export const MIRAGE_WORLD_TO_RADAR_AFFINE: WorldToRadarAffine = [
  1 / MIRAGE_AWPY_DATA_TRANSFORM.scale,
  0,
  0,
  -1 / MIRAGE_AWPY_DATA_TRANSFORM.scale,
  -MIRAGE_AWPY_DATA_TRANSFORM.pos_x / MIRAGE_AWPY_DATA_TRANSFORM.scale,
  MIRAGE_AWPY_DATA_TRANSFORM.pos_y / MIRAGE_AWPY_DATA_TRANSFORM.scale
];

export function mirageAssetDownloadRequest(): MapAssetDownloadRequest {
  return {
    source_uri: MIRAGE_AWPY_DATA_SOURCE.asset_uri,
    asset_path: MIRAGE_AWPY_DATA_SOURCE.asset_path,
    local_cache_ref: MIRAGE_AWPY_DATA_SOURCE.local_cache_ref,
    expected_sha256: MIRAGE_AWPY_DATA_SOURCE.expected_sha256,
    expected_width: MIRAGE_AWPY_DATA_SOURCE.width,
    expected_height: MIRAGE_AWPY_DATA_SOURCE.height
  };
}

export function loadMirageManifest(options: {
  raster_ref?: string;
  acquired_at?: string;
  source_kind?: MapAssetSourceKind;
  authorization_basis?: string;
} = {}): MapAssetManifest {
  const radarLayer: MapAssetLayer = {
    id: "mirage-radar",
    kind: "RADAR",
    raster_ref: options.raster_ref ?? MIRAGE_AWPY_DATA_SOURCE.local_cache_ref
  };
  return assertValidMapAssetManifest({
    map_name: "de_mirage",
    map_build_id: String(MIRAGE_AWPY_DATA_RELEASE),
    asset_version: `awpy-data/${MIRAGE_AWPY_DATA_RELEASE}`,
    raster_ref: options.raster_ref ?? MIRAGE_AWPY_DATA_SOURCE.local_cache_ref,
    width: MIRAGE_AWPY_DATA_SOURCE.width,
    height: MIRAGE_AWPY_DATA_SOURCE.height,
    content_sha256: MIRAGE_AWPY_DATA_SOURCE.expected_sha256,
    layers: [radarLayer],
    world_to_radar_affine: MIRAGE_WORLD_TO_RADAR_AFFINE,
    floor_rules: [],
    source_uri: MIRAGE_AWPY_DATA_SOURCE.asset_uri,
    source_revision: `awpy-data-release/${MIRAGE_AWPY_DATA_RELEASE}`,
    rights_status: "LOCALHOST_ONLY_REVIEW_REQUIRED",
    redistribution_policy: "DO_NOT_DISTRIBUTE_UNTIL_ASSET_RIGHTS_REVIEW",
    source_kind: options.source_kind ?? MIRAGE_AWPY_DATA_SOURCE.source_kind,
    acquired_at: options.acquired_at,
    authorization_basis:
      options.authorization_basis ?? MIRAGE_AWPY_DATA_SOURCE.authorization_basis
  });
}
