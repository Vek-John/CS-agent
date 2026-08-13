import type {
  MapAssetManifest,
  ObservationClaim,
  Point2D,
  WorldPoint
} from "@cs-coach/contracts";
import { worldToNormalized } from "@cs-coach/map-semantics";

export type KnowledgeEvidenceOverlay =
  | {
      id: string;
      type: "DIRECTION_SECTOR";
      /** Short, display-only direction hint. It is not an audibility range. */
      rayPath: string;
      boundaryPath: string;
    }
  | {
      id: string;
      type: "AREA" | "LAST_KNOWN_POINT";
      center: Point2D;
      radius: number;
      opacity?: number;
    };

function worldRadiusToNormalized(
  center: WorldPoint,
  radius: number,
  manifest: MapAssetManifest
): number {
  const normalizedCenter = worldToNormalized(center, manifest);
  const normalizedEdge = worldToNormalized({
    x: center.x + radius,
    y: center.y,
    z: center.z
  }, manifest);
  return Math.hypot(
    normalizedEdge.x - normalizedCenter.x,
    normalizedEdge.y - normalizedCenter.y
  );
}

function directionAngle(
  origin: WorldPoint,
  bearingDegrees: number,
  manifest: MapAssetManifest
): number {
  const bearingRadians = (bearingDegrees * Math.PI) / 180;
  const normalizedOrigin = worldToNormalized(origin, manifest);
  const normalizedEdge = worldToNormalized({
    x: origin.x + Math.cos(bearingRadians),
    y: origin.y + Math.sin(bearingRadians),
    z: origin.z
  }, manifest);
  return Math.atan2(
    normalizedEdge.y - normalizedOrigin.y,
    normalizedEdge.x - normalizedOrigin.x
  );
}

function directionPoint(
  origin: Point2D,
  angle: number,
  radius: number
): Point2D {
  return {
    x: origin.x + Math.cos(angle) * radius,
    y: origin.y + Math.sin(angle) * radius
  };
}

function directionHintPaths(
  origin: WorldPoint,
  bearingDegrees: number,
  widthDegrees: number,
  manifest: MapAssetManifest
): { rayPath: string; boundaryPath: string } {
  const normalizedOrigin = worldToNormalized(origin, manifest);
  // `max_distance` on a sound claim is the conservative audibility gate, not
  // a known source distance. Keep the renderer deliberately compact so it
  // cannot be mistaken for a visible area or an exact enemy location.
  const radius = 0.065;
  const halfWidth = widthDegrees / 2;
  const startAngle = directionAngle(origin, bearingDegrees - halfWidth, manifest);
  const endAngle = directionAngle(origin, bearingDegrees + halfWidth, manifest);
  const start = directionPoint(normalizedOrigin, startAngle, radius);
  const end = directionPoint(normalizedOrigin, endAngle, radius);
  const centerAngle = directionAngle(origin, bearingDegrees, manifest);
  const rayEnd = directionPoint(normalizedOrigin, centerAngle, radius * 1.08);
  return {
    rayPath: `M ${normalizedOrigin.x} ${normalizedOrigin.y} L ${rayEnd.x} ${rayEnd.y}`,
    boundaryPath: [
      `M ${normalizedOrigin.x} ${normalizedOrigin.y} L ${start.x} ${start.y}`,
      `M ${normalizedOrigin.x} ${normalizedOrigin.y} L ${end.x} ${end.y}`
    ].join(" ")
  };
}

export function getRenderablePlayerClaims(
  claims: readonly ObservationClaim[]
): ObservationClaim[] {
  return claims.filter((claim) => (
    (claim.claim_type === "PLAYER_POSITION" || claim.claim_type === "PLAYER_PRESENCE") &&
    claim.subject_resolution === "EXACT_PLAYER" &&
    claim.subject_ref !== undefined &&
    claim.spatial_estimate.type === "EXACT_POINT"
  ));
}

export function buildKnowledgeEvidenceOverlays(
  claims: readonly ObservationClaim[],
  manifest: MapAssetManifest
): KnowledgeEvidenceOverlay[] {
  return claims.flatMap((claim): KnowledgeEvidenceOverlay[] => {
    const spatial = claim.spatial_estimate;
    if (spatial.type === "DIRECTION_SECTOR" && spatial.origin) {
      const paths = directionHintPaths(
        spatial.origin,
        spatial.bearing_degrees,
        spatial.width_degrees,
        manifest
      );
      return [{
        id: claim.id,
        type: "DIRECTION_SECTOR" as const,
        ...paths
      }];
    }
    if (spatial.type === "AREA") {
      return [{
        id: claim.id,
        type: "AREA" as const,
        center: worldToNormalized(spatial.center, manifest),
        radius: worldRadiusToNormalized(spatial.center, spatial.radius, manifest)
      }];
    }
    if (spatial.type === "LAST_KNOWN_POINT") {
      return [{
        id: claim.id,
        type: "LAST_KNOWN_POINT" as const,
        center: worldToNormalized(spatial.point, manifest),
        radius: worldRadiusToNormalized(spatial.point, spatial.radius, manifest),
        opacity: Math.max(0.18, Math.min(0.72, claim.confidence * Math.pow(0.5, spatial.age_ticks / 256)))
      }];
    }
    return [];
  });
}
