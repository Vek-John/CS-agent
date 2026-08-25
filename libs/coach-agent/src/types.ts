import { z } from "zod";

export const LEGACY_COACH_AGENT_STATE_VERSION = "coach-agent-state.v1" as const;
export const LEGACY_COACH_AGENT_EVENT_VERSION = "coach-agent-event.v1" as const;
export const COACH_AGENT_STATE_VERSION = "coach-agent-state.v2" as const;
export const COACH_AGENT_EVENT_VERSION = "coach-agent-event.v2" as const;
export const COACH_AGENT_RESULT_VERSION = "coach-agent-result.v1" as const;
export const COACH_AGENT_GRAPH_VERSION = "coach-agent-graph.v2" as const;
export const COACH_AGENT_SESSION_VERSION = "coaching-session.v1" as const;
export const COACH_AGENT_RECOVERY_VERSION = "session-recovery-record.v1" as const;

const CoachAgentEventVersionSchema = z.union([
  z.literal(LEGACY_COACH_AGENT_EVENT_VERSION),
  z.literal(COACH_AGENT_EVENT_VERSION),
]);

const Id = z.string().min(1).max(160);
const Hash = z.string().min(1).max(256);
const EvidenceRef = z.string().min(1).max(160);

export const CoachAgentIdentitySchema = z
  .object({
    runId: Id,
    sessionId: Id,
    demoId: Id,
    demoContentHash: Hash,
    selectedPlayerId: Id,
    routeId: Id,
    routeHash: Hash,
  })
  .strict();
export type CoachAgentIdentity = z.infer<typeof CoachAgentIdentitySchema>;

export const TeachingToolNameSchema = z.enum([
  "REPLAY_CUE_SLOW",
  "FOCUS_MAP_EVIDENCE",
  "SHOW_GRENADE_TRACE",
  "SHOW_WIN_RATE_IMPACT",
  "SHOW_ECONOMY_CONTEXT",
]);
export type TeachingToolName = z.infer<typeof TeachingToolNameSchema>;

