import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { decisionAssessmentEvalCases } from "../libs/review-planner/src/decision-assessment-fixtures.ts";
import { decisionAssessmentFingerprint } from "../libs/review-planner/src/decision-assessment.ts";

const root = resolve(import.meta.dirname, "..");
const run = args => spawnSync(process.execPath, ["--import", "tsx", "tools/compare-jev-deadlines.ts", ...args], { cwd: root, encoding: "utf8", timeout: 10000 });
describe("bounded generation deadline diagnostic", () => {
  it("plans only unique actual timeout attempts and never requests credentials offline", () => {
    const folder = mkdtempSync(join(root, ".local-data/deadline-test-"));
    try {
      const c = decisionAssessmentEvalCases[0];
      const row = { provider: "GENERATION_MODEL", caseId: c.id, packetFingerprint: decisionAssessmentFingerprint(c.packet), reason: "TIMEOUT", remoteCall: true };
      const prior = join(folder, "prior.json");
      writeFileSync(prior, JSON.stringify({ version: "decision-assessment-eval.v2", budget: { requestTimeoutMs: 3000 }, rows: [row, { ...row, remoteCall: false }] }));
      const result = run([`--prior=${prior}`, `--out=${join(folder, "report.json")}`]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ mode: "OFFLINE_PLAN", maximumCalls: 1, selectedCases: [c.id], requestTimeoutMs: 10000 });
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it("rejects a symlink output escaping the worktree without touching its target", () => {
    const folder = mkdtempSync(join(root, ".local-data/deadline-test-"));
    const external = mkdtempSync(join(tmpdir(), "jev-deadline-target-"));
    try {
      const target = join(external, "keep.json"); writeFileSync(target, "KEEP");
      const output = join(folder, "escape.json"); symlinkSync(target, output);
      const result = run([`--out=${output}`]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("OUTPUT_MUST_NOT_ESCAPE_WORKTREE");
      expect(readFileSync(target, "utf8")).toBe("KEEP");
    } finally { rmSync(folder, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); }
  });
});
