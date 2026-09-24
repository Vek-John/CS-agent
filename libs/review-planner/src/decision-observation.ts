import { OBSERVATION_SOURCE_TYPES, type ObservationClaim, type ObservationSpatialEstimate } from "../../contracts/src/observation";
import type { WorldPoint } from "../../contracts/src/geometry";
import type { Compass8, DecisionObservationSemantics } from "../../contracts/src/decision-observation";
import { MIRAGE_AWPY_DATA_TRANSFORM } from "@cs-coach/map-semantics";

const fail = (): never => { throw new Error("INVALID_OBSERVATION_SEMANTICS"); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonnegative = (v: unknown): number => finite(v) && v >= 0 ? v : fail();
const keys = (v: unknown, required: readonly string[], optional: readonly string[] = []) => {
  if (!record(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) return fail();
  return v;
};
function enumeration<T extends string>(v: unknown, choices: readonly T[]): T { return typeof v === "string" && choices.includes(v as T) ? v as T : fail(); }
const KNOWLEDGE = ["OBSERVED", "INFERRED", "USER_ASSERTED"] as const;
const SCOPES = ["SELF", "VERIFIED_TEAM_SHARED", "USER_CONTEXT_ONLY"] as const;
const RESOLUTIONS = ["EXACT_PLAYER", "TEAM_ONLY", "UNKNOWN_ACTOR"] as const;
const SPATIAL = ["EXACT_POINT", "UNCERTAIN_POINT", "AREA", "DIRECTION_SECTOR", "LAST_KNOWN_POINT", "NONE"] as const;
const BEARINGS: readonly Compass8[] = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
function point(v: unknown): WorldPoint {
  const p = keys(v, ["x", "y", "z"]);
  if (![p.x, p.y, p.z].every(finite)) return fail();
  return { x: p.x as number, y: p.y as number, z: p.z as number };
}
function spatialShape(v: unknown): ObservationSpatialEstimate {
  if (!record(v)) return fail();
  switch (v.type) {
    case "NONE": keys(v, ["type"]); return { type: "NONE" };
    case "EXACT_POINT": keys(v, ["type", "point"]); return { type: "EXACT_POINT", point: point(v.point) };
    case "AREA": case "UNCERTAIN_POINT":
      keys(v, ["type", "center", "radius"]); return { type: v.type, center: point(v.center), radius: nonnegative(v.radius) };
    case "LAST_KNOWN_POINT":
      keys(v, ["type", "point", "radius", "age_ticks"]); return { type: v.type, point: point(v.point), radius: nonnegative(v.radius), age_ticks: nonnegative(v.age_ticks) };
    case "DIRECTION_SECTOR": {
      keys(v, ["type", "bearing_degrees", "width_degrees"], ["origin", "max_distance"]);
      if (!finite(v.bearing_degrees) || !finite(v.width_degrees) || v.width_degrees <= 0 || v.width_degrees > 360) return fail();
      return { type: v.type, bearing_degrees: v.bearing_degrees, width_degrees: v.width_degrees, ...(v.origin === undefined ? {} : { origin: point(v.origin) }), ...(v.max_distance === undefined ? {} : { max_distance: nonnegative(v.max_distance) }) };
    }
    default: return fail();
  }
}
function validateSource(s: Pick<DecisionObservationSemantics, "modality" | "knowledge" | "sharingScope" | "subject">, type: ObservationSpatialEstimate["type"]) {
  if ((s.modality === "FOOTSTEP" || s.modality === "GUNSHOT") && (type === "EXACT_POINT" || s.subject.resolution !== "UNKNOWN_ACTOR" || s.knowledge !== "INFERRED")) fail();
  if (s.modality === "DAMAGE_DIRECTION" && (type !== "DIRECTION_SECTOR" || s.subject.resolution !== "UNKNOWN_ACTOR" || s.knowledge !== "INFERRED")) fail();
  if (s.modality === "LAST_KNOWN" && (type !== "LAST_KNOWN_POINT" || s.knowledge !== "INFERRED")) fail();
  if ((s.modality === "DIRECT_VISION" || s.modality === "SPOTTED") && (type !== "EXACT_POINT" || s.subject.resolution !== "EXACT_PLAYER" || s.knowledge !== "OBSERVED")) fail();
  if (s.modality === "TEAM_SHARED" && (s.sharingScope !== "VERIFIED_TEAM_SHARED" || s.knowledge === "OBSERVED")) fail();
  if (["DIRECT_VISION", "SPOTTED", "FOOTSTEP", "GUNSHOT", "DAMAGE_DIRECTION", "UTILITY", "BOMB"].includes(s.modality) && s.sharingScope !== "SELF") fail();
  if (s.modality === "USER_CONTEXT" && (type !== "NONE" || s.knowledge !== "USER_ASSERTED" || s.sharingScope !== "USER_CONTEXT_ONLY")) fail();
  if (s.sharingScope === "USER_CONTEXT_ONLY" && s.modality !== "USER_CONTEXT") fail();
}

/** Fixed radar projection: 1024px square, 8x8 cells. No map polygon or floor inference. */
function grid(p: WorldPoint, radius: number) {
  const { pos_x, pos_y, scale } = MIRAGE_AWPY_DATA_TRANSFORM;
  const x = (p.x - pos_x) / scale, y = (pos_y - p.y) / scale, r = radius / scale;
  const cells: string[] = [];
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const nearestX = Math.max(col * 128, Math.min((col + 1) * 128, x));
    const nearestY = Math.max(row * 128, Math.min((row + 1) * 128, y));
    if (Math.hypot(x - nearestX, y - nearestY) <= r) cells.push(`G${row * 8 + col}`);
  }
  return { mapCells: cells, includesOutsideMap: x - r < 0 || y - r < 0 || x + r > 1024 || y + r > 1024 };
}
function relative(center: WorldPoint, radius: number, self: WorldPoint, exact: boolean): NonNullable<DecisionObservationSemantics["spatial"]["relativeToSelf"]> {
  const dx = center.x - self.x, dy = center.y - self.y, distance = Math.hypot(dx, dy);
  const bearing = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const halfWidth = radius >= distance ? 180 : Math.asin(radius / distance) * 180 / Math.PI;
  const possibleBearings = distance === 0 && radius === 0 ? [] : BEARINGS.filter((_, i) => {
    const delta = Math.abs(((i * 45 - bearing + 540) % 360) - 180);
    return delta <= halfWidth + 22.5 + 1e-9;
  });
  return { horizontalDistanceMin: Math.floor(Math.max(0, distance - radius)), horizontalDistanceMax: Math.ceil(distance + radius), possibleBearings, heightDelta: exact ? center.z - self.z : null };
}

/** Consumes only candidate-bound legal claims; it never accepts a Snapshot or roster. */
export function buildDecisionObservationSemantics(claims: readonly ObservationClaim[], options: { playerId: string; decisionTick: number; tickRate: number }): DecisionObservationSemantics[] {
  if (!Array.isArray(claims) || !options.playerId || !Number.isSafeInteger(options.decisionTick) || !finite(options.tickRate) || options.tickRate <= 0 || options.tickRate > 1024) return fail();
  const subjects = new Map<string, string>();
  const prepared = claims.map(claim => {
    const knowledge = enumeration(claim.knowledge_kind, KNOWLEDGE), modality = enumeration(claim.source_type, OBSERVATION_SOURCE_TYPES), sharingScope = enumeration(claim.sharing_scope, SCOPES), resolution = enumeration(claim.subject_resolution, RESOLUTIONS);
    if (![claim.evidence_tick, claim.available_from_tick].every(Number.isSafeInteger) || claim.available_from_tick < claim.evidence_tick || claim.evidence_tick > options.decisionTick || claim.available_from_tick > options.decisionTick || claim.expires_at_tick !== undefined && (!Number.isSafeInteger(claim.expires_at_tick) || claim.expires_at_tick <= options.decisionTick)) return fail();
    const known = resolution === "EXACT_PLAYER";
    if (known && (typeof claim.subject_ref !== "string" || !claim.subject_ref.trim())) return fail();
    const self = known && claim.subject_ref === options.playerId;
    if (known && !self && !subjects.has(claim.subject_ref!)) subjects.set(claim.subject_ref!, `s${subjects.size + 1}`);
    const subject: DecisionObservationSemantics["subject"] = { resolution, role: self ? "SELF" : known ? "OTHER_KNOWN_SUBJECT" : resolution === "TEAM_ONLY" ? "TEAM_UNSPECIFIED" : "UNKNOWN", alias: known && !self ? subjects.get(claim.subject_ref!)! : null };
    if (modality === "FOOTSTEP" || modality === "GUNSHOT") {
      const assessment = claim.audibility_assessment;
      if (!record(assessment) || assessment.result !== "POSSIBLY_AUDIBLE"
        || typeof assessment.assessed_by !== "string" || !assessment.assessed_by.trim()
        || !Array.isArray(assessment.evidence_refs) || assessment.evidence_refs.length === 0
        || !Array.isArray(claim.evidence_refs)
        || !assessment.evidence_refs.every(ref => typeof ref === "string" && claim.evidence_refs.includes(ref))
        || !Array.isArray(assessment.limitations)) return fail();
      if (assessment.spatial_estimate !== undefined && spatialShape(assessment.spatial_estimate).type === "EXACT_POINT") return fail();
    }
    const shape = spatialShape(claim.spatial_estimate);
    validateSource({ knowledge, modality, sharingScope, subject }, shape.type);
    return { claim, knowledge, modality, sharingScope, subject, shape };
  });
  const anchors = prepared.filter(p => p.subject.role === "SELF" && p.modality === "DIRECT_VISION" && p.knowledge === "OBSERVED" && p.sharingScope === "SELF" && p.claim.evidence_tick === options.decisionTick && p.shape.type === "EXACT_POINT").map(p => (p.shape as Extract<ObservationSpatialEstimate, { type: "EXACT_POINT" }>).point);
  const first = anchors[0];
  const anchor = first && anchors.every(p => p.x === first.x && p.y === first.y && p.z === first.z) ? first : undefined;
  return prepared.map(p => {
    const shape = p.shape;
    const spatial: DecisionObservationSemantics["spatial"] = { sourceType: shape.type, representation: "COARSE_GRID_AND_BOUNDED_RELATION", mapCells: [], includesOutsideMap: null, radiusWorldUnits: null, lastKnownAgeSeconds: null, relativeToSelf: null, direction: null };
    if (shape.type === "DIRECTION_SECTOR") {
      const origin = shape.origin ? grid(shape.origin, 0) : null;
      spatial.direction = { bearingDegrees: shape.bearing_degrees, widthDegrees: shape.width_degrees, maxDistanceWorldUnits: shape.max_distance ?? null, originMapCells: origin?.mapCells ?? null, originIncludesOutsideMap: origin?.includesOutsideMap ?? null };
    } else if (shape.type !== "NONE") {
      const center = shape.type === "EXACT_POINT" || shape.type === "LAST_KNOWN_POINT" ? shape.point : shape.center;
      const radius = shape.type === "EXACT_POINT" ? 0 : shape.radius;
      Object.assign(spatial, grid(center, radius));
      spatial.radiusWorldUnits = shape.type === "EXACT_POINT" ? null : radius;
      spatial.lastKnownAgeSeconds = shape.type === "LAST_KNOWN_POINT" ? shape.age_ticks / options.tickRate : null;
      spatial.relativeToSelf = anchor ? relative(center, radius, anchor, shape.type === "EXACT_POINT") : null;
    }
    return parseDecisionObservationSemantics({ knowledge: p.knowledge, modality: p.modality, sharingScope: p.sharingScope, subject: p.subject, availableAgeSeconds: (options.decisionTick - p.claim.available_from_tick) / options.tickRate, expiresInSeconds: p.claim.expires_at_tick === undefined ? null : (p.claim.expires_at_tick - options.decisionTick) / options.tickRate, spatial });
  });
}

function cells(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(v => typeof v !== "string" || !/^G(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(v)) || new Set(value).size !== value.length) return fail();
  return [...value] as string[];
}
const nullableNonnegative = (v: unknown) => v === null ? null : nonnegative(v);
const nullableBoolean = (v: unknown) => v === null || typeof v === "boolean" ? v : fail();
/** Strict serialized whitelist: no coordinates, identities or prose survive this parser. */
export function parseDecisionObservationSemantics(value: unknown): DecisionObservationSemantics {
  const v = keys(value, ["knowledge", "modality", "sharingScope", "subject", "availableAgeSeconds", "expiresInSeconds", "spatial"]);
  const knowledge = enumeration(v.knowledge, KNOWLEDGE), modality = enumeration(v.modality, OBSERVATION_SOURCE_TYPES), sharingScope = enumeration(v.sharingScope, SCOPES);
  const s = keys(v.subject, ["resolution", "role", "alias"]);
  const resolution = enumeration(s.resolution, RESOLUTIONS), role = enumeration(s.role, ["SELF", "OTHER_KNOWN_SUBJECT", "TEAM_UNSPECIFIED", "UNKNOWN"] as const);
  const alias = s.alias === null ? null : typeof s.alias === "string" && /^s[1-9][0-9]{0,2}$/.test(s.alias) ? s.alias : fail();
  if (resolution === "EXACT_PLAYER" ? !["SELF", "OTHER_KNOWN_SUBJECT"].includes(role) || (role === "SELF" ? alias !== null : alias === null) : alias !== null || role !== (resolution === "TEAM_ONLY" ? "TEAM_UNSPECIFIED" : "UNKNOWN")) return fail();
  const subject = { resolution, role, alias };
  const raw = keys(v.spatial, ["sourceType", "representation", "mapCells", "includesOutsideMap", "radiusWorldUnits", "lastKnownAgeSeconds", "relativeToSelf", "direction"]);
  const sourceType = enumeration(raw.sourceType, SPATIAL);
  if (raw.representation !== "COARSE_GRID_AND_BOUNDED_RELATION") return fail();
  let relativeToSelf: DecisionObservationSemantics["spatial"]["relativeToSelf"] = null;
  if (raw.relativeToSelf !== null) {
    const r = keys(raw.relativeToSelf, ["horizontalDistanceMin", "horizontalDistanceMax", "possibleBearings", "heightDelta"]);
    const min = nonnegative(r.horizontalDistanceMin), max = nonnegative(r.horizontalDistanceMax);
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max || !Array.isArray(r.possibleBearings) || r.possibleBearings.length > 8 || max > 0 && r.possibleBearings.length === 0 || new Set(r.possibleBearings).size !== r.possibleBearings.length) return fail();
    const height = r.heightDelta === null ? null : finite(r.heightDelta) ? r.heightDelta : fail();
    if (sourceType !== "EXACT_POINT" && height !== null) return fail();
    relativeToSelf = { horizontalDistanceMin: min, horizontalDistanceMax: max, possibleBearings: r.possibleBearings.map(b => enumeration(b, BEARINGS)), heightDelta: height };
  }
  let direction: DecisionObservationSemantics["spatial"]["direction"] = null;
  if (raw.direction !== null) {
    const d = keys(raw.direction, ["bearingDegrees", "widthDegrees", "maxDistanceWorldUnits", "originMapCells", "originIncludesOutsideMap"]);
    if (!finite(d.bearingDegrees) || !finite(d.widthDegrees) || d.widthDegrees <= 0 || d.widthDegrees > 360) return fail();
    const origin = d.originMapCells === null ? null : cells(d.originMapCells), outside = nullableBoolean(d.originIncludesOutsideMap);
    if ((origin === null) !== (outside === null) || origin !== null && origin.length === 0 && outside !== true) return fail();
    direction = { bearingDegrees: d.bearingDegrees, widthDegrees: d.widthDegrees, maxDistanceWorldUnits: nullableNonnegative(d.maxDistanceWorldUnits), originMapCells: origin, originIncludesOutsideMap: outside };
  }
  const mapCells = cells(raw.mapCells), includesOutsideMap = nullableBoolean(raw.includesOutsideMap), radiusWorldUnits = nullableNonnegative(raw.radiusWorldUnits), lastKnownAgeSeconds = nullableNonnegative(raw.lastKnownAgeSeconds);
  if (sourceType === "NONE" || sourceType === "DIRECTION_SECTOR") {
    if (mapCells.length || includesOutsideMap !== null || radiusWorldUnits !== null || lastKnownAgeSeconds !== null || relativeToSelf !== null || (sourceType === "NONE" ? direction !== null : direction === null)) return fail();
  } else {
    if (includesOutsideMap === null || mapCells.length === 0 && includesOutsideMap !== true || direction !== null || (sourceType === "EXACT_POINT" ? radiusWorldUnits !== null : radiusWorldUnits === null) || (sourceType === "LAST_KNOWN_POINT" ? lastKnownAgeSeconds === null : lastKnownAgeSeconds !== null)) return fail();
  }
  validateSource({ knowledge, modality, sharingScope, subject }, sourceType);
  const expiresInSeconds = nullableNonnegative(v.expiresInSeconds);
  if (expiresInSeconds === 0) return fail();
  return { knowledge, modality, sharingScope, subject, availableAgeSeconds: nonnegative(v.availableAgeSeconds), expiresInSeconds, spatial: { sourceType, representation: "COARSE_GRID_AND_BOUNDED_RELATION", mapCells, includesOutsideMap, radiusWorldUnits, lastKnownAgeSeconds, relativeToSelf, direction } };
}