export const TeachingCapabilityIdSchema = z
  .string()
  .regex(/^cap-[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type TeachingCapabilityId = z.infer<typeof TeachingCapabilityIdSchema>;

const ReplayCueSlowBoundArgsSchema = z
  .object({
    tool: z.literal("REPLAY_CUE_SLOW"),
    cueId: Id,
    speed: z.literal(0.5),
  })
  .strict();
const FocusMapEvidenceBoundArgsSchema = z
  .object({
    tool: z.literal("FOCUS_MAP_EVIDENCE"),
    cueId: Id,
    annotationRefs: z.array(EvidenceRef).max(16),
    actorRefs: z.array(EvidenceRef).max(16),
    calloutRefs: z.array(EvidenceRef).max(16),
  })
  .strict();
const ShowGrenadeTraceBoundArgsSchema = z
  .object({
    tool: z.literal("SHOW_GRENADE_TRACE"),
    cueId: Id,
    trajectoryRefs: z.array(EvidenceRef).max(16),
    landingRefs: z.array(EvidenceRef).max(16),
  })
  .strict();
const ShowWinRateImpactBoundArgsSchema = z
  .object({
    tool: z.literal("SHOW_WIN_RATE_IMPACT"),
    cueId: Id,
    measurementRef: EvidenceRef,
  })
  .strict();
const ShowEconomyContextBoundArgsSchema = z
  .object({
    tool: z.literal("SHOW_ECONOMY_CONTEXT"),
    cueId: Id,
    economyRef: EvidenceRef,
    economyClass: z.enum(["PISTOL", "ECO", "FORCE", "FULL", "UNKNOWN"]),
  })
  .strict();
export const TeachingBoundArgsSchema = z.discriminatedUnion("tool", [
  ReplayCueSlowBoundArgsSchema,
  FocusMapEvidenceBoundArgsSchema,
  ShowGrenadeTraceBoundArgsSchema,
  ShowWinRateImpactBoundArgsSchema,
  ShowEconomyContextBoundArgsSchema,
]);
export type TeachingBoundArgs = z.infer<typeof TeachingBoundArgsSchema>;

const TeachingCapabilityBaseSchema = z.object({
  capabilityId: TeachingCapabilityIdSchema,
  evidenceRefs: z.array(EvidenceRef).max(16),
  estimatedDurationMs: z.number().int().positive().max(300_000),
});
export const TeachingCapabilitySchema = z
  .discriminatedUnion("tool", [
    TeachingCapabilityBaseSchema.extend({
      tool: z.literal("REPLAY_CUE_SLOW"),
      boundArgs: ReplayCueSlowBoundArgsSchema,
    }),
    TeachingCapabilityBaseSchema.extend({
      tool: z.literal("FOCUS_MAP_EVIDENCE"),
      boundArgs: FocusMapEvidenceBoundArgsSchema,
    }),
    TeachingCapabilityBaseSchema.extend({
      tool: z.literal("SHOW_GRENADE_TRACE"),
      boundArgs: ShowGrenadeTraceBoundArgsSchema,
    }),
    TeachingCapabilityBaseSchema.extend({
      tool: z.literal("SHOW_WIN_RATE_IMPACT"),
      boundArgs: ShowWinRateImpactBoundArgsSchema,
    }),
    TeachingCapabilityBaseSchema.extend({
      tool: z.literal("SHOW_ECONOMY_CONTEXT"),
      boundArgs: ShowEconomyContextBoundArgsSchema,
    }),
  ])
  .superRefine((capability, context) => {
    if (capability.boundArgs.tool !== capability.tool) {
      context.addIssue({ code: "custom", message: "boundArgs.tool must match tool" });
    }
  });
export type TeachingCapability = z.infer<typeof TeachingCapabilitySchema>;

export const TeachingMoveSchema = z
  .intersection(
    z.object({
      moveId: Id,
      source: z.enum(["RULE", "MODEL", "FALLBACK"]),
    }),
    TeachingCapabilitySchema,
  );
export type TeachingMove = z.infer<typeof TeachingMoveSchema>;

export const AgentToolRequestSchema = z
  .object({
    callId: Id,
    runId: Id,
    cueId: Id,
    capabilityId: TeachingCapabilityIdSchema,
    tool: TeachingToolNameSchema,
    evidenceRefs: z.array(EvidenceRef).max(16),
  })
  .strict();
export type AgentToolRequest = z.infer<typeof AgentToolRequestSchema>;

export const AgentToolObservationSchema = z
  .object({
    code: z.enum(["CUE_PLAYED", "EVIDENCE_SHOWN", "UNAVAILABLE", "NO_CHANGE"]),
    completed: z.boolean(),
  })
  .strict();
export type AgentToolObservation = z.infer<typeof AgentToolObservationSchema>;

export const AgentToolResultSchema = z
  .object({
    callId: Id,
    status: z.enum(["SUCCEEDED", "REJECTED", "FAILED", "CANCELLED"]),
    observation: AgentToolObservationSchema,
    limitations: z.array(z.string().min(1).max(200)).max(8),
  })
  .strict();
export type AgentToolResult = z.infer<typeof AgentToolResultSchema>;

export const SessionPhaseSchema = z.enum([
  "DORMANT",
  "INTRO",
  "PLAYING",
  "SKIPPING",
  "BUFFERING",
  "PAUSED_FOR_COACHING",
  "REVEALING",
  "REPLAYING",
  "WRAP_UP",
  "COMPLETED",
]);
export type SessionPhase = z.infer<typeof SessionPhaseSchema>;

export const SegmentModeSchema = z.enum([
  "SKIP",
  "FREEZE",
  "BRIEF",
  "OBSERVE",
  "DEEP_DIVE",
  "HABIT_CHECK",
]);
export type SegmentMode = z.infer<typeof SegmentModeSchema>;

export const RouteObservationModeSchema = z.enum(["SKIP", "FREEZE", "BRIEF", "OBSERVE"]);
export type RouteObservationMode = z.infer<typeof RouteObservationModeSchema>;

export const OutcomeGateStatusSchema = z.enum([
  "NOT_APPLICABLE",
  "LOCKED",
  "COMPLETE",
]);
export type OutcomeGateStatus = z.infer<typeof OutcomeGateStatusSchema>;

export const SessionThemeSchema = z
  .object({
    focus: Id,
    cueRefs: z.array(EvidenceRef).max(16),
    roundRefs: z.array(EvidenceRef).max(16),
    evidenceRefs: z.array(EvidenceRef).max(16),
    occurrence: z.number().int().positive().max(64),
    economyContext: z.enum(["PISTOL", "ECO", "FORCE", "FULL", "UNKNOWN"]),
    repeated: z.boolean(),
    conflictEvidence: z.boolean(),
  })
  .strict();
export type SessionTheme = z.infer<typeof SessionThemeSchema>;

export const NarrationReadinessSchema = z.enum([
  "NOT_REQUIRED",
  "PENDING",
  "READY",
  "FALLBACK",
]);
export type NarrationReadiness = z.infer<typeof NarrationReadinessSchema>;

export const NarrationFieldPolicySummarySchema = z
  .object({
    text: z.string().max(240),
    refs: z.array(EvidenceRef).max(8),
    limitations: z.array(z.string().min(1).max(160)).max(4),
  })
  .strict();
export type NarrationFieldPolicySummary = z.infer<typeof NarrationFieldPolicySummarySchema>;

export const NarrationPolicySummarySchema = z
  .object({
    primaryFocusCode: Id,
    readiness: NarrationReadinessSchema,
    limitationCount: z.number().int().nonnegative().max(8),
    fields: z
      .object({
        currentSituation: NarrationFieldPolicySummarySchema,
        playerAction: NarrationFieldPolicySummarySchema,
        coreIssue: NarrationFieldPolicySummarySchema,
        betterPlay: NarrationFieldPolicySummarySchema,
        outcomeImpact: NarrationFieldPolicySummarySchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (JSON.stringify(summary).length > 8_000) {
      context.addIssue({ code: "custom", message: "Narration policy summary exceeds 8KB." });
    }
  });

const LegacyNarrationSummarySchema = z
  .object({
    primaryFocusCode: Id,
    readiness: NarrationReadinessSchema,
    limitationCount: z.number().int().nonnegative().max(8),
  })
  .strict();

export const NarrationSummarySchema = z.union([
  NarrationPolicySummarySchema,
  LegacyNarrationSummarySchema,
]);
export type NarrationSummary = z.infer<typeof NarrationSummarySchema>;
export type NarrationPolicySummary = z.infer<typeof NarrationPolicySummarySchema>;

export function normalizeNarrationSummary(summary: NarrationSummary): NarrationPolicySummary {
  if ("fields" in summary) return summary;
  const empty = (): NarrationFieldPolicySummary => ({ text: "", refs: [], limitations: [] });
  return NarrationPolicySummarySchema.parse({
    ...summary,
    fields: {
      currentSituation: empty(),
      playerAction: empty(),
      coreIssue: empty(),
      betterPlay: empty(),
      outcomeImpact: empty(),
    },
  });
}

export const AllowedEvidenceSummarySchema = z
  .object({
    namespace: z.enum([
      "DECISION",
      "ACTION",
      "ADVICE",
      "EVIDENCE",
      "OUTCOME",
      "MEASUREMENT",
    ]),
    refs: z.array(EvidenceRef).max(16),
  })
  .strict();
export type AllowedEvidenceSummary = z.infer<typeof AllowedEvidenceSummarySchema>;

export const CapabilityBuilderInputSchema = z
  .object({
    cueId: Id,
    primaryFocusCode: Id,
    decisionRefs: z.array(EvidenceRef).max(16),
    actionRefs: z.array(EvidenceRef).max(16),
    outcomeRefs: z.array(EvidenceRef).max(16),
    evidenceRefs: z.array(EvidenceRef).max(16),
    annotationRefs: z.array(EvidenceRef).max(16),
    actorRefs: z.array(EvidenceRef).max(16),
    calloutRefs: z.array(EvidenceRef).max(16),
    grenadeTrajectoryRefs: z.array(EvidenceRef).max(16),
    grenadeLandingRefs: z.array(EvidenceRef).max(16),
    outcomeGateStatus: OutcomeGateStatusSchema,
    modelStatus: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    measurementRefs: z.array(EvidenceRef).max(16),
    negativeWinProbabilitySwingPercentagePoints: z.number().finite().nullable(),
    economyContext: z
      .object({
        reliable: z.boolean(),
        relevant: z.boolean(),
        ref: EvidenceRef.nullable(),
        economyClass: z.enum(["PISTOL", "ECO", "FORCE", "FULL", "UNKNOWN"]),
      })
      .strict(),
    limitations: z.array(z.string().min(1).max(200)).max(8),
  })
  .strict();
export type CapabilityBuilderInput = z.infer<typeof CapabilityBuilderInputSchema>;

export const PresentableCueSummarySchema = z
  .object({
    completionStatus: z.literal("COMPLETED"),
    presentationStatus: z.literal("PRESENTABLE"),
    cueId: Id,
    roundId: Id,
    focus: Id,
    evidenceRefs: z.array(EvidenceRef).max(16),
    adviceRefs: z.array(EvidenceRef).max(8),
    economyContext: z.enum(["PISTOL", "ECO", "FORCE", "FULL", "UNKNOWN"]),
    conflictEvidence: z.boolean(),
  })
  .strict();
export type PresentableCueSummary = z.infer<typeof PresentableCueSummarySchema>;

export const SessionSummaryCueSchema = z
  .object({
    cueId: Id,
    roundId: Id,
    focus: Id,
    evidenceRefs: z.array(EvidenceRef).max(16),
    adviceRefs: z.array(EvidenceRef).max(8),
  })
  .strict();
export type SessionSummaryCue = z.infer<typeof SessionSummaryCueSchema>;

export const SessionSummaryThemeSchema = z
  .object({
    focus: Id,
    cueRefs: z.array(EvidenceRef).max(16),
    roundRefs: z.array(EvidenceRef).max(16),
    evidenceRefs: z.array(EvidenceRef).max(16),
    occurrence: z.number().int().positive().max(64),
    economyContext: z.enum(["PISTOL", "ECO", "FORCE", "FULL", "UNKNOWN"]),
    repeated: z.literal(true),
    conflictEvidence: z.boolean(),
    adviceRefs: z.array(EvidenceRef).max(8),
    limitations: z.array(z.string().min(1).max(200)).max(4),
  })
  .strict();
export type SessionSummaryTheme = z.infer<typeof SessionSummaryThemeSchema>;

export const SessionSummaryInputSchema = z
  .object({
    schemaVersion: z.literal("coach-agent-session-summary.v1"),
    themes: z.array(SessionSummaryThemeSchema).max(3),
    completedCues: z.array(SessionSummaryCueSchema).max(3),
    limitations: z.array(z.string().min(1).max(200)).max(8),
  })
  .strict();
export type SessionSummaryInput = z.infer<typeof SessionSummaryInputSchema>;

export const StartCueEventSchema = z
  .object({
    version: CoachAgentEventVersionSchema,
    type: z.literal("START_CUE"),
    eventId: Id,
    identity: CoachAgentIdentitySchema,
    segmentId: Id,
    cueId: Id,
    focus: Id,
    currentSessionPhase: SessionPhaseSchema,
    outcomeGateStatus: OutcomeGateStatusSchema,
    narrationReadiness: NarrationReadinessSchema,
    narrationSummary: NarrationSummarySchema,
    allowedEvidenceSummary: z.array(AllowedEvidenceSummarySchema).max(6),
    limitations: z.array(z.string().min(1).max(200)).max(8),
    sessionThemes: z.array(SessionThemeSchema).max(16),
    capabilities: z.array(TeachingCapabilitySchema).max(8),
    presentableSummary: PresentableCueSummarySchema.optional(),
    segmentMode: SegmentModeSchema.optional(),
    routeSegmentIndex: z.number().int().nonnegative().max(512).optional(),
    resumeFromTakeover: z.boolean().optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.version === COACH_AGENT_EVENT_VERSION && !event.presentableSummary) {
      context.addIssue({ code: "custom", path: ["presentableSummary"], message: "v2 START_CUE requires a strict presentable summary." });
    }
    if (event.presentableSummary) {
      if (event.presentableSummary.cueId !== event.cueId) {
        context.addIssue({ code: "custom", path: ["presentableSummary", "cueId"], message: "presentable summary cueId must match START_CUE." });
      }
      if (event.presentableSummary.focus !== event.focus) {
        context.addIssue({ code: "custom", path: ["presentableSummary", "focus"], message: "presentable summary focus must match START_CUE." });
      }
      const allowed = new Set(event.allowedEvidenceSummary.flatMap((summary) => summary.refs));
      if (event.presentableSummary.evidenceRefs.some((ref) => !allowed.has(ref))) {
        context.addIssue({ code: "custom", path: ["presentableSummary", "evidenceRefs"], message: "presentable summary evidence must be allowlisted by START_CUE." });
      }
      if (event.presentableSummary.adviceRefs.some((ref) => !allowed.has(ref))) {
        context.addIssue({ code: "custom", path: ["presentableSummary", "adviceRefs"], message: "presentable summary advice must be allowlisted by START_CUE." });
      }
    }
  });
export type StartCueEvent = z.infer<typeof StartCueEventSchema>;

export const ResumeToolEventSchema = z
  .object({
    version: CoachAgentEventVersionSchema,
    type: z.literal("RESUME_TOOL"),
    eventId: Id,
    identity: CoachAgentIdentitySchema,
    result: AgentToolResultSchema,
  })
  .strict();
export type ResumeToolEvent = z.infer<typeof ResumeToolEventSchema>;

export const ResetEventSchema = z
  .object({
    version: CoachAgentEventVersionSchema,
    type: z.literal("RESET"),
    eventId: Id,
    identity: CoachAgentIdentitySchema,
  })
  .strict();
export type ResetEvent = z.infer<typeof ResetEventSchema>;

export const ObserveSegmentEventSchema = z
  .object({
    version: z.literal(COACH_AGENT_EVENT_VERSION),
    type: z.literal("OBSERVE_SEGMENT"),
    eventId: Id,
    identity: CoachAgentIdentitySchema,
    segmentId: Id,
    segmentIndex: z.number().int().nonnegative().max(512),
    mode: RouteObservationModeSchema,
    currentSessionPhase: SessionPhaseSchema,
  })
  .strict();
export type ObserveSegmentEvent = z.infer<typeof ObserveSegmentEventSchema>;

export const UserTakeoverEventSchema = z
  .object({
    version: z.literal(COACH_AGENT_EVENT_VERSION),
    type: z.literal("USER_TAKEOVER"),
    eventId: Id,
    identity: CoachAgentIdentitySchema,
    cueId: Id.nullable().optional(),
    reason: z.string().min(1).max(160),
  })
  .strict();
export type UserTakeoverEvent = z.infer<typeof UserTakeoverEventSchema>;

export const CancelRunEventSchema = z
  .object({
    version: z.literal(COACH_AGENT_EVENT_VERSION),
    type: z.literal("CANCEL_RUN"),
    eventId: Id,
    identity: CoachAgentIdentitySchema,
    reason: z.string().min(1).max(160),
  })
  .strict();
export type CancelRunEvent = z.infer<typeof CancelRunEventSchema>;

export const CompleteSessionEventSchema = z
  .object({
    version: z.literal(COACH_AGENT_EVENT_VERSION),
    type: z.literal("COMPLETE_SESSION"),
    eventId: Id,
    identity: CoachAgentIdentitySchema,
  })
  .strict();
export type CompleteSessionEvent = z.infer<typeof CompleteSessionEventSchema>;

export const ReplayAvailabilitySchema = z.enum(["ABSENT", "LOADING", "READY"]);
export type ReplayAvailability = z.infer<typeof ReplayAvailabilitySchema>;

export const RecoveryBoundarySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ROUTE_START"),
    boundaryId: Id,
    segmentIndex: z.literal(0),
  }).strict(),
  z.object({
    kind: z.literal("CUE_PAUSED"),
    boundaryId: Id,
    segmentId: Id,
    segmentIndex: z.number().int().nonnegative().max(512),
    cueId: Id,
    sessionPhase: z.literal("PAUSED_FOR_COACHING"),
    outcomeGateStatus: z.literal("COMPLETE"),
  }).strict(),
  z.object({
    kind: z.literal("WRAP_UP"),
    boundaryId: Id,
    segmentIndex: z.number().int().nonnegative().max(512),
  }).strict(),
]);
export type RecoveryBoundary = z.infer<typeof RecoveryBoundarySchema>;

