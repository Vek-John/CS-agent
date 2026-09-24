import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createRealJevProbe, readJevKeyLine } from "./jev-real-live.ts";
import { optionsFromArgs } from "./verify-jev-real-smoke.ts";
import { decisionAssessmentEvalCases } from "../libs/review-planner/src/decision-assessment-fixtures.ts";
import { buildJevHttpBody } from "../apps/web/lib/coaching/jev-decision-assessment.ts";

describe("real-Demo probe control boundaries (synthetic inputs, mocked HTTP only)", () => {
  it("defaults offline and requires explicit stdin plus a budget of at most five", () => {
    const args = ["--demo", "/tmp/unused.dem", "--parser-dir", "/tmp/unused"];
    expect(optionsFromArgs(args)).toMatchObject({ live: false, keyStdin: false, maxCalls: 0 });
    expect(optionsFromArgs([...args, "--live", "--key-stdin", "--max-calls", "5"])).toMatchObject({ live: true, maxCalls: 5 });
    for (const extra of [["--live"], ["--key-stdin"], ["--live", "--key-stdin", "--max-calls", "6"], ["--live", "--key-stdin", "--max-calls", "0"], ["--max-calls", "1"], ["--out", "/tmp/forbidden.json"]]) expect(() => optionsFromArgs([...args, ...extra])).toThrow();
  });
  it("reads only a bounded stdin line without env or file fallback", async () => {
    const input = new PassThrough(); const pending = readJevKeyLine(input, 100);
    input.write("fake-test-credential\n");
    expect(await pending).toBe("fake-test-credential");
    expect(Object.values(process.env)).not.toContain("fake-test-credential"); input.destroy();
    const long = new PassThrough(); const invalid = readJevKeyLine(long, 100); long.write("x".repeat(515));
    await expect(invalid).rejects.toThrow("INVALID_OR_MISSING_STDIN_KEY"); long.destroy();
    const empty = new PassThrough(); await expect(readJevKeyLine(empty, 5)).rejects.toThrow("INVALID_OR_MISSING_STDIN_KEY"); empty.destroy();
  });
  it("caps actual transport globally and deduplicates without serializing credentials or packet bindings", async () => {
    const remote = vi.fn(async () => Response.json({}, { status: 429 }));
    const probe = createRealJevProbe({ apiKey: "fake-test-credential", maxCalls: 2, fetcher: remote });
    const original = structuredClone(decisionAssessmentEvalCases[2].packet);
    await probe.assessPacket(original); await probe.assessPacket(original);
    await probe.assessPacket({ ...original, action: { ...original.action, durationSeconds: 0.25 } });
    expect((await probe.assessPacket({ ...original, action: { ...original.action, durationSeconds: 0.5 } })).reason).toBe("GLOBAL_REAL_SMOKE_BUDGET");
    expect(remote).toHaveBeenCalledTimes(2);
    const summary = probe.summary(); expect(summary).toMatchObject({ attempts: 2, remoteCalls: 2, deduplicated: 1, budgetSkipped: 1, latencyMs: { p95: null, p99: null } });
    expect(JSON.stringify(summary)).not.toMatch(/fake-test-credential|authorization|packetFingerprint|playerId|candidateId/);
    expect(summary.requestRecords[0]).toMatchObject({ whitelistPassed: true, reason: "HTTP_429" }); probe.dispose();
  });
  it("records parsed response version, tokens and cost while keeping generation deterministic", async () => {
    const remote = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body)); const expected = buildJevHttpBody(body.state);
      const answers = Object.fromEntries(Object.entries(expected.questions).map(([key, question]) => {
        const chosen = key === "riskWarranted" || key === "alternativePreferable" ? "UNKNOWN" : key === "contextSufficient" ? "INSUFFICIENT" : key === "limitation" ? "MISSING_CONTEXT" : "UNSUPPORTED";
        return [key, { type: "choice", choice: chosen, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(c => [c, c === chosen ? 1 : 0])) }];
      }));
      return Response.json({ model: body.model, answers, usage: { input_tokens: 100, output_tokens: 10 } });
    });
    const probe = createRealJevProbe({ apiKey: "fake-test-credential", maxCalls: 1, fetcher: remote });
    await probe.assessPacket(decisionAssessmentEvalCases[2].packet);
    expect(probe.summary().requestRecords[0]).toMatchObject({ status: "SUCCEEDED", reason: null, returnedModel: "jev-1.13.0", usage: { inputTokens: 100, outputTokens: 10 } });
    expect(probe.summary().requestRecords[0].usage.costUsd).toBeCloseTo(0.0000042, 12);
    probe.dispose();
  });
});
