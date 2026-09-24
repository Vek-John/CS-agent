import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseOptions, parseHistory, readGenerationSettings, validateMatches } from "./compare-jev-existing.ts";
import { decisionAssessmentEvalCases } from "../libs/review-planner/src/decision-assessment-fixtures.ts";
import { buildJevHttpBody } from "../apps/web/lib/coaching/jev-decision-assessment.ts";
import { parseDecisionAssessmentPacket } from "../libs/review-planner/src/decision-assessment.ts";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture() {
  const packets = Array.from({ length: 5 }, (_, index) => {
    const packet = structuredClone(decisionAssessmentEvalCases[2].packet);
    packet.action.durationSeconds = (index + 1) / 10;
    return parseDecisionAssessmentPacket(packet);
  });
  const rows = packets.map(packet => ({ bodySha256: hash(buildJevHttpBody(packet)), stateSha256: hash(packet),
    projectionVersion: packet.projectionVersion, questionVersion: packet.questionVersion, requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0", status: "SUCCEEDED", whitelistPassed: true,
    choices: { riskWarranted: "UNKNOWN", alternativePreferable: "UNKNOWN", contextSufficient: "INSUFFICIENT" }, modelConfidence: 0.9, latencyMs: 100, usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 } }));
  const history = parseHistory({ schemaVersion: "jev-real-smoke.v1", status: "PASS", source: "CANONICAL_DEMO", execution: "LIVE_JEV_WITH_DETERMINISTIC_DIRECTOR_NARRATOR", remoteModelCalls: 5,
    generatedAt: "2026-09-23T00:00:00.000Z", demoSha256: "a".repeat(64), parserWasmSha256: "b".repeat(64), parserJsSha256: "c".repeat(64), live: { requestRecords: rows } });
  return { history, matches: packets.map((packet, index) => ({ packet, bodySha256: rows[index].bodySha256, baselineAssessmentKind: "INSUFFICIENT_EVIDENCE" })) };
}

describe("historical comparison boundaries (synthetic test material only)", () => {
  it("is offline by default and requires explicit file plus a bounded budget for live", () => {
    const args = ["--demo", "/tmp/example.dem", "--parser-dir", "/tmp/parser"];
    expect(parseOptions(args).live).toBe(false);
    expect(() => parseOptions([...args, "--live"])).toThrow();
    expect(parseOptions([...args, "--live", "--generation-env-file=/tmp/named.env"]).maxCalls).toBe(5);
    expect(() => parseOptions([...args, "--max-calls=6"])).toThrow();
    expect(() => parseOptions([...args, "--out=/tmp/escape.json"])).toThrow();
  });
  it("requires all five exact state/body/model/question matches and only anonymous packet fields", () => {
    const { history, matches } = fixture();
    expect(validateMatches(history, [...matches].reverse())).toEqual(matches);
    expect(() => validateMatches(history, matches.slice(0, 4))).toThrow();
    expect(() => validateMatches(history, [matches[0], ...matches.slice(0, 4)])).toThrow();
    const changed = structuredClone(matches); changed[0].packet.action.durationSeconds = 1.9;
    expect(() => validateMatches(history, changed)).toThrow();
    expect(() => validateMatches(history, [{ ...matches[0], actorPlayerId: "forbidden" }, ...matches.slice(1)])).toThrow();
    const mismatchedVersion = structuredClone(history); mismatchedVersion.rows[0].questionVersion = "other";
    expect(() => validateMatches(mismatchedVersion, matches)).toThrow();
  });
  it("reads only the two named generation fields and never copies secrets into environment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-comparison-test-"));
    try {
      const path = join(directory, "settings.env");
      writeFileSync(path, "UNRELATED=ignore\nDEEPSEEK_API_KEY='fake-comparison-key'\nDEEPSEEK_MODEL=deepseek-v4-flash\nOTHER=ignore\n");
      expect(await readGenerationSettings(path)).toEqual({ DEEPSEEK_API_KEY: "fake-comparison-key", DEEPSEEK_MODEL: "deepseek-v4-flash" });
      expect(Object.values(process.env)).not.toContain("fake-comparison-key");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
