import { describe, expect, it } from "vitest";
import type { ObservationClaim } from "@cs-coach/contracts";
import {
  assertNoFutureObservationClaims,
  buildObservableState,
  collectObservationClaimIssues,
  decayLastKnownClaim,
  FutureObservationClaimError,
  filterObservationClaimsAtTick,
  ObservationFactValidationError,
  type ObservationFact,
  type SoundEmissionFact
} from "./index";

const baseInput = {
  demo_id: "demo-1",
  timeline_version: "timeline-1",
  observer_player_id: "p-self",
  at_tick: 100,
  observer_position: { x: 0, y: 0, z: 64 }
};

describe("Observation rules", () => {
  it("keeps direct vision and spotted positions precise", () => {
    const state = buildObservableState({
      ...baseInput,
      facts: [
        {
          id: "vision-1",
          source_type: "DIRECT_VISION",
          observer_player_id: "p-self",
          subject_player_id: "p-enemy",
          tick: 90,
          world_position: { x: 120, y: 30, z: 72 }
        },
        {
          id: "spotted-1",
          source_type: "SPOTTED",
          observer_player_id: "p-self",
          subject_player_id: "p-enemy-2",
          tick: 95,
          world_position: { x: -40, y: 80, z: 64 }
        }
      ]
    });

    expect(state.claims.map((claim) => claim.spatial_estimate.type)).toEqual([
      "EXACT_POINT",
      "EXACT_POINT"
    ]);
    expect(state.claims.every((claim) => claim.subject_resolution === "EXACT_PLAYER")).toBe(true);
  });

  it("keeps footsteps and gunshots coarse and never exposes hidden realtime coordinates", () => {
    const state = buildObservableState({
      ...baseInput,
      facts: [
        {
          id: "step-1",
          source_type: "FOOTSTEP",
          observer_player_id: "p-self",
          tick: 70,
          world_origin: { x: 200, y: 300, z: 64 },
          audibility_assessment: {
            result: "POSSIBLY_AUDIBLE",
            assessed_by: "test-audibility",
            evidence_refs: ["step-1-audibility"],
            limitations: ["未建模遮挡与同时噪声。"]
          }
        },
        {
          id: "shot-1",
          source_type: "GUNSHOT",
          observer_player_id: "p-self",
          tick: 80,
          world_origin: { x: -200, y: 100, z: 64 },
          audibility_assessment: {
            result: "POSSIBLY_AUDIBLE",
            assessed_by: "test-audibility",
            evidence_refs: ["shot-1-audibility"],
            limitations: ["未建模遮挡与同时噪声。"]
          }
        }
      ]
    });

    expect(state.claims).toHaveLength(2);
    expect(state.claims.every((claim) => claim.subject_resolution === "UNKNOWN_ACTOR")).toBe(true);
    expect(
      state.claims.every(
        (claim) =>
          claim.spatial_estimate.type === "DIRECTION_SECTOR" ||
          claim.spatial_estimate.type === "UNCERTAIN_POINT" ||
          claim.spatial_estimate.type === "AREA"
      )
    ).toBe(true);
    expect(state.claims.some((claim) => claim.spatial_estimate.type === "EXACT_POINT")).toBe(false);
    expect(state.claims.every((claim) => !claim.subject_ref)).toBe(true);
    expect(state.claims[0]?.limitations.join(" ")).toContain("不证明观察者确实听到");
  });

  it("represents damage direction without upgrading it to an attacker location", () => {
    const state = buildObservableState({
      ...baseInput,
      facts: [
        {
          id: "damage-1",
          source_type: "DAMAGE_DIRECTION",
          observer_player_id: "p-self",
          tick: 80,
          direction: { bearing_degrees: 45, width_degrees: 60 }
        }
      ]
    });

    expect(state.claims[0]?.spatial_estimate.type).toBe("DIRECTION_SECTOR");
    expect(state.claims[0]?.subject_resolution).toBe("UNKNOWN_ACTOR");
  });

  it("keeps utility and bomb facts bounded by observer knowledge", () => {
    const state = buildObservableState({
      ...baseInput,
      facts: [
        {
          id: "visible-utility",
          source_type: "UTILITY",
          observer_player_id: "p-self",
          tick: 80,
          visible_to_observer: true,
          subject_ref: "p-self",
          world_position: { x: 10, y: 20, z: 0 }
        },
        {
          id: "hidden-bomb",
          source_type: "BOMB",
          observer_player_id: "p-self",
          tick: 90,
          visible_to_observer: false,
          world_position: { x: 100, y: 100, z: 0 }
        }
      ]
    });

    expect(state.claims[0]?.spatial_estimate.type).toBe("EXACT_POINT");
    expect(state.claims[0]?.subject_resolution).toBe("EXACT_PLAYER");
    expect(state.claims[1]?.spatial_estimate.type).toBe("NONE");
    expect(state.claims[1]?.subject_resolution).toBe("TEAM_ONLY");
    expect(state.limitations.join(" ")).toContain("ground-truth world_position 被丢弃");
  });

  it("does not inherit teammate vision unless a verified shared claim exists", () => {
    const teammateClaim: ObservationClaim = {
      id: "teammate-vision",
      claim_type: "PLAYER_POSITION",
      knowledge_kind: "OBSERVED",
      source_type: "DIRECT_VISION",
      subject_ref: "p-enemy",
      subject_resolution: "EXACT_PLAYER",
      available_from_tick: 70,
      evidence_tick: 70,
      spatial_estimate: { type: "EXACT_POINT", point: { x: 500, y: 500, z: 64 } },
      confidence: 1,
      sharing_scope: "SELF",
      evidence_refs: ["teammate-fact"],
      derived_by: "test",
      limitations: []
    };
    const state = buildObservableState({
      ...baseInput,
      facts: [
        {
          id: "not-shared",
          source_type: "TEAM_SHARED",
          observer_player_id: "p-self",
          tick: 80,
          shared_to_observer: false,
          source_claim: teammateClaim
        },
        {
          id: "shared",
          source_type: "TEAM_SHARED",
          observer_player_id: "p-self",
          tick: 90,
          shared_to_observer: true,
          shared_at_tick: 90,
          source_claim: teammateClaim
        }
      ]
    });

    expect(state.claims).toHaveLength(1);
    expect(state.claims[0]?.source_type).toBe("TEAM_SHARED");
    expect(state.claims[0]?.sharing_scope).toBe("VERIFIED_TEAM_SHARED");
    expect(state.claims[0]?.id).toBe("shared:team-shared");
  });

  it("keeps user context independent from Demo-derived claims", () => {
    const state = buildObservableState({
      ...baseInput,
      facts: [
        {
          id: "user-note",
          source_type: "USER_CONTEXT",
          observer_player_id: "p-self",
          tick: 90,
          context_ref: "voice-call-1",
          context_tick: 90
        }
      ]
    });

    expect(state.claims[0]?.source_type).toBe("USER_CONTEXT");
    expect(state.claims[0]?.knowledge_kind).toBe("USER_ASSERTED");
    expect(state.claims[0]?.sharing_scope).toBe("USER_CONTEXT_ONLY");
    expect(state.claims[0]?.context_ref).toBe("voice-call-1");
    expect(state.claims[0]?.spatial_estimate.type).toBe("NONE");
  });

  it("rejects future claims at a decision tick", () => {
    const futureClaim: ObservationClaim = {
      id: "future",
      claim_type: "PLAYER_POSITION",
      knowledge_kind: "OBSERVED",
      source_type: "DIRECT_VISION",
      subject_ref: "p-enemy",
      subject_resolution: "EXACT_PLAYER",
      available_from_tick: 101,
      evidence_tick: 101,
      spatial_estimate: { type: "EXACT_POINT", point: { x: 1, y: 1, z: 1 } },
      confidence: 1,
      sharing_scope: "SELF",
      evidence_refs: ["future-fact"],
      derived_by: "test",
      limitations: []
    };

    expect(filterObservationClaimsAtTick([futureClaim], 100)).toEqual([]);
    expect(() => assertNoFutureObservationClaims([futureClaim], 100)).toThrow(
      FutureObservationClaimError
    );
  });

  it("keeps last-known fixed while confidence decays and radius grows", () => {
    const confirmed: ObservationClaim = {
      id: "confirmed",
      claim_type: "PLAYER_POSITION",
      knowledge_kind: "OBSERVED",
      source_type: "DIRECT_VISION",
      subject_ref: "p-enemy",
      subject_resolution: "EXACT_PLAYER",
      available_from_tick: 50,
      evidence_tick: 50,
      spatial_estimate: { type: "EXACT_POINT", point: { x: 200, y: 300, z: 64 } },
      confidence: 1,
      sharing_scope: "SELF",
      evidence_refs: ["vision"],
      derived_by: "test",
      limitations: []
    };

    const early = decayLastKnownClaim(confirmed, 60);
    const late = decayLastKnownClaim(confirmed, 180);
    expect(early?.spatial_estimate.type).toBe("LAST_KNOWN_POINT");
    expect(late?.spatial_estimate.type).toBe("LAST_KNOWN_POINT");
    if (early?.spatial_estimate.type === "LAST_KNOWN_POINT" && late?.spatial_estimate.type === "LAST_KNOWN_POINT") {
      expect(late.spatial_estimate.point).toEqual(early.spatial_estimate.point);
      expect(late.spatial_estimate.radius).toBeGreaterThan(early.spatial_estimate.radius);
      expect(late.confidence).toBeLessThan(early.confidence);
    }
  });

  it("flags a manually constructed sound claim that violates the red line", () => {
    const issues = collectObservationClaimIssues({
      id: "invalid-sound",
      claim_type: "SOUND_SOURCE",
      knowledge_kind: "INFERRED",
      source_type: "GUNSHOT",
      subject_ref: "hidden-enemy",
      subject_resolution: "EXACT_PLAYER",
      available_from_tick: 1,
      evidence_tick: 1,
      spatial_estimate: { type: "EXACT_POINT", point: { x: 1, y: 2, z: 3 } },
      confidence: 1,
      sharing_scope: "SELF",
      evidence_refs: ["shot"],
      derived_by: "test",
      limitations: []
    });

    expect(issues.join(" ")).toContain("cannot expose an exact hidden-player point");
  });

  it("rejects raw/global sound emissions instead of applying them to every observer", () => {
    const emission: SoundEmissionFact = {
      id: "global-step",
      source_type: "FOOTSTEP",
      tick: 70,
      world_origin: { x: 900, y: 900, z: 64 },
      evidence_refs: ["parser-footstep"],
      source_parser_event: "player_footstep"
    };

    expect(() =>
      buildObservableState({
        ...baseInput,
        facts: [emission as unknown as ObservationFact]
      })
    ).toThrow(ObservationFactValidationError);
    try {
      buildObservableState({
        ...baseInput,
        facts: [emission as unknown as ObservationFact]
      });
    } catch (error) {
      expect((error as ObservationFactValidationError).issues.join(" ")).toContain(
        "raw/global MatchEvent facts cannot be ObservationFacts"
      );
    }
  });

  it("rejects an unbound non-sound fact instead of treating it as globally observable", () => {
    expect(() =>
      buildObservableState({
        ...baseInput,
        facts: [
          {
            id: "unbound-vision",
            source_type: "DIRECT_VISION",
            subject_player_id: "p-enemy",
            tick: 70,
            world_position: { x: 1, y: 2, z: 3 }
          } as unknown as ObservationFact
        ]
      })
    ).toThrow(ObservationFactValidationError);
  });

  it("isolates observer-specific audibility assessments and only emits POSSIBLY_AUDIBLE sound claims", () => {
    const p1Sound = {
      id: "p1-shot",
      source_type: "GUNSHOT" as const,
      observer_player_id: "p1",
      tick: 70,
      world_origin: { x: 200, y: 200, z: 64 },
      audibility_assessment: {
        result: "POSSIBLY_AUDIBLE" as const,
        assessed_by: "audibility-rules",
        evidence_refs: ["p1-audibility"],
        limitations: ["仅为可能听到。"]
      }
    };
    const p2Sound = {
      id: "p2-shot",
      source_type: "GUNSHOT" as const,
      observer_player_id: "p2",
      tick: 70,
      world_origin: { x: -200, y: -200, z: 64 },
      audibility_assessment: {
        result: "POSSIBLY_AUDIBLE" as const,
        assessed_by: "audibility-rules",
        evidence_refs: ["p2-audibility"],
        limitations: ["仅为可能听到。"]
      }
    };
    const notAudible = {
      ...p1Sound,
      id: "p1-not-audible",
      audibility_assessment: {
        ...p1Sound.audibility_assessment,
        result: "NOT_AUDIBLE" as const,
        evidence_refs: ["p1-not-audible-assessment"]
      }
    };

    const p1State = buildObservableState({
      ...baseInput,
      observer_player_id: "p1",
      facts: [p1Sound, p2Sound, notAudible]
    });
    const p2State = buildObservableState({
      ...baseInput,
      observer_player_id: "p2",
      facts: [p1Sound, p2Sound]
    });
    const p2WithoutOwnAssessment = buildObservableState({
      ...baseInput,
      observer_player_id: "p2",
      facts: [p1Sound]
    });

    expect(p1State.claims.map((claim) => claim.id)).toEqual(["p1-shot:sound"]);
    expect(p2State.claims.map((claim) => claim.id)).toEqual(["p2-shot:sound"]);
    expect(p2WithoutOwnAssessment.claims).toEqual([]);
    expect(p1State.claims[0]?.spatial_estimate.type).not.toBe("EXACT_POINT");
    expect(p1State.claims[0]?.subject_resolution).toBe("UNKNOWN_ACTOR");
    expect(p1State.limitations.join(" ")).toContain("不是 POSSIBLY_AUDIBLE");
  });

  it("does not turn an unlocalized parser sound origin into an observer point", () => {
    const state = buildObservableState({
      ...baseInput,
      observer_position: undefined,
      facts: [
        {
          id: "unlocalized-shot",
          source_type: "GUNSHOT",
          observer_player_id: "p-self",
          tick: 70,
          world_origin: { x: 999, y: 999, z: 64 },
          audibility_assessment: {
            result: "POSSIBLY_AUDIBLE",
            assessed_by: "audibility-rules",
            evidence_refs: ["unlocalized-audibility"],
            limitations: ["没有观察者相对方向证据。"]
          }
        }
      ]
    });

    expect(state.claims[0]?.spatial_estimate).toEqual({ type: "NONE" });
    expect(state.claims[0]?.spatial_estimate).not.toEqual({
      type: "UNCERTAIN_POINT",
      center: { x: 999, y: 999, z: 64 },
      radius: 512
    });
  });

  it("never uses hidden utility or bomb ground truth without explicit observable evidence", () => {
    const state = buildObservableState({
      ...baseInput,
      facts: [
        {
          id: "hidden-utility-with-evidence",
          source_type: "UTILITY",
          observer_player_id: "p-self",
          tick: 80,
          visible_to_observer: false,
          world_position: { x: 999, y: 999, z: 999 },
          observable_evidence_basis: {
            spatial_estimate: { type: "AREA", center: { x: 10, y: 20, z: 0 }, radius: 80 },
            assessed_by: "utility-observation",
            evidence_refs: ["visible-smoke-edge"],
            limitations: ["只确认大致区域。"]
          }
        }
      ]
    });

    expect(state.claims[0]?.spatial_estimate).toEqual({
      type: "AREA",
      center: { x: 10, y: 20, z: 0 },
      radius: 80
    });
    expect(state.claims[0]?.spatial_estimate).not.toEqual({
      type: "UNCERTAIN_POINT",
      center: { x: 999, y: 999, z: 999 },
      radius: 128
    });
  });

  it("keeps delayed team sharing unavailable before the share tick", () => {
    const sourceClaim: ObservationClaim = {
      id: "delayed-source",
      claim_type: "PLAYER_POSITION",
      knowledge_kind: "OBSERVED",
      source_type: "DIRECT_VISION",
      subject_ref: "p-enemy",
      subject_resolution: "EXACT_PLAYER",
      available_from_tick: 70,
      evidence_tick: 70,
      spatial_estimate: { type: "EXACT_POINT", point: { x: 500, y: 500, z: 64 } },
      confidence: 1,
      sharing_scope: "SELF",
      evidence_refs: ["delayed-source-evidence"],
      derived_by: "test",
      limitations: []
    };
    const delayedShare = {
      id: "delayed-share",
      source_type: "TEAM_SHARED" as const,
      observer_player_id: "p-self",
      tick: 70,
      shared_to_observer: true,
      shared_at_tick: 90,
      source_claim: sourceClaim
    };

    const beforeShare = buildObservableState({ ...baseInput, at_tick: 89, facts: [delayedShare] });
    const atShare = buildObservableState({ ...baseInput, at_tick: 90, facts: [delayedShare] });

    expect(beforeShare.claims).toEqual([]);
    expect(atShare.claims[0]?.available_from_tick).toBe(90);
    expect(atShare.claims[0]?.evidence_tick).toBe(70);
  });

  it("allows evidence to become available after the evidence event", () => {
    const delayed: ObservationClaim = {
      id: "delayed",
      claim_type: "TEAM_REPORT",
      knowledge_kind: "INFERRED",
      source_type: "TEAM_SHARED",
      subject_resolution: "UNKNOWN_ACTOR",
      available_from_tick: 90,
      evidence_tick: 70,
      spatial_estimate: { type: "AREA", center: { x: 1, y: 1, z: 0 }, radius: 100 },
      confidence: 0.5,
      sharing_scope: "VERIFIED_TEAM_SHARED",
      evidence_refs: ["source-event", "share-event"],
      derived_by: "test",
      limitations: []
    };

    expect(collectObservationClaimIssues(delayed)).toEqual([]);
    expect(filterObservationClaimsAtTick([delayed], 89)).toEqual([]);
    expect(filterObservationClaimsAtTick([delayed], 90)).toEqual([delayed]);
  });
});
