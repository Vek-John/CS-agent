import test from "node:test";
import assert from "node:assert/strict";
import { FROZEN_DATASET_SHA256, classifySemanticsResult, parseSemanticsEvalOptions, runSemanticsEvaluation, verifySemanticsDataset } from "./eval-decision-semantics.ts";
import { decisionSemanticsEvalCases, legacyDecisionSemanticsPacket } from "../libs/review-planner/src/decision-semantics-eval-fixtures.ts";
import { ruleDecisionAssessment } from "../libs/review-planner/src/decision-assessment.ts";

test("dataset is frozen with disjoint development/holdout sources before live calls", () => {
  const manifest = verifySemanticsDataset();
  assert.equal(manifest.sha256, FROZEN_DATASET_SHA256);
  assert.equal(manifest.developmentCases, 3); assert.equal(manifest.holdoutCases, 6);
  assert.equal(manifest.groups, 9); assert.equal(manifest.expertLabels, 0);
});
test("default plans make zero calls and reserve nine development requests", async () => {
  const plan = await runSemanticsEvaluation(parseSemanticsEvalOptions([]));
  assert.equal(plan.mode, "OFFLINE_PLAN"); assert.equal(plan.remoteCalls, 0);
  assert.equal(plan.plannedCalls, 9); assert.equal(plan.maximumCalls, 9);
  assert(plan.plan.filter(x => x.arm !== "OLD_JEV").every(x => x.questions === 6));
  const holdout = await runSemanticsEvaluation(parseSemanticsEvalOptions(["--split=holdout"]));
  assert.equal(holdout.plannedCalls, 18); assert.equal(holdout.remoteCalls, 0);
});
test("live intent, key input, named settings and bounded budgets must be explicit", () => {
  for (const args of [["--live"], ["--key-stdin"], ["--generation-env-file=secret"], ["--max-calls=101"], ["--max-calls=11"], ["--split=unknown"], ["--split=holdout", "--split=development"]]) {
    assert.throws(() => parseSemanticsEvalOptions(args));
  }
  assert.equal(parseSemanticsEvalOptions(["--live", "--key-stdin", "--generation-env-file=named-settings", "--max-calls=9"]).maxCalls, 9);
});
test("old and new packets differ only by semantic projection/version, never local labels", () => {
  for (const item of decisionSemanticsEvalCases) {
    assert.deepEqual(legacyDecisionSemanticsPacket(item.packet), item.legacyPacket);
    assert(!JSON.stringify(item.packet).includes("AGENT_AUTHORED_PROXY"));
    assert(!JSON.stringify(item.packet).includes(item.description));
    assert(!JSON.stringify(item.packet).includes("acceptable"));
  }
});
test("primary success requires validated witnesses, non-abstention and all author sets", () => {
  const item = decisionSemanticsEvalCases[0]!;
  const result = ruleDecisionAssessment(item.packet);
  const attempt = { status: "SUCCEEDED" as const, result, latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  assert.equal(classifySemanticsResult(item, item.packet, attempt).primarySuccess, true);
  const invalid = { ...result, riskWarranted: { ...result.riskWarranted, refs: [] } };
  const diagnostic = classifySemanticsResult(item, item.packet, { ...attempt, status: "FALLBACK", result: undefined, diagnosticResult: invalid });
  assert.equal(diagnostic.parsed, true); assert.equal(diagnostic.allLabelSetsHit, true); assert.equal(diagnostic.primarySuccess, false);
  assert(diagnostic.rejectionReasons.length > 0);
  const returning = decisionSemanticsEvalCases[2]!;
  const refusal = classifySemanticsResult(returning, returning.packet, { ...attempt, result: ruleDecisionAssessment(returning.packet) });
  assert.equal(refusal.gateValid, true); assert.equal(refusal.allLabelSetsHit, true); assert.equal(refusal.nonabstaining, false); assert.equal(refusal.primarySuccess, false);
});
