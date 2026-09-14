import type { DecisionSnapshot } from "@cs-coach/contracts";

/** Compact synthetic window with explicit provenance, used only by planner regression tests. */
export function decisionSnapshotFixture(decisionTick = 900, factRef = "fact-a"): DecisionSnapshot {
  return {
    version: "decision-snapshot.v1", snapshotId: `snapshot-${decisionTick}`, roundNumber: 1,
    selectedPlayerId: "p-user", decisionTick, sampledAtTick: decisionTick,
    selectedPlayer: { value: { side: "T", alive: true, health: 2, armor: 100, helmet: true, weapon: "ak47", grenades: ["flashbang"], money: 300, equipmentValue: 4000, hasDefuseKit: false, callout: null }, boundary: "OBSERVABLE", evidenceRefs: [factRef], limitations: [] },
    aliveCounts: { value: { allies: 1, enemies: 3, includesSelectedPlayer: true }, boundary: "OBSERVABLE", evidenceRefs: [factRef], limitations: [] },
    players: [], score: { value: { t: 1, ct: 2 }, boundary: "OBSERVABLE", evidenceRefs: [factRef], limitations: [] },
    clock: { value: { phase: "LIVE", elapsedSeconds: 50, remainingSeconds: 65 }, boundary: "OBSERVABLE", evidenceRefs: [factRef], limitations: [] },
    bomb: { value: { state: "CARRIED", carriedBySelectedPlayer: true, remainingSeconds: null }, boundary: "OBSERVABLE", evidenceRefs: [factRef], limitations: [] },
    supportChecks: [], pressureChecks: [], spatialChecks: [], missingFields: [], limitations: []
  };
}