export const ReconnectToolDispositionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NONE") }).strict(),
  z.object({
    status: z.literal("SUCCEEDED"),
    callId: Id,
    result: AgentToolResultSchema,
  }).strict().superRefine((value, context) => {
    if (value.result.callId !== value.callId || value.result.status !== "SUCCEEDED") {
      context.addIssue({ code: "custom", path: ["result"], message: "A SUCCEEDED reconnect disposition requires the matching successful result." });
    }
  }),
  z.object({
    status: z.enum(["POSTED", "FAILED", "REJECTED", "CANCELLED"]),
    callId: Id,
  }).strict(),
]);
export type ReconnectToolDisposition = z.infer<typeof ReconnectToolDispositionSchema>;

export const ReconnectReplayEventSchema = z
  .object({
    version: z.literal(COACH_AGENT_EVENT_VERSION),
    type: z.literal("RECONNECT_REPLAY"),
    eventId: Id,
    identity: CoachAgentIdentitySchema,
    replayAvailability: z.literal("READY"),
    expectedCheckpointId: Id,
    versions: z.object({
      graph: Id,
      state: Id,
      session: Id,
      recovery: Id,
    }).strict(),
    boundary: RecoveryBoundarySchema,
    pendingToolDisposition: ReconnectToolDispositionSchema,
  })
  .strict();
