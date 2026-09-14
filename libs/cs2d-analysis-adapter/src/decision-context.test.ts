import { describe, expect, it } from "vitest";
import { MAX_DECISION_SNAPSHOT_BYTES } from "@cs-coach/contracts";
import type { ObservableState } from "@cs-coach/contracts";
import { assertDecisionSnapshot, buildDecisionSnapshot, buildObservableDecisionContext } from "./decision-context";
import type { Cs2dRound, Cs2dPlayerState } from "./index";

function player(index: number): Cs2dPlayerState {
  return { steamId: `p${index}`, side: index < 5 ? "T" : "CT", alive: index === 0 || index >= 5, health: index === 0 ? 2 : index < 5 ? 0 : 100, armor: 20, x: index * 100, y: 200, z: 0, yaw: 0, weapon: "ak47", grenades: [], money: 200, equipValue: 2700, helmet: false };
}
function round(players = Array.from({ length: 10 }, (_, index) => player(index))): Cs2dRound {
  return { number: 16, freezeStartTick: 0, startTick: 64, decidedTick: 800, endTick: 880, postEndTick: 960, scoreT: 8, scoreCt: 7, winner: "CT", frames: [{ tick: 128, t: 2, players }], events: [], grenadePaths: [] };
}
function snapshot(current = round(), decisionTick = 128) {
  return buildDecisionSnapshot({ round: current, selectedPlayerId: "p0", decisionTick, tickRate: 64, snapshotId: "snapshot-event-1", rosterIds: Array.from({ length: 10 }, (_, i) => `p${i}`) });
}
const check = (current: ReturnType<typeof snapshot>, code: string) => [...current.supportChecks, ...current.pressureChecks, ...current.spatialChecks].find((item) => item.code === code);

