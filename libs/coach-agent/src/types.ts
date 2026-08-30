import { z } from "zod";
import {
  CueCaseSchema,
  LearningThreadSchema,
  TeachingDiagnosisInputSchema,
  UserReflectionSchema,
} from "./teaching-diagnosis";

export const LEGACY_COACH_AGENT_STATE_VERSION = "coach-agent-state.v1" as const;
export const LEGACY_COACH_AGENT_EVENT_VERSION = "coach-agent-event.v1" as const;
export const COACH_AGENT_STATE_VERSION = "coach-agent-state.v3" as const;
export const COACH_AGENT_EVENT_VERSION = "coach-agent-event.v2" as const;
export const COACH_AGENT_RESULT_VERSION = "coach-agent-result.v1" as const;
export const COACH_AGENT_GRAPH_VERSION = "coach-agent-graph.v3" as const;
export const COACH_AGENT_SESSION_VERSION = "coaching-session.v2" as const;
export const COACH_AGENT_RECOVERY_VERSION = "session-recovery-record.v2" as const;

const LEGACY_COACH_AGENT_STATE_V2_VERSION = "coach-agent-state.v2" as const;
const LEGACY_COACH_AGENT_GRAPH_V1_VERSION = "coach-agent-graph.v1" as const;
const LEGACY_COACH_AGENT_GRAPH_V2_VERSION = "coach-agent-graph.v2" as const;

/**
 * State checkpoints are read at several boundaries (including old browser
 * fixtures).  Keep the object schema strict while translating only versions
 * that are known predecessors of the current v3 contract.
 */
const CoachAgentStateVersionSchema = z.preprocess(
  (value) =>
    value === LEGACY_COACH_AGENT_STATE_VERSION || value === LEGACY_COACH_AGENT_STATE_V2_VERSION
      ? COACH_AGENT_STATE_VERSION
      : value,
  z.literal(COACH_AGENT_STATE_VERSION),
);
const CoachAgentGraphVersionSchema = z.preprocess(
  (value) =>
    value === LEGACY_COACH_AGENT_GRAPH_V1_VERSION || value === LEGACY_COACH_AGENT_GRAPH_V2_VERSION
      ? COACH_AGENT_GRAPH_VERSION
      : value,
  z.literal(COACH_AGENT_GRAPH_VERSION),
);

const CoachAgentEventVersionSchema = z.union([
  z.literal(LEGACY_COACH_AGENT_EVENT_VERSION),
  z.literal(COACH_AGENT_EVENT_VERSION),
]);

const Id = z.string().min(1).max(160);
const Hash = z.string().min(1).max(256);
const EvidenceRef = z.string().min(1).max(160);

/**
 * Memory Brief is a read-only projection owned by @cs-coach/memory.  The
 * Coach Agent only carries the already-validated projection across its wire
 * seam; it must not duplicate MemoryRecord/LearningThread schemas here.  The
 * shallow guard enforces the projection's hard cardinality/byte bounds while
 * the Memory Domain remains the authoritative validator for nested records.
 */