export type ReconnectReplayEvent = z.infer<typeof ReconnectReplayEventSchema>;

export const CoachAgentEventSchema = z.discriminatedUnion("type", [
  StartCueEventSchema,
  ResumeToolEventSchema,
  ResetEventSchema,
  ObserveSegmentEventSchema,
  UserTakeoverEventSchema,
  CancelRunEventSchema,
  CompleteSessionEventSchema,
  ReconnectReplayEventSchema,
]);
export type CoachAgentEvent = z.infer<typeof CoachAgentEventSchema>;

export const TraceEntrySchema = z
  .object({
    runId: Id,
    graphVersion: z.literal(COACH_AGENT_GRAPH_VERSION),
    node: z.enum(["RUNTIME", "ROUTE", "POLICY", "TOOL", "SESSION", "FINISH"]),
    cueId: Id.nullable(),
    inputHash: Hash,
    selectedCapabilityId: TeachingCapabilityIdSchema.nullable(),
    evidenceRefs: z.array(EvidenceRef).max(16),
    toolResultStatus: z
      .enum(["SUCCEEDED", "REJECTED", "FAILED", "CANCELLED"])
      .nullable(),
    fallbackReasons: z.array(z.string().min(1).max(160)).max(8),
    latencyMs: z.number().int().nonnegative().max(3_600_000).nullable(),
    tokenCount: z.number().int().nonnegative().nullable(),
    provider: z.string().min(1).max(80).nullable(),
    model: z.string().min(1).max(120).nullable(),
    checkpointId: Id.nullable(),
    finalStatus: z
      .enum([
        "DORMANT",
        "RUNNING",
        "WAITING_TOOL",
        "CUE_COMPLETED",
        "USER_TAKEOVER",
        "CANCELLED",
        "COMPLETED",
      ])
      .nullable(),
  })
  .strict();
