/** Real-Demo smoke: offline by default; explicit live mode has a global five-request ceiling. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Cs2dReplay } from "../libs/cs2d-analysis-adapter/src/index.ts";

const DEADLINE_MS = 10 * 60 * 1000;
const HEAP_MIB = 1536;
const scriptPath = fileURLToPath(import.meta.url);
const workspace = realpathSync(resolve(dirname(scriptPath), ".."));
type Options = { demo: string; parserDir: string; out: string; live: boolean; keyStdin: boolean; maxCalls: number };
type PlayerSummary = {
  playerIndex: number; rounds: number; candidates: number; cues: number; segments: number;
  explicitSkips: number; bundleBytes: number; eligible: number; supportRate: number;
  rejectionReasons: Record<string, number>; buildMs: number;
  signalCounts: Record<string, number>; actionPatternCounts: Record<string, number>;
};

export function optionsFromArgs(args: string[]): Options {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key || values[key]) throw new Error("INVALID_ARGUMENTS");
    if (key === "--live" || key === "--key-stdin") { values[key] = "true"; continue; }
    const value = args[++i];
    if (!["--demo", "--parser-dir", "--out", "--max-calls"].includes(key) || !value || value.startsWith("--")) {
      throw new Error("INVALID_ARGUMENTS");
    }
    values[key] = value;
  }
  const live = values["--live"] === "true", keyStdin = values["--key-stdin"] === "true";
  const maxCalls = values["--max-calls"] === undefined ? live ? 5 : 0 : Number(values["--max-calls"]);
  if (live !== keyStdin || !Number.isInteger(maxCalls) || live && (maxCalls < 1 || maxCalls > 5) || !live && maxCalls !== 0) throw new Error("INVALID_LIVE_MODE_OR_BUDGET");
  if (!values["--demo"] || !values["--parser-dir"]) throw new Error("INPUT_PATHS_REQUIRED");
  const out = resolve(values["--out"] ?? resolve(workspace, "docs/validation/JEV_REAL_SMOKE.json"));
  const insideWorkspace = (path: string) => { const part = relative(workspace, path); return !!part && !part.startsWith("..") && !isAbsolute(part); };
  if (!insideWorkspace(out)) throw new Error("OUTPUT_MUST_BE_IN_TASK_WORKTREE");
  let existingParent = dirname(out);
  while (!existsSync(existingParent)) existingParent = dirname(existingParent);
  if (realpathSync(existingParent) !== workspace && !insideWorkspace(realpathSync(existingParent))) throw new Error("OUTPUT_PARENT_ESCAPES_WORKTREE");
  if (existsSync(out) && !insideWorkspace(realpathSync(out))) throw new Error("OUTPUT_ESCAPES_WORKTREE");
  return { demo: resolve(values["--demo"]), parserDir: resolve(values["--parser-dir"]), out, live, keyStdin, maxCalls };
}

async function runWorker(options: Options): Promise<void> {
  let stage = "IMPORT";
  let liveProbe: ReturnType<typeof import("./jev-real-live.ts")["createRealJevProbe"]> | undefined;
  const progress = (next: string) => { stage = next; process.send?.({ type: "stage", stage }); };
  try {
    const { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle } = await import("../libs/cs2d-analysis-adapter/src/index.ts");
    const { assertValidReviewPlan, buildDecisionAssessmentPacket, parseDecisionAssessmentPacket } = await import("../libs/review-planner/src/index.ts");
    const { DECISION_ASSESSMENT_VERSIONS } = await import("../libs/contracts/src/index.ts");
    const started = performance.now();
    if (options.live) {
      progress("READ_STDIN_KEY");
      const { createRealJevProbe, readJevKeyLine } = await import("./jev-real-live.ts");
      liveProbe = createRealJevProbe({ apiKey: await readJevKeyLine(process.stdin), maxCalls: options.maxCalls,
        onTelemetry: summary => process.send?.({ type: "live-progress", summary }) });
    }
    progress("PARSER_INIT");
    const parser = await import(pathToFileURL(resolve(options.parserDir, "demo_parser.js")).href);
    const wasm = readFileSync(resolve(options.parserDir, "demo_parser_bg.wasm"));
    const parserWasmSha256 = createHash("sha256").update(wasm).digest("hex");
    const parserJsSha256 = createHash("sha256").update(readFileSync(resolve(options.parserDir, "demo_parser.js"))).digest("hex");
    parser.initSync({ module: wasm });
    progress("PARSE_ONCE");
    let bytes: Buffer | undefined = readFileSync(options.demo);
    const inputBytes = bytes.length;
    const demoSha256 = createHash("sha256").update(bytes).digest("hex");
    const parseStarted = performance.now();
    const parsed = parser.parse_demo(bytes, 8);
    let replay: Cs2dReplay;
    try { replay = JSON.parse(parsed.replay) as Cs2dReplay; } finally { parsed.free(); }
    bytes = undefined;
    const parseMs = Math.round(performance.now() - parseStarted);
    assert.equal(replay.players.length, 10);
    assert(replay.rounds.length > 0);
    const players: PlayerSummary[] = [];
    const rejectionReasons: Record<string, number> = {};
    const signalCounts: Record<string, number> = {}, actionPatternCounts: Record<string, number> = {};
    let assertions = 2;
    for (const [index, player] of replay.players.entries()) {
      progress(`PLAYER_${index + 1}_OF_${replay.players.length}`);
      const playerStarted = performance.now();
      const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: player.steamId, demoId: `cs2d-${demoSha256}`, demoContentHash: demoSha256 });
      const plan = assertValidReviewPlan(bundle.match_timeline, bundle.review_plan);
      assert.equal(plan.status, "COMPLETE");
      const sorted = [...plan.segments].sort((a, b) => a.start_tick - b.start_tick);
      assert.equal(sorted[0]?.start_tick, bundle.match_timeline.start_tick);
      assert.equal(sorted.at(-1)?.end_tick, bundle.match_timeline.end_tick);
      for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i - 1]!.end_tick, sorted[i]!.start_tick);
      assert(sorted.filter(segment => segment.mode === "SKIP").every(segment => segment.expandable && segment.display_reason.length > 0));
      const wire = serializeCs2dAnalysisBundle(bundle);
      const restored = deserializeCs2dAnalysisBundle(wire);
      assertValidReviewPlan(restored.match_timeline, restored.review_plan);
      assert.equal(serializeCs2dAnalysisBundle(restored), wire);
      const bundleBytes = Buffer.byteLength(wire);
      assert(bundleBytes <= 16 * 1024 * 1024);
      assertions += 8 + Math.max(0, sorted.length - 1);
      const materialByCandidate = new Map(bundle.candidate_set.materials.map(material => [material.candidateId, material]));
      let eligible = 0;
      const playerRejections: Record<string, number> = {};
      const playerSignals: Record<string, number> = {}, playerPatterns: Record<string, number> = {};
      for (const candidate of bundle.candidate_set.candidates) {
        const signal = candidate.source.kind;
        playerSignals[signal] = (playerSignals[signal] ?? 0) + 1; signalCounts[signal] = (signalCounts[signal] ?? 0) + 1;
        const material = materialByCandidate.get(candidate.candidateId);
        assert(material); assertions++;
        for (const action of material.playerActionFacts) if (action.decisionAction) {
          const pattern = action.decisionAction.kind;
          playerPatterns[pattern] = (playerPatterns[pattern] ?? 0) + 1; actionPatternCounts[pattern] = (actionPatternCounts[pattern] ?? 0) + 1;
        }
        const result = buildDecisionAssessmentPacket(candidate, material, {
          mapName: replay.map, tickRate: bundle.match_timeline.tick_rate, playerId: player.steamId,
        });
        if (result.packet) {
          parseDecisionAssessmentPacket(JSON.parse(JSON.stringify(result.packet)));
          assert(result.binding); assert.equal(result.rejectionReasons.length, 0); assertions += 3;
          eligible++;
        } else {
          assert(result.rejectionReasons.length > 0); assertions++;
          for (const reason of result.rejectionReasons) {
            // Only bounded enum-like diagnostic codes can leave this process.
            assert(/^[A-Z][A-Z0-9_]{0,79}$/.test(reason)); assertions++;
            playerRejections[reason] = (playerRejections[reason] ?? 0) + 1;
            rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
          }
        }
      }
      if (liveProbe) { progress(`LIVE_PLAYER_${index + 1}_OF_${replay.players.length}`); await liveProbe.prepare(bundle); }
      const candidates = bundle.candidate_set.candidates.length;
      players.push({ playerIndex: index + 1, rounds: bundle.match_timeline.rounds.length, candidates,
        cues: plan.cues.length, segments: plan.segments.length, explicitSkips: plan.segments.filter(s => s.mode === "SKIP").length,
        bundleBytes, eligible, supportRate: candidates ? eligible / candidates : 0,
        rejectionReasons: playerRejections, signalCounts: playerSignals, actionPatternCounts: playerPatterns,
        buildMs: Math.round(performance.now() - playerStarted) });
    }
    const candidates = players.reduce((sum, player) => sum + player.candidates, 0);
    const eligible = players.reduce((sum, player) => sum + player.eligible, 0);
    process.send?.({ type: "result", report: {
      schemaVersion: "jev-real-smoke.v1", status: "PASS", generatedAt: new Date().toISOString(),
      source: "CANONICAL_DEMO", demoSha256, inputBytes, map: replay.map,
      parserWasmSha256, parserJsSha256, samplingHz: 8, parseInvocations: 1, parseMs,
      elapsedMs: Math.round(performance.now() - started), heapLimitMiB: HEAP_MIB,
      peakRssBytes: process.resourceUsage().maxRSS * 1024, deadlineMs: DEADLINE_MS,
      decisionAssessmentVersions: DECISION_ASSESSMENT_VERSIONS,
      players: players.length, rounds: replay.rounds.length, playerRoundObservations: players.reduce((sum, p) => sum + p.rounds, 0),
      candidates, eligible, rejected: candidates - eligible, supportRate: candidates ? eligible / candidates : 0,
      rejectionReasons, signalCounts, actionPatternCounts, playerSummaries: players, assertions,
      fullTimelineCoverage: "PASS", explicitSkipReasons: "PASS", serializationRoundTrip: "PASS",
      remoteModelCalls: liveProbe?.summary().remoteCalls ?? 0,
      execution: options.live ? "LIVE_JEV_WITH_DETERMINISTIC_DIRECTOR_NARRATOR" : "OFFLINE",
      live: liveProbe?.summary() ?? null, modelQuality: "NOT_EXPERT_EVALUATED", expertLabels: 0,
      limitations: ["SINGLE_DEMO_TEN_CORRELATED_PLAYER_PERSPECTIVES", "EIGHT_HZ_STATE_SAMPLING_NOT_EXACT_PER_TICK_STATE",
        ...(options.live ? ["AT_MOST_FIVE_CALLS_NOT_RELIABLE_TAIL_OR_QUALITY_ESTIMATE", "DETERMINISTIC_DIRECTOR_AND_NARRATOR"] : ["NO_REMOTE_MODEL_CALLS"]),
        "NO_EXPERT_LABELS", "STRUCTURAL_COVERAGE_NOT_TACTICAL_ACCURACY",
        ...(eligible === 0 ? ["NO_ELIGIBLE_PACKET_ON_THIS_REAL_DEMO"] : [])],
    } });
    process.disconnect?.();
  } catch {
    // Never emit arbitrary parser errors, paths, identities, Replay or free text.
    process.send?.({ type: "failure", stage, code: "REAL_SMOKE_STAGE_FAILED", live: liveProbe?.summary() ?? null });
    process.exitCode = 1;
    process.disconnect?.();
  } finally { liveProbe?.dispose(); }
}

async function runController(options: Options): Promise<void> {
  const child = fork(scriptPath, ["--worker", "--demo", options.demo, "--parser-dir", options.parserDir, "--out", options.out,
    ...(options.live ? ["--live", "--key-stdin", "--max-calls", String(options.maxCalls)] : [])], {
    cwd: workspace, execArgv: [`--max-old-space-size=${HEAP_MIB}`, "--import", "tsx"],
    stdio: [options.live ? "inherit" : "ignore", "ignore", "ignore", "ipc"],
  });
  let report: Record<string, unknown> | undefined;
  let failure: { stage: string; code: string } | undefined;
  let stage = "START";
  let live: Record<string, unknown> | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  };
  const deadline = setTimeout(() => { failure = { stage, code: "DEADLINE_EXCEEDED" }; terminate(); }, DEADLINE_MS);
  const interrupt = () => { failure = { stage, code: "INTERRUPTED" }; terminate(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  child.on("message", (message: { type?: string; stage?: string; code?: string; report?: Record<string, unknown>; summary?: Record<string, unknown>; live?: Record<string, unknown> }) => {
    if (message.type === "stage" && typeof message.stage === "string" && /^[A-Z0-9_]{1,80}$/.test(message.stage)) {
      stage = message.stage;
      console.error(JSON.stringify({ stage }));
    } else if (message.type === "result" && message.report?.schemaVersion === "jev-real-smoke.v1") {
      report = message.report;
    } else if (message.type === "live-progress") live = message.summary;
    else if (message.type === "failure") { live = message.live ?? live; failure = { stage, code: "REAL_SMOKE_STAGE_FAILED" }; }
  });
  const code = await new Promise<number | null>((done) => {
    child.once("exit", done);
    child.once("error", () => { failure = { stage, code: "CHILD_START_FAILED" }; done(1); });
  });
  clearTimeout(deadline); if (killTimer) clearTimeout(killTimer);
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  if (failure || code !== 0 || !report) {
    report = { schemaVersion: "jev-real-smoke.v1", status: "FAIL", source: "CANONICAL_DEMO",
      remoteModelCalls: live?.remoteCalls ?? 0, live: live ?? null, ...(failure ?? { stage, code: "CHILD_EXIT_WITHOUT_REPORT" }) };
    process.exitCode = 1;
  }
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
if (process.argv.includes("--help")) {
  console.log("Usage: pnpm exec tsx tools/verify-jev-real-smoke.ts --demo <read-only .dem> --parser-dir <WASM parser directory> [--out <task-worktree JSON>] [--live --key-stdin --max-calls <1..5>]\nOffline by default. Live key is read as one stdin line by the child; arrange no-echo input externally. One parse, 1536 MiB heap, 10 minute deadline; live calls globally deduplicated and capped at five.");
} else {
  try {
    const worker = process.argv[2] === "--worker";
    const options = optionsFromArgs(process.argv.slice(worker ? 3 : 2));
    if (worker) await runWorker(options); else await runController(options);
  } catch {
    console.error(JSON.stringify({ status: "FAIL", code: "INVALID_ARGUMENTS_OR_OUTPUT_PATH" }));
    process.exitCode = 1;
  }
}
}
