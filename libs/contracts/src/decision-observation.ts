import type { ObservationKnowledgeKind, ObservationSourceType, ObservationSharingScope, ObservationSubjectResolution, ObservationSpatialEstimate } from "./observation";

/** Map-oriented world XY: E = +X, N = +Y. Never player-facing left/right/front. */
export type Compass8 = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

/** Deliberately coarse position projection, not lossless geometry or tactical regions.
 * G0..G63 are row-major cells of the pinned Mirage 8x8 radar grid. Uncertain
 * shapes retain all intersected cells and bounded relations, never their center.
 */
export interface DecisionObservationSemantics {
  knowledge: ObservationKnowledgeKind;
  modality: ObservationSourceType;
  sharingScope: ObservationSharingScope;
  subject: {
    resolution: ObservationSubjectResolution;
    role: "SELF" | "OTHER_KNOWN_SUBJECT" | "TEAM_UNSPECIFIED" | "UNKNOWN";
    alias: string | null;
  };
  availableAgeSeconds: number;
  expiresInSeconds: number | null;
  spatial: {
    sourceType: ObservationSpatialEstimate["type"];
    representation: "COARSE_GRID_AND_BOUNDED_RELATION";
    mapCells: readonly string[];
    includesOutsideMap: boolean | null;
    radiusWorldUnits: number | null;
    lastKnownAgeSeconds: number | null;
    /** Distance is horizontal Euclidean separation, not walk time, visibility,
     * reachability or combat effectiveness. Height is unknown for uncertain shapes.
     */
    relativeToSelf: {
      horizontalDistanceMin: number;
      horizontalDistanceMax: number;
      possibleBearings: readonly Compass8[];
      heightDelta: number | null;
    } | null;
    /** Preserves the original sector; its origin need not be current self position.
     * No finite map coverage is invented for an unbounded direction.
     */
    direction: {
      bearingDegrees: number;
      widthDegrees: number;
      maxDistanceWorldUnits: number | null;
      originMapCells: readonly string[] | null;
      originIncludesOutsideMap: boolean | null;
    } | null;
  };
}
