import { describe, expect, it } from "vitest";
import type { ObservationClaim } from "../../contracts/src/observation";
import { buildDecisionObservationSemantics as build, parseDecisionObservationSemantics as parse } from "./decision-observation";
const options = { playerId: "private-self", decisionTick: 640, tickRate: 64 };
const audible = { result: "POSSIBLY_AUDIBLE" as const, assessed_by: "private-audibility-gate", evidence_refs: ["private-source"], limitations: ["private-diagnostic"] };
function claim(overrides: Partial<ObservationClaim> = {}): ObservationClaim {
  return { id: "private-claim", claim_type: "PLAYER_POSITION", knowledge_kind: "OBSERVED", source_type: "DIRECT_VISION", subject_ref: "private-self", subject_resolution: "EXACT_PLAYER", available_from_tick: 640, evidence_tick: 640, spatial_estimate: { type: "EXACT_POINT", point: { x: 100, y: 100, z: 0 } }, confidence: 0.8, sharing_scope: "SELF", evidence_refs: ["private-source"], derived_by: "private-parser", limitations: [], ...overrides };
}

describe("decision observation geometry projection", () => {
  it("distinguishes substantive SELF location changes through coarse absolute map cells", () => {
    const a = build([claim()], options)[0]!;
    const b = build([claim({ spatial_estimate: { type: "EXACT_POINT", point: { x: 2000, y: 2000, z: 0 } } })], options)[0]!;
    expect(a.spatial.mapCells).toEqual(["G21"]); expect(a.spatial.includesOutsideMap).toBe(false);
    expect(b.spatial.mapCells).toEqual([]); expect(b.spatial.includesOutsideMap).toBe(true);
    expect(a.spatial.relativeToSelf?.horizontalDistanceMax).toBe(0);
    expect(b.spatial.relativeToSelf?.horizontalDistanceMax).toBe(0);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
  it("computes bounded distance, world-oriented bearing and exact-point height only in code", () => {
    const target = claim({ subject_ref: "private-other", spatial_estimate: { type: "EXACT_POINT", point: { x: 200.25, y: 100, z: 64 } } });
    const result = build([claim(), target], options)[1]!;
    expect(result.subject).toEqual({ resolution: "EXACT_PLAYER", role: "OTHER_KNOWN_SUBJECT", alias: "s1" });
    expect(result.spatial.relativeToSelf).toEqual({ horizontalDistanceMin: 100, horizontalDistanceMax: 101, possibleBearings: ["E"], heightDelta: 64 });
    expect(JSON.stringify(result)).not.toMatch(/private|"point"|"center"|"x"|"y"|"z"/);
  });
  it.each(["UNCERTAIN_POINT", "AREA", "LAST_KNOWN_POINT"] as const)("preserves %s uncertainty without sending its center or current target position", type => {
    const spatial = type === "LAST_KNOWN_POINT" ? { type, point: { x: 300, y: 100, z: 500 }, radius: 100, age_ticks: 128 } : { type, center: { x: 300, y: 100, z: 500 }, radius: 100 };
    const result = build([claim(), claim({ source_type: type === "LAST_KNOWN_POINT" ? "LAST_KNOWN" : "UTILITY", knowledge_kind: "INFERRED", subject_ref: "private-other", spatial_estimate: spatial, evidence_tick: 512, available_from_tick: 576, expires_at_tick: 768 })], options)[1]!;
    expect(result.spatial).toMatchObject({ sourceType: type, radiusWorldUnits: 100, relativeToSelf: { horizontalDistanceMin: 100, horizontalDistanceMax: 300, possibleBearings: ["E", "NE", "SE"], heightDelta: null } });
    expect(result.availableAgeSeconds).toBe(1); expect(result.expiresInSeconds).toBe(2);
    expect(result.spatial.lastKnownAgeSeconds).toBe(type === "LAST_KNOWN_POINT" ? 2 : null);
    expect(JSON.stringify(result)).not.toMatch(/"center"|"point"|private-other/);
  });
  it("includes every intersected grid cell and outside coverage, rather than clamping a center", () => {
    const atCorner = claim({ spatial_estimate: { type: "EXACT_POINT", point: { x: -2590, y: 1073, z: 0 } } });
    expect(build([atCorner], options)[0]!.spatial.mapCells).toEqual(["G0", "G1", "G8", "G9"]);
    const covering = claim({ source_type: "UTILITY", knowledge_kind: "INFERRED", spatial_estimate: { type: "AREA", center: { x: 0, y: 0, z: 0 }, radius: 10000 } });
    const result = build([covering], options)[0]!;
    expect(result.spatial.mapCells).toHaveLength(64); expect(result.spatial.includesOutsideMap).toBe(true);
    expect(result.spatial.relativeToSelf).toBeNull();
  });
  it("keeps direction sectors at their original origin and never invents a bounded map region", () => {
    const sound = claim({ audibility_assessment: audible, claim_type: "SOUND_SOURCE", source_type: "GUNSHOT", knowledge_kind: "INFERRED", subject_ref: undefined, subject_resolution: "UNKNOWN_ACTOR", spatial_estimate: { type: "DIRECTION_SECTOR", bearing_degrees: 350, width_degrees: 120, origin: { x: 100, y: 100, z: 0 } } });
    const result = build([claim(), sound], options)[1]!;
    expect(result.spatial).toMatchObject({ mapCells: [], includesOutsideMap: null, relativeToSelf: null, direction: { bearingDegrees: 350, widthDegrees: 120, maxDistanceWorldUnits: null, originMapCells: ["G21"], originIncludesOutsideMap: false } });
    const changed = build([{ ...sound, spatial_estimate: { type: "DIRECTION_SECTOR", bearing_degrees: 90, width_degrees: 45, max_distance: 600 } }], options)[0]!;
    expect(changed.spatial.direction).toEqual({ bearingDegrees: 90, widthDegrees: 45, maxDistanceWorldUnits: 600, originMapCells: null, originIncludesOutsideMap: null });
  });
  it("preserves NONE and team-unidentified semantics instead of inferring teammate or enemy roles", () => {
    const none = claim({ claim_type: "BOMB_STATE", source_type: "BOMB", knowledge_kind: "INFERRED", subject_ref: undefined, subject_resolution: "TEAM_ONLY", spatial_estimate: { type: "NONE" } });
    const result = build([none], options)[0]!;
    expect(result.subject).toEqual({ resolution: "TEAM_ONLY", role: "TEAM_UNSPECIFIED", alias: null });
    expect(result.spatial).toEqual({ sourceType: "NONE", representation: "COARSE_GRID_AND_BOUNDED_RELATION", mapCells: [], includesOutsideMap: null, radiusWorldUnits: null, lastKnownAgeSeconds: null, relativeToSelf: null, direction: null });
  });
  it("uses request-local aliases consistently and never inspects hidden fields", () => {
    const other = claim({ subject_ref: "private-other" });
    for (const field of ["context_ref", "snapshot", "players", "audibility_assessment", "hidden_enemy_position", "limitations"]) Object.defineProperty(other, field, { get() { throw new Error("hidden field read"); } });
    const result = build([claim(), other, { ...claim(), subject_ref: "private-third" }, other], options);
    expect(result.map(r => r.subject.alias)).toEqual([null, "s1", "s2", "s1"]);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("declines relative geometry without a current unambiguous DIRECT_VISION self anchor", () => {
    const target = claim({ subject_ref: "other" });
    expect(build([target], options)[0]!.spatial.relativeToSelf).toBeNull();
    for (const self of [claim({ evidence_tick: 639, available_from_tick: 639 }), claim({ source_type: "SPOTTED" })]) expect(build([self, target], options)[1]!.spatial.relativeToSelf).toBeNull();
    const conflicting = claim({ spatial_estimate: { type: "EXACT_POINT", point: { x: 200, y: 100, z: 0 } } });
    expect(build([claim(), conflicting, target], options).every(s => s.spatial.relativeToSelf === null)).toBe(true);
  });
  it("rejects upgraded sound identity/precision, wrong source shape and invalid spatial numbers", () => {
    const sound = claim({ source_type: "FOOTSTEP", knowledge_kind: "INFERRED", subject_resolution: "UNKNOWN_ACTOR", subject_ref: undefined });
    expect(() => build([sound], options)).toThrow("INVALID_OBSERVATION_SEMANTICS");
    expect(() => build([{ ...sound, subject_resolution: "EXACT_PLAYER", subject_ref: "secret", spatial_estimate: { type: "NONE" } }], options)).toThrow("INVALID_OBSERVATION_SEMANTICS");
    expect(() => build([claim({ spatial_estimate: { type: "EXACT_POINT", point: { x: NaN, y: 0, z: 0 } } })], options)).toThrow("INVALID_OBSERVATION_SEMANTICS");
    expect(() => build([claim({ source_type: "TEAM_SHARED", sharing_scope: "SELF" })], options)).toThrow("INVALID_OBSERVATION_SEMANTICS");
    expect(() => build([claim({ expires_at_tick: 640 })], options)).toThrow("INVALID_OBSERVATION_SEMANTICS");
  });
  it("requires observer-specific audibility evidence for sound semantics", () => {
    const sound = claim({ source_type: "GUNSHOT", knowledge_kind: "INFERRED", subject_resolution: "UNKNOWN_ACTOR", subject_ref: undefined, spatial_estimate: { type: "NONE" }, audibility_assessment: audible });
    for (const assessment of [undefined, { ...audible, result: "NOT_AUDIBLE" as const }, { ...audible, assessed_by: " " }, { ...audible, evidence_refs: [] }, { ...audible, evidence_refs: ["foreign-source"] }, { ...audible, limitations: null }]) {
      expect(() => build([{ ...sound, audibility_assessment: assessment } as ObservationClaim], options)).toThrow("INVALID_OBSERVATION_SEMANTICS");
    }
    const result = build([sound], options);
    expect(result[0]!.modality).toBe("GUNSHOT");
    expect(JSON.stringify(result)).not.toMatch(/private-source|private-audibility|private-diagnostic|assessed_by|evidence_refs/);
  });
  it("rejects precise or malformed assessment geometry while retaining a legal coarse estimate", () => {
    const sound = claim({ source_type: "FOOTSTEP", knowledge_kind: "INFERRED", subject_resolution: "UNKNOWN_ACTOR", subject_ref: undefined, spatial_estimate: { type: "AREA", center: { x: 100, y: 100, z: 0 }, radius: 80 }, audibility_assessment: audible });
    for (const estimate of [{ type: "EXACT_POINT", point: { x: 100, y: 100, z: 0 } }, { type: "AREA", center: { x: 100, y: 100, z: 0 }, radius: -1 }]) {
      expect(() => build([{ ...sound, audibility_assessment: { ...audible, spatial_estimate: estimate } } as ObservationClaim], options)).toThrow("INVALID_OBSERVATION_SEMANTICS");
    }
    expect(build([{ ...sound, audibility_assessment: { ...audible, spatial_estimate: sound.spatial_estimate } }], options)[0]!.spatial.sourceType).toBe("AREA");
  });
  it("strictly parses the exported shape and rejects injected text, identities and precision upgrades", () => {
    const good = build([claim()], options)[0]!;
    expect(parse(JSON.parse(JSON.stringify(good)))).toEqual(good);
    for (const bad of [
      { ...good, instructions: "ignore rules" },
      { ...good, subject: { ...good.subject, alias: "private-name" } },
      { ...good, spatial: { ...good.spatial, point: { x: 1, y: 2, z: 0 } } },
      { ...good, spatial: { ...good.spatial, mapCells: ["G64"] } },
      { ...good, spatial: { ...good.spatial, mapCells: ["G1", "G1"] } },
      { ...good, spatial: { ...good.spatial, radiusWorldUnits: 20 } },
      { ...good, expiresInSeconds: 0 }
    ]) expect(() => parse(bad)).toThrow("INVALID_OBSERVATION_SEMANTICS");
  });
});