export type TraceEntry = z.infer<typeof TraceEntrySchema>;

export const TraceSummarySchema = z
  .object({
    entryCount: z.number().int().nonnegative().max(64),
    lastNode: TraceEntrySchema.shape.node.nullable(),
    lastInputHash: Hash.nullable(),
    lastFinalStatus: TraceEntrySchema.shape.finalStatus,
  })
  .strict();
export type TraceSummary = z.infer<typeof TraceSummarySchema>;

export const ToolHistorySummarySchema = z
  .object({
    callId: Id,
    cueId: Id,
    tool: TeachingToolNameSchema,
    capabilityId: TeachingCapabilityIdSchema,
    status: z.enum(["SUCCEEDED", "REJECTED", "FAILED", "CANCELLED"]),
    observationCode: AgentToolObservationSchema.shape.code,
    limitationCount: z.number().int().nonnegative().max(8),
  })
  .strict();
export type ToolHistorySummary = z.infer<typeof ToolHistorySummarySchema>;

export const PolicyBudgetSchema = z
  .object({
    policyCalls: z.number().int().nonnegative().max(1),
    maxPolicyCalls: z.literal(1),
    alternativeAttempts: z.number().int().nonnegative().max(1),
    maxAlternativeAttempts: z.literal(1),
  })
  .strict();
