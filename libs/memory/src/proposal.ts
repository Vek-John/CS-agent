import type { CueCase, LearningThread, UserClaim } from "@cs-coach/contracts";
import {
  MEMORY_PROPOSAL_VERSION,
  type MemoryProposal,
  type MemoryProposalBuildInput,
  type MemorySourceNamespace,
  type MemorySourceRef,
} from "./domain";
import { MemoryProposalSchema } from "./schemas";

const MAX_TEXT = 1_200;
const MAX_SHORT_TEXT = 240;
const MAX_REFS = 64;

function bounded(value: string | undefined, max = MAX_TEXT): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, max);
  return normalized || undefined;
}

function required(value: string, max = MAX_TEXT): string {
  return bounded(value, max) ?? "unknown";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Small deterministic non-cryptographic token for keys, not a security secret. */
export function stableMemoryToken(value: string): string {
  // A synchronous, non-secret 64-bit FNV-1a token keeps IDs deterministic in
  // browser/Worker code while making accidental logical-key collisions far
  // less likely than the old 32-bit token. It is not used as a security hash.
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function stableMemoryLogicalKey(thread: Pick<LearningThread, "hingeCode" | "diagnosis" | "transferRule">): string {
  const semantic = [
    thread.hingeCode,
    thread.diagnosis.type,
    thread.transferRule.when,
    thread.transferRule.do,
    thread.transferRule.unless ?? "",
  ]
    .map((value) => value.replace(/\s+/g, " ").trim().toLowerCase())
    .join("|");
  return `memory-logical-${stableMemoryToken(semantic)}`;
}

export function stableMemoryIdempotencyKey(input: {
  userId: string;
  eventType: string;
  sessionId: string;
  demoContentHash: string;
  cueId: string;
  logicalKey: string;
}): string {
  return `memory-idem-${stableMemoryToken(
    [input.userId, input.eventType, input.sessionId, input.demoContentHash, input.cueId, input.logicalKey]
      .map((value) => value.trim())
      .join("|"),
  )}`;
}

/** Short aliases for adapters that use the contract vocabulary. */
export const stableLogicalKey = stableMemoryLogicalKey;
export const stableIdempotencyKey = stableMemoryIdempotencyKey;

export function createMemorySourceRef(input: {
  namespace: MemorySourceNamespace;
  refId: string;
  demoContentHash: string;
  sessionId: string;
  cueId: string;
  caseId?: string;
  threadId?: string;
  label?: string;
}): MemorySourceRef {
  return {
    namespace: input.namespace,
    refId: required(input.refId, 160),
    demoContentHash: required(input.demoContentHash, 256),
    sessionId: required(input.sessionId, 160),
    cueId: required(input.cueId, 160),
    ...(bounded(input.caseId, 160) ? { caseId: bounded(input.caseId, 160) } : {}),
    ...(bounded(input.threadId, 160) ? { threadId: bounded(input.threadId, 160) } : {}),
    ...(bounded(input.label, MAX_SHORT_TEXT) ? { label: bounded(input.label, MAX_SHORT_TEXT) } : {}),
  };
}

function refForClaim(
  claim: UserClaim,
  input: MemoryProposalBuildInput,
  thread: LearningThread,
): MemorySourceRef {
  return createMemorySourceRef({
    namespace: "USER_CLAIM",
    refId: claim.claimId,
    demoContentHash: input.demoContentHash,
    sessionId: input.sessionId,
    cueId: input.cueCase.cueId,
    caseId: input.cueCase.caseId,
    threadId: thread.threadId,
    label: "user claim",
  });
}

function buildRefs(input: MemoryProposalBuildInput, thread: LearningThread): MemorySourceRef[] {
  const refs: MemorySourceRef[] = input.cueCase.claims.slice(0, 16).map((claim) => refForClaim(claim, input, thread));
  for (const provenance of input.provenanceRefs ?? []) {
    refs.push(
      createMemorySourceRef({
        namespace: provenance.namespace,
        refId: provenance.refId,
        demoContentHash: input.demoContentHash,
        sessionId: input.sessionId,
        cueId: input.cueCase.cueId,
        caseId: input.cueCase.caseId,
        threadId: thread.threadId,
        label: provenance.label,
      }),
    );
  }
  if (input.cueCase.verdict) {
    refs.push(
      createMemorySourceRef({
        namespace: "VERDICT",
        refId: `${input.cueCase.verdict.hingeId}-${input.cueCase.caseId}`,
        demoContentHash: input.demoContentHash,
        sessionId: input.sessionId,
        cueId: input.cueCase.cueId,
        caseId: input.cueCase.caseId,
        threadId: thread.threadId,
        label: "coach verdict",
      }),
    );
  }
  refs.push(
    createMemorySourceRef({
      namespace: "TRANSFER_RULE",
      refId: thread.transferRule.ruleId,
      demoContentHash: input.demoContentHash,
      sessionId: input.sessionId,
      cueId: input.cueCase.cueId,
      caseId: input.cueCase.caseId,
      threadId: thread.threadId,
      label: "transfer rule",
    }),
  );
  return refs.slice(0, MAX_REFS);
}

function assertCueCaseShape(cueCase: CueCase): void {
  if (!cueCase || cueCase.schemaVersion !== "cue-case.v1") throw new Error("INVALID_CUE_CASE");
  if (!cueCase.caseId?.trim() || !cueCase.cueId?.trim()) throw new Error("INVALID_CUE_CASE_ID");
  if (!Array.isArray(cueCase.claims)) throw new Error("INVALID_CUE_CASE_CLAIMS");
  // A proposal is allowed only after the deterministic diagnosis/outcome
  // boundary has completed.  `VERDICT_READY` is an intermediate Session
  // state; accepting it here would let an accidental trusted-sink caller
  // promote an unfinished or skipped cue into durable memory.
  if (!["AWAITING_CONFIRMATION", "DISAGREED", "COMPLETED"].includes(cueCase.status)) {
    throw new Error("OUTCOME_GATE_INCOMPLETE");
  }
  if (!cueCase.diagnosticResult || cueCase.diagnosticResult.cueId !== cueCase.cueId) {
    throw new Error("DIAGNOSTIC_RESULT_REQUIRED");
  }
  if (!cueCase.verdict || cueCase.verdict.hingeId !== cueCase.diagnosticResult.hingeId) {
    throw new Error("COACH_VERDICT_REQUIRED");
  }
}

function boundedThread(thread: LearningThread): LearningThread {
  return {
    ...thread,
    scope: "CROSS_DEMO",
    trigger: {
      situation: required(thread.trigger.situation),
      conditions: thread.trigger.conditions.slice(0, 8).map((condition) => required(condition, MAX_SHORT_TEXT)),
    },
    userModel: {
      ...(bounded(thread.userModel.goal, MAX_SHORT_TEXT) ? { goal: bounded(thread.userModel.goal, MAX_SHORT_TEXT) } : {}),
      ...(bounded(thread.userModel.belief, MAX_SHORT_TEXT) ? { belief: bounded(thread.userModel.belief, MAX_SHORT_TEXT) } : {}),
      ...(bounded(thread.userModel.expectedTeammateAction, MAX_SHORT_TEXT)
        ? { expectedTeammateAction: bounded(thread.userModel.expectedTeammateAction, MAX_SHORT_TEXT) }
        : {}),
    },
    diagnosis: {
      ...thread.diagnosis,
      summary: required(thread.diagnosis.summary),
      confidence: Math.max(0, Math.min(1, thread.diagnosis.confidence)),
    },
    transferRule: {
      ...thread.transferRule,
      when: required(thread.transferRule.when),
      do: required(thread.transferRule.do),
      ...(bounded(thread.transferRule.unless) ? { unless: bounded(thread.transferRule.unless) } : {}),
      refs: unique(thread.transferRule.refs).slice(0, MAX_REFS),
      confidence: Math.max(0, Math.min(1, thread.transferRule.confidence)),
      limitations: thread.transferRule.limitations.slice(0, 12).map((value) => required(value, MAX_SHORT_TEXT)),
    },
    evidenceCueIds: unique(thread.evidenceCueIds).slice(0, MAX_REFS),
    successfulCueIds: unique(thread.successfulCueIds).slice(0, MAX_REFS),
    conflictingCueIds: unique(thread.conflictingCueIds).slice(0, MAX_REFS),
  };
}

function boundedClaims(claims: readonly UserClaim[]): UserClaim[] {
  return claims.slice(0, 16).map((claim) => ({
    ...claim,
    claimId: required(claim.claimId, 160),
    content: required(claim.content, 800),
    supportingRefs: unique(claim.supportingRefs).slice(0, 32),
    contradictingRefs: unique(claim.contradictingRefs).slice(0, 32),
    limitations: claim.limitations.slice(0, 12).map((value) => required(value, MAX_SHORT_TEXT)),
  }));
}

/**
 * Projects a validated Session CueCase + LearningThread into a bounded,
 * cross-Demo proposal.  It intentionally does not inspect or persist facts,
 * ObservableState, frames, ticks, capabilities, or player identity details.
 */
export function buildMemoryProposal(input: MemoryProposalBuildInput): MemoryProposal {
  assertCueCaseShape(input.cueCase);
  if (input.outcomeGateStatus !== "COMPLETE") throw new Error("OUTCOME_GATE_INCOMPLETE");
  if (!input.userId.trim() || !input.sessionId.trim() || !input.demoContentHash.trim()) throw new Error("INVALID_PROVENANCE");
  const thread = boundedThread(input.learningThread);
  const logicalKey = stableMemoryLogicalKey(thread);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const typedSourceRefs = buildRefs(input, thread);
  const proposal: MemoryProposal = {
    schemaVersion: MEMORY_PROPOSAL_VERSION,
    proposalId: `proposal-${stableMemoryToken(`${input.sessionId}|${input.cueCase.caseId}|${input.demoContentHash}|${logicalKey}`)}`,
    userId: required(input.userId, 160),
    operation: "CREATE",
    eventType: "CUE_DIAGNOSED",
    requestedScope: "CROSS_DEMO",
    kind: "LEARNING_THREAD",
    logicalKey,
    thread,
    claims: boundedClaims(input.cueCase.claims),
    ...(input.cueCase.verdict ? { verdict: input.cueCase.verdict } : {}),
    transferRule: thread.transferRule,
    origin: {
      sessionId: required(input.sessionId, 160),
      demoContentHash: required(input.demoContentHash, 256),
      cueId: required(input.cueCase.cueId, 160),
      caseId: required(input.cueCase.caseId, 160),
      sourceThreadId: required(thread.threadId, 160),
      typedSourceRefs,
    },
    outcomeGateStatus: "COMPLETE",
    lifecycle: "CANDIDATE",
    consentState: "GRANTED",
    producerVersion: required(input.producerVersion ?? "memory-domain.v1", 160),
    idempotencyKey: stableMemoryIdempotencyKey({
      userId: input.userId,
      eventType: "CUE_DIAGNOSED",
      sessionId: input.sessionId,
      demoContentHash: input.demoContentHash,
      cueId: input.cueCase.cueId,
      logicalKey,
    }),
    createdAt,
  };
  return MemoryProposalSchema.parse(proposal) as unknown as MemoryProposal;
}

/** Explicitly named alias used by API/Outbox adapters. */
export const buildMemoryProposalFromCueCase = buildMemoryProposal;
export const buildMemoryProposalFromValidatedCueCase = buildMemoryProposal;
export const createMemoryProposal = buildMemoryProposal;
