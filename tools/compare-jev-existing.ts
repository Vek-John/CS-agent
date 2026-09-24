/** Same-input comparison with historical Jev calls. Raw Replay lives only in one bounded child. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import type { Cs2dReplay } from "../libs/cs2d-analysis-adapter/src/index.ts";
import type { DecisionAssessmentPacket, DecisionAssessmentResult } from "../libs/contracts/src/index.ts";
import { DECISION_ASSESSMENT_VERSIONS as V } from "../libs/contracts/src/index.ts";
import { parseDecisionAssessmentPacket, ruleDecisionAssessment, validateDecisionAssessmentResult } from "../libs/review-planner/src/decision-assessment.ts";
import { buildJevHttpBody, compareWithGenerationModel, DEFAULT_DECISION_COMPARISON_MODEL } from "../apps/web/lib/coaching/jev-decision-assessment.ts";
import { optionsFromArgs as smokeOptions } from "./verify-jev-real-smoke.ts";

const script = fileURLToPath(import.meta.url), workspace = resolve(dirname(script), "..");
const DEADLINE_MS = 600_000, HEAP_MIB = 1536, TIMEOUT_MS = 3000;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Options = { demo: string; parserDir: string; out: string; jevReport: string; generationEnvFile?: string; live: boolean; maxCalls: number };
type Choices = { riskWarranted: string; alternativePreferable: string; contextSufficient: string };
type Usage = { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
type HistoricalRow = { bodySha256: string; stateSha256: string; projectionVersion: string; questionVersion: string; requestedModel: string;
  returnedModel: string; status: "SUCCEEDED"; choices: Choices; modelConfidence: number; latencyMs: number; usage: Usage };
type History = { generatedAt: string; demoSha256: string; parserWasmSha256: string; parserJsSha256: string; rows: HistoricalRow[] };
type Match = { bodySha256: string; packet: DecisionAssessmentPacket; baselineAssessmentKind: string };
const kinds = ["DECISION_ERROR", "EXECUTION_ISSUE", "POSITIVE_PROCESS", "FORCED_CHOICE", "INSUFFICIENT_EVIDENCE", "NO_TEACHING_VALUE"];
const safeCode = (value: unknown) => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : "UNSPECIFIED";
const numberOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const usage = (value: unknown): Usage => {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { inputTokens: numberOrNull(object.inputTokens), outputTokens: numberOrNull(object.outputTokens), costUsd: numberOrNull(object.costUsd) };
};
const choices = (result: DecisionAssessmentResult): Choices => ({ riskWarranted: result.riskWarranted.choice, alternativePreferable: result.alternativePreferable.choice, contextSufficient: result.contextSufficient.choice });

export function parseOptions(args: string[]): Options {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i]!.split(/=(.*)/s);
    if (values[name!]) throw new Error("INVALID_ARGUMENTS");
    if (name === "--live") { if (inline !== undefined) throw new Error("INVALID_ARGUMENTS"); values[name] = "true"; continue; }
    if (!["--demo", "--parser-dir", "--out", "--jev-report", "--generation-env-file", "--max-calls"].includes(name!)) throw new Error("INVALID_ARGUMENTS");
    const value = inline ?? args[++i];
    if (!value || value.startsWith("--")) throw new Error("INVALID_ARGUMENTS");
    values[name!] = value;
  }
  const base = smokeOptions(["--demo", values["--demo"] ?? "", "--parser-dir", values["--parser-dir"] ?? "", "--out", values["--out"] ?? resolve(workspace, "docs/validation/JEV_EXISTING_MODEL_COMPARISON.json")]);
  const live = values["--live"] === "true", maxCalls = Number(values["--max-calls"] ?? "5");
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 5 || live && !values["--generation-env-file"]) throw new Error("INVALID_LIVE_CONFIGURATION");
  return { demo: base.demo, parserDir: base.parserDir, out: base.out, live, maxCalls,
    jevReport: resolve(values["--jev-report"] ?? resolve(workspace, "docs/validation/JEV_RETURN_FIRE_LIVE.json")),
    ...(values["--generation-env-file"] ? { generationEnvFile: resolve(values["--generation-env-file"]) } : {}) };
}

export function parseHistory(input: unknown): History {
  assert(input && typeof input === "object");
  const value = input as Record<string, any>;
  assert.equal(value.schemaVersion, "jev-real-smoke.v1"); assert.equal(value.status, "PASS"); assert.equal(value.source, "CANONICAL_DEMO");
  assert.equal(value.execution, "LIVE_JEV_WITH_DETERMINISTIC_DIRECTOR_NARRATOR"); assert.equal(value.remoteModelCalls, 5);
  assert(typeof value.generatedAt === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(value.generatedAt));
  for (const name of ["demoSha256", "parserWasmSha256", "parserJsSha256"]) assert(typeof value[name] === "string" && /^[0-9a-f]{64}$/.test(value[name]));
  assert(Array.isArray(value.live?.requestRecords) && value.live.requestRecords.length === 5);
  const rows: HistoricalRow[] = value.live.requestRecords.map((row: Record<string, any>) => {
    assert.equal(row.requestedModel, V.model); assert.equal(row.returnedModel, V.model); assert.equal(row.status, "SUCCEEDED");
    assert.equal(row.whitelistPassed, true);
    for (const name of ["bodySha256", "stateSha256"]) assert(typeof row[name] === "string" && /^[0-9a-f]{64}$/.test(row[name]));
    assert([V.questions, V.questionsReturnAndFire, V.questionsWithWitnesses].includes(row.questionVersion));
    assert([V.projection, V.projectionWithUserContext, V.projectionWithReturnAndFire, V.projectionWithObservationSemantics].includes(row.projectionVersion));
    assert(["WARRANTED", "UNWARRANTED", "UNKNOWN"].includes(row.choices?.riskWarranted));
    assert(["PREFERABLE", "NOT_ESTABLISHED", "UNKNOWN"].includes(row.choices?.alternativePreferable));
    assert(["SUFFICIENT", "INSUFFICIENT"].includes(row.choices?.contextSufficient));
    assert(typeof row.modelConfidence === "number" && row.modelConfidence >= 0 && row.modelConfidence <= 1);
    assert(numberOrNull(row.latencyMs) !== null);
    return { bodySha256: row.bodySha256, stateSha256: row.stateSha256, projectionVersion: row.projectionVersion, questionVersion: row.questionVersion,
      requestedModel: row.requestedModel, returnedModel: row.returnedModel, status: "SUCCEEDED", modelConfidence: row.modelConfidence,
      choices: { riskWarranted: row.choices.riskWarranted, alternativePreferable: row.choices.alternativePreferable, contextSufficient: row.choices.contextSufficient }, latencyMs: row.latencyMs, usage: usage(row.usage) };
  });
  assert.equal(new Set(rows.map(row => row.bodySha256)).size, 5);
  return { generatedAt: value.generatedAt, demoSha256: value.demoSha256, parserWasmSha256: value.parserWasmSha256, parserJsSha256: value.parserJsSha256, rows };
}

/** Revalidate all five packets before reading credentials or allowing any billable work. */
export function validateMatches(history: History, incoming: unknown): Match[] {
  assert(Array.isArray(incoming) && incoming.length === 5);
  const matches = incoming.map((item: Record<string, unknown>) => {
    assert.deepEqual(Object.keys(item).sort(), ["baselineAssessmentKind", "bodySha256", "packet"]);
    assert(typeof item.bodySha256 === "string"); assert(kinds.includes(String(item.baselineAssessmentKind)));
    const packet = parseDecisionAssessmentPacket(item.packet);
    const body = buildJevHttpBody(packet);
    assert.equal(hash(JSON.stringify(body)), item.bodySha256);
    const old = history.rows.find(row => row.bodySha256 === item.bodySha256); assert(old);
    assert.equal(hash(JSON.stringify(packet)), old.stateSha256); assert.equal(packet.questionVersion, old.questionVersion);
    assert.equal(packet.projectionVersion, old.projectionVersion); assert.equal(body.model, old.requestedModel);
    return { bodySha256: item.bodySha256, packet, baselineAssessmentKind: String(item.baselineAssessmentKind) };
  });
  assert.equal(new Set(matches.map(m => m.bodySha256)).size, 5);
  return history.rows.map(row => matches.find(m => m.bodySha256 === row.bodySha256)!);
}