export const MemoryBriefWireSchema = z
  .object({
    schemaVersion: z.literal("memory-brief.v1"),
    generatedAt: z.string().min(1).max(80),
    preferences: z.record(z.string().min(1).max(160), z.union([z.string().max(1_200), z.number().finite(), z.boolean()])).optional(),
    activeThreads: z.array(z.unknown()).max(2),
    memories: z.array(z.unknown()).max(3),
    corrections: z.array(z.unknown()).max(2),
    limitations: z.array(z.string().max(240)).max(16),
    source: z.enum(["STRUCTURED", "STRUCTURED_PLUS_SEMANTIC", "EMPTY"]),
    structuredStatus: z.enum(["AVAILABLE", "UNAVAILABLE", "EMPTY"]).optional(),
    semanticStatus: z.enum(["OPTIONAL", "UNAVAILABLE", "USED"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      context.addIssue({ code: "custom", message: "memoryBrief must be an object" });
      return;
    }
    const brief = value as Record<string, unknown>;
    // The base object schema already checks the version and top-level shape.
    const boundedArrays: Array<[string, number]> = [
      ["activeThreads", 2],
      ["memories", 3],
      ["corrections", 2],
      ["limitations", 16],
    ];
    for (const [name, max] of boundedArrays) {
      if (!Array.isArray(brief[name]) || brief[name].length > max) {
        context.addIssue({ code: "custom", path: [name], message: `${name} exceeds memory brief bound` });
      }
    }
    if (brief.preferences !== undefined &&
      (!brief.preferences || typeof brief.preferences !== "object" || Array.isArray(brief.preferences) || Object.keys(brief.preferences).length > 8)) {
      context.addIssue({ code: "custom", path: ["preferences"], message: "preferences exceeds memory brief bound" });
    }
    if (brief.preferences && typeof brief.preferences === "object" && !Array.isArray(brief.preferences)) {
      for (const [key, preference] of Object.entries(brief.preferences as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9_.:-]{1,160}$/u.test(key) ||
          !((typeof preference === "string" && preference.length <= 1_200) ||
            (typeof preference === "number" && Number.isFinite(preference)) ||
            typeof preference === "boolean")) {
          context.addIssue({ code: "custom", path: ["preferences", key], message: "invalid memory preference projection" });
        }
      }
    }
    const forbiddenKeys = new Set([
      "userId", "principal", "cookie", "rawDemo", "raw_demo", "demoBytes", "demo_bytes", "frames", "ticks", "fullReplay", "full_replay", "replay", "tickStream", "tick_stream", "prompt",
      "chainOfThought", "chain_of_thought", "cot", "memoryId", "logicalKey", "proposalId",
      "eventId", "idempotencyKey", "sessionId", "demoContentHash", "cueId", "caseId",
      "threadId", "refId", "previousRevisionId", "lastIdempotencyKey", "correctionId",
      "originReflectionId", "sourceThreadId", "targetMemoryId", "evidenceCueIds", "successfulCueIds",
      "conflictingCueIds", "claimIds", "evidenceRefs", "adviceRefs", "refs", "sourceRefs",
      "demoContentHashes", "supportingRefs", "contradictingRefs",
    ]);
    const scan = (nested: unknown, seen: Set<unknown>): void => {
      if (!nested || typeof nested !== "object" || seen.has(nested)) return;
      seen.add(nested);
      if (Array.isArray(nested)) {
        for (const item of nested) scan(item, seen);
        return;
      }
      for (const [key, child] of Object.entries(nested)) {
        if (forbiddenKeys.has(key)) context.addIssue({ code: "custom", path: [key], message: `${key} is not allowed in memory brief` });
        scan(child, seen);
      }
    };
    scan(value, new Set());
    if (!["STRUCTURED", "STRUCTURED_PLUS_SEMANTIC", "EMPTY"].includes(String(brief.source))) {
      context.addIssue({ code: "custom", path: ["source"], message: "invalid memory brief source" });
    }
    try {
      const serialized = JSON.stringify(value);
      if (new TextEncoder().encode(serialized).byteLength > 16 * 1024) {
        context.addIssue({ code: "custom", message: "memory brief exceeds 16KiB" });
      }
      // Keep a tokenizer-free deterministic approximation in the wire seam as
      // well as in the domain projection. The actual model tokenizer is
      // intentionally not a runtime dependency.
      if (Math.ceil(serialized.length / 3) > 800) {
        context.addIssue({ code: "custom", message: "memory brief exceeds the 800-token teaching budget" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "memory brief is not JSON serializable" });
    }
  });
export type MemoryBriefWire = z.infer<typeof MemoryBriefWireSchema>;

/**
 * The diagnosis module owns the bounded input contract.  A submission keeps
 * the reflection beside the frozen evidence packet so Host code cannot hide a
 * second, unvalidated reflection in an arbitrary object.  The module's
 * runtime input schema also accepts the combined form; the graph combines
 * these two fields immediately before invoking the pure function.
 */
const TeachingDiagnosisInputPayloadSchema = TeachingDiagnosisInputSchema.omit({ reflection: true });
export type TeachingDiagnosisInputPayload = z.infer<typeof TeachingDiagnosisInputPayloadSchema>;

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

const CueStartPayloadSchema = z
  .object({
    version: CoachAgentEventVersionSchema,
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
    /** Optional server-fetched, read-only projection; never a fact source. */
    memoryBrief: MemoryBriefWireSchema.nullable().optional(),
    capabilities: z.array(TeachingCapabilitySchema).max(8),
    presentableSummary: PresentableCueSummarySchema.optional(),
    segmentMode: SegmentModeSchema.optional(),
  })
  .strict();

function validateCueStartPayload(
  event: z.infer<typeof CueStartPayloadSchema>,
  context: z.RefinementCtx,
): void {
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
}

export const StartCueEventSchema = CueStartPayloadSchema.extend({
  type: z.literal("START_CUE"),
  routeSegmentIndex: z.number().int().nonnegative().max(512).optional(),
  resumeFromTakeover: z.boolean().optional(),
}).strict().superRefine(validateCueStartPayload);
export type StartCueEvent = z.infer<typeof StartCueEventSchema>;

export const StartManualCueVisitEventSchema = CueStartPayloadSchema.extend({
  version: z.literal(COACH_AGENT_EVENT_VERSION),
  type: z.literal("START_MANUAL_CUE_VISIT"),
  visitId: Id,
  targetSegmentIndex: z.number().int().nonnegative().max(512),
  outcomeGateStatus: z.literal("COMPLETE"),
  narrationReadiness: z.enum(["READY", "FALLBACK"]),
}).strict().superRefine(validateCueStartPayload);
export type StartManualCueVisitEvent = z.infer<typeof StartManualCueVisitEventSchema>;

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

const DiagnosisSubmissionBaseSchema = z
  .object({
    version: z.literal(COACH_AGENT_EVENT_VERSION),
    eventId: Id,
    identity: CoachAgentIdentitySchema,
    cueId: Id,
    // A diagnosis is allowed only after the host has completed the
    // decision-before-outcome gate.  The runtime repeats this check against
    // its checkpoint state; this wire check prevents accidental leakage at
    // the API boundary.
    outcomeGateStatus: z.literal("COMPLETE"),
    // Accept the canonical split packet as well as the combined
    // TeachingDiagnosisInput shape emitted by the standalone diagnosis API.
    // Both branches are strict and bounded; accepting the latter keeps old
    // Host adapters source-compatible without widening the event surface.
    input: z.union([TeachingDiagnosisInputPayloadSchema, TeachingDiagnosisInputSchema]),
    reflection: UserReflectionSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.input.cueId !== event.cueId) {
      context.addIssue({
        code: "custom",
        path: ["input", "cueId"],
        message: "diagnosis input cueId must match event cueId",
      });
    }
    if ("reflection" in event.input && event.input.reflection.cueId !== event.cueId) {
      context.addIssue({
        code: "custom",
        path: ["input", "reflection", "cueId"],
        message: "combined diagnosis input reflection cueId must match event cueId",
      });
    }
    if (event.reflection.cueId !== event.cueId) {
      context.addIssue({
        code: "custom",
        path: ["reflection", "cueId"],
        message: "reflection cueId must match event cueId",
      });
    }
    if (event.input.candidateId && event.input.material?.candidateId &&
      event.input.candidateId !== event.input.material.candidateId) {
      context.addIssue({
        code: "custom",
        path: ["input", "candidateId"],
        message: "diagnosis candidateId must match material candidateId",
      });
    }
  });

