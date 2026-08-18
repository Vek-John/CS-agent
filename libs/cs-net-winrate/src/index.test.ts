import { describe, expect, it } from "vitest";
import {
  buildCsNetFeatureBatch,
  buildCsNetFeatureBatches,
  buildWinProbabilityTimeline,
  classifyEconomy,
  CS_NET_FEATURE_VERSION,
  CS_NET_SOURCE,
  outcomeImpactText,
  unavailableWinProbabilityTimeline,
  type CsNetReplay,
} from "./index";

function replayFixture(): CsNetReplay {
  const players = Array.from({ length: 10 }, (_, index) => ({
    steamId: `p-${index}`,
    startSide: index < 5 ? "CT" as const : "T" as const,
  }));
  const frame = (tick: number, t: number) => ({
    tick,
    t,
    players: players.map((player, index) => ({
      ...player,
      side: player.startSide,
      x: -600 + index * 25 + tick / 10,
      y: -850 + index * 10,
      z: -170,
      yaw: index * 15,
      health: index === 5 && tick > 100 ? 0 : 100,
      alive: !(index === 5 && tick > 100),
      weapon: index < 5 ? "M4A4" : "AK-47",
      primary: index < 5 ? "M4A4" : "AK-47",
      money: 3_000,
      equipValue: 4_500,
      armor: 100,
      helmet: true,
      grenades: ["Smoke"],
    })),
  });
  return {
    map: "de_mirage",
    demoTickRate: 64,
    frameRate: 8,
    players,
    rounds: [{
      number: 1,
      freezeStartTick: 0,
      startTick: 64,
      decidedTick: 320,
      endTick: 384,
      postEndTick: 448,
      winner: "CT",
      scoreCt: 0,
      scoreT: 0,
      frames: [frame(64, 1), frame(128, 2), frame(192, 3)],
      events: [{ type: "kill", tick: 192, t: 3, attackerSteamId: "p-0", victimSteamId: "p-5", x: 0, y: 0, z: 0 }],
    }],
  };
}

describe("cs-net win-rate contract", () => {
  it("builds the pinned 31-token feature layout from structured Replay", () => {
    const batch = buildCsNetFeatureBatch(replayFixture());
    expect(batch.samples).toHaveLength(3);
    expect(batch.inputs.mlp1_f).toHaveLength(3);
    expect(batch.inputs.mlp1_f[0]).toHaveLength(31);
    expect(batch.inputs.mlp2_f[0][0]).toHaveLength(14);
    expect(batch.inputs.mlp5_f[0][0]).toHaveLength(9);
    expect(batch.inputs.mlp5_f[0][0][0]).toHaveLength(13);
    expect(batch.inputs.pad_mask[0][11]).toBe(true);
    expect(batch.samples[0].sideOrder.slice(0, 5)).toEqual(["p-0", "p-1", "p-2", "p-3", "p-4"]);
  });

  it("streams the same canonical sample and feature order at every batch size", () => {
    const replay = replayFixture();
    const full = buildCsNetFeatureBatch(replay);
    const chunks = [...buildCsNetFeatureBatches(replay, 2)];
    expect(chunks.flatMap((chunk) => chunk.samples)).toEqual(full.samples);
    expect(chunks.flatMap((chunk) => chunk.inputs.mlp1_f)).toEqual(full.inputs.mlp1_f);
    expect(chunks.flatMap((chunk) => chunk.inputs.dead_mask)).toEqual(full.inputs.dead_mask);
  });

  it("keeps both team economy classes independent and model metadata fixed", () => {
    const replay = replayFixture();
    const players = replay.rounds[0].frames[0].players;
    expect(classifyEconomy(players, "CT").kind).toBe("FULL");
    expect(classifyEconomy(players, "T").kind).toBe("FULL");
    expect(CS_NET_SOURCE.temperature).toBe(1.0613423585891724);
    expect(CS_NET_FEATURE_VERSION).toBe("cs-net-space-only-features/1.0.0");
  });

  it("classifies pistol, eco, force and full buys without coupling the two sides", () => {
    const base = replayFixture().rounds[0].frames[0].players;
    const team = (equipValue: number, money: number, primary?: string) => base.slice(0, 5).map((player) => ({
      ...player,
      equipValue,
      money,
      primary,
      weapon: primary ?? "Glock-18"
    }));
    expect(classifyEconomy(team(1_000, 1_000), "CT").kind).toBe("PISTOL");
    expect(classifyEconomy(team(2_000, 2_000), "CT").kind).toBe("ECO");
    expect(classifyEconomy(team(2_500, 2_500), "CT").kind).toBe("FORCE");
    expect(classifyEconomy(team(4_000, 4_000, "AK-47"), "CT").kind).toBe("FULL");
    expect(classifyEconomy([], "CT").kind).toBe("UNKNOWN");
    expect(classifyEconomy(team(1_000, 1_000), "T").kind).toBe("UNKNOWN");
  });

  it("creates an all-match curve with a canonical terminal point and swing", () => {
    const replay = replayFixture();
    const batch = buildCsNetFeatureBatch(replay);
    const timeline = buildWinProbabilityTimeline({ replay, samples: batch.samples, logits: [-0.4, -0.2, 0.8], selectedPlayerId: "p-5" });
    expect(timeline.status).toBe("AVAILABLE");
    expect(timeline.rounds[0].samples).toHaveLength(3);
    expect(timeline.rounds[0].terminal).toMatchObject({ tick: 448, probability: 1, winner: "CT" });
    expect(timeline.swings.some((swing) => swing.direction === "UP")).toBe(true);
    expect(timeline.swings.some((swing) => swing.selectedPlayerDeath && swing.victimSide === "T")).toBe(true);
    expect(timeline.swings.find((swing) => swing.selectedPlayerDeath)?.economy).toBe("FULL");
    expect(timeline.limitations.join(" ")).toContain("ObservableClaim");
  });

  it("makes model failure explicit without blocking the replay fallback", () => {
    const timeline = unavailableWinProbabilityTimeline("WASM unavailable");
    expect(timeline.status).toBe("UNAVAILABLE");
    expect(timeline.unavailableReason).toBe("WASM unavailable");
    expect(outcomeImpactText(0.62, 0.31)).toContain("31");
  });
});