/** Stream and parse only two explicitly named settings; never read any environment fallback. */
export async function readGenerationSettings(path: string): Promise<{ DEEPSEEK_API_KEY: string; DEEPSEEK_MODEL: string }> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0, apiKey = "", model = "";
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line); if (bytes > 64 * 1024) throw new Error("SETTINGS_SIZE_LIMIT");
      if (!/^\s*(?:export\s+)?(?:DEEPSEEK_API_KEY|DEEPSEEK_MODEL)\s*=/.test(line)) continue;
      const named = parseEnv(line);
      if (named.DEEPSEEK_API_KEY !== undefined) apiKey = named.DEEPSEEK_API_KEY;
      if (named.DEEPSEEK_MODEL !== undefined) model = named.DEEPSEEK_MODEL;
      if (apiKey && model) break;
    }
  } finally { lines.close(); stream.destroy(); }
  if (!apiKey || apiKey.length > 512 || /[\u0000-\u001f\u007f]/u.test(apiKey)) throw new Error("GENERATION_KEY_MISSING_OR_INVALID");
  model ||= DEFAULT_DECISION_COMPARISON_MODEL;
  if (!/^[a-zA-Z0-9_.:/-]{1,120}$/.test(model)) throw new Error("GENERATION_MODEL_INVALID");
  return { DEEPSEEK_API_KEY: apiKey, DEEPSEEK_MODEL: model };
}

