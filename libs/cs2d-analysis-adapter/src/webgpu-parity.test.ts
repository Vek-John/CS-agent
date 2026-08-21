import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Cs2dReplay } from "./index";
import { buildCs2dAnalysisBundle } from "./index";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "@cs-coach/session";
import type { WinProbabilityTimelineV1 } from "@cs-coach/contracts";

const ROOT = process.cwd();
const benchmarkPath = `${ROOT}/.local-data/acceptance-csnet-webgpu-fp16/adapter-only-batch16-three-run-v2/edge-webgpu-benchmark.json`;
const cpuParityPath = `${ROOT}/.local-data/acceptance-csnet-webgpu-fp16/fp16-cpu-parity.json`;

function replayFixture(): Cs2dReplay {
  const players = Array.from({ length: 10 }, (_, index) => ({
    steamId: index < 5 ? `p-t${index + 1}` : `p-ct${index - 4}`,
    name: `Player ${index + 1}`,
    startSide: index < 5 ? "T" as const : "CT" as const,
  }));
  const frame = (tick: number, selectedHealth: number) => ({
    tick,
    t: tick / 64,
    players: players.map((player, index) => ({
      steamId: player.steamId,
      x: 100 + tick / 10 + index,
      y: 200 + index,
      z: 64,
      yaw: 90,
      health: index === 0 ? selectedHealth : 100,
      alive: index !== 0 || selectedHealth > 0,
      side: player.startSide,
      weapon: "AK-47",
      lastPlaceName: "Connector",
      primary: "AK-47",
      money: 3200,
      equipValue: 4500,
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
    rounds: [
      {
        number: 1,
        freezeStartTick: 0,
        startTick: 64,
        decidedTick: 640,
        endTick: 700,
        postEndTick: 760,
        winner: "T",
        scoreCt: 0,
        scoreT: 0,
        damage: { "p-t1": 30 },
        frames: [64, 160, 256, 352, 448, 544].map((tick) => frame(tick, tick === 256 || tick === 352 ? 70 : 100)),
        events: [
          { type: "kill", tick: 224, t: 3.5, attackerSteamId: "p-t1", victimSteamId: "p-ct1", assisterSteamId: null, assistedFlash: false, weapon: "AK-47", headshot: false, x: 500, y: 300, z: 64 },
          { type: "bomb_planted", tick: 480, t: 7.5, playerSteamId: "p-t1" },
        ],
        grenadePaths: [],
      },
      {
        number: 2,
        freezeStartTick: 800,
        startTick: 864,
        decidedTick: 1500,
        endTick: 1560,
        postEndTick: 1620,
        winner: "CT",
        scoreCt: 0,
        scoreT: 1,
        frames: [864, 960, 1056, 1152].map((tick) => frame(tick, tick >= 1056 ? 60 : 100)),
        events: [
          { type: "kill", tick: 1024, t: 3.5, attackerSteamId: "p-ct1", victimSteamId: "p-t1", assisterSteamId: null, assistedFlash: false, weapon: "AWP", headshot: false, x: 700, y: 400, z: 64 },
        ],
        grenadePaths: [],
      },
    ],
  } as unknown as Cs2dReplay;
}

function loadSavedTimeline(): WinProbabilityTimelineV1 {
  const benchmark = JSON.parse(readFileSync(benchmarkPath, "utf8"));
  return benchmark.matrix[0].cold.timeline as WinProbabilityTimelineV1;
}

function signature(bundle: ReturnType<typeof buildCs2dAnalysisBundle>) {
  return {
    cueIds: bundle.review_plan.cues.map((cue) => ({
      id: cue.id,
      type: cue.cue_type,
      segmentId: cue.segment_id,
      decisionTick: cue.decision_tick,
      outcomeStartTick: cue.outcome_start_tick,
      revealTick: cue.reveal_tick,
      outcomeEndTick: cue.outcome_end_tick,
    })),
    segments: bundle.review_plan.segments.map((segment) => ({
      id: segment.id,
      mode: segment.mode,
      startTick: segment.start_tick,
      endTick: segment.end_tick,
      cueIds: segment.cue_ids,
    })),
    impacts: bundle.outcome_impacts.map((impact) => ({
      cueId: impact.cueId,
      beforeProbability: impact.beforeProbability,
      afterProbability: impact.afterProbability,
      delta: impact.delta,
      percentagePoints: impact.percentagePoints,
      relativeChange: impact.relativeChange,
      attribution: impact.attribution,
      confidence: impact.confidence,
    })),
  };
}

function sessionSignature(plan: ReturnType<typeof buildCs2dAnalysisBundle>["review_plan"]) {
  let state = createCoachingSession(plan);
  const transitions = [] as Array<{ cueId?: string; phase: string; tick: number; revealed: readonly string[] }>;
  for (const cue of plan.cues) {
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.decision_tick });
    state = reduceCoachingSession(plan, state, { type: "TICK", tick: cue.outcome_end_tick });
    transitions.push({ cueId: getCurrentCue(plan, state)?.id, phase: state.phase, tick: state.current_tick, revealed: state.revealed_cue_ids });
  }
  return { segmentModes: plan.segments.map((segment) => segment.mode), transitions };
}

const savedArtifactsAvailable = existsSync(benchmarkPath) && existsSync(cpuParityPath);

describe.skipIf(!savedArtifactsAvailable)("saved WebGPU timeline deterministic Director parity", () => {
  it("keeps cue ranges, teaching modes, OutcomeImpact and Session transitions stable", () => {
    const replay = replayFixture();
    const timeline = loadSavedTimeline();
    const first = buildCs2dAnalysisBundle({ replay, selectedSteamId: "p-t1", demoId: "webgpu-parity", winProbabilityTimeline: timeline });
    const second = buildCs2dAnalysisBundle({ replay, selectedSteamId: "p-t1", demoId: "webgpu-parity", winProbabilityTimeline: timeline });
    const firstSignature = { plan: signature(first), session: sessionSignature(first.review_plan) };
    const secondSignature = { plan: signature(second), session: sessionSignature(second.review_plan) };
    expect(secondSignature).toEqual(firstSignature);
    const cpuParity = JSON.parse(readFileSync(cpuParityPath, "utf8"));
    const output = {
      source: {
        webgpuTimeline: benchmarkPath,
        fp16CpuParity: cpuParityPath,
        adapter: "@cs-coach/cs2d-analysis-adapter",
        session: "@cs-coach/session",
      },
      webgpuTimeline: {
        sampleCount: timeline.rounds.reduce((sum, round) => sum + round.samples.length, 0),
        tickOrder: timeline.rounds.flatMap((round) => round.samples.map((sample) => sample.tick)),
        swingCount: timeline.swings.length,
        swingDirections: timeline.swings.map((swing) => [swing.tick, swing.direction]),
      },
      fp16CpuParity: cpuParity.fp16_cpu_vs_fp32,
      director: firstSignature,
      deterministic: true,
    };
    writeFileSync(`${ROOT}/.local-data/acceptance-csnet-webgpu-fp16/adapter-only-director-outcome-parity.json`, `${JSON.stringify(output, null, 2)}\n`);
    expect(first.review_plan.cues.every((cue) => cue.decision_tick < cue.reveal_tick && cue.reveal_tick <= cue.outcome_end_tick)).toBe(true);
    expect(first.review_plan.segments.every((segment) => ["SKIP", "BRIEF", "DEEP_DIVE", "HABIT_CHECK"].includes(segment.mode))).toBe(true);
  });
});
