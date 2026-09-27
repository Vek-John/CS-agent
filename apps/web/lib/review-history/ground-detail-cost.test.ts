import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import type { GroundSampleEvidence } from "@cs-coach/contracts";
import type { Cs2dReplay } from "@cs-coach/cs2d-analysis-adapter";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { cleanupRestoredHistoryFixture, withReopenedTeachingHistory, type TeachingHistoryRestoreMeasurement } from "./teaching-history-restore-fixture";

const mode = process.env.CS_AGENT_GROUND_DETAIL_COST;
const enabled = mode === "smoke" || mode === "bounded";
const frameCount = mode === "bounded" ? 10_000 : 88;
function replay(withGround: boolean): Cs2dReplay {
  const original = fireReplay("DEATH", []), base = original.rounds[0], player = base.frames[0].players[0];
  const death = base.startTick + (frameCount - 2) * 8;
  const ids = Array.from({ length: 10 }, (_, i) => i === 0 ? self : `synthetic-other-${i}`);
  return { ...original,
    players: ids.map((steamId, i) => ({ steamId, name: "Synthetic", startSide: i < 5 ? "T" : "CT" })),
    rounds: [{ ...base, decidedTick: death + 32, endTick: death + 80, postEndTick: death + 96,
      frames: Array.from({ length: frameCount }, (_, i) => {
        const tick = base.startTick + i * 8;
        return { tick, t: i / 8, players: ids.map((steamId, index) => {
          const alive = index !== 0 || tick < death;
          const value: GroundSampleEvidence["value"] = !alive || i % 20 === 0 ? null : i % 5 === 0 ? "FLAG_UNSET" : "FLAG_SET";
          return { ...player, steamId, side: index < 5 ? "T" : "CT", alive, health: alive ? 40 : 0,
            ...(withGround ? { groundEvidence: { version: 1, source: "SOURCE2_PAWN_FLAGS", phase: "TICK_START", sampledAtTick: tick, playerId: steamId, value } satisfies GroundSampleEvidence } : {}) };
        }) };
      }),
      events: [{ ...base.events[0], tick: death, t: (death - base.startTick) / 64 }],
    }],
  };
}

it.skipIf(!enabled)("measures one bounded paired SQLite/detail/control-plane restoration", async () => {
  const results: Array<TeachingHistoryRestoreMeasurement & { withGround: boolean; aliveSamples: number; set: number; unset: number; unknown: number; cueCount: number }> = [];
  for (const withGround of [false, true]) {
    let counts = { aliveSamples: 0, set: 0, unset: 0, unknown: 0, cueCount: 0 };
    try {
      await withReopenedTeachingHistory({ replay: replay(withGround),
        verify: ({ normalized, recovered }) => {
          const states = normalized.match_timeline.player_state_tracks ?? [];
          expect(states).toHaveLength(frameCount);
          expect(recovered.plan.cues.length).toBeGreaterThan(0);
          counts = { aliveSamples: states.filter(s => s.alive).length,
            set: states.filter(s => s.ground_evidence?.value === "FLAG_SET").length,
            unset: states.filter(s => s.ground_evidence?.value === "FLAG_UNSET").length,
            unknown: states.filter(s => s.ground_evidence?.value === null).length,
            cueCount: recovered.plan.cues.length };
          expect(counts.aliveSamples).toBe(frameCount - 2);
          if (withGround) expect(counts.set + counts.unset + counts.unknown).toBe(frameCount);
        },
        onMeasurement: measured => {
          expect(measured.groundSampleCount).toBe(withGround ? frameCount : 0);
          results.push({ ...measured, ...counts, withGround });
        },
      });
    } finally { cleanupRestoredHistoryFixture(); }
  }
  const summary = { kind: "SYNTHETIC_GROUND_DETAIL_COST", mode, inputFrames: frameCount, playersPerFrame: 10, results,
    delta: { analysisBytes: results[1].analysisBytes - results[0].analysisBytes, detailBytes: results[1].detailBytes - results[0].detailBytes,
      openToReadyMs: results[1].openToReadyMs - results[0].openToReadyMs },
    limitations: ["Single ordered pair: no SLA, confidence interval or real Demo performance claim.", "One synthetic round and few cues; selected-player tracks only are persisted.", "Controller open includes GET response construction and response.json; open-to-ready includes Controller open and recovery preparation. Do not sum inclusive timings.", "Detail bytes are parsed DTO re-encoded as compact UTF8 JSON; no HTTP headers/compression/network transfer measured.", "Size calculation, Fixture verification, final artifact equality checks and cleanup are outside open-to-ready timing.", "Control-plane recovery only; Viewer cold parse/hydrate not measured.", "--max-old-space-size=2048 is per V8 process old-space, not total RSS or a 2 GiB cap over the process tree."] };
  const directory = resolve(".local-data/ground-detail-cost-smoke"); await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${mode}.json`), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
}, 110_000);
