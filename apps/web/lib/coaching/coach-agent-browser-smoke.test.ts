import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgentToolRequestSchema,
  CoachAgentResultSchema,
  type CoachAgentResult,
} from "@cs-coach/coach-agent/client";
import {
  STAGE0_CUE_ID,
  STAGE0_PHASE,
  createStage0ResumeEvent,
  createStage0StartEvent,
  createWaitingBrowserSmokeResult,
  dispatchStage0Event,
  evaluateRemoteResumeResult,
  evaluateRemoteStartResult,
  parseStage0ToolRequest,
  serializeStage0ToolRequest,
  stage0BackendDescription,
  stage0PhaseFromSearch,
  toolRequestFromResult,
} from "./coach-agent-browser-smoke";

function fakeResult(
  options: {
    status?: "WAITING_TOOL" | "COMPLETED" | "DORMANT";
    backend?: "MEMORY" | "DURABLE_OBJECT";
    recoverableAfterRefresh?: boolean;
  } = {},
): CoachAgentResult {
  const event = createStage0StartEvent();
  const capability = event.capabilities[0];
  if (!capability) throw new Error("test capability missing");
  const status = options.status ?? "WAITING_TOOL";
  const isCompleted = status === "COMPLETED";
  const isDormant = status === "DORMANT";
  const request = AgentToolRequestSchema.parse({
    callId: "stage0-call",
    runId: event.identity.runId,
    cueId: event.cueId,
    capabilityId: capability.capabilityId,
    tool: capability.tool,
    evidenceRefs: capability.evidenceRefs,
  });
  const presentableSummary = {
    completionStatus: "COMPLETED" as const,
    presentationStatus: "PRESENTABLE" as const,
    cueId: event.cueId,
    roundId: "stage0-round",
    focus: event.focus,
    evidenceRefs: ["stage0-action-ref"],
    adviceRefs: [],
    economyContext: "UNKNOWN" as const,
    conflictEvidence: false,
  };
  const runStatus = isCompleted ? "CUE_COMPLETED" : status;
  const state = {
    schemaVersion: "coach-agent-state.v2",
    graphVersion: "coach-agent-graph.v2",
    ...event.identity,
    sessionStatus: "ACTIVE" as const,
    runStatus,
    activeSegmentId: isDormant ? null : event.segmentId,
    activeCueId: isDormant ? null : event.cueId,
    routeCursor: -1,
    currentSegmentMode: isDormant ? null : "DEEP_DIVE" as const,
    activeFocus: isDormant ? null : event.focus,
    activeNarrationPolicySummary: isDormant ? null : {
      primaryFocusCode: "STAGE0_FOCUS",
      readiness: "READY" as const,
      limitationCount: 1,
      fields: {
        currentSituation: { text: "", refs: [], limitations: [] },
        playerAction: { text: "", refs: ["stage0-action-ref"], limitations: [] },
        coreIssue: { text: "", refs: ["stage0-action-ref"], limitations: [] },
        betterPlay: { text: "", refs: ["stage0-action-ref"], limitations: [] },
        outcomeImpact: { text: "", refs: [], limitations: ["stage0 fixture has no outcome summary"] },
      },
    },
    activeAllowedEvidenceSummary: event.allowedEvidenceSummary,
    observedSegmentIds: [],
    currentSessionPhase: isDormant ? "DORMANT" : STAGE0_PHASE,
    outcomeGateStatus: isDormant ? "NOT_APPLICABLE" : "COMPLETE",
    narrationReadiness: isDormant ? "NOT_REQUIRED" : "READY",
    availableCapabilities: isDormant || isCompleted ? [] : [capability],
    selectedTeachingMove: null,
    pendingToolCall: status === "WAITING_TOOL" ? request : null,
    toolHistory: [],
    completedCueIds: isCompleted ? [STAGE0_CUE_ID] : [],
    completedCueSummaries: isCompleted ? [presentableSummary] : [],
    sessionThemes: [],
    summaryThemes: [],
    sessionSummaryInput: null,
    sessionSummaryFallback: null,
    policyBudget: {
      policyCalls: 0,
      maxPolicyCalls: 1,
      alternativeAttempts: 0,
      maxAlternativeAttempts: 1,
    },
    fallbackReasons: [],
    lastStableCheckpoint: { checkpointId: null, sequence: 0 },
    traceSummary: {
      entryCount: 0,
      lastNode: null,
      lastInputHash: null,
      lastFinalStatus: null,
    },
    processedEventIds: [],
    trace: [],
    lastToolResult: null,
  };
  return CoachAgentResultSchema.parse({
    version: "coach-agent-result.v1",
    status,
    identity: event.identity,
    state,
    effects: status === "WAITING_TOOL" ? [request] : [],
    trace: [],
    checkpoint: {
      backend: options.backend ?? "MEMORY",
      recoverableAfterRefresh:
        options.recoverableAfterRefresh ?? options.backend === "DURABLE_OBJECT",
    },
    restored: isCompleted ? "MATCHED" : "FRESH",
  });
}

