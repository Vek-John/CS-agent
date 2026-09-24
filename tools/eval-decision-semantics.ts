/** Compact, bounded pre-frozen semantic/witness comparison. No model calls by default. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DECISION_ASSESSMENT_VERSIONS as V, type DecisionAssessmentPacket, type DecisionAssessmentResult } from "../libs/contracts/src/decision-assessment.ts";
import { decisionSemanticsEvalCases, legacyDecisionSemanticsPacket, DECISION_SEMANTICS_DATASET_VERSION, type DecisionSemanticsEvalCase } from "../libs/review-planner/src/decision-semantics-eval-fixtures.ts";
import { parseDecisionAssessmentPacket, ruleDecisionAssessment, validateDecisionAssessmentResult } from "../libs/review-planner/src/decision-assessment.ts";
import { assessWithJev, compareWithGenerationModel, buildJevHttpBody, type DecisionProviderAttempt } from "../apps/web/lib/coaching/jev-decision-assessment.ts";
import { readGenerationSettings } from "./compare-jev-existing.ts";
import { readJevKeyLine } from "./jev-real-live.ts";

type Arm = "OLD_JEV" | "NEW_JEV" | "GENERATION_MODEL";
type Split = DecisionSemanticsEvalCase["split"];
export interface SemanticsEvalOptions { split: Split; live: boolean; keyStdin: boolean; generationEnvFile?: string; maxCalls: number }
const TIMEOUT_MS = 3000, TOTAL_MS = 600_000;
const ARMS = ["OLD_JEV", "NEW_JEV", "GENERATION_MODEL"] as const;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Filled and verified before the first model call. A change requires an explicit new freeze.
export const FROZEN_DATASET_SHA256 = "0efb9189eff4df85f3e7e06d6d1141b262ce138ee9a3ad5623cef0731e1a07e8";
const safeReason = (reason: string | undefined) => reason && /^[A-Z][A-Z0-9_]{0,90}$/.test(reason) ? reason : "UNSPECIFIED";

export function parseSemanticsEvalOptions(args: readonly string[]): SemanticsEvalOptions {
  const allowed = /^(?:--split=(?:development|holdout)|--live|--key-stdin|--generation-env-file=.+|--max-calls=\d+)$/;
  const names = args.map(arg => arg.split("=")[0]);
  assert(args.every(arg => allowed.test(arg)) && new Set(names).size === names.length, "INVALID_ARGUMENTS");
  const value = (name: string) => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const split = value("--split") ?? "development";
  assert(split === "development" || split === "holdout", "INVALID_SPLIT");
  const live = args.includes("--live"), keyStdin = args.includes("--key-stdin");
  const maxCalls = Number(value("--max-calls") ?? (split === "development" ? 9 : 18));
  assert(Number.isInteger(maxCalls) && maxCalls > 0 && maxCalls <= 100 && (split !== "development" || maxCalls <= 10), "INVALID_CALL_BUDGET");
  const generationEnvFile = value("--generation-env-file");
  if (live) assert(keyStdin && generationEnvFile, "LIVE_REQUIRES_STDIN_KEY_AND_EXPLICIT_GENERATION_SETTINGS");
  else assert(!keyStdin && !generationEnvFile, "OFFLINE_DOES_NOT_READ_SECRETS");
  return { split, live, keyStdin, maxCalls, ...(generationEnvFile ? { generationEnvFile } : {}) };
}

export function verifySemanticsDataset() {
  assert.equal(decisionSemanticsEvalCases.length, 9);
  assert.equal(decisionSemanticsEvalCases.filter(c => c.split === "development").length, 3);
  assert.equal(decisionSemanticsEvalCases.filter(c => c.split === "holdout").length, 6);
  const groups = new Set<string>(), sourceHashes = new Set<string>(), legacyHashes = new Set<string>();
  for (const item of decisionSemanticsEvalCases) {
    assert.equal(item.provenance, "AGENT_AUTHORED_PROXY");
    assert(!groups.has(item.group), "SCENARIO_GROUP_REUSED"); groups.add(item.group);
    const sourceHash = sha(item.packet), legacyHash = sha(item.legacyPacket);
    assert(!sourceHashes.has(sourceHash) && !legacyHashes.has(legacyHash), "IDENTICAL_INPUT_REUSED_ACROSS_GROUPS");
    sourceHashes.add(sourceHash); legacyHashes.add(legacyHash);
    assert.deepEqual(parseDecisionAssessmentPacket(item.packet), item.packet);
    assert.deepEqual(parseDecisionAssessmentPacket(item.legacyPacket), item.legacyPacket);
    assert.deepEqual(legacyDecisionSemanticsPacket(item.packet), item.legacyPacket);
    assert(item.packet.state.observations.every(o => o.semantic));
    assert(item.legacyPacket.state.observations.every(o => !o.semantic));
    assert(item.acceptable.risk.length > 0 && item.acceptable.risk.length < 3);
    assert(item.acceptable.alternative.length > 0 && item.acceptable.alternative.length < 3);
    assert.equal(item.acceptable.sufficiency.length, 1);
    for (const packet of [item.packet, item.legacyPacket]) {
      const serialized = JSON.stringify(buildJevHttpBody(packet));
      assert(!/"(?:acceptable|provenance|outcome|assessment|decisionTick|playerId|subject_ref)"|AGENT_AUTHORED_PROXY|synthetic-self|synthetic-other|synthetic-audibility/.test(serialized), "LOCAL_LABEL_OR_SOURCE_LEAK");
    }
    assert.equal(Object.keys(buildJevHttpBody(item.packet).questions).length, 6, "NEW_PROTOCOL_MUST_HAVE_SIX_QUESTIONS");
  }
  return { version: DECISION_SEMANTICS_DATASET_VERSION, sha256: sha(decisionSemanticsEvalCases),
    cases: decisionSemanticsEvalCases.length, groups: groups.size, developmentCases: 3, holdoutCases: 6,
    labelSource: "AGENT_AUTHORED_PROXY", expertLabels: 0, timeBasis: "SYNTHETIC_RELATIVE_TIME",
    note: "Development archetypes were previously explored. Holdout is a new pre-call proxy test, not a blinded coach-labeled set." };
}

export function classifySemanticsResult(item: DecisionSemanticsEvalCase, packet: DecisionAssessmentPacket, attempt: DecisionProviderAttempt, allowedModel?: string) {
  const parsed = attempt.result ?? attempt.diagnosticResult;
  const validation = parsed ? validateDecisionAssessmentResult(packet, parsed, allowedModel ? { allowedModel } : {}) : undefined;
  const riskHit = parsed ? item.acceptable.risk.includes(parsed.riskWarranted.choice) : null;
  const alternativeHit = parsed ? item.acceptable.alternative.includes(parsed.alternativePreferable.choice) : null;
  const sufficiencyHit = parsed ? item.acceptable.sufficiency.includes(parsed.contextSufficient.choice) : null;
  const allLabelSetsHit = parsed ? riskHit && alternativeHit && sufficiencyHit : null;
  const nonabstaining = Boolean(parsed && parsed.riskWarranted.choice !== "UNKNOWN" && parsed.alternativePreferable.choice !== "UNKNOWN" && parsed.contextSufficient.choice === "SUFFICIENT");
  const gateValid = attempt.status === "SUCCEEDED" && validation?.valid === true;
  return { parsed: Boolean(parsed), gateValid, nonabstaining, riskHit, alternativeHit, sufficiencyHit, allLabelSetsHit,
    primarySuccess: gateValid && nonabstaining && allLabelSetsHit === true,
    refusal: parsed ? !nonabstaining : null, evidenceConfidence: validation?.evidenceConfidence ?? null,
    rejectionReasons: [...new Set([...(validation?.rejectionReasons ?? []), ...(attempt.rejectionReasons ?? [])])] };
}
type Row = ReturnType<typeof classifySemanticsResult> & {
  caseId: string; group: string; split: Split; arm: Arm;
  packetSha256: string; canonicalBodySha256: string; actualRequestSha256: string | null;
  status: string; reason: string | null; actualModel: string | null; remoteCalls: number;
  latencyMs: number | null; usage: DecisionProviderAttempt["usage"];
  result: DecisionAssessmentResult | null; diagnosticResult: DecisionAssessmentResult | null;
};
function summarize(rows: readonly Row[]) {
  const parsed = rows.filter(r => r.parsed), accepted = rows.filter(r => r.gateValid), primary = rows.filter(r => r.primarySuccess);
  const completed = rows.filter(r => r.remoteCalls && r.reason !== "TIMEOUT" && r.reason !== "CANCELLED" && r.latencyMs !== null).map(r => r.latencyMs!).sort((a, b) => a - b);
  const median = completed.length ? (completed[Math.floor((completed.length - 1) / 2)]! + completed[Math.floor(completed.length / 2)]!) / 2 : null;
  const reasons = rows.map(r => r.reason).filter((x): x is string => Boolean(x));
  const calls = rows.filter(r => r.remoteCalls);
  return { cases: rows.length, parsed: parsed.length, gateValid: accepted.length,
    gateValidNonabstaining: accepted.filter(r => r.nonabstaining).length,
    primarySuccess: primary.length, primaryRate: rows.length ? primary.length / rows.length : null,
    primaryDefinition: "GATE_VALID_AND_NONABSTAINING_AND_ALL_THREE_AUTHOR_LABEL_SETS_HIT",
    rawAllLabelSetHits: parsed.filter(r => r.allLabelSetsHit).length, rawDenominator: parsed.length,
    parsedRefusals: parsed.filter(r => r.refusal).length,
    fallbackReasons: Object.fromEntries([...new Set(reasons)].map(reason => [reason, reasons.filter(x => x === reason).length])),
    remoteCalls: calls.reduce((sum, r) => sum + r.remoteCalls, 0),
    latency: { completedSamples: completed.length, completedP50MsDescriptive: median, timeouts: rows.filter(r => r.reason === "TIMEOUT").length,
      p95Ms: null, p99Ms: null, note: "Timeouts are right-censored; tiny non-randomized samples cannot establish reliable tail latency." },
    usage: { inputTokens: calls.some(r => r.usage.inputTokens === null) ? null : calls.reduce((s, r) => s + (r.usage.inputTokens ?? 0), 0),
      outputTokens: calls.some(r => r.usage.outputTokens === null) ? null : calls.reduce((s, r) => s + (r.usage.outputTokens ?? 0), 0),
      knownCostUsd: calls.filter(r => r.usage.costUsd !== null).reduce((s, r) => s + r.usage.costUsd!, 0), unknownCostCalls: calls.filter(r => r.usage.costUsd === null).length },
    professionalQuality: "NOT_MEASURED_NO_COACH_LABELS", confidenceInterval: null,
    uncertainty: "At most six new proxy scenario groups; no stable population-quality interval or acceptance threshold is inferred." };
}

export async function runSemanticsEvaluation(options: SemanticsEvalOptions) {
  const frozen = verifySemanticsDataset();
  assert.equal(frozen.sha256, FROZEN_DATASET_SHA256, "FROZEN_DATASET_CHANGED_START_A_NEW_VERSION_BEFORE_LIVE");
  const selected = decisionSemanticsEvalCases.filter(c => c.split === options.split);
  const plan = selected.flatMap(item => ARMS.map(arm => { const packet = arm === "OLD_JEV" ? item.legacyPacket : item.packet; const body = buildJevHttpBody(packet);
    return { caseId: item.id, group: item.group, arm, packetSha256: sha(packet), canonicalBodySha256: sha(body), questions: Object.keys(body.questions).length }; }));
  const common = { version: "decision-semantics-eval.v1", generatedAt: new Date().toISOString(), split: options.split, frozenDataset: frozen,
    configuredVersions: V, requestTimeoutMs: TIMEOUT_MS, totalDeadlineMs: TOTAL_MS, maximumCalls: options.maxCalls, plannedCalls: plan.length,
    comparison: "Old Jev uses exactly the same source-derived metadata and checked facts but intentionally drops semantic. New Jev and generation share v4 state and six questions. This compares a combined projection/protocol revision, not separate causal attribution to each change.",
    productionAcceptance: "DISABLED_UNVALIDATED_PROXY_LABELS", plan };
  if (!options.live) return { ...common, mode: "OFFLINE_PLAN", remoteCalls: 0 };
  assert(options.keyStdin && options.generationEnvFile, "MISSING_LIVE_SETTINGS");
  const controller = new AbortController(), started = performance.now();
  const timer = setTimeout(() => controller.abort(), TOTAL_MS);
  let jevKey = "";
  let generation: Awaited<ReturnType<typeof readGenerationSettings>> | undefined;
  let remoteCalls = 0;
  const rows: Row[] = [];
  try {
    // Each input helper is bounded; neither reads or prints unrelated environment values.
    const settingsFile = statSync(options.generationEnvFile);
    assert(settingsFile.isFile() && settingsFile.size <= 65536, "SETTINGS_MUST_BE_A_BOUNDED_REGULAR_FILE");
    jevKey = await readJevKeyLine(process.stdin);
    generation = await readGenerationSettings(options.generationEnvFile);
    for (const item of selected) for (const arm of ARMS) {
      const packet = arm === "OLD_JEV" ? item.legacyPacket : item.packet;
      const canonical = buildJevHttpBody(packet);
      let callCount = 0, actualRequestSha256: string | null = null;
      let attempt: DecisionProviderAttempt;
      if (controller.signal.aborted || remoteCalls >= options.maxCalls) {
        attempt = { status: "FALLBACK", reason: controller.signal.aborted ? "TOTAL_DEADLINE" : "REQUEST_BUDGET", latencyMs: 0, usage: { inputTokens: null, outputTokens: null, costUsd: null } };
      } else {
        const fetcher: typeof fetch = async (url, init) => {
          assert.equal(init?.method, "POST");
          assert(!controller.signal.aborted && remoteCalls < options.maxCalls && callCount === 0, "REMOTE_BUDGET_OR_RETRY");
          const serialized = String(init.body), body = JSON.parse(serialized);
          if (arm === "GENERATION_MODEL") {
            assert.equal(String(url), "https://api.deepseek.com/chat/completions");
            const user = JSON.parse(body.messages[1].content);
            assert.deepEqual(user.state, packet); assert.deepEqual(user.questions, canonical.questions);
            assert.equal(body.model, generation!.DEEPSEEK_MODEL);
          } else {
            assert.equal(String(url), "https://api.typesafe.ai/v1/systemone"); assert.deepEqual(body, canonical);
          }
          actualRequestSha256 = sha(body); remoteCalls++; callCount++;
          return fetch(url, init);
        };
        try {
          const opts = { fetcher, signal: controller.signal, timeoutMs: TIMEOUT_MS };
          attempt = arm === "GENERATION_MODEL" ? await compareWithGenerationModel(packet, generation, opts) : await assessWithJev(packet, { JEV_API_KEY: jevKey }, opts);
        } catch { attempt = { status: "FALLBACK", reason: "PROVIDER_THROW", latencyMs: 0, usage: { inputTokens: null, outputTokens: null, costUsd: null } }; }
      }
      const model = attempt.actualModel ?? (attempt.result ?? attempt.diagnosticResult)?.model ?? null;
      rows.push({ caseId: item.id, group: item.group, split: item.split, arm,
        packetSha256: sha(packet), canonicalBodySha256: sha(canonical), actualRequestSha256,
        status: attempt.status, reason: attempt.reason ? safeReason(attempt.reason) : null, actualModel: model, remoteCalls: callCount,
        latencyMs: callCount ? attempt.latencyMs : null, usage: attempt.usage, result: attempt.result ?? null, diagnosticResult: attempt.diagnosticResult ?? null,
        ...classifySemanticsResult(item, packet, attempt, arm === "GENERATION_MODEL" ? model ?? generation.DEEPSEEK_MODEL : undefined) });
    }
    const rules = selected.map(item => ({ caseId: item.id, provenance: "DETERMINISTIC_PROXY_NOT_GOLD", result: ruleDecisionAssessment(item.packet) }));
    return { ...common, mode: "LIVE_COMPARISON", elapsedMs: Math.round(performance.now() - started), remoteCalls, comparisonComplete: remoteCalls === plan.length,
      configuredGenerationModel: generation.DEEPSEEK_MODEL, rules,
      summaries: Object.fromEntries(ARMS.map(arm => [arm, summarize(rows.filter(row => row.arm === arm))])), rows };
  } finally { clearTimeout(timer); jevKey = ""; if (generation) generation.DEEPSEEK_API_KEY = ""; }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { const report = await runSemanticsEvaluation(parseSemanticsEvalOptions(process.argv.slice(2))); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); }
  catch { process.stderr.write(JSON.stringify({ status: "FAIL", code: "SEMANTICS_EVAL_FAILED_NO_SECRET_DETAILS" }) + "\n"); process.exitCode = 1; }
}
