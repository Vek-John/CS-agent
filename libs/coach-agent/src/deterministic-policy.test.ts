import { describe, expect, it } from "vitest";
import { deterministicPolicyOutput } from "./deterministic-policy";
import { PolicyInputSchema } from "./types";

function policyInput(memoryBrief?: unknown) {
  const field = { text: "", refs: [], limitations: [] };
  return PolicyInputSchema.parse({
    cueId: "cue-memory",
    focus: "UNKNOWN_FOCUS",
    narrationSummary: {
      primaryFocusCode: "UNKNOWN_FOCUS",
      readiness: "READY",
      limitationCount: 0,
      fields: {
        currentSituation: field,
        playerAction: field,
        coreIssue: field,
        betterPlay: field,
        outcomeImpact: field,
      },
    },
    allowedEvidenceSummary: [
      { namespace: "ACTION", refs: ["action-memory"] },
      { namespace: "EVIDENCE", refs: ["evidence-memory"] },
    ],
    phase: "PAUSED_FOR_COACHING",
    outcomeGateStatus: "COMPLETE",
    capabilities: [
      { capabilityId: "cap-memory-replay", tool: "REPLAY_CUE_SLOW", evidenceRefs: ["action-memory"], estimatedDurationMs: 1_000 },
      { capabilityId: "cap-memory-map", tool: "FOCUS_MAP_EVIDENCE", evidenceRefs: ["evidence-memory"], estimatedDurationMs: 1_000 },
    ],
    toolObservations: [],
    themes: [],
    ...(memoryBrief === undefined ? {} : { memoryBrief }),
    limitations: [],
    budget: { policyCalls: 0, maxPolicyCalls: 1, alternativeAttempts: 0, maxAlternativeAttempts: 1 },
    maxMoves: 1,
  });
}

describe("deterministic memory-aware policy", () => {
  it("uses a prior cross-Demo thread to choose an evidence re-check fallback", () => {
    const output = deterministicPolicyOutput(policyInput({
      schemaVersion: "memory-brief.v1",
      generatedAt: "2026-08-28T00:00:00.000Z",
      activeThreads: [{ scope: "CROSS_DEMO", status: "STABLE", diagnosis: { summary: "transfer" } }],
      memories: [],
      corrections: [],
      limitations: [],
      source: "STRUCTURED",
    }));
    expect(output).toMatchObject({ action: "SELECT_CAPABILITY", capabilityId: "cap-memory-replay" });
  });

  it("keeps the normal evidence tie behavior when no memory hint is present", () => {
    expect(deterministicPolicyOutput(policyInput())).toMatchObject({ action: "FINISH_CUE" });
  });
});