export type PolicyBudget = z.infer<typeof PolicyBudgetSchema>;

export const FallbackReasonSchema = z.enum([
  "CHECKPOINT_UNAVAILABLE",
  "IDB_FALLBACK",
  "CHECKPOINT_VERSION_MISMATCH",
  "IDENTITY_MISMATCH",
  "ROUTE_HASH_MISMATCH",
  "ROUTE_ORDER_MISMATCH",
  "BRIDGE_LOST",
  "POLICY_FAILED",
  "POLICY_INVALID_OUTPUT",
  "STALE_RESUME",
  "EXPIRED_EVENT",
  "TOOL_FAILED",
  "TOOL_REJECTED",
  "TOOL_CANCELLED",
  "INVALID_EVENT",
  "RESET",
  "RECOVERY_CHECKPOINT_MISMATCH",
  "RECOVERY_BOUNDARY_MISMATCH",
  "RECOVERY_VERSION_MISMATCH",
  "RECOVERY_REPLAY_NOT_READY",
  "RECOVERY_TOOL_CANCELLED",
  "RECOVERY_TOOL_MISMATCH",
]);
export type FallbackReason = z.infer<typeof FallbackReasonSchema>;

export const LastStableCheckpointSchema = z
  .object({
    checkpointId: Id.nullable(),
    sequence: z.number().int().nonnegative(),
  })
  .strict();
