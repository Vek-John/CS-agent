import type { WorldPoint, WorldToRadarAffine } from "./geometry";

export type MapAssetSourceKind =
  | "AWPY_DATA_RELEASE"
  | "LOCAL_CS2_INSTALL"
  | "VALVE_GAME_ASSET"
  | "USER_PROVIDED";

export type MapAssetRightsStatus =
  | "LOCALHOST_ONLY_REVIEW_REQUIRED"
  | "LOCALHOST_ONLY"
  | "APPROVED_FOR_DISTRIBUTION"
  | "RESTRICTED";

export interface MapAssetLayer {
  id: string;
  kind: "RADAR" | "CALLOUTS" | "GEOMETRY" | "NAV" | "OTHER";
  raster_ref?: string;
  vector_ref?: string;
}

export interface WorldBounds {
  min: WorldPoint;
  max: WorldPoint;
}

export interface FloorRule {
  id: string;
  layer_id: string;
  min_z?: number;
  max_z?: number;
}

export interface MapAssetManifest {
  map_name: string;
  map_build_id?: string;
  asset_version: string;
  raster_ref: string;
  width: number;
  height: number;
  content_sha256: string;
  layers: readonly MapAssetLayer[];
  world_to_radar_affine: WorldToRadarAffine;
  world_bounds?: WorldBounds;
  floor_rules: readonly FloorRule[];
  /** Original source or release URL. Runtime rendering must use raster_ref. */
  source_uri: string;
  source_revision: string;
  rights_status: MapAssetRightsStatus;
  redistribution_policy: string;
  source_kind: MapAssetSourceKind;
  /** Set when a local cache materialization has actually been acquired. */
  acquired_at?: string;
  authorization_basis: string;
}
