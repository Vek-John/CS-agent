import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMirageManifest } from "@cs-coach/map-semantics";
import { adaptReplayBundle } from "../replay-bundle";
import {
  toGroundTruthReplaySource,
  toKnowledgeFrameInput,
  toObservationBoundaryInput
} from "./ground-truth-adapter";
import { buildKnowledgeFrame, buildOmniscientFrame } from "./playback-frame";

const manifest = loadMirageManifest({ raster_ref: "/generated-assets/maps/de_mirage.png" });
const smallBundle = fileURLToPath(new URL("../../public/generated-data/test_demo.replay.json", import.meta.url));
const largeBundle = fileURLToPath(new URL(
  "../../public/generated-data/uploads/4dedab6e-2645-4089-bfe6-a6858c68d344.replay.json",
  import.meta.url
));

interface BenchmarkResult {
  label: string;
  bytes: number;
  rounds: number;
  actors: number;
  projectile_tracks: number;
  frames: number;
  json_and_adapter_ms: number;
  frame_total_ms: number;
  frame_average_ms: number;
  frame_p95_ms: number;
  builder_fps_at_p95: number;
  heap_delta_mb: number;
}

function percentile(values: readonly number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] ?? 0;
}

function benchmark(path: string, label: string): BenchmarkResult {
  const heapBefore = process.memoryUsage().heapUsed;
  const parseStart = performance.now();
  const view = adaptReplayBundle(JSON.parse(readFileSync(path, "utf8")));
  const source = toGroundTruthReplaySource(view);
  const observation = toObservationBoundaryInput(view);
  const parseEnd = performance.now();
  const round = source.rounds[0];
  if (!round) throw new Error(`${label} has no complete round`);
  const step = Math.max(1, Math.ceil((round.end_tick - round.start_tick) / 600));
  const timings: number[] = [];
  let frames = 0;
  for (let tick = round.start_tick; tick < round.end_tick; tick += step) {
    const started = performance.now();
    const frame = buildOmniscientFrame(source, tick, manifest);
    timings.push(performance.now() - started);
    expect(frame.tick).toBe(tick);
    expect(frame.actors.length).toBeLessThanOrEqual(source.players.length);
    frames += 1;
  }
  for (const observableState of view.observable_states.slice(0, 20)) {
    const frame = buildKnowledgeFrame(
      toKnowledgeFrameInput(source, observableState.at_tick, observation, manifest),
      manifest
    );
    expect(frame.perspective).toBe("PLAYER_KNOWLEDGE");
    expect(frame.round).not.toHaveProperty("winner");
    expect(frame.round).not.toHaveProperty("score_after");
    expect(frame.actors.every((actor) => actor.source !== "GROUND_TRUTH")).toBe(true);
  }
  const frameTotal = timings.reduce((sum, value) => sum + value, 0);
  const p95 = percentile(timings, 0.95);
  return {
    label,
    bytes: statSync(path).size,
    rounds: source.rounds.length,
    actors: source.players.length,
    projectile_tracks: source.projectile_tracks.length,
    frames,
    json_and_adapter_ms: Number((parseEnd - parseStart).toFixed(3)),
    frame_total_ms: Number(frameTotal.toFixed(3)),
    frame_average_ms: Number((frameTotal / frames).toFixed(3)),
    frame_p95_ms: Number(p95.toFixed(3)),
    builder_fps_at_p95: Number((1000 / Math.max(0.001, p95)).toFixed(1)),
    heap_delta_mb: Number(((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(1))
  };
}

describe("Pixi frame PoC real ReplayBundle integration", () => {
  it("walks one complete test_demo round through the unified frame contract", () => {
    const result = benchmark(smallBundle, "test_demo");
    console.info(`[pixi-poc-benchmark] ${JSON.stringify(result)}`);
    expect(result.frames).toBeGreaterThanOrEqual(500);
    expect(result.frame_p95_ms).toBeLessThan(16.7);
  });

  const runLarge = process.env.CS2_RUN_LARGE_DEMO_TESTS === "1" && existsSync(largeBundle);
  it.runIf(runLarge)("walks one complete Falcons vs Spirit round", () => {
    const result = benchmark(largeBundle, "falcons_vs_spirit");
    console.info(`[pixi-poc-benchmark] ${JSON.stringify(result)}`);
    expect(result.rounds).toBe(21);
    expect(result.actors).toBe(10);
    expect(result.frame_p95_ms).toBeLessThan(16.7);
  });
});
