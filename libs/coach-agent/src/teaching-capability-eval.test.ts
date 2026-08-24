import { describe, expect, it } from "vitest";
import {
  formatTeachingCapabilityEval,
  runTeachingCapabilityEval,
  teachingCapabilityEvalCases,
} from "./teaching-capability-eval";
import type { PolicyInput } from "./types";

describe("teaching capability eval runner", () => {
  it("executes deterministic Policy selection separately from legal capability generation", async () => {
    expect(teachingCapabilityEvalCases).toHaveLength(23);
    const stats = await runTeachingCapabilityEval();
    expect(stats).toMatchObject({
      totalCases: 23,
      needToolAccuracy: 100,
      preferredCapabilityAccuracyWhenNeeded: 100,
      illegalSelectionAccuracy: 100,
      requiredEvidenceAccuracy: 100,
      legalCapabilityAccuracy: 100,
      policySelectionCount: 12,
      finishSelectionCount: 11,
    });
    expect(stats.illegalSelectionAccuracy).toBe(100);
    expect(stats.requiredEvidenceAccuracy).toBe(100);
    expect(stats.legalCapabilityAccuracy).toBe(100);
    expect(stats.policySelectionCount).toBeGreaterThan(0);
    expect(stats.finishSelectionCount).toBeGreaterThan(0);
    expect(formatTeachingCapabilityEval(stats)).toContain("illegal=0%");
  });

  it("accepts a legal alternative only when the injected Policy selects it", async () => {
    const testCase = teachingCapabilityEvalCases.find((item) => item.id === "multi-position-policy");
    if (!testCase) throw new Error("multi-position-policy fixture missing");
    const policy = {
      async selectCapability(input: PolicyInput) {
        const slow = input.capabilities.find((capability) => capability.tool === "REPLAY_CUE_SLOW");
        if (!slow) throw new Error("slow alternative missing");
        return {
          action: "SELECT_CAPABILITY" as const,
          capabilityId: slow.capabilityId,
          evidenceRefs: slow.evidenceRefs.slice(0, 1),
          rationaleCode: "TIMING_NEEDS_SLOW_REPLAY" as const,
          confidence: 0.7,
        };
      },
    };
    const stats = await runTeachingCapabilityEval([testCase], policy);
    expect(stats.needToolAccuracy).toBe(100);
    expect(stats.preferredCapabilityAccuracyWhenNeeded).toBe(100);
    expect(stats.illegalSelectionAccuracy).toBe(100);
  });
});
