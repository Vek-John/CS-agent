/** A CS2 Hammer/world-space position. The Z component is retained even when a
 * renderer only needs the X/Y projection. */
export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

/** A world-space vector such as velocity or a damage direction. */
export interface Direction {
  x: number;
  y: number;
  z: number;
}

/** Explicit alias used at world-space boundaries. */
export type WorldDirection = Direction;

export interface RadarPoint {
  x: number;
  y: number;
}

/** Coordinates in the renderer's [0, 1] x [0, 1] normalized space. */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/**
 * Affine coefficients in row-major form:
 *
 *   radar_x = a * world_x + c * world_y + e
 *   radar_y = b * world_x + d * world_y + f
 */
export type WorldToRadarAffine = readonly [
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
];

export interface DirectionSector {
  /** The known origin of the sector, normally the observer's own position. */
  origin?: WorldPoint;
  bearing_degrees: number;
  width_degrees: number;
  max_distance?: number;
}
