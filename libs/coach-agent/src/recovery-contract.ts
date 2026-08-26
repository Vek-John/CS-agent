import { z } from "zod";
import {
  AgentToolResultSchema,
  NarrationPolicySummarySchema,
  ReconnectToolDispositionSchema,
  RecoveryBoundarySchema,
  ReplayAvailabilitySchema,
  type CoachAgentIdentity,
  type NarrationPolicySummary,
  type ReconnectToolDisposition,
  type RecoveryBoundary,
} from "./types";

export const SESSION_RECOVERY_RECORD_VERSION = "session-recovery-record.v2" as const;
export const SESSION_RECOVERY_RUNTIME_VERSION = "session-recovery-runtime.v1" as const;
export const MAX_RECOVERY_RECORD_BYTES = 1 * 1024 * 1024;
export const MAX_RECOVERY_TOOL_LEDGER = 64;
export const MAX_RECOVERY_NARRATION_ARTIFACTS = 3;

const Id = z.string().min(1).max(160);
const Hash = z.string().min(1).max(256);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/i);

function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 16 || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value !== "object") return false;
  if (value instanceof Map || value instanceof Set || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
  if (typeof File !== "undefined" && value instanceof File) return false;
  if (typeof Blob !== "undefined" && value instanceof Blob) return false;
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((nested) => isPlainJson(nested, depth + 1));
}

function hasForbiddenRecoveryKey(value: unknown, depth = 0): boolean {
  if (depth > 16 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenRecoveryKey(item, depth + 1));
  const forbidden = /^(?:file|demo(?:Bytes|File|Data)?|rawReplay|replay|frames?|analysisBundle|mapTexture|mapAssets?|modelWeights|modelBytes|prompt|cot|chainOfThought|secret|apiKey)$/i;
  return Object.entries(value).some(([key, nested]) => forbidden.test(key) || hasForbiddenRecoveryKey(nested, depth + 1));
}

/**
 * Strict top-level ReviewPlan snapshot shape. Nested route/cue objects remain
 * owned by the existing contracts package; this contract only bounds the
 * recovery envelope and rejects replay/model-shaped data recursively.
 */
export const FrozenReviewPlanSchema = z
  .object({
    id: Id,
    demo_id: Id,
    player_id: Id,
    status: z.literal("COMPLETE"),
    match_timeline_version: Id,
    observation_version: Id,
    signal_version: Id,
    planner_version: Id,
    estimated_duration_seconds: z.number().finite().nonnegative().max(86_400),
    available_until_round: z.number().int().nonnegative().max(64),
    full_match_index_ready: z.boolean(),
    global_aggregation_ready: z.boolean(),
    segments: z.array(z.unknown()).max(512),
    cues: z.array(z.unknown()).max(50),
    habit_clusters: z.array(z.unknown()).max(16),
    generation_manifest: z.unknown(),
    candidate_set_id: Id.optional(),
    candidate_set_version: Id.optional(),
    candidate_set_hash: Hash.optional(),
    candidate_set_generation_manifest: z.unknown().optional(),
    director_decision_set: z.unknown().optional(),
    compiler_provenance: z.unknown().optional(),
  })
  .strict()
  .superRefine((plan, context) => {
    if (!isPlainJson(plan) || hasForbiddenRecoveryKey(plan)) {
      context.addIssue({ code: "custom", message: "Frozen ReviewPlan cannot contain File, Replay, frames, model, prompt, CoT, or secret data." });
    }
  });
export type FrozenReviewPlan = z.infer<typeof FrozenReviewPlanSchema>;

export const RecoveryRouteReadinessSchema = z
  .record(z.string().min(1).max(160), z.enum(["PENDING", "READY", "FALLBACK"]))
  .refine((value) => Object.keys(value).length <= 50, "routeReadiness is too large");

export const RecoveryCueProgressSchema = z.object({
  completedCueIds: z.array(Id).max(64),
  // Older v2 host records predate manual-cue presentation tracking. Treat a
  // missing list as an empty history, while keeping the list itself strict.
  presentedCueIds: z.array(Id).max(64).default([]),
  consumedCueIds: z.array(Id).max(64),
  revealedCueIds: z.array(Id).max(64),
}).strict();