async function matchInChild(options: Options) {
  let stage = "CHILD_IMPORT";
  const progress = (next: string) => { stage = next; process.send?.({ type: "stage", stage }); };
  try {
    const history = parseHistory(JSON.parse(readFileSync(options.jevReport, "utf8")));
    const { buildCs2dAnalysisBundle } = await import("../libs/cs2d-analysis-adapter/src/index.ts");
    const { assessCandidateTeaching, buildDecisionAssessmentPacket, assertValidReviewPlan } = await import("../libs/review-planner/src/index.ts");
    progress("PARSER_INIT");
    const jsPath = resolve(options.parserDir, "demo_parser.js"), wasmPath = resolve(options.parserDir, "demo_parser_bg.wasm");
    const wasm = readFileSync(wasmPath);
    assert.equal(hash(wasm), history.parserWasmSha256); assert.equal(hash(readFileSync(jsPath)), history.parserJsSha256);
    const parser = await import(pathToFileURL(jsPath).href); parser.initSync({ module: wasm });
    let bytes: Buffer | undefined = readFileSync(options.demo); assert.equal(hash(bytes), history.demoSha256);
    progress("PARSE_ONCE"); const started = performance.now(); const parsed = parser.parse_demo(bytes, 8);
    let replay: Cs2dReplay; try { replay = JSON.parse(parsed.replay); } finally { parsed.free(); } bytes = undefined;
    const parseMs = Math.round(performance.now() - started);
    const wanted = new Set(history.rows.map(row => row.bodySha256)), found = new Map<string, Match>();
    let candidates = 0, eligible = 0;
    for (const [index, player] of replay.players.entries()) {
      progress(`MATCH_PLAYER_${index + 1}`);
      const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: player.steamId, demoId: `cs2d-${history.demoSha256}`, demoContentHash: history.demoSha256 });
      assertValidReviewPlan(bundle.match_timeline, bundle.review_plan);
      for (const candidate of bundle.candidate_set.candidates) {
        candidates++; const material = bundle.candidate_set.materials.find(m => m.candidateId === candidate.candidateId)!;
        let isEligible = false;
        for (const projectionVersion of new Set(history.rows.map(row => row.projectionVersion as DecisionAssessmentPacket["projectionVersion"]))) {
          // Historical comparisons must retain their measured projection when the preparation default evolves.
          const built = buildDecisionAssessmentPacket(candidate, material, { mapName: replay.map, tickRate: bundle.match_timeline.tick_rate, playerId: player.steamId, projectionVersion });
          if (!built.packet) continue; isEligible = true;
          const bodySha256 = hash(JSON.stringify(buildJevHttpBody(built.packet)));
          if (wanted.has(bodySha256) && !found.has(bodySha256)) found.set(bodySha256, { bodySha256, packet: parseDecisionAssessmentPacket(built.packet), baselineAssessmentKind: assessCandidateTeaching(candidate, material).kind });
        }
        if (isEligible) eligible++;
      }
    }
    const matches = validateMatches(history, [...found.values()]);
    assert(Buffer.byteLength(JSON.stringify(matches)) < 64 * 1024);
    process.send?.({ type: "matches", matches, telemetry: { parseInvocations: 1, parseMs, players: replay.players.length, rounds: replay.rounds.length,
      candidates, eligible, matched: matches.length, peakRssBytes: process.resourceUsage().maxRSS * 1024 } });
    process.disconnect?.();
  } catch { process.send?.({ type: "failure", stage }); process.exitCode = 1; process.disconnect?.(); }
}