describe("coach-agent remote browser smoke contract", () => {
  it("parses URL phase and starts with a deterministic WAITING report", () => {
    expect(stage0PhaseFromSearch("")).toBe("start");
    expect(stage0PhaseFromSearch("?phase=start")).toBe("start");
    expect(stage0PhaseFromSearch("?phase=resume")).toBe("resume");
    expect(stage0PhaseFromSearch("?phase=reset")).toBe("reset");

    const initial = createWaitingBrowserSmokeResult("reset");
    expect(initial.status).toBe("WAITING");
    expect(initial.phase).toBe("reset");
    expect(initial.backend).toBeNull();
    expect(initial.error).toBeNull();
  });

  it("posts the strict remote envelope and strictly parses CoachAgentResult", async () => {
    const event = createStage0StartEvent("stage0-remote-start");
    const expected = fakeResult();
    const result = await dispatchStage0Event(event, async (input, init) => {
      expect(input).toBe("/api/coaching/agent");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      const envelope = JSON.parse(String(init?.body)) as {
        schemaVersion: string;
        sessionId: string;
        event: { type: string; identity: { sessionId: string } };
      };
      expect(envelope.schemaVersion).toBe("coach-agent-remote-dispatch.v1");
      expect(envelope.sessionId).toBe(event.identity.sessionId);
      expect(envelope.event.type).toBe("START_CUE");
      expect(envelope.event.identity.sessionId).toBe(envelope.sessionId);
      return new Response(JSON.stringify(expected), { status: 200 });
    });

    expect(result).toEqual(expected);
    const request = toolRequestFromResult(result);
    expect(parseStage0ToolRequest(serializeStage0ToolRequest(request))).toEqual(request);
    expect(createStage0ResumeEvent(request).type).toBe("RESUME_TOOL");
  });

  it("keeps local Memory and Durable Object recovery semantics honest", () => {
    const local = evaluateRemoteStartResult(fakeResult());
    expect(local).toMatchObject({
      status: "PASS",
      backend: "MEMORY",
      startStatus: "WAITING_TOOL",
      resumeStatus: null,
      effectCount: 1,
      cuePhaseMatch: true,
      recoverableAfterRefresh: false,
    });
    expect(stage0BackendDescription(local)).toBe("当前服务进程内恢复");

    const durable = evaluateRemoteStartResult(
      fakeResult({ backend: "DURABLE_OBJECT", recoverableAfterRefresh: true }),
    );
    expect(durable.status).toBe("PASS");
    expect(stage0BackendDescription(durable)).toBe("可跨页面/实例恢复");

    const resumed = evaluateRemoteResumeResult(
      fakeResult({ status: "COMPLETED", backend: "DURABLE_OBJECT" }),
    );
    expect(resumed).toMatchObject({
      status: "PASS",
      phase: "resume",
      backend: "DURABLE_OBJECT",
      resumeStatus: "COMPLETED",
      effectCount: 0,
      cuePhaseMatch: true,
      recoverableAfterRefresh: true,
    });
  });

  it("keeps Stage0 page-side imports on the client-safe entry", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../../app/agent-poc/page.tsx", import.meta.url)),
      "utf8",
    );
    const helper = readFileSync(
      fileURLToPath(new URL("./coach-agent-browser-smoke.ts", import.meta.url)),
      "utf8",
    );
    expect(helper).toContain("@cs-coach/coach-agent/client");
    expect(`${page}\n${helper}`).not.toMatch(
      /@cs-coach\/coach-agent["']|createCoachAgentRuntime|MemorySaver|IndexedDbCheckpointSaver|browser-async-context|interrupt\s*\(/,
    );
  });
});