export const HostToolLedgerSummarySchema = z
  .object({
    callId: Id,
    cueId: Id,
    capabilityId: z.string().regex(/^cap-[a-z0-9]+(?:-[a-z0-9]+)*$/),
    status: z.enum(["POSTED", "RESULTED", "RESUMED"]),
    observationCode: z.enum(["CUE_PLAYED", "EVIDENCE_SHOWN", "UNAVAILABLE", "NO_CHANGE"]).nullable(),
    result: AgentToolResultSchema.nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.result && entry.observationCode !== entry.result.observation.code) {
      context.addIssue({ code: "custom", path: ["observationCode"], message: "Ledger observationCode must match result.observation.code." });
    }
    if (entry.status === "POSTED") {
      if (entry.observationCode !== null) context.addIssue({ code: "custom", path: ["observationCode"], message: "POSTED ledger entries must not contain an observation." });
      if (entry.result !== null) context.addIssue({ code: "custom", path: ["result"], message: "POSTED ledger entries must not contain a result." });
      return;
    }
    if (entry.status === "RESULTED") {
      if (!entry.result) {
        context.addIssue({ code: "custom", path: ["result"], message: "RESULTED ledger entries require the matching AgentToolResult." });
        return;
      }
      if (entry.result.callId !== entry.callId) {
        context.addIssue({ code: "custom", path: ["result"], message: "Ledger result callId must match the ledger entry." });
      }
      return;
    }
    if (!entry.result) {
      context.addIssue({ code: "custom", path: ["result"], message: "RESUMED ledger entries retain the matching AgentToolResult." });
      return;
    }
    if (entry.result.callId !== entry.callId) {
      context.addIssue({ code: "custom", path: ["result", "callId"], message: "RESUMED ledger result must match the ledger callId." });
    }
  });
export type HostToolLedgerSummary = z.infer<typeof HostToolLedgerSummarySchema>;

/** Converts persisted ledger truth into the Agent reconnect disposition. */
export function reconnectDispositionFromLedger(
  rawEntry: HostToolLedgerSummary,
): ReconnectToolDisposition {
  const entry = HostToolLedgerSummarySchema.parse(rawEntry);
  if (entry.status === "RESUMED") return ReconnectToolDispositionSchema.parse({ status: "NONE" });
  if (entry.status === "RESULTED" && entry.result?.status === "SUCCEEDED") {
    return ReconnectToolDispositionSchema.parse({
      status: "SUCCEEDED",
      callId: entry.callId,
      result: entry.result,
    });
  }
  if (entry.status === "RESULTED" && entry.result) {
    return ReconnectToolDispositionSchema.parse({ status: entry.result.status, callId: entry.callId });
  }
  return ReconnectToolDispositionSchema.parse({ status: "POSTED", callId: entry.callId });
}

export const PreparedNarrationArtifactSchema = z
  .object({
    cueId: Id,
    readiness: z.enum(["READY", "FALLBACK"]),
    presentation: z.enum(["PREPARED", "PRESENTABLE"]),
    narrationSummary: NarrationPolicySummarySchema,
  })
  .strict();
type ReadonlyNarrationField = Omit<NarrationPolicySummary["fields"]["coreIssue"], "refs" | "limitations"> & {
  readonly refs: readonly string[];
  readonly limitations: readonly string[];
};
export interface PreparedNarrationArtifact {
  readonly cueId: string;
  readonly readiness: "READY" | "FALLBACK";
  readonly presentation: "PREPARED" | "PRESENTABLE";
  readonly narrationSummary: Omit<NarrationPolicySummary, "fields"> & {
    readonly fields: {
      readonly currentSituation: ReadonlyNarrationField;
      readonly playerAction: ReadonlyNarrationField;
      readonly coreIssue: ReadonlyNarrationField;
      readonly betterPlay: ReadonlyNarrationField;
      readonly outcomeImpact: ReadonlyNarrationField;
    };
  };
}

const RecoveryPostedToolLedgerEntrySchema = z
  .object({
    callId: Id,
    cueId: Id,
    capabilityId: z.string().regex(/^cap-[a-z0-9]+(?:-[a-z0-9]+)*$/),
    status: z.literal("POSTED"),
    observationCode: z.null(),
    result: z.null(),
  })
  .strict();

export type RecoveryPostedToolLedgerEntry = z.infer<typeof RecoveryPostedToolLedgerEntrySchema>;

export const RecoveryStableBoundaryUpdateSchema = z.object({
  boundary: RecoveryBoundarySchema,
  cueProgress: RecoveryCueProgressSchema,
  routeReadiness: RecoveryRouteReadinessSchema,
  narrationArtifacts: z.array(PreparedNarrationArtifactSchema).max(MAX_RECOVERY_NARRATION_ARTIFACTS),
  agentCheckpointId: Id.nullable(),
  updatedAt: z.number().int().nonnegative(),
  toolLedgerEntry: RecoveryPostedToolLedgerEntrySchema.optional(),
}).strict();

