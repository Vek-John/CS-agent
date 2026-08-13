import type { Annotation, MapAssetManifest, Point2D, WorldPoint } from "@cs-coach/contracts";
import { worldToNormalized } from "@cs-coach/map-semantics";

export function annotationPointToRadarPercent(
  point: Point2D | WorldPoint,
  coordinateSpace: Annotation["coordinate_space"],
  manifest: MapAssetManifest
): Point2D {
  if (coordinateSpace === "WORLD") {
    const normalized = worldToNormalized(point as WorldPoint, manifest);
    return { x: normalized.x * 100, y: normalized.y * 100 };
  }
  return { x: point.x, y: point.y };
}

export function annotationRadiusToRadarPercent(
  center: Point2D | WorldPoint,
  radius: number,
  coordinateSpace: Annotation["coordinate_space"],
  manifest: MapAssetManifest
): number {
  if (coordinateSpace !== "WORLD") return radius;
  const worldCenter = center as WorldPoint;
  const normalizedCenter = worldToNormalized(worldCenter, manifest);
  const normalizedEdge = worldToNormalized({
    x: worldCenter.x + radius,
    y: worldCenter.y,
    z: worldCenter.z
  }, manifest);
  return Math.hypot(
    normalizedEdge.x - normalizedCenter.x,
    normalizedEdge.y - normalizedCenter.y
  ) * 100;
}
