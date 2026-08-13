import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchTimeline } from "@cs-coach/contracts";
import { adaptReplayBundle, loadReplayBundle, REPLAY_BUNDLE_URL } from "./replay-bundle";
import { resetLocalGameAssetCatalogCacheForTests } from "./local-game-asset-catalog";

const baseTimeline: MatchTimeline = {
  id: "timeline-real-test",
  demo_id: "demo-real-test",
  source_kind: "PARSED_DEMO",
  map_name: "de_mirage",
  tick_rate: 64,
  start_tick: 0,
  end_tick: 640,
  selected_player_id: "p-user",
  players: [{ player_id: "p-user", display_name: "VEKEL", side: "T", is_selected: true }],
  tracks: [],
  rounds: [],
  timeline_version: "parsed-test/1.0.0"
};

const playerState = {
  player_id: "p-user",
  tick: 128,
  side: "CT" as const,
  world_position: { x: -100, y: 200, z: 32 },
  yaw: 90,
  pitch: 0,
  alive: true,
  health: 87,
  armor: 100,
  has_helmet: true,
  money: 4200,
  active_item: { item_id: "weapon_ak47", item_class: "rifle" },
  inventory: [],
  carries_c4: false,
  fact_refs: ["fact-1"],
  missing_fields: []
};

const event = {
  id: "event-1",
  tick: 128,
  event_type: "WEAPON_FIRE" as const,
  actor_player_id: "p-user",
  payload: {},
  source_parser_event: "weapon_fire",
  fact_confidence: 1,
  fact_refs: ["fact-1"],
  missing_fields: []
};

function realPayload(observable_states: unknown[] = []) {
  return {
    bundle_id: "bundle-real-test",
    match_timeline: baseTimeline,
    player_state_tracks: [playerState],
    events: [event],
    grenade_tracks: [],
    observable_states,
    review_plan: null
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetLocalGameAssetCatalogCacheForTests();
});

describe("ReplayBundle web adapter", () => {
  it("loads the frozen top-level real bundle shape and adapts events into timeline.match_events", () => {
    const view = adaptReplayBundle(realPayload());

    expect(view.status).toBe("LOADED");
    expect(view.source_kind).toBe("PARSED_DEMO");
    expect(view.bundle_id).toBe("bundle-real-test");
    expect(view.player_states).toHaveLength(1);
    expect(view.events).toHaveLength(1);
    expect(view.timeline.match_events).toEqual([event]);
    expect(view.review_plan).toBeUndefined();
  });

  it("keeps a missing bundle explicitly synthetic instead of presenting it as parsed Demo", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    const view = await loadReplayBundle();

    expect(view.status).toBe("MISSING");
    expect(view.source_kind).toBe("SYNTHETIC_FIXTURE");
    expect(view.timeline.source_kind).toBe("SYNTHETIC_FIXTURE");
    expect(view.detail).toContain(REPLAY_BUNDLE_URL);
    expect(view.detail).toContain("重新选择 Demo");
  });

  it("loads a generated upload bundle from an explicit localhost URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => realPayload()
      })
      .mockResolvedValueOnce({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    const view = await loadReplayBundle("/generated-data/uploads/job.replay.json");

    expect(view.status).toBe("LOADED");
    expect(fetchMock).toHaveBeenCalledWith("/generated-data/uploads/job.replay.json", { cache: "no-store" });
    expect(fetchMock).toHaveBeenCalledWith("/generated-assets/items/catalog.json", { cache: "no-store" });
  });

  it("attaches a versioned localhost item catalog when a bundle omits it", async () => {
    const catalog = {
      asset_version: "test-assets/1",
      maps: [],
      item_icons: [],
      generated_at: "2026-08-13T00:00:00.000Z",
      generation_manifest: { generator: "test", generator_version: "1" }
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => realPayload() })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => catalog }));

    const view = await loadReplayBundle();

    expect(view.asset_catalog?.asset_version).toBe("test-assets/1");
  });

  it("preserves an empty observable_states boundary without falling back to omniscient knowledge", () => {
    const view = adaptReplayBundle(realPayload([]));

    expect(view.observable_states).toEqual([]);
    expect(view.review_plan).toBeUndefined();
    expect(view.detail).toContain("ReviewPlan 尚未生成");
  });

  it("loads the generated grenade tracks through the Web ReplayBundle boundary", () => {
    const path = fileURLToPath(new URL("../public/generated-data/test_demo.replay.json", import.meta.url));
    const view = adaptReplayBundle(JSON.parse(readFileSync(path, "utf8")));

    expect(view.status).toBe("LOADED");
    expect(view.grenade_tracks.length).toBeGreaterThan(0);
    expect(view.grenade_tracks.every((track) => track.id && track.item_id && track.points?.length)).toBe(true);
  });
});