export const SubmitReflectionEventSchema = DiagnosisSubmissionBaseSchema.extend({
  type: z.literal("SUBMIT_REFLECTION"),
}).strict();
export type SubmitReflectionEvent = z.infer<typeof SubmitReflectionEventSchema>;

export const SubmitDisagreementEventSchema = DiagnosisSubmissionBaseSchema.extend({
  type: z.literal("SUBMIT_DISAGREEMENT"),
}).strict();
export type SubmitDisagreementEvent = z.infer<typeof SubmitDisagreementEventSchema>;

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

export const ObservePresentedCueEventSchema = z
  .object({
    version: z.literal(COACH_AGENT_EVENT_VERSION),
    type: z.literal("OBSERVE_PRESENTED_CUE"),
    eventId: Id,
    identity: CoachAgentIdentitySchema,
    segmentId: Id,
    segmentIndex: z.number().int().nonnegative().max(512),
    cueId: Id,
    currentSessionPhase: SessionPhaseSchema,
  })
  .strict();
export type ObservePresentedCueEvent = z.infer<typeof ObservePresentedCueEventSchema>;

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
  StartManualCueVisitEventSchema,
  ResumeToolEventSchema,
  SubmitReflectionEventSchema,
  SubmitDisagreementEventSchema,
  ResetEventSchema,
  ObserveSegmentEventSchema,
  ObservePresentedCueEventSchema,
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
  "DIAGNOSIS_FAILED",
  "DIAGNOSIS_GATE_LOCKED",
  "DIAGNOSIS_ATTEMPT_EXHAUSTED",
  "DIAGNOSIS_INVALID_OUTPUT",
]);
export type FallbackReason = z.infer<typeof FallbackReasonSchema>;