describe("trusted compact decision snapshots", () => {
  it("uses all ten states only to report counts and veto support when all four allies are dead", () => {
    const value = snapshot();
    expect(value.selectedPlayer.value?.health).toBe(2);
    expect(value.aliveCounts.value).toEqual({ allies: 1, enemies: 5, includesSelectedPlayer: true });
    for (const code of ["teammateAlive", "higherHealthTeammate", "tradeWindow"]) expect(check(value, code)?.status).toBe("INAPPLICABLE");
    expect(JSON.stringify(value)).not.toMatch(/"(?:x|y|z|yaw|world_position|frames|tracks)"/);
    expect(value.players).toHaveLength(10);
  });
  it("does not approve trade or high-health contact merely because a teammate exists", () => {
    const players = Array.from({ length: 10 }, (_, i) => player(i));
    players[1] = { ...players[1], alive: true, health: 100 };
    const value = snapshot(round(players));
    expect(check(value, "teammateAlive")?.status).toBe("APPLICABLE");
    expect(check(value, "tradeWindow")?.status).toBe("UNVERIFIABLE");
    expect(check(value, "higherHealthTeammate")?.status).toBe("UNVERIFIABLE");
    expect(check(value, "objectiveAllowsDelay")?.status).toBe("UNVERIFIABLE");
  });
  it("takes the current per-player side after side switch", () => {
    const switched = Array.from({ length: 10 }, (_, i) => ({ ...player(i), side: i < 5 ? "CT" as const : "T" as const }));
    const value = snapshot(round(switched));
    expect(value.selectedPlayer.value?.side).toBe("CT");
    expect(value.aliveCounts.value).toMatchObject({ allies: 1, enemies: 5 });
    expect(check(value, "teammateAlive")?.status).toBe("INAPPLICABLE");
    expect(value.score.value).toEqual({ t: 8, ct: 7 });
  });
  it("ignores future frames, future bomb events and final round outcome in decision context", () => {
    const current = round();
    const changed = { ...current, decidedTick: 900, winner: "T" as const, frames: [...current.frames, { tick: 129, t: 2.01, players: Array.from({ length: 10 }, (_, i) => ({ ...player(i), alive: true, health: 100, x: 999_999 })) }], events: [{ type: "bomb_planted" as const, tick: 129, t: 2.01, playerSteamId: "p5" }] };
    expect(snapshot(changed)).toEqual(snapshot(current));
    expect(snapshot(changed).bomb.value?.state).toBe("UNKNOWN");
  });
  it("keeps missing inventory, armor, alive and current side explicitly unknown", () => {
    const players = Array.from({ length: 10 }, (_, i) => player(i));
    players[0] = { ...players[0], side: undefined, armor: undefined, alive: undefined, grenades: undefined, helmet: undefined } as unknown as Cs2dPlayerState;
    const value = snapshot(round(players));
    expect(value.selectedPlayer.value).toMatchObject({ side: null, armor: null, alive: null, grenades: null, helmet: null });
    expect(value.aliveCounts.value).toBeNull();
    expect(check(value, "flashAvailable")?.status).toBe("UNVERIFIABLE");
    expect(value.missingFields).toEqual(expect.arrayContaining(["current_side", "armor", "alive", "inventory", "damage_source", "enemy_visibility"]));
  });
  it("does not guess timers from match settings or eventual round duration", () => {
    const value = snapshot({ ...round(), events: [{ type: "bomb_planted", tick: 100, t: 1.5625, playerSteamId: "p5" }] });
    expect(value.clock.value).toEqual({ phase: "LIVE", elapsedSeconds: 1, remainingSeconds: null });
    expect(value.bomb).toMatchObject({ boundary: "OBSERVABLE", value: { state: "PLANTED", remainingSeconds: null } });
    expect(check(value, "objectiveAllowsDelay")?.status).toBe("UNVERIFIABLE");
  });
  it("uses rounded bomb keyframes conservatively and keeps a hidden carrier out of public knowledge", () => {
    expect(snapshot({ ...round(), bomb: [{ t: 2, state: "carried", carrierSteamId: "p5" }] }).bomb.value?.state).toBe("UNKNOWN");
    const value = snapshot({ ...round(), bomb: [{ t: 1, state: "carried", carrierSteamId: "p5" }] });
    expect(value.bomb.boundary).toBe("APPLICABILITY_ONLY");
    expect(value.bomb.value?.state).toBe("CARRIED");
    expect(JSON.stringify(value.bomb)).not.toContain("p5");
  });
  it("marks stale or incomplete rosters unknown instead of declaring no teammates", () => {
    const stale = snapshot(round(), 192);
    expect(stale.selectedPlayer.value).toBeNull();
    expect(stale.aliveCounts.value).toBeNull();
    expect(check(stale, "teammateAlive")?.status).toBe("UNVERIFIABLE");
    const sparse = snapshot(round([player(0)]));
    expect(sparse.aliveCounts.value).toBeNull();
    expect(check(sparse, "tradeWindow")?.status).toBe("UNVERIFIABLE");
  });
  it("filters future and expired observer claims without introducing any enemy world positions", () => {
    const current = snapshot();
    const state: ObservableState = { id: "obs", demo_id: "demo", timeline_version: "v", observer_player_id: "p0", at_tick: 128, observation_version: "v", limitations: [], claims: [
      { id: "future", claim_type: "PLAYER_POSITION", source_type: "DIRECT_VISION", knowledge_kind: "OBSERVED", subject_resolution: "EXACT_PLAYER", available_from_tick: 129, evidence_tick: 129, spatial_estimate: { type: "EXACT_POINT", point: { x: 999, y: 999, z: 0 } }, confidence: 1, sharing_scope: "SELF", evidence_refs: [], derived_by: "test", limitations: [] },
      { id: "expired", claim_type: "PLAYER_PRESENCE", source_type: "LAST_KNOWN", knowledge_kind: "OBSERVED", subject_resolution: "UNKNOWN_ACTOR", available_from_tick: 100, evidence_tick: 100, expires_at_tick: 128, spatial_estimate: { type: "NONE" }, confidence: 1, sharing_scope: "SELF", evidence_refs: [], derived_by: "test", limitations: [] }
    ] };
    const context = buildObservableDecisionContext(current, state);
    expect(context.state.claims).toEqual([]);
    expect(context.publicFacts.join(" ")).toContain("己方 1 人存活");
    expect(JSON.stringify(context)).not.toMatch(/999|p5/);
  });
  it("enforces snapshot byte, player, nested field and full-world approval limits", () => {
    const value = snapshot();
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(MAX_DECISION_SNAPSHOT_BYTES);
    expect(() => assertDecisionSnapshot({ ...value, limitations: ["长".repeat(MAX_DECISION_SNAPSHOT_BYTES)] })).toThrow(/16 KiB/);
    expect(() => assertDecisionSnapshot({ ...value, sampledAtTick: 129 })).toThrow(/future/);
    expect(() => assertDecisionSnapshot({ ...value, players: [...value.players, value.players[0]] })).toThrow(/boundary/);
    expect(() => assertDecisionSnapshot({ ...value, selectedPlayer: { ...value.selectedPlayer, value: { ...value.selectedPlayer.value!, enemies: [{ x: 999 }] } } } as unknown as typeof value)).toThrow(/undocumented/);
    expect(() => assertDecisionSnapshot({ ...value, supportChecks: [{ ...value.supportChecks[0], status: "APPLICABLE", boundary: "APPLICABILITY_ONLY" }] })).toThrow(/cannot approve/);
  });
});
