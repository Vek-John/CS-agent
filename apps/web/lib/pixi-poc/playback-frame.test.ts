import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  MatchEvent,
  MatchPlayer,
  ObservableState,
  ObservationClaim,
  PlayerStateSample
} from "@cs-coach/contracts";
import { loadMirageManifest, worldToNormalized } from "@cs-coach/map-semantics";
import type { ReplayGrenadeTrack } from "../replay-bundle";
import {
  buildKnowledgeFrame,
  buildOmniscientFrame,
  radarYawFromWorldYaw,
  type GroundTruthReplaySource,
  type KnowledgeFrameInput,
  type PlaybackFrameActor
} from "./playback-frame";

const manifest = loadMirageManifest({ raster_ref: "/test.png" });

function sample(
  playerId: string,
  tick: number,
  overrides: Partial<PlayerStateSample> = {}
): PlayerStateSample {
  return {
    player_id: playerId,
    tick,
    side: "T",
    world_position: { x: -1000 + tick, y: 400, z: -64 },
    yaw: 0,
    pitch: 0,
    alive: true,
    health: 100,
    armor: 50,
    has_helmet: true,
    money: 800,
    active_item: { item_id: "usp_s", item_class: "weapon" },
    inventory: [{ item_id: "smokegrenade", item_class: "grenade", count: 1 }],
    fact_refs: [],
    missing_fields: [],
    ...overrides
  };
}

const players: MatchPlayer[] = [
  { player_id: "p1", display_name: "Alpha", side: "T", is_selected: true },
  { player_id: "p2", display_name: "Bravo", side: "CT", is_selected: false }
];

const grenade: ReplayGrenadeTrack = {
  id: "grenade-1",
  item_id: "smokegrenade",
  start_tick: 100,
  end_tick: 130,
  points: [
    { tick: 100, world_position: { x: -900, y: 400, z: -64 } },
    { tick: 110, world_position: { x: -850, y: 420, z: -64 } },
    { tick: 130, world_position: { x: -800, y: 440, z: -64 } }
  ]
};

function event(overrides: Partial<MatchEvent> = {}): MatchEvent {
  return {
    id: "event-1",
    tick: 110,
    event_type: "GUNSHOT",
    world_origin: { x: -900, y: 420, z: -64 },
    payload: {},
    source_parser_event: "weapon_fire",
    fact_confidence: 1,
    fact_refs: [],
    missing_fields: [],
    ...overrides
  };
}

function source(): GroundTruthReplaySource {
  return {
    bundle_id: "bundle-1",
    demo_id: "demo-1",
    tick_rate: 64,
    start_tick: 100,
    end_tick: 200,
    selected_player_id: "p1",
    players,
    rounds: [{
      round_number: 1,
      start_tick: 100,
      freeze_end_tick: 105,
      end_tick: 200,
      score_before: [0, 0],
      score_after: [1, 0],
      winner: "T"
    }],
    player_states_by_player: new Map([
      ["p1", [sample("p1", 100), sample("p1", 124, { world_position: { x: -800, y: 400, z: -64 } })]],
      ["p2", [sample("p2", 100, { side: "CT", world_position: { x: -500, y: 500, z: -64 } })]]
    ]),
    events: [event(), event({ id: "future-event", tick: 130 })],
    projectile_tracks: [{
      track_id: grenade.id,
      item_id: grenade.item_id,
      samples: grenade.points ?? [],
      start_tick: grenade.start_tick,
      end_tick: grenade.end_tick,
      source_fact_refs: []
    }]
  };
}

function claim(overrides: Partial<ObservationClaim> = {}): ObservationClaim {
  return {
    id: "sound-claim",
    claim_type: "SOUND_SOURCE",
    knowledge_kind: "INFERRED",
    source_type: "GUNSHOT",
    subject_resolution: "UNKNOWN_ACTOR",
    available_from_tick: 100,
    evidence_tick: 108,
    spatial_estimate: {
      type: "DIRECTION_SECTOR",
      origin: { x: -1000, y: 400, z: -64 },
      bearing_degrees: 20,
      width_degrees: 60,
      max_distance: 800
    },
    confidence: 0.8,
    sharing_scope: "SELF",
    evidence_refs: ["fact-sound"],
    derived_by: "observation/test",
    limitations: [],
    ...overrides
  };
}

