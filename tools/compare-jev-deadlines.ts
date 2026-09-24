/** Offline diagnostic only: replay timed-out generation comparisons with a fixed 10s deadline.
 * Preserves the original 3s results; never modifies product timeouts or sends labels/outcomes. */
import assert from "node:assert/strict";
import { createReadStream, readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseEnv } from "node:util";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decisionAssessmentEvalCases } from "../libs/review-planner/src/decision-assessment-fixtures.ts";
import { decisionAssessmentFingerprint, validateDecisionAssessmentResult } from "../libs/review-planner/src/decision-assessment.ts";
import { compareWithGenerationModel, buildJevHttpBody } from "../apps/web/lib/coaching/jev-decision-assessment.ts";
import { createHash } from "node:crypto";

const workspace = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const args = process.argv.slice(2);
const option = (name: string) => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
const live = args.includes("--live");
if (args.some(a => a !== "--live" && !["--prior", "--out", "--generation-env-file"].some(n => a.startsWith(`${n}=`)))) throw new Error("INVALID_ARGS");
const priorPath = resolve(option("--prior") ?? "docs/validation/JEV_PAIRED_SYNTHETIC_LIVE.json");
const outputPath = resolve(option("--out") ?? "docs/validation/JEV_GENERATION_DEADLINE_DIAGNOSTIC.json");
function owned(path: string) { const rel = relative(workspace, path); return !!rel && !rel.startsWith("..") && !isAbsolute(rel); }
assert(owned(outputPath) && owned(realpathSync(dirname(outputPath))), "OUTPUT_MUST_BE_IN_WORKTREE");
assert(!existsSync(outputPath) || owned(realpathSync(outputPath)), "OUTPUT_MUST_NOT_ESCAPE_WORKTREE");
const prior = JSON.parse(readFileSync(priorPath, "utf8"));
assert.equal(prior.version, "decision-assessment-eval.v2");
assert.equal(prior.budget.requestTimeoutMs, 3000);
const rows = prior.rows.filter((r: { provider: string; reason: string; remoteCall: boolean }) => r.provider === "GENERATION_MODEL" && r.reason === "TIMEOUT" && r.remoteCall);
assert(rows.length > 0 && rows.length <= 5, "EXPECTED_ONE_TO_FIVE_DISTINCT_TIMEOUTS");
const cases = rows.map((r: { caseId: string; packetFingerprint: string }) => {
  const c = decisionAssessmentEvalCases.find(c => c.id === r.caseId);
  assert(c && decisionAssessmentFingerprint(c.packet) === r.packetFingerprint, "INPUT_CHANGED_SINCE_BASELINE");
  return c;
});
assert.equal(new Set(cases.map((c: typeof decisionAssessmentEvalCases[number]) => decisionAssessmentFingerprint(c.packet))).size, cases.length, "DUPLICATE_INPUT_ATTEMPTS");
const selectedCases = cases.map((c: typeof decisionAssessmentEvalCases[number]) => c.id);
if (!live) { process.stdout.write(JSON.stringify({ mode: "OFFLINE_PLAN", selectedCases, maximumCalls: cases.length, requestTimeoutMs: 10000 }) + "\n"); }
else {
  const configPath = option("--generation-env-file"); assert(configPath, "EXPLICIT_GENERATION_SETTINGS_REQUIRED");
  const env: { DEEPSEEK_API_KEY?: string; DEEPSEEK_MODEL?: string } = {};
  const stream = createReadStream(configPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0;
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line); assert(bytes <= 65536, "SETTINGS_TOO_LARGE");
      if (!/^\s*(?:export\s+)?(?:DEEPSEEK_API_KEY|DEEPSEEK_MODEL)\s*=/.test(line)) continue;
      const named = parseEnv(line);
      for (const field of ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"] as const) if (named[field] !== undefined) {
        const value = named[field]; assert(value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value), "INVALID_SETTINGS"); env[field] ||= value;
      }
      if (env.DEEPSEEK_API_KEY && env.DEEPSEEK_MODEL) break;
    }
  } finally { lines.close(); stream.destroy(); }
  assert(env.DEEPSEEK_API_KEY && env.DEEPSEEK_MODEL, "MISSING_NAMED_SETTINGS");
  assert.equal(env.DEEPSEEK_MODEL, prior.configuredGenerationModel, "MODEL_CHANGED_SINCE_BASELINE");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 600000);
  const results = []; let remoteCalls = 0;
  const start = performance.now();
  try {
    for (const c of cases) {
      assert(!controller.signal.aborted);
      const canonicalBody = buildJevHttpBody(c.packet);
      const packetFingerprint = decisionAssessmentFingerprint(c.packet);
      const attempt = await compareWithGenerationModel(c.packet, env, { timeoutMs: 10000, signal: controller.signal, fetcher: async (url, init) => {
        assert.equal(String(url), "https://api.deepseek.com/chat/completions");
        const body = JSON.parse(String(init?.body));
        const userInput = JSON.parse(body.messages[1].content);
        assert.deepEqual(userInput.state, c.packet); assert.deepEqual(userInput.questions, canonicalBody.questions);
        assert.equal(body.model, env.DEEPSEEK_MODEL); assert(remoteCalls < 5); remoteCalls++;
        return fetch(url, init);
      } });
      const output = attempt.result ?? attempt.diagnosticResult;
      const checked = output ? validateDecisionAssessmentResult(c.packet, output, { allowedModel: output.model }) : undefined;
      results.push({ caseId: c.id, demoGroup: c.demoGroup, provenance: c.provenance, packetFingerprint,
        canonicalBodySha256: createHash("sha256").update(JSON.stringify(canonicalBody)).digest("hex"),
        originalReason: "TIMEOUT", originalDeadlineMs: 3000, diagnosticDeadlineMs: 10000, ...attempt,
        parsed: Boolean(output), valid: checked?.valid ?? false,
        authorExpectationMatch: output ? { risk: c.acceptableLabels.includes(output.riskWarranted.choice), alternative: c.acceptableAlternatives.includes(output.alternativePreferable.choice), sufficiency: c.acceptableSufficiency.includes(output.contextSufficient.choice) } : null });
    }
  } finally { clearTimeout(timer); env.DEEPSEEK_API_KEY = undefined; }
  const report = { version: "jev-generation-deadline-diagnostic.v1", generatedAt: new Date().toISOString(), purpose: "DIAGNOSTIC_ONLY_NOT_PRODUCTION_TIMEOUT_CHANGE", configuredGenerationModel: env.DEEPSEEK_MODEL,
    remoteCalls, elapsedMs: Math.round(performance.now() - start), requestTimeoutMs: 10000, selectedCases, priorReportCreatedAt: prior.createdAt, expertLabels: 0, rows: results };
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ status: "COMPLETE", remoteCalls, cases: results.length, parsed: results.filter(r => r.parsed).length, valid: results.filter(r => r.valid).length }) + "\n");
}
