import { z } from "zod";
import {
  CLAIM_VERIFICATION_STATUSES,
  COACH_VERDICT_TYPES,
  LEARNING_THREAD_DIAGNOSIS_TYPES,
  LEARNING_THREAD_STATUSES,
  USER_CLAIM_TYPES,
  type CoachVerdict,
  type LearningThread,
  type TransferRule,
  type UserClaim,
} from "@cs-coach/contracts";
import {
  MEMORY_AUTHORIZATION_VERSION,
  MEMORY_BRIEF_VERSION,
  MEMORY_CONSENT_STATES,
  MEMORY_EVENT_TYPES,
  MEMORY_EVENT_VERSION,
  MEMORY_KINDS,
  MEMORY_OPERATIONS,
  MEMORY_PROPOSAL_VERSION,
  MEMORY_RECORD_VERSION,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MEMORY_SOURCE_NAMESPACES,
  MEMORY_STATUSES,
  type MemoryEvent,
  type MemoryEventType,
  type MemoryOperation,
  type MemoryProposal,
  type MemoryRecord,
} from "./domain";

export const MEMORY_MAX_ID = 160;
export const MEMORY_MAX_SHORT_TEXT = 240;
export const MEMORY_MAX_TEXT = 800;
export const MEMORY_MAX_CONTENT = 1_200;
export const MEMORY_MAX_REFS = 64;
export const MEMORY_MAX_CLAIMS = 16;
export const MEMORY_MAX_CORRECTIONS = 8;
export const MEMORY_MAX_DEMO_HASHES = 64;

export const MemoryIdSchema = z.string().trim().min(1).max(MEMORY_MAX_ID);
export const MemoryShortTextSchema = z.string().trim().min(1).max(MEMORY_MAX_SHORT_TEXT);
export const MemoryTextSchema = z.string().trim().min(1).max(MEMORY_MAX_TEXT);
export const MemoryContentSchema = z.string().trim().min(1).max(MEMORY_MAX_CONTENT);
export const MemoryConfidenceSchema = z.number().finite().min(0).max(1);
export const MemoryTimestampSchema = z.string().trim().min(1).max(80);
export const MemoryDemoHashSchema = z.string().trim().min(1).max(256);

const boundedIdArray = (max = MEMORY_MAX_REFS) => z.array(MemoryIdSchema).max(max);
const boundedTextArray = (max = 16) => z.array(MemoryShortTextSchema).max(max);

export const MemorySourceRefSchema = z
  .object({
    namespace: z.enum(MEMORY_SOURCE_NAMESPACES),
    refId: MemoryIdSchema,
    demoContentHash: MemoryDemoHashSchema,
    sessionId: MemoryIdSchema,
    cueId: MemoryIdSchema,
    caseId: MemoryIdSchema.optional(),
    threadId: MemoryIdSchema.optional(),
    source: z.enum(MEMORY_SOURCES).optional(),
    label: MemoryShortTextSchema.optional(),
  })
  .strict();

export const MemoryFactRefSchema = z
  .object({
    ref: MemorySourceRefSchema,
    kind: z.enum(["DEMO_FACT", "OBSERVATION_CLAIM"]).optional(),
  })
  .strict();

export const MemoryInferenceSchema = z
  .object({
    id: MemoryIdSchema,
    summary: MemoryTextSchema,
    confidence: MemoryConfidenceSchema,
    refs: z.array(MemorySourceRefSchema).max(MEMORY_MAX_REFS),
  })
  .strict();

export const MemoryAdviceSchema = z
  .object({
    id: MemoryIdSchema,
    when: MemoryTextSchema,
    do: MemoryTextSchema,
    unless: MemoryTextSchema.optional(),
    confidence: MemoryConfidenceSchema,
    refs: z.array(MemorySourceRefSchema).max(MEMORY_MAX_REFS),
  })
  .strict();

export const MemoryPreferenceSchema = z
  .object({
    key: MemoryIdSchema,
    value: z.union([z.string().max(MEMORY_MAX_CONTENT), z.number().finite(), z.boolean()]),
    label: MemoryShortTextSchema.optional(),
    source: z.enum(["USER", "USER_EXPLICIT"]),
    refs: z.array(MemorySourceRefSchema).max(MEMORY_MAX_REFS),
  })
  .strict();

const MemoryProfileKeySchema = z.string().trim().min(1).max(64);
export const MemoryProfileValueSchema = z.union([
  z.string().trim().min(1).max(MEMORY_MAX_SHORT_TEXT),
  z.number().finite(),
  z.boolean(),
]);

