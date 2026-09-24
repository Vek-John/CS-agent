import { createReadStream } from "node:fs";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline";
/** Bounded, explicit decision-provider comparison; emits anonymous JSON to stdout. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DECISION_ASSESSMENT_VERSIONS, type DecisionAssessmentResult } from "../libs/contracts/src/decision-assessment";
import { decisionAssessmentEvalCases, type DecisionAssessmentEvalCase } from "../libs/review-planner/src/decision-assessment-fixtures";
import { decisionAssessmentFingerprint, parseDecisionAssessmentPacket, ruleDecisionAssessment, validateDecisionAssessmentResult } from "../libs/review-planner/src/decision-assessment";
import { assessWithJev, compareWithGenerationModel, DEFAULT_DECISION_COMPARISON_MODEL } from "../apps/web/lib/coaching/jev-decision-assessment";

type Provider = "RULE" | "JEV" | "GENERATION_MODEL";
type Attempt = Awaited<ReturnType<typeof assessWithJev>>;
interface Row {
  caseId: string; demoGroup: string; split: DecisionAssessmentEvalCase["split"];
  provenance: DecisionAssessmentEvalCase["provenance"]; provider: Provider;
  packetFingerprint: string; status: "SUCCEEDED" | "FALLBACK" | "BLOCKED";
  reason: string | null; model: string | null; result: DecisionAssessmentResult | null;
  diagnosticResult: DecisionAssessmentResult | null; schemaParsed: boolean | null;
  structuralValid: boolean | null; rejectionReasons: readonly string[];
  evidenceConfidence: number | null; modelConfidence: number | null;
  acceptableLabelHit: boolean | null; acceptableAlternativeHit: boolean | null;
  acceptableSufficiencyHit: boolean | null; refused: boolean | null;
  latencyMs: number | null; remoteCall: boolean; reusedInRun: boolean;
  usage: Attempt["usage"];
  brierProxy: number | null; calibrationProxy: { confidence: number; correct: number } | null;
}

const args = process.argv.slice(2);
const live = args.includes("--live");
const numericOption = (name: string, fallback: number) => {
  const arg = args.find((value) => value.startsWith(`${name}=`));
  if (!arg) return fallback;
  const n = Number(arg.slice(name.length + 1));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
};
for (const arg of args) {
  if (arg !== "--live" && arg !== "--key-stdin" && !/^--(?:max-calls|timeout-ms)=\d+$/.test(arg) && !/^--case-prefix=[a-z0-9-]{1,80}$/.test(arg) && !arg.startsWith("--generation-env-file=")) throw new Error("Unsupported argument. Use --live, --max-calls=N, --timeout-ms=N.");
}
const casePrefix = args.find(arg => arg.startsWith("--case-prefix="))?.slice("--case-prefix=".length);
const evaluationCases = casePrefix ? decisionAssessmentEvalCases.filter(item => item.id.startsWith(casePrefix)) : decisionAssessmentEvalCases;
if (evaluationCases.length === 0) throw new Error("NO_MATCHING_CASES");
const maximumCalls = Math.min(100, numericOption("--max-calls", 10));
const requestTimeoutMs = Math.min(3_000, numericOption("--timeout-ms", 2_500));
const deadlineMs = 600_000;
const started = performance.now();
const deadline = new AbortController();
const timer = setTimeout(() => deadline.abort(), deadlineMs);
timer.unref();
// Read named provider settings only. Never print credentials or arbitrary environment data.
const jevEnv = { JEV_API_KEY: process.env.JEV_API_KEY };
if (args.includes("--key-stdin")) {
  const lines = createInterface({ input: process.stdin, terminal: false });
  const key = await new Promise<string>((resolve, reject) => {
    let received = false;
    const timeout = setTimeout(() => { lines.close(); reject(new Error("KEY_INPUT_TIMEOUT")); }, 60_000);
    lines.once("line", (line) => { received = true; clearTimeout(timeout); resolve(line.trim()); lines.close(); });
    lines.once("close", () => { clearTimeout(timeout); if (!received) reject(new Error("KEY_INPUT_CLOSED")); });
  });
  if (!key || key.length > 512 || /[\x00-\x1f\x7f]/.test(key)) throw new Error("INVALID_KEY_INPUT");
  jevEnv.JEV_API_KEY = key;
}
const generationEnv = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
  DEEPSEEK_URL: process.env.DEEPSEEK_URL,
  DEEPSEEK_ALLOW_EMPTY_KEY: process.env.DEEPSEEK_ALLOW_EMPTY_KEY === "true",
};

const generationEnvPath = args.find(arg => arg.startsWith("--generation-env-file="))?.slice("--generation-env-file=".length);
if (generationEnvPath) {
  // Read only the named provider settings; never parse, retain or print the full environment configuration.
  const stream = createReadStream(generationEnvPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0;
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > 64 * 1024) throw new Error("GENERATION_SETTINGS_TOO_LARGE");
      if (!/^\s*(?:export\s+)?(?:DEEPSEEK_API_KEY|DEEPSEEK_MODEL)\s*=/.test(line)) continue;
      const named = parseEnv(line);
      for (const field of ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"] as const) {
        const value = named[field];
        if (value !== undefined) {
          if (!value.trim() || value.length > (field === "DEEPSEEK_MODEL" ? 120 : 512) || /[\x00-\x1f\x7f]/.test(value)) throw new Error("INVALID_GENERATION_SETTINGS");
          generationEnv[field] ||= value;
        }
      }
      if (generationEnv.DEEPSEEK_API_KEY && generationEnv.DEEPSEEK_MODEL) break;
    }
  } catch { throw new Error("GENERATION_SETTINGS_UNAVAILABLE_OR_INVALID"); }
  finally { lines.close(); stream.destroy(); }
}

function verifyFixtures(): { status: "PASS"; cases: number; demoGroups: number; counterfactualPairs: number; quality: string } {
  const groups = new Map<string, Set<string>>();
  const pairs = new Map<string, DecisionAssessmentEvalCase[]>();
  const fingerprints = new Map<string, string>();
  for (const item of decisionAssessmentEvalCases) {
    assert(item.acceptableLabels.length && item.acceptableAlternatives.length && item.acceptableSufficiency.length);
    assert.equal(item.provenance, "SYNTHETIC_AUTHOR_EXPECTATION");
    assert.equal(item.timeBasis, "SYNTHETIC_RELATIVE_SECONDS");
    const serialized = JSON.stringify(item.packet);
    assert(!/"(?:outcome|assessment|selectedPlayerDeath|winProbability|steamId|nickname|decisionTick|rawReplay)"|LOSS_DEATH|WIN_SURVIVE/.test(serialized));
    parseDecisionAssessmentPacket(item.packet);
    const fingerprint = decisionAssessmentFingerprint(item.packet);
    const previousSplit = fingerprints.get(fingerprint);
    assert(previousSplit === undefined || previousSplit === item.split, "An identical input packet cannot cross calibration/holdout splits");
    fingerprints.set(fingerprint, item.split);
    assert(item.packet.state.advantage === item.packet.state.allies - item.packet.state.enemies);
    const aliases = new Set(item.packet.evidence.map((evidence) => evidence.alias));
    assert.equal(aliases.size, item.packet.evidence.length);
    for (const reference of [...item.packet.action.refs, ...item.packet.state.checks.flatMap((check) => check.refs)]) assert(aliases.has(reference));
    const splits = groups.get(item.demoGroup) ?? new Set<string>();
    splits.add(item.split); groups.set(item.demoGroup, splits);
    if (item.counterfactualPair) pairs.set(item.counterfactualPair, [...(pairs.get(item.counterfactualPair) ?? []), item]);
  }
  for (const splits of groups.values()) assert.equal(splits.size, 1, "A Demo group cannot cross calibration/holdout splits");
  for (const pair of pairs.values()) {
    assert.equal(pair.length, 2);
    assert.notEqual(pair[0].outcome, pair[1].outcome);
    assert.deepEqual(pair[0].packet, pair[1].packet);
    assert.equal(decisionAssessmentFingerprint(pair[0].packet), decisionAssessmentFingerprint(pair[1].packet));
    assert.equal(pair[0].demoGroup, pair[1].demoGroup);
  }
  const informed = decisionAssessmentEvalCases.find((item) => item.id === "reliable-new-information")!;
  const multiple = decisionAssessmentEvalCases.find((item) => item.id === "multiple-reasonable-actions")!;
  assert.notEqual(decisionAssessmentFingerprint(informed.packet), decisionAssessmentFingerprint(multiple.packet));
  const reports = decisionAssessmentEvalCases.filter(item => item.id.startsWith("structured-report-"));
  assert.equal(reports.length, 2);
  assert.notEqual(decisionAssessmentFingerprint(reports[0]!.packet), decisionAssessmentFingerprint(reports[1]!.packet));
  assert.deepEqual(reports[0]!.packet.action, reports[1]!.packet.action);
  assert.deepEqual(reports[0]!.packet.state.checks, reports[1]!.packet.state.checks);
  const user = decisionAssessmentEvalCases.find((item) => item.id === "user-context-not-demo-fact")!;
  assert.equal(user.packet.state.observations[0].source, "USER_PROVIDED");
  assert(user.packet.state.observations[0].confidence < 1);
  return { status: "PASS", cases: decisionAssessmentEvalCases.length, demoGroups: groups.size, counterfactualPairs: pairs.size, quality: "Packet-only engineering assertions; final HTTP serialization is covered by adapter tests, not proved by this fixture check." };
}

function rowFor(item: DecisionAssessmentEvalCase, provider: Provider, attempt?: Attempt, blockedReason?: string, remoteCall = false, reusedInRun = false): Row {
  const result = attempt?.result ?? null;
  // Audit rejected-but-parsed labels as well: gating must not hide difficult cases.
  // Keep them in a separate field so no consumer mistakes them for accepted inference.
  const diagnosticResult = attempt?.diagnosticResult ?? null;
  const parsed = result ?? diagnosticResult;
  const validation = parsed ? validateDecisionAssessmentResult(item.packet, parsed,
    provider === "GENERATION_MODEL" ? { allowedModel: attempt?.actualModel ?? generationEnv.DEEPSEEK_MODEL ?? DEFAULT_DECISION_COMPARISON_MODEL } : {}) : null;
  const singleton = item.acceptableLabels.length === 1;
  const probabilities = parsed?.riskWarranted.probabilities ?? null;
  const brierProxy = probabilities && singleton ? Object.entries(probabilities).reduce((sum, [label, p]) => sum + (p - Number(label === item.acceptableLabels[0])) ** 2, 0) : null;
  const calibrationProxy = probabilities && singleton ? {
    confidence: Math.max(...Object.values(probabilities)), correct: Number(item.acceptableLabels.includes(parsed!.riskWarranted.choice)),
  } : null;
  return {
    caseId: item.id, demoGroup: item.demoGroup, split: item.split, provenance: item.provenance, provider,
    packetFingerprint: decisionAssessmentFingerprint(item.packet), status: blockedReason ? "BLOCKED" : attempt?.status ?? "FALLBACK",
    reason: blockedReason ?? attempt?.reason ?? null, model: parsed?.model ?? null, result, diagnosticResult,
    schemaParsed: attempt ? Boolean(parsed) : null,
    structuralValid: validation?.valid ?? null, rejectionReasons: [...new Set([...(validation?.rejectionReasons ?? []), ...(attempt?.rejectionReasons ?? [])])],
    evidenceConfidence: validation?.evidenceConfidence ?? null, modelConfidence: validation?.modelConfidence ?? null,
    acceptableLabelHit: parsed ? item.acceptableLabels.includes(parsed.riskWarranted.choice) : null,
    acceptableAlternativeHit: parsed ? item.acceptableAlternatives.includes(parsed.alternativePreferable.choice) : null,
    acceptableSufficiencyHit: parsed ? item.acceptableSufficiency.includes(parsed.contextSufficient.choice) : null,
    refused: parsed ? parsed.riskWarranted.choice === "UNKNOWN" || parsed.contextSufficient.choice === "INSUFFICIENT" : null,
    latencyMs: attempt?.latencyMs ?? null, remoteCall, reusedInRun,
    usage: attempt?.usage ?? { inputTokens: null, outputTokens: null, costUsd: null }, brierProxy, calibrationProxy,
  };
}

function mean(values: readonly number[]): number | null { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function quantile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
// Cluster bootstrap samples whole Demo groups, retaining correlated counterfactual nodes.
function clusterInterval(rows: readonly Row[], selector: (row: Row) => number | null): { estimate: number | null; ci95: readonly [number, number] | null; groups: number; warning: string } {
  const observed = rows.filter((row) => selector(row) !== null);
  const groups = [...new Set(observed.map((row) => row.demoGroup))];
  const estimate = mean(observed.map((row) => selector(row)!));
  if (groups.length < 2) return { estimate, ci95: null, groups: groups.length, warning: "Fewer than two Demo groups; cluster interval unavailable. No expert labels." };
  let seed = 23719;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const draws: number[] = [];
  for (let iteration = 0; iteration < 1_000; iteration++) {
    const values: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const selected = groups[Math.floor(random() * groups.length)];
      values.push(...observed.filter((row) => row.demoGroup === selected).map((row) => selector(row)!));
    }
    draws.push(mean(values)!);
  }
  return { estimate, ci95: [quantile(draws, 0.025)!, quantile(draws, 0.975)!], groups: groups.length, warning: "Exploratory 1,000-draw Demo-cluster bootstrap over synthetic author expectations; small group count and no expert labels prevent professional-quality claims." };
}

function stats(rows: readonly Row[]) {
  const ratio = (field: "acceptableLabelHit" | "acceptableAlternativeHit" | "acceptableSufficiencyHit" | "refused") => clusterInterval(rows, (row) => row[field] === null ? null : Number(row[field]));
  const attempted = rows.filter((row) => row.status !== "BLOCKED");
  const parsed = rows.filter((row) => row.schemaParsed === true);
  const passed = parsed.filter((row) => row.structuralValid === true);
  const counts = (codes: readonly string[]) => Object.fromEntries([...new Set(codes)].map((code) => [code, codes.filter((candidate) => candidate === code).length]));
  const calibrations = rows.flatMap((row) => row.calibrationProxy ? [row.calibrationProxy] : []);
  let ece = 0;
  for (let bin = 0; bin < 5; bin++) {
    const entries = calibrations.filter((entry) => Math.min(4, Math.floor(entry.confidence * 5)) === bin);
    if (entries.length) ece += entries.length / calibrations.length * Math.abs(mean(entries.map((e) => e.confidence))! - mean(entries.map((e) => e.correct))!);
  }
  return {
    cases: rows.length, blocked: rows.filter((row) => row.status === "BLOCKED").length,
    fallback: rows.filter((row) => row.status === "FALLBACK").length,
    outputParsing: { attemptedRows: attempted.length, parsedRows: parsed.length, unparsedRows: attempted.length - parsed.length, rate: attempted.length ? parsed.length / attempted.length : null },
    deterministicValidation: { evaluatedParsedRows: parsed.length, passed: passed.length, rejected: parsed.length - passed.length, passRateAmongParsed: parsed.length ? passed.length / parsed.length : null },
    structuralValidity: { evaluated: attempted.length, valid: passed.length, rate: attempted.length ? passed.length / attempted.length : null, denominator: "ALL_NON_BLOCKED_ROWS_INCLUDING_PARSE_AND_VALIDATION_FAILURES" },
    fallbackReasons: counts(rows.filter((row) => row.status === "FALLBACK").map((row) => row.reason ?? "UNKNOWN")),
    deterministicRejectionReasons: counts(rows.flatMap((row) => [...row.rejectionReasons])),
    proxyMetricDenominator: "ALL_PARSED_OUTPUTS_INCLUDING_DETERMINISTICALLY_REJECTED_DIAGNOSTICS",
    proxyAcceptableLabelHit: ratio("acceptableLabelHit"), proxyAcceptableAlternativeHit: ratio("acceptableAlternativeHit"), proxyAcceptableSufficiencyHit: ratio("acceptableSufficiencyHit"), refusalRate: ratio("refused"),
    professionalDecisionAccuracy: { value: null, status: "BLOCKED_NO_EXPERT_HOLDOUT" },
    productionAutomaticAcceptance: { enabled: false, accepted: 0, coverage: rows.length ? 0 : null, errorRate: null, reason: "No expert-validated acceptance threshold; evaluation never publishes teaching or Memory." },
    calibration: { proxyBrier: clusterInterval(rows, (row) => row.brierProxy), proxyEceFiveBins: calibrations.length ? ece : null, singletonAuthorLabelCount: calibrations.length, status: "DESCRIPTIVE_PROXY_ONLY", warning: "Ambiguous acceptable sets are excluded. Model confidence is not evidence confidence or empirical tactical accuracy; too few synthetic labels for calibrated thresholds." },
  };
}

/** Engineering regression only; this fake row never enters reported provider runs. */
function verifyDiagnosticAccounting(): "PASS" {
  const item = decisionAssessmentEvalCases[2]!;
  const diagnostic = { ...ruleDecisionAssessment(item.packet), model: DECISION_ASSESSMENT_VERSIONS.model };
  diagnostic.contextSufficient = { ...diagnostic.contextSufficient, refs: [] };
  const row = rowFor(item, "JEV", { status: "FALLBACK", reason: "VALIDATION_REJECTED", diagnosticResult: diagnostic,
    rejectionReasons: ["UNSUPPORTED_CITATION"], latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: null } });
  const summary = stats([row]);
  assert.equal(row.result, null);
  assert.equal(row.schemaParsed, true);
  assert.equal(row.structuralValid, false);
  assert.equal(row.acceptableLabelHit, true);
  assert.equal(summary.structuralValidity.evaluated, 1);
  assert.equal(summary.structuralValidity.valid, 0);
  assert.equal(summary.outputParsing.parsedRows, 1);
  assert.equal(summary.proxyAcceptableLabelHit.estimate, 1);
  assert.equal(summary.fallbackReasons.VALIDATION_REJECTED, 1);
  return "PASS";
}

