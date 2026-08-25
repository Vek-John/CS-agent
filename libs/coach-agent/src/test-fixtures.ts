import {
  AgentToolResultSchema,
  CoachAgentIdentitySchema,
  StartCueEventSchema,
  TeachingCapabilitySchema,
  type AgentToolRequest,
  type CoachAgentEvent,
  type CoachAgentIdentity,
  type TeachingCapability,
} from "./types";

export const fixtureIdentity: CoachAgentIdentity = CoachAgentIdentitySchema.parse({
  runId: "run-demo-1",
  sessionId: "session-1",
  demoId: "demo-1",
  demoContentHash: "sha256-demo-1",
  selectedPlayerId: "player-t1",
  routeId: "route-1",
  routeHash: "sha256-route-1",
});

export const slowReplayCapability: TeachingCapability = TeachingCapabilitySchema.parse({
  capabilityId: "cap-cue17-slow-replay",
  tool: "REPLAY_CUE_SLOW",
  boundArgs: {
    tool: "REPLAY_CUE_SLOW",
    cueId: "cue-17",
    speed: 0.5,
  },
  evidenceRefs: ["action-a1"],
  estimatedDurationMs: 12_000,
});

export const mapFocusCapability: TeachingCapability = TeachingCapabilitySchema.parse({
  capabilityId: "cap-cue17-map-focus",
  tool: "FOCUS_MAP_EVIDENCE",
  boundArgs: {
    tool: "FOCUS_MAP_EVIDENCE",
    cueId: "cue-17",
    annotationRefs: ["annotation-a1"],
    actorRefs: ["actor-selected"],
    calloutRefs: ["callout-a1"],
  },
  evidenceRefs: ["decision-d1", "annotation-a1"],
  estimatedDurationMs: 8_000,
});

export function startCueEvent(
  overrides: Partial<{
    identity: CoachAgentIdentity;
    capabilities: TeachingCapability[];
    eventId: string;
    cueId: string;
    segmentId: string;
    routeSegmentIndex?: number;
    outcomeGateStatus: "LOCKED" | "COMPLETE" | "NOT_APPLICABLE";
    narrationReadiness: "NOT_REQUIRED" | "PENDING" | "READY" | "FALLBACK";
  }> = {},
): Extract<CoachAgentEvent, { type: "START_CUE" }> {
  return StartCueEventSchema.parse({
    version: "coach-agent-event.v1",
    type: "START_CUE",
    eventId: overrides.eventId ?? "event-start-1",
    identity: overrides.identity ?? fixtureIdentity,
    segmentId: overrides.segmentId ?? "segment-1",
    cueId: overrides.cueId ?? "cue-17",
    focus: "primary-positioning",
    currentSessionPhase: "PAUSED_FOR_COACHING",
    outcomeGateStatus: overrides.outcomeGateStatus ?? "COMPLETE",
    narrationReadiness: overrides.narrationReadiness ?? "READY",
    narrationSummary: {
      primaryFocusCode: "POSITIONING",
      readiness: overrides.narrationReadiness ?? "READY",
      limitationCount: 1,
    },
    allowedEvidenceSummary: [
      { namespace: "DECISION", refs: ["decision-d1"] },
      { namespace: "ACTION", refs: ["action-a1"] },
      { namespace: "ADVICE", refs: ["advice-a1"] },
      { namespace: "EVIDENCE", refs: ["annotation-a1"] },
    ],
    limitations: ["teaching fixture contains no raw replay"],
    sessionThemes: [
      {
        focus: "positioning",
        cueRefs: ["cue-17"],
        roundRefs: ["round-1"],
        evidenceRefs: ["decision-d1"],
        occurrence: 1,
        economyContext: "FULL",
        repeated: false,
        conflictEvidence: false,
      },
    ],
    capabilities: overrides.capabilities ?? [slowReplayCapability],
    ...(overrides.routeSegmentIndex === undefined ? {} : { routeSegmentIndex: overrides.routeSegmentIndex }),
    presentableSummary: {
      completionStatus: "COMPLETED",
      presentationStatus: "PRESENTABLE",
      cueId: overrides.cueId ?? "cue-17",
      roundId: "round-1",
      focus: "primary-positioning",
      evidenceRefs: ["decision-d1", "action-a1", "advice-a1"],
      adviceRefs: ["advice-a1"],
      economyContext: "FULL",
      conflictEvidence: false,
    },
  });
}

export function resumeEvent(
  request: AgentToolRequest,
  options: { eventId?: string; identity?: CoachAgentIdentity; status?: "SUCCEEDED" | "REJECTED" | "FAILED" | "CANCELLED" } = {},
): Extract<CoachAgentEvent, { type: "RESUME_TOOL" }> {
  return {
    version: "coach-agent-event.v1",
    type: "RESUME_TOOL",
    eventId: options.eventId ?? "event-resume-1",
    identity: options.identity ?? fixtureIdentity,
    result: AgentToolResultSchema.parse({
      callId: request.callId,
      status: options.status ?? "SUCCEEDED",
      observation: {
        code: options.status === "SUCCEEDED" || !options.status ? "CUE_PLAYED" : "UNAVAILABLE",
        completed: options.status === "SUCCEEDED" || !options.status,
      },
      limitations: [],
    }),
  };
}
