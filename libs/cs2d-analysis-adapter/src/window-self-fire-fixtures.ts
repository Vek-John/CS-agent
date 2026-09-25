import { buildCs2dAnalysisBundle, type Cs2dReplay, type Cs2dRound, type Cs2dShotEvent } from "./index";
// Synthetic event fixture. Integer times here are not measured Demo ticks.
export const self = "synthetic-self";
export const shot = (tick: number, actor: string | null | undefined = self): Cs2dShotEvent => ({ type: "shot", tick, t: 0, shooterSteamId: actor, x: 0, y: 0, yaw: 0 });
export function fireReplay(kind: "DEATH" | "HP_CHANGE", shots: readonly Cs2dShotEvent[] = [shot(1404)]): Cs2dReplay {
  const round: Cs2dRound = {
    number: 1, freezeStartTick: 1000, startTick: 1064, decidedTick: 1700, endTick: 1760, postEndTick: 1800, winner: "CT", scoreT: 0, scoreCt: 0,
    frames: Array.from({ length: 88 }, (_, i) => ({ tick: 1064 + i * 8, t: 0, players: [{ steamId: self, side: "T", alive: kind !== "DEATH" || 1064 + i * 8 < 1408, health: 1064 + i * 8 < 1408 ? 40 : kind === "DEATH" ? 0 : 10, armor: 100, helmet: true, weapon: "ak47", grenades: [], money: 1000, equipValue: 3000, x: 0, y: 0, z: 0, yaw: 0 }] })),
    events: [...shots, ...(kind === "DEATH" ? [{ type: "kill" as const, tick: 1408, t: 0, attackerSteamId: "other", victimSteamId: self, assisterSteamId: null, assistedFlash: false, weapon: "ak47", headshot: false, x: 0, y: 0, z: 0 }] : [])], grenadePaths: [],
  };
  return { map: "de_mirage", demoTickRate: 64, frameRate: 8, generatedBy: "synthetic-shot-identity", players: [{ steamId: self, name: "Synthetic", startSide: "T" }], rounds: [round] };
}
export const analyzeFire = (replay: Cs2dReplay) => buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-window-fire" });
