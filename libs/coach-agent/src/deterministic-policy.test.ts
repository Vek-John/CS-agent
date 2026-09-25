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

it("selects factual replay for a current judgment without inventing a timing judgment", () => {
  const input = policyInput();
  input.narrationSummary.primaryFocusCode = "REVIEW_UNCERTAINTY";
  input.capabilities = [{ ...input.capabilities[0], presentationPurpose: "ACTION_FACT_REPLAY" }];
  expect(deterministicPolicyOutput(input)).toMatchObject({ action: "SELECT_CAPABILITY", rationaleCode: "RECORDED_ACTION_NEEDS_REPLAY" });
  input.allowedEvidenceSummary = [{ namespace: "DECISION", refs: ["action-memory"] }];
  expect(deterministicPolicyOutput(input).action).toBe("FINISH_CUE");
});

it("requires current focus and matching purpose even with memory hints", () => {
  const input = policyInput({ schemaVersion: "memory-brief.v1", generatedAt: "2026-08-28T00:00:00.000Z", corrections: [{}], activeThreads: [], memories: [], limitations: [], source: "STRUCTURED" });
  input.capabilities = [{ ...input.capabilities[0], presentationPurpose: "ACTION_FACT_REPLAY" }];
  expect(deterministicPolicyOutput(input).action).toBe("FINISH_CUE");
  input.narrationSummary.primaryFocusCode = "REVIEW_UNCERTAINTY";
  delete input.capabilities[0].presentationPurpose;
  expect(deterministicPolicyOutput(input).action).toBe("FINISH_CUE");
});
