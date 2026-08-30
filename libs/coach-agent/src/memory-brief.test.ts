import { describe, expect, it } from "vitest";
import {
  CoachAgentStateSchema,
  MemoryBriefWireSchema,
  StartCueEventSchema,
} from "./types";
import { fixtureIdentity, startCueEvent } from "./test-fixtures";

const brief = {
  schemaVersion: "memory-brief.v1",
  generatedAt: "2026-08-28T00:00:00.000Z",
  activeThreads: [],
  memories: [],
  corrections: [],
  limitations: [],
  source: "EMPTY",
  structuredStatus: "EMPTY",
  semanticStatus: "OPTIONAL",
};

describe("Coach Agent Memory Brief seam", () => {
  it("accepts a bounded read-only brief on START_CUE and keeps old fixtures valid", () => {
    const event = StartCueEventSchema.parse({
      ...startCueEvent({ identity: { ...fixtureIdentity, sessionId: "brief-wire" } }),
      memoryBrief: brief,
    });
    expect(event.memoryBrief).toEqual(brief);
    expect(StartCueEventSchema.parse(startCueEvent()).memoryBrief).toBeUndefined();
  });

  it("rejects invalid or over-limit brief projections", () => {
    expect(MemoryBriefWireSchema.safeParse({ ...brief, source: "RAW_MEMORY" }).success).toBe(false);
    expect(MemoryBriefWireSchema.safeParse({
      ...brief,
      memories: [{}, {}, {}, {}],
    }).success).toBe(false);
    expect(MemoryBriefWireSchema.safeParse({
      ...brief,
      limitations: ["x".repeat(17_000)],
    }).success).toBe(false);
  });

  it("omits memoryBrief in legacy/feature-off state checkpoints", () => {
    const state = CoachAgentStateSchema.parse({
      schemaVersion: "coach-agent-state.v3",
      graphVersion: "coach-agent-graph.v3",
      runId: "run-brief",
      sessionId: "session-brief",
      demoId: "demo-brief",
      demoContentHash: "sha256-brief",
      selectedPlayerId: "player-brief",
      routeId: "route-brief",
      routeHash: "sha256-route-brief",
      sessionStatus: "ACTIVE",
      runStatus: "RUNNING",
      activeSegmentId: null,
      activeCueId: null,
      routeCursor: -1,
      currentSegmentMode: null,
      activeFocus: null,
      activeNarrationPolicySummary: null,
      activeAllowedEvidenceSummary: [],
      observedSegmentIds: [],
      currentSessionPhase: "INTRO",
      outcomeGateStatus: "NOT_APPLICABLE",
      narrationReadiness: "NOT_REQUIRED",
      availableCapabilities: [],
      selectedTeachingMove: null,
      pendingToolCall: null,
      toolHistory: [],
      completedCueIds: [],
      completedCueSummaries: [],
      sessionThemes: [],
      summaryThemes: [],
      sessionSummaryInput: null,
      sessionSummaryFallback: null,
      policyBudget: { policyCalls: 0, maxPolicyCalls: 1, alternativeAttempts: 0, maxAlternativeAttempts: 1 },
      fallbackReasons: [],
      lastStableCheckpoint: { checkpointId: null, sequence: 0 },
      traceSummary: { entryCount: 0, lastNode: null, lastInputHash: null, lastFinalStatus: null },
      processedEventIds: [],
      trace: [],
      lastToolResult: null,
    });
    expect(state.memoryBrief).toBeUndefined();
    expect(state).not.toHaveProperty("memoryBrief");
    expect(JSON.stringify(state)).not.toContain("memoryBrief");
  });
});