export const SessionRecoveryRecordSchema = z
  .object({
    schemaVersion: z.literal(SESSION_RECOVERY_RECORD_VERSION),
    status: z.enum(["INCOMPLETE", "INCOMPATIBLE"]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    recoveryId: Id,
    sessionId: Id,
    runId: Id,
    demoContentHash: Sha256,
    selectedPlayerId: Id,
    routeId: Id,
    routeHash: Hash,
    versions: z.object({
      parser: Id,
      analysisAdapter: Id,
      candidateGenerator: Id,
      director: Id,
      planCompiler: Id,
      reviewPlanSchema: Id,
      sessionSchema: Id,
      graph: Id,
      agentState: Id,
    }).strict(),
    frozenReviewPlan: FrozenReviewPlanSchema,
    routeReadiness: RecoveryRouteReadinessSchema,
    boundary: RecoveryBoundarySchema,
    cueProgress: RecoveryCueProgressSchema,
    agentCheckpointId: Id.nullable(),
    toolLedger: z.array(HostToolLedgerSummarySchema).max(MAX_RECOVERY_TOOL_LEDGER),
    narrationArtifacts: z.array(PreparedNarrationArtifactSchema).max(MAX_RECOVERY_NARRATION_ARTIFACTS),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.updatedAt < record.createdAt) {
      context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt must not precede createdAt." });
    }
    if (!isPlainJson(record) || hasForbiddenRecoveryKey(record)) {
      context.addIssue({ code: "custom", message: "Recovery record contains forbidden replay/model data." });
    }
    if (JSON.stringify(record).length > MAX_RECOVERY_RECORD_BYTES) {
      context.addIssue({ code: "custom", message: "Recovery record exceeds 1 MiB." });
    }
  });
export type SessionRecoveryRecord = z.infer<typeof SessionRecoveryRecordSchema>;

export const SessionRecoveryEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("BOOT"), eventId: Id }).strict(),
  z.object({ type: z.literal("SESSION_STARTED"), eventId: Id, record: SessionRecoveryRecordSchema }).strict(),
  z.object({ type: z.literal("REPLAY_LOADING"), eventId: Id, recoveryId: Id }).strict(),
  z.object({
    type: z.literal("REPLAY_READY"),
    eventId: Id,
    recoveryId: Id,
    replayAvailability: z.literal("READY"),
    demoContentHash: Sha256,
    availablePlayerIds: z.array(Id).max(64),
  }).strict(),
  z.object({
    type: z.literal("ANALYSIS_READY"),
    eventId: Id,
    recoveryId: Id,
    demoContentHash: Sha256,
    selectedPlayerId: Id,
    routeId: Id,
    routeHash: Hash,
    versions: z.object({ parser: Id, analysisAdapter: Id, planner: Id }).strict(),
  }).strict(),
  z.object({
    type: z.literal("STABLE_BOUNDARY_REACHED"),
    eventId: Id,
    recoveryId: Id,
    ...RecoveryStableBoundaryUpdateSchema.shape,
  }).strict(),
  z.object({
    type: z.literal("TOOL_LEDGER_UPDATED"),
    eventId: Id,
    recoveryId: Id,
    entry: HostToolLedgerSummarySchema,
    agentCheckpointId: Id.nullable(),
    updatedAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({ type: z.literal("SESSION_COMPLETED"), eventId: Id, recoveryId: Id }).strict(),
  z.object({ type: z.literal("DISCARD_RECOVERY"), eventId: Id, recoveryId: Id }).strict(),
  z.object({ type: z.literal("RECOVERY_HANDSHAKE_COMPLETED"), eventId: Id, recoveryId: Id }).strict(),
  z.object({ type: z.literal("RECOVERY_HANDSHAKE_FAILED"), eventId: Id, recoveryId: Id, reason: z.string().min(1).max(200), degraded: z.boolean() }).strict(),
]);
export type SessionRecoveryEvent = z.infer<typeof SessionRecoveryEventSchema>;

export const SessionRecoveryResultSchema = z
  .object({
    schemaVersion: z.literal(SESSION_RECOVERY_RUNTIME_VERSION),
    status: z.enum(["DORMANT", "READY", "REBUILDING", "RECOVERED", "REJECTED", "DEGRADED"]),
    recoveryId: Id.nullable(),
    record: SessionRecoveryRecordSchema.nullable(),
    effects: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("REQUEST_REPLAY"), recoveryId: Id }).strict(),
      z.object({ type: z.literal("REQUEST_SESSION_REHYDRATE"), recoveryId: Id }).strict(),
      z.object({ type: z.literal("RECONNECT_AGENT"), recoveryId: Id }).strict(),
      z.object({ type: z.literal("SELECT_PLAYER"), recoveryId: Id, playerId: Id }).strict(),
      z.object({ type: z.literal("SEEK_RECOVERY_BOUNDARY"), recoveryId: Id, boundary: RecoveryBoundarySchema }).strict(),
    ])).max(3),
    reason: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type SessionRecoveryResult = z.infer<typeof SessionRecoveryResultSchema>;

export interface SessionRecoveryRuntime {
  dispatch(event: SessionRecoveryEvent): Promise<SessionRecoveryResult>;
}

export type RecoveryIdentity = CoachAgentIdentity;
export type RecoveryBoundaryProjection = RecoveryBoundary;
export type RecoveryReplayAvailability = z.infer<typeof ReplayAvailabilitySchema>;

export { RecoveryBoundarySchema, ReplayAvailabilitySchema };
export { ReconnectToolDispositionSchema };
export type { ReconnectToolDisposition };