export const LastStableCheckpointSchema = z
  .object({
    checkpointId: Id.nullable(),
    sequence: z.number().int().nonnegative(),
  })
  .strict();
export type LastStableCheckpoint = z.infer<typeof LastStableCheckpointSchema>;

export const PresentedCueBindingSchema = z
  .object({
    cueId: Id,
    segmentId: Id,
    segmentIndex: z.number().int().nonnegative().max(512),
  })
  .strict();
export type PresentedCueBinding = z.infer<typeof PresentedCueBindingSchema>;

export const CoachAgentStateSchema = z
  .object({
    schemaVersion: CoachAgentStateVersionSchema,
    graphVersion: CoachAgentGraphVersionSchema,
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
    activeCueSource: z.enum(["DEFAULT", "MANUAL"]).nullable().default(null),
    activeManualVisitId: Id.nullable().default(null),
    activeTargetSegmentIndex: z.number().int().nonnegative().max(512).nullable().default(null),
    routeCursor: z.number().int().min(-1).max(512),
    currentSegmentMode: SegmentModeSchema.nullable(),
    activeFocus: Id.nullable(),
    activeNarrationPolicySummary: NarrationPolicySummarySchema.nullable(),
    activeAllowedEvidenceSummary: z.array(AllowedEvidenceSummarySchema).max(6),
    activePresentableCueSummary: PresentableCueSummarySchema.nullable().optional(),
    // Optional rather than default-null keeps the legacy Coach response
    // byte-compatible when memory is disabled. A null supplied by the trust
    // boundary is a clear signal and is normalized away before it reaches the
    // public state shape.
    memoryBrief: z.preprocess(
      (value) => value === null ? undefined : value,
      MemoryBriefWireSchema.optional(),
    ),
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
    presentedCueBindings: z.array(PresentedCueBindingSchema).max(64).default([]),
    // Added after state.v3 shipped. Defaults deliberately make old v3
    // checkpoints and fixtures readable without a migration write.
    cueCases: z
      .record(Id, CueCaseSchema)
      .superRefine((cases, context) => {
        if (Object.keys(cases).length > 64) {
          context.addIssue({ code: "custom", message: "cueCases exceeds the 64-case bound." });
        }
      })
      .default({}),
    learningThreads: z.array(LearningThreadSchema).max(16).default([]),
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
    memoryBrief: MemoryBriefWireSchema.optional(),
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