function observableState(claims: readonly ObservationClaim[]): ObservableState {
  return {
    id: "observable-1",
    demo_id: "demo-1",
    timeline_version: "timeline/1",
    observer_player_id: "p1",
    at_tick: 100,
    observation_version: "observation/1",
    claims,
    limitations: []
  };
}

function observerKnownState(): PlaybackFrameActor {
  return {
    id: "p1",
    label: "Alpha",
    side: "T",
    radar_position: worldToNormalized({ x: -900, y: 400, z: -64 }, manifest),
    radar_yaw: 0,
    status: "ALIVE",
    health: 100,
    armor: 50,
    inventory: ["smokegrenade"],
    source: "SELF_STATE",
    source_fact_refs: [],
    source_claim_ids: []
  };
}

describe("isolated PlaybackFrameViewModel builders", () => {
  it("keeps omniscient ground truth and the same canonical tick in one frame", () => {
    const frame = buildOmniscientFrame(source(), 120, manifest);

    expect(frame.perspective).toBe("OMNISCIENT");
    expect(frame.tick).toBe(120);
    expect(frame.actors).toHaveLength(2);
    expect(frame.actors.map((actor) => actor.side)).toEqual(["T", "CT"]);
    expect(frame.projectiles[0]?.radar_flight_points).toHaveLength(2);
    expect(frame.projectiles[0]?.radar_flight_points).not.toContain(
      worldToNormalized({ x: -800, y: 440, z: -64 }, manifest)
    );
    expect(frame.effects.map((effect) => effect.id)).toEqual(["event-1"]);
  });

  it("uses current PlayerStateSample.side rather than initial roster side after a swap", () => {
    const swapped = source();
    swapped.player_states_by_player = new Map([
      ["p1", [sample("p1", 100, { side: "T" }), sample("p1", 124, { side: "CT" })]],
      ["p2", [sample("p2", 100, { side: "CT" })]]
    ]);

    expect(buildOmniscientFrame(swapped, 124, manifest).actors[0]?.side).toBe("CT");
  });

  it("converts world yaw through the map affine before rendering heading", () => {
    expect(radarYawFromWorldYaw({ x: 0, y: 0, z: 0 }, 0, manifest)).toBeCloseTo(0);
    expect(radarYawFromWorldYaw({ x: 0, y: 0, z: 0 }, 90, manifest)).toBeCloseTo(270);
  });

  it("keeps knowledge input observation-scoped and never upgrades sound to an enemy marker", () => {
    const sound = claim();
    const visual = claim({
      id: "visual-claim",
      claim_type: "PLAYER_POSITION",
      source_type: "DIRECT_VISION",
      subject_resolution: "EXACT_PLAYER",
      subject_ref: "enemy-1",
      spatial_estimate: { type: "EXACT_POINT", point: { x: -700, y: 430, z: -64 } }
    });
    const input: KnowledgeFrameInput = {
      tick: 120,
      tick_rate: 64,
      selected_player_id: "p1",
      observable_state: observableState([sound, visual]),
      observer_known_state: observerKnownState(),
      // Deliberately simulate a sloppy adapter passing an omniscient round;
      // the knowledge builder must still project a fresh whitelist object.
      round: source().rounds[0] as KnowledgeFrameInput["round"]
    };
    const frame = buildKnowledgeFrame(input, manifest);
    const serialized = JSON.stringify(frame);

    expect(frame.perspective).toBe("PLAYER_KNOWLEDGE");
    expect(frame.actors.map((actor) => actor.source)).toEqual(["SELF_STATE", "DIRECT_VISION"]);
    expect(frame.actors.find((actor) => actor.source === "DIRECT_VISION")?.radar_position).toEqual(
      worldToNormalized({ x: -700, y: 430, z: -64 }, manifest)
    );
    expect(frame.evidence).toMatchObject([{ source_claim_ids: ["sound-claim"], kind: "SOUND_DIRECTION" }]);
    const direction = frame.evidence[0];
    expect(direction && "radar_ray_end" in direction
      ? Math.hypot(
          direction.radar_ray_end.x - direction.radar_origin.x,
          direction.radar_ray_end.y - direction.radar_origin.y
        )
      : 0).toBeGreaterThan(0.02);
    expect(serialized).not.toContain("enemy-1");
    expect(frame.projectiles).toEqual([]);
    expect(frame.effects).toEqual([]);
    expect(frame.round).not.toHaveProperty("winner");
    expect(frame.round).not.toHaveProperty("score_after");
    expect(frame.round).not.toHaveProperty("end_tick");
  });

  it("rejects future/wrong-observer state and future or expired claims", () => {
    const futureClaim = claim({ id: "future-claim", evidence_tick: 130 });
    const expiredClaim = claim({ id: "expired-claim", expires_at_tick: 120 });
    const baseInput: KnowledgeFrameInput = {
      tick: 120,
      tick_rate: 64,
      selected_player_id: "p1",
      observer_known_state: observerKnownState()
    };

    expect(buildKnowledgeFrame({
      ...baseInput,
      observable_state: { ...observableState([futureClaim]), at_tick: 130 }
    }, manifest).evidence).toEqual([]);
    expect(buildKnowledgeFrame({
      ...baseInput,
      observable_state: { ...observableState([claim()]), observer_player_id: "other-player" }
    }, manifest).evidence).toEqual([]);
    expect(buildKnowledgeFrame({
      ...baseInput,
      observable_state: observableState([futureClaim, expiredClaim])
    }, manifest).evidence).toEqual([]);
  });

  it("requires claim provenance for knowledge annotations and typed overlays", () => {
    const sound = claim();
    const trustedEffect = {
      id: "effect-claim",
      kind: "EVENT" as const,
      event_type: "GUNSHOT" as const,
      source_fact_refs: ["fact-sound"],
      source_claim_ids: [sound.id]
    };
    const trustedProjectile = {
      id: "projectile-claim",
      label: "smokegrenade",
      radar_flight_points: [],
      source_fact_refs: [],
      source_claim_ids: [sound.id]
    };
    const trustedBomb = {
      state: "PLANTED" as const,
      source_fact_refs: [],
      source_claim_ids: [sound.id]
    };
    const frame = buildKnowledgeFrame({
      tick: 120,
      tick_rate: 64,
      selected_player_id: "p1",
      observable_state: observableState([sound]),
      observer_known_state: observerKnownState(),
      observable_effects: [trustedEffect, { ...trustedEffect, id: "untrusted-effect", source_claim_ids: ["not-known"] }],
      observable_projectile_history: [trustedProjectile, { ...trustedProjectile, id: "untrusted-projectile", source_claim_ids: [] }],
      observable_bomb: trustedBomb
    }, manifest, {
      annotations: [
        {
          id: "trusted-annotation",
          kind: "POINT",
          radar_point: { x: 0.5, y: 0.5 },
          source_fact_refs: [],
          source_claim_ids: [sound.id]
        },
        {
          id: "outcome-annotation",
          kind: "POINT",
          radar_point: { x: 0.7, y: 0.7 },
          source_fact_refs: [],
          source_claim_ids: []
        }
      ]
    });

    expect(frame.effects.map((effect) => effect.id)).toEqual(["effect-claim"]);
    expect(frame.projectiles.map((projectile) => projectile.id)).toEqual(["projectile-claim"]);
    expect(frame.bomb?.source_claim_ids).toEqual([sound.id]);
    expect(frame.annotations.map((annotation) => annotation.id)).toEqual(["trusted-annotation"]);
  });

  it("distinguishes bomb begin/complete parser facts and only renders real item drops", () => {
    const grounded = source();
    grounded.events = [
      event({ id: "planting", tick: 110, event_type: "BOMB_PLANT", source_parser_event: "bomb_beginplant" }),
      event({ id: "planted", tick: 120, event_type: "BOMB_PLANT", source_parser_event: "bomb_planted" }),
      event({ id: "drop", tick: 122, event_type: "ITEM_DROP", item_id: "ak47", world_origin: { x: -700, y: 400, z: -64 } })
    ];

    expect(buildOmniscientFrame(grounded, 115, manifest).bomb?.state).toBe("PLANTING");
    expect(buildOmniscientFrame(grounded, 125, manifest).bomb?.state).toBe("PLANTED");
    expect(buildOmniscientFrame(grounded, 125, manifest).dropped_weapons).toMatchObject([
      { id: "drop", item_id: "ak47" }
    ]);
  });

  it("does not accept a ground-truth source as the knowledge builder input", () => {
    expectTypeOf<Parameters<typeof buildKnowledgeFrame>[0]>().toEqualTypeOf<KnowledgeFrameInput>();
    expectTypeOf<Parameters<typeof buildOmniscientFrame>[0]>().toEqualTypeOf<GroundTruthReplaySource>();
  });
});