async function run(options: Options) {
  const started = performance.now(); let stage = "VALIDATE_HISTORY", calls = 0;
  const rows: Array<Record<string, unknown>> = [];
  let child: ReturnType<typeof fork> | undefined, killTimer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  const stop = () => { controller.abort(); child?.kill("SIGTERM"); if (child) killTimer = setTimeout(() => child?.kill("SIGKILL"), 3000); };
  const timer = setTimeout(stop, DEADLINE_MS); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let report: Record<string, unknown>;
  let generation: Awaited<ReturnType<typeof readGenerationSettings>> | undefined;
  try {
    const history = parseHistory(JSON.parse(readFileSync(options.jevReport, "utf8")));
    child = fork(script, ["--worker", "--demo", options.demo, "--parser-dir", options.parserDir, "--out", options.out, "--jev-report", options.jevReport], {
      cwd: workspace, execArgv: [`--max-old-space-size=${HEAP_MIB}`, "--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let matches: Match[] | undefined, telemetry: Record<string, number> | undefined, failed = false;
    child.on("message", (message: { type?: string; stage?: string; matches?: unknown; telemetry?: Record<string, number> }) => {
      if (message.type === "stage" && /^[A-Z0-9_]{1,80}$/.test(message.stage ?? "")) { stage = message.stage!; console.error(JSON.stringify({ stage })); }
      else if (message.type === "matches") {
        try { matches = validateMatches(history, message.matches); telemetry = message.telemetry; } catch { failed = true; stop(); }
      } else if (message.type === "failure") failed = true;
    });
    const code = await new Promise<number | null>(done => { child!.once("exit", done); child!.once("error", () => { failed = true; done(1); }); });
    child = undefined;
    if (failed || code !== 0 || controller.signal.aborted || !matches) throw new Error("MATCH_STAGE_FAILED");
    stage = "ALL_FIVE_HASHES_VERIFIED"; console.error(JSON.stringify({ stage }));
    // All identity/version/hash checks finish before credentials are accessed.
    if (options.live) generation = await readGenerationSettings(options.generationEnvFile!);
    for (const [index, item] of matches.entries()) {
      if (controller.signal.aborted) throw new Error("DEADLINE_EXCEEDED");
      const old = history.rows[index]!;
      const base = { inputIndex: index + 1, bodySha256: item.bodySha256, source: "CANONICAL_DEMO", baselineAssessmentKind: item.baselineAssessmentKind,
        projectionVersion: item.packet.projectionVersion, questionVersion: item.packet.questionVersion };
      const rule = ruleDecisionAssessment(item.packet), checkedRule = validateDecisionAssessmentResult(item.packet, rule);
      rows.push({ ...base, provider: "RULE", provenance: "DETERMINISTIC_PROXY_NOT_GOLD", choices: choices(rule), result: rule,
        structuralValid: checkedRule.valid, evidenceConfidence: checkedRule.evidenceConfidence, remoteCallsThisRun: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
      rows.push({ ...base, provider: "JEV", provenance: "HISTORICAL_LIVE_REUSE", measuredAt: history.generatedAt,
        status: old.status, requestedModel: old.requestedModel, returnedModel: old.returnedModel, choices: old.choices,
        modelConfidence: old.modelConfidence, latencyMs: old.latencyMs, usage: old.usage, remoteCallsThisRun: 0,
        limitation: "HISTORICAL_SUMMARY_HAS_NO_FULL_PROBABILITIES_OR_REFS" });
      if (!options.live || calls >= options.maxCalls) {
        rows.push({ ...base, provider: "GENERATION_MODEL", status: "NOT_RUN", reason: options.live ? "REQUEST_BUDGET" : "OFFLINE_MATCH_ONLY", remoteCallsThisRun: 0 }); continue;
      }
      stage = `GENERATION_INPUT_${index + 1}`; console.error(JSON.stringify({ stage }));
      const callsBefore = calls;
      const attempt = await compareWithGenerationModel(item.packet, generation!, { timeoutMs: TIMEOUT_MS, signal: controller.signal,
        fetcher: async (url, init) => {
          assert.equal(String(url), "https://api.deepseek.com/chat/completions"); assert(calls < options.maxCalls && calls < 5);
          const outgoing = JSON.parse(String(init?.body)); const user = JSON.parse(outgoing.messages[1].content);
          const jevBody = buildJevHttpBody(item.packet);
          assert.deepEqual(user.state, jevBody.state); assert.deepEqual(user.questions, jevBody.questions);
          calls++; return fetch(url, init);
        } });
      const result = attempt.result ?? attempt.diagnosticResult;
      const checked = result ? validateDecisionAssessmentResult(item.packet, result, { allowedModel: result.model }) : undefined;
      rows.push({ ...base, provider: "GENERATION_MODEL", provenance: "CURRENT_LIVE_CALL", measuredAt: new Date().toISOString(),
        status: attempt.status, reason: attempt.reason ? safeCode(attempt.reason) : null, requestedModel: generation!.DEEPSEEK_MODEL,
        returnedModel: attempt.actualModel ?? result?.model ?? null, choices: result ? choices(result) : null,
        result: attempt.result ?? null, diagnosticResult: attempt.diagnosticResult ?? null,
        structuralValid: checked?.valid ?? null, rejectionReasons: (checked?.rejectionReasons ?? attempt.rejectionReasons ?? []).map(safeCode),
        evidenceConfidence: checked?.evidenceConfidence ?? null, modelConfidence: checked?.modelConfidence ?? null,
        latencyMs: attempt.latencyMs, usage: attempt.usage, remoteCallsThisRun: calls - callsBefore });
    }
    report = { schemaVersion: "jev-existing-model-comparison.v1", status: "PASS", generatedAt: new Date().toISOString(), mode: options.live ? "LIVE_GENERATION_WITH_HISTORICAL_JEV" : "OFFLINE_MATCH_ONLY",
      demoSha256: history.demoSha256, reusedJevMeasuredAt: history.generatedAt, requestedInputs: 5, exactHashMatches: matches.length,
      newRemoteCalls: calls, newJevCalls: 0, maxCalls: options.maxCalls, timeoutMs: TIMEOUT_MS, deadlineMs: DEADLINE_MS, heapLimitMiB: HEAP_MIB,
      elapsedMs: Math.round(performance.now() - started), parserTelemetry: telemetry, rows,
      expertLabels: 0, tacticalImprovement: "NOT_ESTABLISHED", confidenceIntervals: null,
      limitations: ["ONE_DEMO_CORRELATED_INPUTS", "HISTORICAL_JEV_NOT_CONCURRENT", "IDENTICAL_STATE_AND_RUBRIC_DIFFERENT_NATIVE_PROTOCOL",
        "GENERATION_SELF_REPORTED_PROBABILITIES_NOT_NATIVE_CONFIDENCE", "RULE_PROXY_NOT_EXPERT_GOLD", "REFUSAL_IS_NOT_PROOF_OF_QUALITY_GAIN",
        "FIVE_SAMPLES_INSUFFICIENT_FOR_TAIL_LATENCY_OR_TACTICAL_ACCURACY", "HISTORICAL_JEV_SUMMARY_NO_FULL_PROBABILITIES_OR_REFS", "GENERATION_COST_NOT_AVAILABLE_FROM_ADAPTER"] };
  } catch {
    report = { schemaVersion: "jev-existing-model-comparison.v1", status: "FAIL", stage, code: controller.signal.aborted ? "CANCELLED_OR_DEADLINE" : "COMPARISON_STAGE_FAILED", newRemoteCalls: calls, newJevCalls: 0, rows };
    process.exitCode = 1;
  } finally {
    if (generation) generation.DEEPSEEK_API_KEY = "";
    clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    if (child) { child.kill("SIGTERM"); child.kill("SIGKILL"); }
  }
  mkdirSync(dirname(options.out), { recursive: true }); writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, stage: report.stage, exactHashMatches: report.exactHashMatches, newRemoteCalls: calls, rows: rows.length }));
}

if (resolve(process.argv[1] ?? "") === script) {
  if (process.argv.includes("--help")) console.log("Usage: pnpm exec tsx tools/compare-jev-existing.ts --demo <demo> --parser-dir <parser> [--out <worktree JSON>] [--jev-report <historical JSON>] [--live --generation-env-file=<named settings> --max-calls 5]\nDefault: offline exact matching only. One parse, five historical hashes, at most five new generation calls; never new Jev calls.");
  else try { const worker = process.argv[2] === "--worker"; const options = parseOptions(process.argv.slice(worker ? 3 : 2)); if (worker) await matchInChild(options); else await run(options); }
  catch { console.error(JSON.stringify({ status: "FAIL", code: "INVALID_ARGUMENTS" })); process.exitCode = 1; }
}