const rows: Row[] = [];
let remoteCalls = 0;
const cache = new Map<string, Attempt>();
let fixtureChecks: ReturnType<typeof verifyFixtures>;
let diagnosticAccounting: "PASS";
try {
  fixtureChecks = verifyFixtures();
  diagnosticAccounting = verifyDiagnosticAccounting();
  for (const item of evaluationCases) {
    const t = performance.now();
    rows.push(rowFor(item, "RULE", { status: "SUCCEEDED", result: ruleDecisionAssessment(item.packet), latencyMs: performance.now() - t, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
  }
  for (const item of evaluationCases) {
    for (const provider of ["JEV", "GENERATION_MODEL"] as const) {
      const available = provider === "JEV" ? Boolean(jevEnv.JEV_API_KEY?.trim()) : Boolean(generationEnv.DEEPSEEK_API_KEY?.trim() || (generationEnv.DEEPSEEK_ALLOW_EMPTY_KEY && generationEnv.DEEPSEEK_URL));
      const key = `${provider}:${decisionAssessmentFingerprint(item.packet)}`;
      const reused = cache.get(key);
      const blocked = !live ? "LIVE_NOT_REQUESTED" : !available ? "MISSING_PROVIDER_KEY" : reused ? null : deadline.signal.aborted || performance.now() - started >= deadlineMs ? "TOTAL_DEADLINE" : remoteCalls >= maximumCalls ? "REQUEST_BUDGET_EXHAUSTED" : null;
      if (blocked) { rows.push(rowFor(item, provider, undefined, blocked)); continue; }
      if (reused) { rows.push(rowFor(item, provider, reused, undefined, false, true)); continue; }
      remoteCalls++;
      let attempt: Attempt;
      try {
        const options = { signal: deadline.signal, timeoutMs: requestTimeoutMs };
        attempt = provider === "JEV" ? await assessWithJev(item.packet, jevEnv, options) : await compareWithGenerationModel(item.packet, generationEnv, options);
      } catch {
        // Exception messages can contain server bodies or secrets; persist only a bounded code.
        attempt = { status: "FALLBACK", reason: "PROVIDER_THROW", latencyMs: 0, usage: { inputTokens: null, outputTokens: null, costUsd: null } };
      }
      cache.set(key, attempt);
      rows.push(rowFor(item, provider, attempt, undefined, true));
    }
  }
} finally { clearTimeout(timer); }

const byProvider = Object.fromEntries((["RULE", "JEV", "GENERATION_MODEL"] as const).map((provider) => {
  const providerRows = rows.filter((row) => row.provider === provider);
  const actualCalls = providerRows.filter((row) => row.remoteCall);
  const latency = actualCalls.flatMap((row) => row.latencyMs === null ? [] : [row.latencyMs]);
  const costs = actualCalls.flatMap((row) => row.usage.costUsd === null ? [] : [row.usage.costUsd]);
  return [provider, {
    all: stats(providerRows), calibration: stats(providerRows.filter((row) => row.split === "CALIBRATION")), holdout: stats(providerRows.filter((row) => row.split === "HOLDOUT")),
    actualRemoteCalls: actualCalls.length, deduplicatedReuses: providerRows.filter((row) => row.reusedInRun).length,
    actualUsage: { inputTokens: actualCalls.some((row) => row.usage.inputTokens === null) ? null : actualCalls.reduce((sum, row) => sum + (row.usage.inputTokens ?? 0), 0), outputTokens: actualCalls.some((row) => row.usage.outputTokens === null) ? null : actualCalls.reduce((sum, row) => sum + (row.usage.outputTokens ?? 0), 0), knownCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null, unknownCostCalls: actualCalls.length - costs.length },
    latency: { samples: latency.length, p50MsDescriptive: quantile(latency, 0.5), p95Ms: latency.length >= 100 ? quantile(latency, 0.95) : null, p99Ms: latency.length >= 100 ? quantile(latency, 0.99) : null, status: latency.length < 100 ? "INSUFFICIENT_SAMPLES_FOR_TAIL_ESTIMATION" : "DESCRIPTIVE_ONLY", warning: "At most 100 remote calls, few unique synthetic inputs; no reliable service-level tail estimate. Reused rows are excluded." },
  }];
}));
process.stdout.write(`${JSON.stringify({
  version: "decision-assessment-eval.v2", createdAt: new Date().toISOString(), mode: live ? "LIVE_SMOKE" : "OFFLINE_ENGINEERING",
  versions: DECISION_ASSESSMENT_VERSIONS, fixtureChecks, caseSelection: { prefix: casePrefix ?? null, cases: evaluationCases.length }, generationCredentialFileRequested: Boolean(generationEnvPath), configuredGenerationModel: generationEnv.DEEPSEEK_MODEL ?? DEFAULT_DECISION_COMPARISON_MODEL, budget: { maximumCalls, remoteCalls, requestTimeoutMs, deadlineMs, elapsedMs: Math.round(performance.now() - started) },
  dataInventory: { realDemosInDataset: 0, expertLabels: 0, labelSource: "SYNTHETIC_AUTHOR_EXPECTATION", splitUnit: "demoGroup", thresholdTuningPerformed: false },
  comparison: { sharedInformation: "Identical DecisionAssessmentPacket; no outcomes or baseline answer sent to either provider.", remainingDifferences: ["Jev native Choice distributions versus generation-model JSON-reported probabilities; calibration meanings differ.", "Rule baseline encodes an unvalidated principle, not human ground truth.", "Provider adapters may use different transport/prompts; actual versions and results retained per row.", "No automatic acceptance threshold is tuned on this dataset."] },
  regressions: { fixturePacketBoundaries: "PASS", rejectedDiagnosticAccounting: diagnosticAccounting, finalHttpSerializationAndPromptInjection: "Run adapter/core regression tests; this CLI does not prove HTTP isolation or live adversarial robustness.", modelOutcomeInvariance: "Counterfactuals share a packet/cache key and reuse one response; this is engineering cache evidence, not an independent model counterfactual quality measurement." },
  byProvider, rows,
}, null, 2)}\n`);