export type LastStableCheckpoint = z.infer<typeof LastStableCheckpointSchema>;

export const CoachAgentStateSchema = z
  .object({
    schemaVersion: z.literal(COACH_AGENT_STATE_VERSION),
    graphVersion: z.literal(COACH_AGENT_GRAPH_VERSION),
    runId: Id,
    sessionId: Id,
    demoId: Id,
    demoContentHash: Hash,
    selectedPlayerId: Id,
    routeId: Id,
    routeHash: Hash,
    sessionStatus: z.enum(["ACTIVE", "TAKEN_OVER", "CANCELLED", "COMPLETED"]),
    runStatus: z.enum([
      "DORMANT",
      "RUNNING",
      "WAITING_TOOL",
      "CUE_COMPLETED",
      "USER_TAKEOVER",
      "CANCELLED",
      "COMPLETED",
    ]),
    activeSegmentId: Id.nullable(),
    activeCueId: Id.nullable(),
    routeCursor: z.number().int().min(-1).max(512),
    currentSegmentMode: SegmentModeSchema.nullable(),
    activeFocus: Id.nullable(),
    activeNarrationPolicySummary: NarrationPolicySummarySchema.nullable(),
    activeAllowedEvidenceSummary: z.array(AllowedEvidenceSummarySchema).max(6),
    activePresentableCueSummary: PresentableCueSummarySchema.nullable().optional(),
    observedSegmentIds: z.array(Id).max(128),
    currentSessionPhase: SessionPhaseSchema,
    outcomeGateStatus: OutcomeGateStatusSchema,
    narrationReadiness: NarrationReadinessSchema,
    availableCapabilities: z.array(TeachingCapabilitySchema).max(8),
    selectedTeachingMove: TeachingMoveSchema.nullable(),
    pendingToolCall: AgentToolRequestSchema.nullable(),
    toolHistory: z.array(ToolHistorySummarySchema).max(16),
    completedCueIds: z.array(Id).max(64),
    completedCueSummaries: z.array(PresentableCueSummarySchema).max(64),
    sessionThemes: z.array(SessionThemeSchema).max(16),
    summaryThemes: z.array(SessionThemeSchema).max(3),
    sessionSummaryInput: SessionSummaryInputSchema.nullable(),
    sessionSummaryFallback: z.string().max(240).nullable(),
    policyBudget: PolicyBudgetSchema,
    fallbackReasons: z.array(FallbackReasonSchema).max(8),
    lastStableCheckpoint: LastStableCheckpointSchema,
    traceSummary: TraceSummarySchema,
    processedEventIds: z.array(Id).max(64),
    trace: z.array(TraceEntrySchema).max(64),
    lastToolResult: AgentToolResultSchema.nullable(),
  })
  .strict();
