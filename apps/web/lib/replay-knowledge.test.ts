import { describe, expect, it } from "vitest";
import type { ObservationClaim } from "@cs-coach/contracts";
import { loadMirageManifest } from "@cs-coach/map-semantics";
import {
  buildKnowledgeEvidenceOverlays,
  getRenderablePlayerClaims
} from "./replay-knowledge";

const manifest = loadMirageManifest({ raster_ref: "/test.png" });

function makeClaim(overrides: Partial<ObservationClaim> = {}): ObservationClaim {
  return {
    id: "claim-1",
    claim_type: "SOUND_SOURCE",
    knowledge_kind: "INFERRED",
    source_type: "GUNSHOT",
    subject_resolution: "UNKNOWN_ACTOR",
    available_from_tick: 100,
    evidence_tick: 100,
    spatial_estimate: {
      type: "DIRECTION_SECTOR",
      origin: { x: -1000, y: 400, z: -64 },
      bearing_degrees: 45,
      width_degrees: 90,
      max_distance: 600
    },
    confidence: 0.8,
    sharing_scope: "SELF",
    evidence_refs: [],
    derived_by: "test",
    limitations: [],
    ...overrides
  };
}

describe("player knowledge evidence rendering", () => {
  it("keeps a sound direction claim out of exact player markers", () => {
    const soundClaim = makeClaim({ subject_ref: "enemy-1" });

    expect(getRenderablePlayerClaims([soundClaim])).toEqual([]);
    expect(buildKnowledgeEvidenceOverlays([soundClaim], manifest)).toMatchObject([
      { id: "claim-1", type: "DIRECTION_SECTOR" }
    ]);
  });

  it("renders area and last-known claims as uncertainty overlays", () => {
    const area = makeClaim({
      id: "area-1",
      claim_type: "UTILITY_STATE",
      spatial_estimate: {
        type: "AREA",
        center: { x: -800, y: 300, z: -64 },
        radius: 160
      }
    });
    const lastKnown = makeClaim({
      id: "last-known-1",
      claim_type: "LAST_KNOWN_POSITION",
      source_type: "LAST_KNOWN",
      subject_ref: "enemy-1",
      subject_resolution: "EXACT_PLAYER",
      spatial_estimate: {
        type: "LAST_KNOWN_POINT",
        point: { x: -700, y: 250, z: -64 },
        radius: 220,
        age_ticks: 512
      }
    });

    const overlays = buildKnowledgeEvidenceOverlays([area, lastKnown], manifest);
    expect(overlays.map((overlay) => overlay.type)).toEqual(["AREA", "LAST_KNOWN_POINT"]);
    expect(overlays[1]?.type === "LAST_KNOWN_POINT" && overlays[1].opacity).toBeLessThan(0.8);
  });

  it("does not invent a sound origin when DIRECTION_SECTOR has none", () => {
    const claim = makeClaim({
      spatial_estimate: {
        type: "DIRECTION_SECTOR",
        bearing_degrees: 20,
        width_degrees: 60
      }
    });

    expect(buildKnowledgeEvidenceOverlays([claim], manifest)).toEqual([]);
  });
});