/** Explicit user profile fields; this is not an account/identity envelope. */
export const MemoryProfileSchema = z
  .record(MemoryProfileKeySchema, MemoryProfileValueSchema)
  .superRefine((profile, ctx) => {
    const keys = Object.keys(profile);
    if (keys.length === 0) ctx.addIssue({ code: "custom", message: "profile must contain at least one field" });
    if (keys.length > 8) ctx.addIssue({ code: "custom", message: "profile exceeds the eight-field bound" });
    for (const key of keys) {
      if (["userId", "principal", "cookie", "memoryId", "targetMemoryId"].includes(key)) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} is not a profile field` });
      }
    }
  });

export const MemoryCorrectionSchema = z
  .object({
    correctionId: MemoryIdSchema,
    memoryId: MemoryIdSchema,
    content: MemoryContentSchema,
    source: z.literal("USER"),
    createdAt: MemoryTimestampSchema,
    revision: z.number().int().nonnegative().max(10_000),
    refs: z.array(MemorySourceRefSchema).max(MEMORY_MAX_REFS),
  })
  .strict();

/** Runtime-only contract projections; the semantic types remain in contracts. */
export const MemoryUserClaimSchema = z
  .object({
    claimId: MemoryIdSchema,
    type: z.enum(USER_CLAIM_TYPES),
    content: MemoryTextSchema,
    source: z.literal("USER"),
    verification: z.enum(CLAIM_VERIFICATION_STATUSES),
    supportingRefs: boundedIdArray(32),
    contradictingRefs: boundedIdArray(32),
    limitations: boundedTextArray(12),
    cueId: MemoryIdSchema.optional(),
    originReflectionId: MemoryIdSchema.optional(),
  })
  .strict();

export const MemoryTransferRuleSchema = z
  .object({
    ruleId: MemoryIdSchema,
    when: MemoryTextSchema,
    do: MemoryTextSchema,
    unless: MemoryTextSchema.optional(),
    refs: boundedIdArray(MEMORY_MAX_REFS),
    confidence: MemoryConfidenceSchema,
    limitations: boundedTextArray(12),
  })
  .strict();

export const MemoryCoachVerdictSchema = z
  .object({
    type: z.enum(COACH_VERDICT_TYPES),
    confidence: MemoryConfidenceSchema,
    hingeId: MemoryIdSchema,
    diagnosticResultId: MemoryIdSchema.optional(),
    claimIds: boundedIdArray(32),
    evidenceRefs: boundedIdArray(MEMORY_MAX_REFS),
    limitations: boundedTextArray(12),
    revision: z.number().int().nonnegative().max(10_000),
    explanation: MemoryTextSchema,
  })
  .strict();

export const MemoryLearningThreadSchema = z
  .object({
    threadId: MemoryIdSchema,
    scope: z.enum(["SESSION", "CROSS_DEMO"]),
    hingeCode: MemoryIdSchema,
    trigger: z
      .object({
        situation: MemoryTextSchema,
        conditions: z.array(MemoryTextSchema).max(8),
      })
      .strict(),
    userModel: z
      .object({
        goal: MemoryShortTextSchema.optional(),
        belief: MemoryShortTextSchema.optional(),
        expectedTeammateAction: MemoryShortTextSchema.optional(),
      })
      .strict(),
    diagnosis: z
      .object({
        type: z.enum(LEARNING_THREAD_DIAGNOSIS_TYPES),
        summary: MemoryTextSchema,
        confidence: MemoryConfidenceSchema,
      })
      .strict(),
    transferRule: MemoryTransferRuleSchema,
    evidenceCueIds: boundedIdArray(MEMORY_MAX_REFS),
    successfulCueIds: boundedIdArray(MEMORY_MAX_REFS),
    conflictingCueIds: boundedIdArray(MEMORY_MAX_REFS),
    status: z.enum(LEARNING_THREAD_STATUSES),
  })
  .strict();

export const MemoryOriginSchema = z
  .object({
    sessionId: MemoryIdSchema,
    demoContentHash: MemoryDemoHashSchema,
    cueId: MemoryIdSchema,
    caseId: MemoryIdSchema.optional(),
    sourceThreadId: MemoryIdSchema.optional(),
    typedSourceRefs: z.array(MemorySourceRefSchema).min(1).max(MEMORY_MAX_REFS),
  })
  .strict();

export const MemoryScopeContextSchema = z
  .object({
    mapName: MemoryShortTextSchema.optional(),
    side: z.enum(["T", "CT"]).optional(),
    roleCode: MemoryIdSchema.optional(),
    teamId: MemoryIdSchema.optional(),
  })
  .strict();

const MemoryCorrectionPayloadSchema = z
  .object({
    correctionId: MemoryIdSchema,
    content: MemoryContentSchema,
    source: z.literal("USER"),
  })
  .strict();

const CUE_PROPOSAL_EVENT_TYPES = [
  "CUE_DIAGNOSED",
  "TRANSFER_RULE_TAUGHT",
  "TRANSFER_RULE_APPLIED",
] as const satisfies readonly MemoryEventType[];

const MANAGEMENT_OPERATION_EVENT_TYPES = {
  CORRECT: "USER_CORRECTED_COACH",
  CONFIRM: "USER_CONFIRMED",
  DELETE: "MEMORY_DELETED",
} as const satisfies Partial<Record<MemoryOperation, MemoryEventType>>;

const EVENT_TYPE_OPERATIONS = {
  USER_PREFERENCE_STATED: ["CREATE"],
  USER_PROFILE_STATED: ["CREATE", "UPDATE"],
  USER_CONFIRMED: ["CONFIRM"],
  USER_CORRECTED_COACH: ["CORRECT"],
  CUE_DIAGNOSED: ["CREATE"],
  TRANSFER_RULE_TAUGHT: ["CREATE"],
  TRANSFER_RULE_APPLIED: ["UPDATE"],
  SESSION_COMPLETED: [],
  MEMORY_DELETED: ["DELETE"],
} as const satisfies Partial<Record<MemoryEventType, readonly MemoryOperation[]>>;

export function isManagementOperation(operation: MemoryOperation | undefined): boolean {
  return operation === "CORRECT" || operation === "CONFIRM" || operation === "DELETE";
}

export function isManagementEventType(eventType: MemoryEventType | undefined): boolean {
  return eventType === "USER_CORRECTED_COACH" || eventType === "USER_CONFIRMED" || eventType === "MEMORY_DELETED";
}

export function isCueProposalEventType(eventType: MemoryEventType | undefined): boolean {
  return Boolean(eventType && (CUE_PROPOSAL_EVENT_TYPES as readonly string[]).includes(eventType));
}

export function expectedEventTypeForOperation(operation: MemoryOperation): MemoryEventType | undefined {
  return MANAGEMENT_OPERATION_EVENT_TYPES[operation as keyof typeof MANAGEMENT_OPERATION_EVENT_TYPES];
}

export function operationMatchesEventType(operation: MemoryOperation | undefined, eventType: MemoryEventType | undefined): boolean {
  if (!operation || !eventType) return true;
  return (EVENT_TYPE_OPERATIONS[eventType] as readonly MemoryOperation[] | undefined)?.includes(operation) ?? false;
}

/** Completion events carry only the fixed, bounded lifecycle marker. */
export const MemoryCompletionMetadataSchema = z
  .object({ reason: z.literal("SESSION_COMPLETED") })
  .strict();

export const MemoryProposalSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_PROPOSAL_VERSION),
    proposalId: MemoryIdSchema,
    userId: MemoryIdSchema,
    operation: z.enum(MEMORY_OPERATIONS),
    eventType: z.enum(MEMORY_EVENT_TYPES).optional(),
    targetMemoryId: MemoryIdSchema.optional(),
    requestedScope: z.literal("CROSS_DEMO"),
    kind: z.enum(MEMORY_KINDS),
    logicalKey: MemoryIdSchema,
    thread: MemoryLearningThreadSchema.optional(),
    claims: z.array(MemoryUserClaimSchema).max(MEMORY_MAX_CLAIMS),
    verdict: MemoryCoachVerdictSchema.optional(),
    transferRule: MemoryTransferRuleSchema.optional(),
    preference: MemoryPreferenceSchema.optional(),
    profile: MemoryProfileSchema.optional(),
    origin: MemoryOriginSchema,
    outcomeGateStatus: z.literal("COMPLETE").optional(),
    lifecycle: z.enum(MEMORY_STATUSES),
    consentState: z.enum(MEMORY_CONSENT_STATES),
    producerVersion: MemoryIdSchema,
    idempotencyKey: MemoryIdSchema,
    createdAt: MemoryTimestampSchema,
    content: MemoryContentSchema.optional(),
    correction: MemoryCorrectionPayloadSchema.optional(),
    applicationOutcome: z.enum(["SUCCESS", "CONFLICT"]).optional(),
    deleteReason: MemoryShortTextSchema.optional(),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const expectedEventType = expectedEventTypeForOperation(proposal.operation);
    if (isManagementOperation(proposal.operation) && !proposal.targetMemoryId) {
      // Management proposals address an existing aggregate. Without an
      // explicit target a direct adapter could fall back to logicalKey and
      // mutate or create a record from a forged cue-shaped payload.
      ctx.addIssue({ code: "custom", path: ["targetMemoryId"], message: "management proposals require targetMemoryId" });
    }
    if (expectedEventType !== undefined && proposal.eventType !== expectedEventType) {
      ctx.addIssue({ code: "custom", path: ["eventType"], message: `operation ${proposal.operation} must use eventType ${expectedEventType}` });
    }
    if (proposal.eventType === "SESSION_COMPLETED") {
      ctx.addIssue({ code: "custom", path: ["eventType"], message: "SESSION_COMPLETED cannot carry a MemoryProposal" });
    }
    if (proposal.eventType && !operationMatchesEventType(proposal.operation, proposal.eventType)) {
      ctx.addIssue({ code: "custom", path: ["operation"], message: `operation ${proposal.operation} is not valid for eventType ${proposal.eventType}` });
    }
    if (proposal.eventType === "USER_PREFERENCE_STATED" && !["PREFERENCE", "COACHING_PREFERENCE"].includes(proposal.kind)) {
      ctx.addIssue({ code: "custom", path: ["kind"], message: "preference event must carry a preference kind" });
    }
    const isProfileWrite = proposal.kind === "PROFILE" && ["CREATE", "UPDATE"].includes(proposal.operation);
    if (isProfileWrite && (!proposal.profile || proposal.eventType !== "USER_PROFILE_STATED")) {
      ctx.addIssue({ code: "custom", path: ["profile"], message: "PROFILE proposals require USER_PROFILE_STATED and profile fields" });
    }
    if (proposal.profile && proposal.kind !== "PROFILE") {
      ctx.addIssue({ code: "custom", path: ["kind"], message: "profile fields require PROFILE kind" });
    } else if (proposal.profile && !isProfileWrite) {
      ctx.addIssue({ code: "custom", path: ["profile"], message: "profile fields are only valid for PROFILE CREATE or UPDATE proposals" });
    }
    if (proposal.eventType === "USER_PROFILE_STATED" && (!isProfileWrite || !proposal.profile)) {
      ctx.addIssue({ code: "custom", path: ["profile"], message: "USER_PROFILE_STATED requires a PROFILE proposal" });
    }
    if (["PREFERENCE", "COACHING_PREFERENCE"].includes(proposal.kind) && !proposal.preference) {
      ctx.addIssue({ code: "custom", path: ["preference"], message: "preference is required for PREFERENCE proposals" });
    }
    if (proposal.kind === "LEARNING_THREAD" && !proposal.thread) {
      ctx.addIssue({ code: "custom", path: ["thread"], message: "thread is required for LEARNING_THREAD proposals" });
    }
    if (proposal.operation === "CORRECT" && !proposal.correction) {
      ctx.addIssue({ code: "custom", path: ["correction"], message: "correction is required for CORRECT proposals" });
    }
    if (["CREATE", "UPDATE"].includes(proposal.operation)) {
      const cueEvent = ["CUE_DIAGNOSED", "TRANSFER_RULE_TAUGHT", "TRANSFER_RULE_APPLIED"].includes(proposal.eventType ?? "");
      if (!cueEvent) {
        const explicitPreference = ["PREFERENCE", "COACHING_PREFERENCE"].includes(proposal.kind) &&
          proposal.eventType === "USER_PREFERENCE_STATED";
        if (!explicitPreference && proposal.eventType === undefined) {
          ctx.addIssue({ code: "custom", path: ["eventType"], message: "durable proposals require an event type" });
        }
      } else {
        if (proposal.eventType === undefined) {
          ctx.addIssue({ code: "custom", path: ["eventType"], message: "cue proposals require an event type" });
        }
        if (proposal.outcomeGateStatus !== "COMPLETE") {
          ctx.addIssue({ code: "custom", path: ["outcomeGateStatus"], message: "completed OutcomeCompletionGate proof is required for cue proposals" });
        }
        const proposalOrigin = proposal.origin as { caseId?: unknown; sourceThreadId?: unknown; typedSourceRefs?: unknown[] };
        if (!proposalOrigin?.caseId || !proposalOrigin?.sourceThreadId || !Array.isArray(proposalOrigin?.typedSourceRefs) || proposalOrigin.typedSourceRefs.length === 0 ||
          !proposal.verdict || !proposal.transferRule) {
          ctx.addIssue({ code: "custom", path: ["origin"], message: "cue proposal lacks completed, traceable diagnosis proof" });
        }
      }
    }
  });

const EventControlPayloadSchema = z
  .object({
    proposal: MemoryProposalSchema.optional(),
    memoryId: MemoryIdSchema.optional(),
    proposalId: MemoryIdSchema.optional(),
    targetMemoryId: MemoryIdSchema.optional(),
    logicalKey: MemoryIdSchema.optional(),
    preference: MemoryPreferenceSchema.optional(),
    profile: MemoryProfileSchema.optional(),
    correction: MemoryCorrectionPayloadSchema.optional(),
    content: MemoryContentSchema.optional(),
    reason: MemoryShortTextSchema.optional(),
    key: MemoryIdSchema.optional(),
    value: z.union([z.string().max(MEMORY_MAX_CONTENT), z.number().finite(), z.boolean()]).optional(),
    source: z.enum(["USER", "USER_EXPLICIT"]).optional(),
    label: MemoryShortTextSchema.optional(),
    refs: z.array(MemorySourceRefSchema).max(MEMORY_MAX_REFS).optional(),
  })
  .strict()
  .refine((payload) => Object.values(payload).some((value) => value !== undefined), {
    message: "event payload must contain a bounded proposal or control value",
  });

export const MemoryEventPayloadSchema = z.union([
  MemoryProposalSchema,
  z.object({ proposal: MemoryProposalSchema }).strict(),
  MemoryCompletionMetadataSchema,
  EventControlPayloadSchema,
]);

const FORBIDDEN_EVENT_PAYLOAD_KEYS = new Set([
  "rawDemo",
  "raw_demo",
  "demoBytes",
  "demo_bytes",
  "frames",
  "fullReplay",
  "full_replay",
  "replay",
  "ticks",
  "tickStream",
  "tick_stream",
  "prompt",
  "chainOfThought",
  "chain_of_thought",
  "cot",
  "cookie",
  "apiKey",
  "api_key",
  "secret",
]);

function inspectEventPayload(
  value: unknown,
  eventUserId: string,
  ctx: z.RefinementCtx,
  path: (string | number)[] = ["payload"],
  seen = new Set<unknown>(),
): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectEventPayload(item, eventUserId, ctx, [...path, index], seen));
    return;
  }
  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (FORBIDDEN_EVENT_PAYLOAD_KEYS.has(key)) {
      ctx.addIssue({ code: "custom", path: [...path, key], message: `${key} is not allowed in memory events` });
    }
    if (key === "userId" && typeof child === "string" && child !== eventUserId) {
      ctx.addIssue({ code: "custom", path: [...path, key], message: "nested event userId must match envelope userId" });
    }
    inspectEventPayload(child, eventUserId, ctx, [...path, key], seen);
  }
}

export const MemoryEventSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_EVENT_VERSION),
    eventId: MemoryIdSchema,
    type: z.enum(MEMORY_EVENT_TYPES).optional(),
    eventType: z.enum(MEMORY_EVENT_TYPES).optional(),
    userId: MemoryIdSchema,
    sessionId: MemoryIdSchema,
    demoContentHash: MemoryDemoHashSchema.optional(),
    proposalId: MemoryIdSchema.optional(),
    targetMemoryId: MemoryIdSchema.optional(),
    operation: z.enum(MEMORY_OPERATIONS).optional(),
    idempotencyKey: MemoryIdSchema,
    producerVersion: MemoryIdSchema,
    payload: MemoryEventPayloadSchema.optional(),
    payloadRef: MemorySourceRefSchema.optional(),
    attemptCount: z.number().int().nonnegative().max(100).optional(),
    nextAttemptAt: MemoryTimestampSchema.optional(),
    createdAt: MemoryTimestampSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    const envelopeEventType = event.type ?? event.eventType;
    if (!event.type && !event.eventType) {
      ctx.addIssue({ code: "custom", path: ["type"], message: "type or eventType is required" });
    }
    if (event.type && event.eventType && event.type !== event.eventType) {
      ctx.addIssue({ code: "custom", path: ["eventType"], message: "type and eventType must agree" });
    }
    if (event.operation !== undefined && !operationMatchesEventType(event.operation, envelopeEventType)) {
      ctx.addIssue({ code: "custom", path: ["operation"], message: `operation ${event.operation} is not valid for event type ${envelopeEventType}` });
    }
    if (isManagementEventType(envelopeEventType)) {
      const expectedOperation = EVENT_TYPE_OPERATIONS[envelopeEventType as keyof typeof EVENT_TYPE_OPERATIONS]?.[0];
      if (!event.targetMemoryId) {
        ctx.addIssue({ code: "custom", path: ["targetMemoryId"], message: "management events require targetMemoryId" });
      }
      if (event.operation !== expectedOperation) {
        ctx.addIssue({ code: "custom", path: ["operation"], message: `management event ${envelopeEventType} requires operation ${expectedOperation}` });
      }
    }
    if (envelopeEventType === "SESSION_COMPLETED") {
      if (event.operation !== undefined || event.proposalId !== undefined || event.targetMemoryId !== undefined || event.payloadRef !== undefined) {
        ctx.addIssue({ code: "custom", path: ["payload"], message: "SESSION_COMPLETED accepts metadata only" });
      }
      if (!MemoryCompletionMetadataSchema.safeParse(event.payload).success) {
        ctx.addIssue({ code: "custom", path: ["payload"], message: "SESSION_COMPLETED payload must be { reason: SESSION_COMPLETED }" });
      }
    }
    if (!event.payload && !event.payloadRef) {
      ctx.addIssue({ code: "custom", path: ["payload"], message: "payload or payloadRef is required" });
    }
    // Keep the event envelope free of accidental raw replay payloads even if
    // a future schema adds optional fields.
    const forbidden = ["rawDemo", "frames", "ticks", "demoBytes", "cookie"] as const;
    for (const key of forbidden) {
      if (key in event) ctx.addIssue({ code: "custom", path: [key], message: `${key} is not allowed in memory events` });
    }
    inspectEventPayload(event.payload, event.userId, ctx);
    if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
      const payloadObject = event.payload as Record<string, unknown>;
      const proposalCandidate = payloadObject.proposal && typeof payloadObject.proposal === "object" && !Array.isArray(payloadObject.proposal)
        ? payloadObject.proposal
        : payloadObject;
      // Control payloads (confirm/delete/preference) are intentionally not
      // proposals. Only run envelope/proposal consistency checks after the
      // strict proposal schema accepts the candidate.
      const proposalParsed = MemoryProposalSchema.safeParse(proposalCandidate);
      if (!proposalParsed.success) {
        if (isManagementEventType(envelopeEventType) && event.targetMemoryId !== undefined) {
          const nestedProposal = payloadObject.proposal && typeof payloadObject.proposal === "object" && !Array.isArray(payloadObject.proposal)
            ? payloadObject.proposal as Record<string, unknown>
            : undefined;
          const payloadTarget = typeof payloadObject.memoryId === "string"
            ? payloadObject.memoryId
            : typeof payloadObject.targetMemoryId === "string"
              ? payloadObject.targetMemoryId
              : typeof nestedProposal?.targetMemoryId === "string"
                ? nestedProposal.targetMemoryId
                : undefined;
          if (payloadTarget !== undefined && payloadTarget !== event.targetMemoryId) {
            ctx.addIssue({ code: "custom", path: ["payload", "memoryId"], message: "management payload target must match targetMemoryId" });
          }
        }
        return;
      }
      const proposal = proposalParsed.data as unknown as Record<string, unknown>;
      const payloadEventType = proposal.eventType;
      const cueProposalEvent = ["CUE_DIAGNOSED", "TRANSFER_RULE_TAUGHT", "TRANSFER_RULE_APPLIED"].includes(envelopeEventType ?? "");
      if (isManagementOperation(proposal.operation as MemoryOperation) && !proposal.targetMemoryId) {
        ctx.addIssue({ code: "custom", path: ["payload", "targetMemoryId"], message: "management proposals in events require targetMemoryId" });
      }
      if (cueProposalEvent && proposal.kind === "LEARNING_THREAD") {
        if (payloadEventType !== envelopeEventType) {
          ctx.addIssue({ code: "custom", path: ["payload", "eventType"], message: "learning-thread proposal eventType must match the cue event" });
        }
        if (proposal.outcomeGateStatus !== "COMPLETE") {
          ctx.addIssue({ code: "custom", path: ["payload", "outcomeGateStatus"], message: "completed OutcomeCompletionGate proof is required" });
        }
        const proposalOrigin = proposal.origin as { caseId?: unknown; sourceThreadId?: unknown; typedSourceRefs?: unknown[] };
        if (!proposal.thread || !proposal.verdict || !proposal.transferRule ||
          !proposalOrigin?.caseId || !proposalOrigin?.sourceThreadId || !Array.isArray(proposalOrigin?.typedSourceRefs) || proposalOrigin.typedSourceRefs.length === 0) {
          ctx.addIssue({ code: "custom", path: ["payload", "origin"], message: "cue proposal lacks completed, traceable diagnosis proof" });
        }
      }
      if (typeof payloadEventType === "string" && envelopeEventType && payloadEventType !== envelopeEventType) {
        ctx.addIssue({ code: "custom", path: ["payload", "eventType"], message: "proposal eventType must match envelope event type" });
      }
      const consistencyFields = [
        ["proposalId", "proposalId"],
        ["targetMemoryId", "targetMemoryId"],
        ["operation", "operation"],
      ] as const;
      for (const [envelopeField, proposalField] of consistencyFields) {
        const envelopeValue = event[envelopeField];
        const proposalValue = proposal[proposalField];
        if (envelopeValue !== undefined && proposalValue !== undefined && envelopeValue !== proposalValue) {
          ctx.addIssue({ code: "custom", path: ["payload", proposalField], message: `${proposalField} must match event envelope` });
        }
      }
      const proposalOrigin = proposal.origin as { sessionId?: unknown; demoContentHash?: unknown };
      if (proposalOrigin && event.sessionId !== proposalOrigin.sessionId) {
        ctx.addIssue({ code: "custom", path: ["payload", "origin", "sessionId"], message: "proposal origin sessionId must match event envelope" });
      }
      if (event.demoContentHash !== undefined && proposalOrigin?.demoContentHash !== event.demoContentHash) {
        ctx.addIssue({ code: "custom", path: ["payload", "origin", "demoContentHash"], message: "proposal origin demoContentHash must match event envelope" });
      }
    }
  });

export const MemoryRecordSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_RECORD_VERSION),
    memoryId: MemoryIdSchema,
    userId: MemoryIdSchema,
    kind: z.enum(MEMORY_KINDS),
    source: z.enum(MEMORY_SOURCES),
    scope: z.enum(MEMORY_SCOPES),
    scopeContext: MemoryScopeContextSchema.optional(),
    logicalKey: MemoryIdSchema,
    status: z.enum(MEMORY_STATUSES),
    active: z.boolean(),
    revision: z.number().int().positive().max(10_000),
    content: MemoryContentSchema.optional(),
    summary: MemoryContentSchema.optional(),
    thread: MemoryLearningThreadSchema.optional(),
    claims: z.array(MemoryUserClaimSchema).max(MEMORY_MAX_CLAIMS),
    verdict: MemoryCoachVerdictSchema.optional(),
    transferRule: MemoryTransferRuleSchema.optional(),
    preference: MemoryPreferenceSchema.optional(),
    profile: MemoryProfileSchema.optional(),
    facts: z.array(MemoryFactRefSchema).max(MEMORY_MAX_REFS),
    inferences: z.array(MemoryInferenceSchema).max(16),
    advice: z.array(MemoryAdviceSchema).max(16),
    evidence: z.array(MemorySourceRefSchema).max(MEMORY_MAX_REFS),
    counterEvidenceRefs: z.array(MemorySourceRefSchema).max(MEMORY_MAX_REFS).default([]),
    sourceRefs: z.array(MemorySourceRefSchema).max(MEMORY_MAX_REFS),
    demoContentHashes: z.array(MemoryDemoHashSchema).max(MEMORY_MAX_DEMO_HASHES),
    corrections: z.array(MemoryCorrectionSchema).max(MEMORY_MAX_CORRECTIONS),
    occurrenceCount: z.number().int().nonnegative().max(10_000).default(0),
    successfulApplicationCount: z.number().int().nonnegative().max(10_000).default(0),
    conflictingApplicationCount: z.number().int().nonnegative().max(10_000).default(0),
    previousRevisionId: MemoryIdSchema.optional(),
    createdAt: MemoryTimestampSchema,
    updatedAt: MemoryTimestampSchema,
    confirmedAt: MemoryTimestampSchema.optional(),
    deletedAt: MemoryTimestampSchema.optional(),
    tombstone: z
      .object({
        deletedBy: z.enum(["USER", "SYSTEM"]),
        reason: MemoryShortTextSchema.optional(),
      })
      .strict()
      .optional(),
    limitations: boundedTextArray(16),
    producerVersion: MemoryIdSchema,
    lastIdempotencyKey: MemoryIdSchema,
  })
  .strict();

export const MemoryQuerySchema = z
  .object({
    kind: z.union([z.enum(MEMORY_KINDS), z.array(z.enum(MEMORY_KINDS)).max(MEMORY_KINDS.length)]).optional(),
    status: z.union([z.enum(MEMORY_STATUSES), z.array(z.enum(MEMORY_STATUSES)).max(MEMORY_STATUSES.length)]).optional(),
    logicalKey: MemoryIdSchema.optional(),
    includeDeleted: z.boolean().optional(),
    activeOnly: z.boolean().optional(),
    limit: z.number().int().positive().max(100).optional(),
    cursor: MemoryIdSchema.optional(),
    taxonomyCode: MemoryIdSchema.optional(),
    mapName: MemoryShortTextSchema.optional(),
    side: z.enum(["T", "CT"]).optional(),
    roleCode: MemoryIdSchema.optional(),
    hingeCode: MemoryIdSchema.optional(),
    userGoal: MemoryShortTextSchema.optional(),
    since: MemoryTimestampSchema.optional(),
    minConfidence: MemoryConfidenceSchema.optional(),
  })
  .strict();

export const SemanticMemoryQuerySchema = MemoryQuerySchema.extend({
  text: MemoryContentSchema,
  embedding: z.array(z.number().finite()).max(4_096).optional(),
  minScore: z.number().finite().min(-1).max(1).optional(),
}).strict();

export const LearningThreadQuerySchema = MemoryQuerySchema.extend({
  hingeCode: MemoryIdSchema.optional(),
  diagnosisType: z.enum(LEARNING_THREAD_DIAGNOSIS_TYPES).optional(),
  includeCandidates: z.boolean().optional(),
}).strict();

export const MemoryAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_AUTHORIZATION_VERSION).optional(),
    userId: MemoryIdSchema,
    memoryEnabled: z.boolean().optional(),
    consent: z.enum(MEMORY_CONSENT_STATES),
    featureFlag: z.boolean().optional(),
    consentGranted: z.boolean().optional(),
    consentVersion: z.number().int().nonnegative().max(10_000).optional(),
    updatedAt: MemoryTimestampSchema.optional(),
  })
  .strict()
  .superRefine((authorization, ctx) => {
    if (authorization.memoryEnabled === undefined && authorization.featureFlag === undefined) {
      ctx.addIssue({ code: "custom", path: ["memoryEnabled"], message: "memoryEnabled or featureFlag is required" });
    }
  });

export const MemoryConfirmationSchema = z
  .object({
    confirmationId: MemoryIdSchema.optional(),
    source: z.literal("USER").optional(),
    content: MemoryContentSchema.optional(),
    confirmedAt: MemoryTimestampSchema.optional(),
  })
  .strict();

export const MemoryCorrectionInputSchema = z
  .object({
    correctionId: MemoryIdSchema.optional(),
    content: MemoryContentSchema,
    source: z.literal("USER").optional(),
    refs: z.array(MemorySourceRefSchema).max(MEMORY_MAX_REFS).optional(),
    correctedBy: MemoryIdSchema.optional(),
  })
  .strict();

export const MemoryDeleteInputSchema = z
  .object({
    reason: MemoryShortTextSchema.optional(),
    deletedAt: MemoryTimestampSchema.optional(),
  })
  .strict();

export const MemoryBriefSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_BRIEF_VERSION),
    generatedAt: MemoryTimestampSchema,
    preferences: z
      .record(MemoryIdSchema, z.union([z.string().max(MEMORY_MAX_CONTENT), z.number().finite(), z.boolean()]))
      .superRefine((preferences, ctx) => {
        if (Object.keys(preferences).length > 8) {
          ctx.addIssue({ code: "custom", message: "preferences exceeds memory brief bound" });
        }
      })
      .default({}),
    activeThreads: z.array(MemoryLearningThreadSchema).max(2),
    memories: z.array(MemoryRecordSchema).max(3),
    corrections: z.array(MemoryCorrectionSchema).max(2),
    limitations: boundedTextArray(16),
    source: z.enum(["STRUCTURED", "STRUCTURED_PLUS_SEMANTIC", "EMPTY"]),
    structuredStatus: z.enum(["AVAILABLE", "UNAVAILABLE", "EMPTY"]).optional(),
    semanticStatus: z.enum(["OPTIONAL", "UNAVAILABLE", "USED"]).optional(),
  })
  .strict();

export type ParsedMemoryEvent = z.infer<typeof MemoryEventSchema>;
export type ParsedMemoryProposal = z.infer<typeof MemoryProposalSchema>;

export function parseMemoryEvent(input: unknown): MemoryEvent {
  return MemoryEventSchema.parse(input) as unknown as MemoryEvent;
}

export function parseMemoryProposal(input: unknown): MemoryProposal {
  return MemoryProposalSchema.parse(input) as unknown as MemoryProposal;
}

export function parseMemoryRecord(input: unknown): MemoryRecord {
  return MemoryRecordSchema.parse(input) as unknown as MemoryRecord;
}

export function parseLearningThread(input: unknown): LearningThread {
  return MemoryLearningThreadSchema.parse(input) as unknown as LearningThread;
}

export function parseUserClaim(input: unknown): UserClaim {
  return MemoryUserClaimSchema.parse(input) as unknown as UserClaim;
}

export function parseTransferRule(input: unknown): TransferRule {
  return MemoryTransferRuleSchema.parse(input) as unknown as TransferRule;
}

export function parseCoachVerdict(input: unknown): CoachVerdict {
  return MemoryCoachVerdictSchema.parse(input) as unknown as CoachVerdict;
}