export type CoachAgentState = z.infer<typeof CoachAgentStateSchema>;

export const CheckpointInfoSchema = z
  .object({
    backend: z.enum(["MEMORY", "INDEXEDDB", "DURABLE_OBJECT"]),
    recoverableAfterRefresh: z.boolean(),
    checkpointId: Id.nullable(),
    fallbackReason: z.enum(["NONE", "CHECKPOINT_UNAVAILABLE", "IDB_FALLBACK"]).optional(),
  })
  .strict();
export type CheckpointInfo = z.infer<typeof CheckpointInfoSchema>;

const CurrentCoachAgentResultSchema = z
  .object({
    version: z.literal(COACH_AGENT_RESULT_VERSION),
    status: CoachAgentStateSchema.shape.runStatus,
    identity: CoachAgentIdentitySchema,
    state: CoachAgentStateSchema,
    effects: z.array(AgentToolRequestSchema).max(1),
    trace: z.array(TraceEntrySchema).max(64),
    checkpoint: CheckpointInfoSchema,
    restored: z.enum([
      "FRESH",
      "MATCHED",
      "DORMANT_IDENTITY_MISMATCH",
      "DORMANT_MISSING",
      "DORMANT_RECOVERY_MISMATCH",
    ]),
  })
  .strict();

export const CoachAgentResultSchema = CurrentCoachAgentResultSchema;
export type CoachAgentResult = z.infer<typeof CurrentCoachAgentResultSchema>;

export const PolicyInputSchema = z
  .object({
    cueId: Id,
    focus: Id,
    narrationSummary: NarrationPolicySummarySchema,
    allowedEvidenceSummary: z
      .array(
        z
          .object({
            namespace: z.enum([
              "DECISION",
              "ACTION",
              "ADVICE",
              "EVIDENCE",
              "OUTCOME",
              "MEASUREMENT",
            ]),
            refs: z.array(EvidenceRef).max(16),
          })
          .strict(),
      )
      .max(6),
    phase: SessionPhaseSchema,
    outcomeGateStatus: OutcomeGateStatusSchema,
    capabilities: z
      .array(
        z
          .object({
            capabilityId: TeachingCapabilityIdSchema,
            tool: TeachingToolNameSchema,
            evidenceRefs: z.array(EvidenceRef).max(16),
            estimatedDurationMs: z.number().int().positive().max(300_000),
          })
          .strict(),
      )
      .max(8),
    toolObservations: z.array(ToolHistorySummarySchema).max(16),
    themes: z.array(SessionThemeSchema).max(16),
    limitations: z.array(z.string().min(1).max(200)).max(8),
    budget: PolicyBudgetSchema,
    maxMoves: z.literal(1),
  })
  .strict();
export type PolicyInput = z.infer<typeof PolicyInputSchema>;

export const RationaleCodeSchema = z.enum([
  "TIMING_NEEDS_SLOW_REPLAY",
  "POSITION_NEEDS_MAP_FOCUS",
  "UTILITY_NEEDS_TRAJECTORY",
  "IMPACT_NEEDS_WIN_RATE",
  "ECONOMY_CHANGES_RISK",
  "NO_EXTRA_VISUAL_VALUE",
]);
export type RationaleCode = z.infer<typeof RationaleCodeSchema>;

const SelectCapabilityPolicyOutputSchema = z
  .object({
    action: z.literal("SELECT_CAPABILITY"),
    capabilityId: TeachingCapabilityIdSchema,
    evidenceRefs: z.array(EvidenceRef).max(16),
    rationaleCode: RationaleCodeSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();
const FinishCuePolicyOutputSchema = z
  .object({
    action: z.literal("FINISH_CUE"),
    evidenceRefs: z.array(EvidenceRef).max(16),
    rationaleCode: RationaleCodeSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();
export const PolicyOutputSchema = z.discriminatedUnion("action", [
  SelectCapabilityPolicyOutputSchema,
  FinishCuePolicyOutputSchema,
]);
export type PolicyOutput = z.infer<typeof PolicyOutputSchema>;

export function assertJsonSerializable<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("coach-agent value is not JSON serializable");
  }
  return JSON.parse(encoded) as T;
}
