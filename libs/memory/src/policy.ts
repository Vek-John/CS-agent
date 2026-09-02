import type {
  MemoryEventType,
  MemoryProposal,
  MemoryRecord,
  MemorySourceRef,
  MemoryStatus,
  MemoryWriteDecision,
} from "./domain";
import {
  operationMatchesEventType,
} from "./schemas";

export interface MemoryPolicyInput {
  proposal: MemoryProposal;
  current?: MemoryRecord;
  eventType?: MemoryEventType;
}

function eventTypeFor(input: MemoryPolicyInput): MemoryEventType | undefined {
  return input.eventType ?? input.proposal.eventType;
}

const MANAGEMENT_EVENT_FOR_OPERATION: Partial<Record<MemoryProposal["operation"], MemoryEventType>> = {
  CORRECT: "USER_CORRECTED_COACH",
  CONFIRM: "USER_CONFIRMED",
  DELETE: "MEMORY_DELETED",
};

const MANAGEMENT_OPERATION_FOR_EVENT: Partial<Record<MemoryEventType, MemoryProposal["operation"]>> = {
  USER_CORRECTED_COACH: "CORRECT",
  USER_CONFIRMED: "CONFIRM",
  MEMORY_DELETED: "DELETE",
};

function distinctDemoCount(current: MemoryRecord | undefined, proposal: MemoryProposal): number {
  const hashes = new Set(current?.demoContentHashes ?? []);
  hashes.add(proposal.origin.demoContentHash);
  return hashes.size;
}

function activeStatus(proposal: MemoryProposal, current: MemoryRecord | undefined): MemoryStatus {
  const count = distinctDemoCount(current, proposal);
  if (proposal.kind === "PREFERENCE" || proposal.kind === "COACHING_PREFERENCE") return "CONFIRMED";
  if (count >= 2) return "EMERGING";
  // A single cue is always a candidate, including when it is the first event
  // for a logical key.  It may be observed/repeated only after a later
  // proposal or explicit user action.
  return "CANDIDATE";
}

function lifecycleRank(status: MemoryStatus): number {
  switch (status) {
    case "CANDIDATE": return 1;
    case "OBSERVED": return 2;
    case "REPEATED": return 3;
    case "EMERGING": return 4;
    case "IMPROVING": return 5;
    case "STABLE": return 6;
    case "CONFIRMED": return 7;
    case "DISPUTED": return 8;
    default: return 0;
  }
}

function preserveHigherLifecycle(current: MemoryRecord | undefined, proposed: MemoryStatus): MemoryStatus {
  if (!current || current.status === "DELETED" || current.status === "SUPERSEDED" || current.status === "ARCHIVED" || current.status === "RESOLVED" || current.status === "DISPUTED") return proposed;
  return lifecycleRank(current.status) > lifecycleRank(proposed) ? current.status : proposed;
}

const BEHAVIOR_OPPORTUNITY_SOURCE_PREFIX = "behavior-opportunity-source-";

function opportunityMarkers(refs: readonly MemorySourceRef[]): string[] {
  return refs
    .filter((ref) =>
      ref.namespace === "SESSION" &&
      ref.refId.startsWith(BEHAVIOR_OPPORTUNITY_SOURCE_PREFIX),
    )
    .map((ref) => ref.refId);
}

function evidenceSourceSignature(refs: readonly MemorySourceRef[]): string | undefined {
  const parts = [...new Set(refs
    .filter((ref) =>
      ref.namespace === "DEMO_FACT" ||
      ref.namespace === "OBSERVATION_CLAIM" ||
      ref.namespace === "PRO_EVIDENCE",
    )
    .map((ref) => `${ref.namespace}:${ref.refId}`))]
    .sort();
  return parts.length > 0 ? parts.join("|") : undefined;
}

function sourceRefGroups(refs: readonly MemorySourceRef[], demoContentHash: string): MemorySourceRef[][] {
  const groups = new Map<string, MemorySourceRef[]>();
  for (const ref of refs) {
    if (ref.demoContentHash !== demoContentHash) continue;
    const key = [ref.sessionId, ref.cueId, ref.caseId ?? ""].join("|");
    const group = groups.get(key) ?? [];
    group.push(ref);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function sameOpportunitySource(
  currentRefs: readonly MemorySourceRef[],
  incomingRefs: readonly MemorySourceRef[],
  incomingCueId: string,
): boolean {
  const currentMarkers = opportunityMarkers(currentRefs);
  const incomingMarkers = opportunityMarkers(incomingRefs);
  if (currentMarkers.length > 0 && incomingMarkers.length > 0) {
    return currentMarkers.some((marker) => incomingMarkers.includes(marker));
  }

  // Legacy proposals did not carry the marker. Typed parser/observation
  // provenance remains stable across route reordering and provides the
  // compatibility bridge without treating inference or Advice IDs as facts.
  const currentEvidence = evidenceSourceSignature(currentRefs);
  const incomingEvidence = evidenceSourceSignature(incomingRefs);
  if (currentEvidence && incomingEvidence) return currentEvidence === incomingEvidence;

  // Last-resort compatibility for already-persisted proposals that predate
  // both source markers and typed evidence. New events always carry a marker.
  return currentRefs.some((ref) => ref.cueId === incomingCueId);
}

function repeatsDiagnosedOpportunity(
  current: MemoryRecord | undefined,
  proposal: MemoryProposal,
  eventType: MemoryEventType | undefined,
): boolean {
  if (!current || eventType !== "CUE_DIAGNOSED") return false;
  // The aggregate lookup already fixes the taxonomy/logical key. Compare each
  // prior provenance group by its stable candidate/evidence source, never by
  // the route-local c1/c2 ordinal. Explicit corrections and transfer
  // applications have their own lifecycle paths.
  return sourceRefGroups(current.sourceRefs, proposal.origin.demoContentHash).some(
    (group) => sameOpportunitySource(
      group,
      proposal.origin.typedSourceRefs,
      proposal.origin.cueId,
    ),
  );
}

/**
 * Deterministic lifecycle/write policy.  It has no I/O and gives LLM output
 * no direct persistence authority: callers still need MemoryService's
 * authorization gate and a repository transaction.
 */
export class MemoryWritePolicy {
  decide(input: MemoryPolicyInput): MemoryWriteDecision;
  decide(proposal: MemoryProposal, current?: MemoryRecord, eventType?: MemoryEventType): MemoryWriteDecision;
  decide(
    inputOrProposal: MemoryPolicyInput | MemoryProposal,
    current?: MemoryRecord,
    eventType?: MemoryEventType,
  ): MemoryWriteDecision {
    const input: MemoryPolicyInput = "proposal" in inputOrProposal ? inputOrProposal : { proposal: inputOrProposal, current, eventType };
    const proposal = input.proposal;
    const existing = input.current;
    const type = eventTypeFor(input);
    const base = {
      proposalId: proposal.proposalId,
      userId: proposal.userId,
      logicalKey: proposal.logicalKey,
      idempotencyKey: proposal.idempotencyKey,
      targetMemoryId: existing?.memoryId ?? proposal.targetMemoryId,
      proposal,
    };

    if (proposal.targetMemoryId && existing && proposal.targetMemoryId !== existing.memoryId) {
      // A logical key and an explicit target must identify the same aggregate;
      // otherwise a stale/forged proposal could apply one key's content to a
      // different memory row.
      return { ...base, accepted: false, action: "NOOP", reason: "INVALID_PROPOSAL", revision: existing.revision, status: existing.status };
    }

    // Management operations are aggregate mutations, never free-standing
    // proposals. Require an explicit target, the canonical event type and an
    // existing matching current row so a direct policy/repository caller
    // cannot fall back to logicalKey and create or mutate an arbitrary record.
    const expectedManagementEvent = MANAGEMENT_EVENT_FOR_OPERATION[proposal.operation];
    const expectedManagementOperation = type ? MANAGEMENT_OPERATION_FOR_EVENT[type] : undefined;
    if (expectedManagementEvent !== undefined &&
      (!proposal.targetMemoryId || !existing || existing.memoryId !== proposal.targetMemoryId || type !== expectedManagementEvent)) {
      return { ...base, accepted: false, action: "NOOP", reason: "INVALID_PROPOSAL", revision: existing?.revision, status: existing?.status };
    }
    if (expectedManagementOperation !== undefined &&
      (proposal.operation !== expectedManagementOperation || !proposal.targetMemoryId || !existing || existing.memoryId !== proposal.targetMemoryId)) {
      return { ...base, accepted: false, action: "NOOP", reason: "INVALID_PROPOSAL", revision: existing?.revision, status: existing?.status };
    }
    if (proposal.lifecycle === "DELETED" && proposal.operation !== "DELETE") {
      return { ...base, accepted: false, action: "NOOP", reason: "INVALID_PROPOSAL", revision: existing?.revision, status: existing?.status };
    }
    if (type !== undefined && !operationMatchesEventType(proposal.operation, type)) {
      return { ...base, accepted: false, action: "NOOP", reason: "INVALID_PROPOSAL", revision: existing?.revision, status: existing?.status };
    }

    if (proposal.requestedScope !== "CROSS_DEMO") {
      return { ...base, accepted: false, action: "NOOP", reason: "INVALID_SCOPE" };
    }
    if (proposal.consentState !== "GRANTED") {
      return { ...base, accepted: false, action: "NOOP", reason: "CONSENT_REQUIRED" };
    }
    if (existing?.status === "DELETED") {
      // Tombstones outrank every replay/idempotency/source comparison: an old
      // event can never observe a path that would recreate deleted content.
      return { ...base, accepted: false, action: "NOOP", reason: "DELETED_TOMBSTONE", revision: existing.revision, status: "DELETED" };
    }
    if (existing?.lastIdempotencyKey === proposal.idempotencyKey) {
      return {
        ...base,
        accepted: false,
        action: "NOOP",
        reason: "DUPLICATE_IDEMPOTENCY",
        revision: existing.revision,
        status: existing.status,
      };
    }
    if (existing && repeatsDiagnosedOpportunity(existing, proposal, type)) {
      return {
        ...base,
        accepted: false,
        action: "NOOP",
        reason: "DUPLICATE_SOURCE",
        revision: existing.revision,
        status: existing.status,
      };
    }
    // An explicit user deletion is stronger than a prior correction.  Check
    // it before the correction-precedence guard so corrected memories remain
    // deletable while late model proposals still cannot overwrite them.
    if (type === "MEMORY_DELETED" || proposal.operation === "DELETE" || proposal.lifecycle === "DELETED") {
      return { ...base, accepted: true, action: "DELETE", reason: "ACCEPTED", status: "DELETED", revision: (existing?.revision ?? 0) + 1 };
    }
    if (existing && existing.corrections.length > 0 && type !== "USER_CORRECTED_COACH" && proposal.operation !== "CORRECT" && type !== "USER_CONFIRMED") {
      // A later model/application event may add independent provenance and
      // progress counters, but it cannot replace user-authored content. The
      // reducer preserves the corrected projection while creating an
      // idempotent revision for the new evidence.
      return {
        ...base,
        accepted: true,
        action: "UPDATE",
        reason: "USER_CORRECTION_PRECEDENCE",
        revision: existing.revision + 1,
        status: existing.status,
      };
    }

    if (type === "USER_CORRECTED_COACH" || proposal.operation === "CORRECT") {
      return {
        ...base,
        accepted: true,
        action: "CORRECT",
        reason: "USER_CORRECTION_PRECEDENCE",
        status: "DISPUTED",
        revision: (existing?.revision ?? 0) + 1,
      };
    }
    if (type === "USER_CONFIRMED" || proposal.operation === "CONFIRM") {
      return {
        ...base,
        accepted: true,
        action: "CONFIRM",
        reason: "ACCEPTED",
        status: "CONFIRMED",
        revision: (existing?.revision ?? 0) + 1,
      };
    }
    if (["SUPERSEDED", "ARCHIVED", "RESOLVED"].includes(proposal.lifecycle)) {
      return {
        ...base,
        accepted: true,
        action: existing ? "UPDATE" : "CREATE",
        reason: "ACCEPTED",
        status: proposal.lifecycle,
        revision: (existing?.revision ?? 0) + 1,
      };
    }
    if (proposal.lifecycle === "DISPUTED") {
      return {
        ...base,
        accepted: true,
        action: existing ? "UPDATE" : "CREATE",
        reason: "USER_CORRECTION_PRECEDENCE",
        status: "DISPUTED",
        revision: (existing?.revision ?? 0) + 1,
      };
    }
    if (type === "TRANSFER_RULE_APPLIED") {
      const successful = proposal.applicationOutcome === "SUCCESS";
      const priorSuccesses = existing?.successfulApplicationCount ?? 0;
      // A transfer application is evidence, not a user confirmation.  It may
      // increment bounded counters on the first Demo, but it must not make a
      // memory active until the aggregate has evidence from two distinct Demo
      // content hashes.  This gate lives here (and is repeated by the pure
      // reducer) so every adapter observes the same lifecycle contract.
      const hasDistinctDemoEvidence = distinctDemoCount(existing, proposal) >= 2;
      const status = successful
        ? hasDistinctDemoEvidence
          ? priorSuccesses + 1 >= 2 ? "STABLE" : "IMPROVING"
          : existing?.status ?? "CANDIDATE"
        : hasDistinctDemoEvidence
          ? existing?.status === "STABLE" ? "STABLE" : existing ? "REPEATED" : "CANDIDATE"
          : existing?.status ?? "CANDIDATE";
      return {
        ...base,
        accepted: true,
        action: existing ? "UPDATE" : "CREATE",
        reason: "ACCEPTED",
        status: preserveHigherLifecycle(existing, status),
        revision: (existing?.revision ?? 0) + 1,
      };
    }
    const explicitPreference = type === "USER_PREFERENCE_STATED" &&
      Boolean(proposal.preference) &&
      (proposal.preference?.source === "USER" || proposal.preference?.source === "USER_EXPLICIT");
    if (explicitPreference) {
      return {
        ...base,
        accepted: true,
        action: existing ? "UPDATE" : "CREATE",
        reason: "ACCEPTED",
        status: "CONFIRMED",
        revision: (existing?.revision ?? 0) + 1,
      };
    }
    if (type === "USER_PROFILE_STATED" || proposal.kind === "PROFILE" || proposal.profile) {
      if (type !== "USER_PROFILE_STATED" || proposal.kind !== "PROFILE" || !proposal.profile || !["CREATE", "UPDATE"].includes(proposal.operation)) {
        return { ...base, accepted: false, action: "NOOP", reason: "INVALID_PROPOSAL", revision: existing?.revision, status: existing?.status };
      }
      return {
        ...base,
        accepted: true,
        action: existing ? "UPDATE" : "CREATE",
        reason: "ACCEPTED",
        status: "CONFIRMED",
        revision: (existing?.revision ?? 0) + 1,
      };
    }
    if (type === "SESSION_COMPLETED") {
      return { ...base, accepted: false, action: "NOOP", reason: "INVALID_PROPOSAL", status: existing?.status ?? "CANDIDATE" };
    }

    const status = preserveHigherLifecycle(existing, activeStatus(proposal, existing));
    return {
      ...base,
      accepted: true,
      action: existing ? "UPDATE" : "CREATE",
      reason: status === "CANDIDATE" ? "CANDIDATE_ONLY" : "ACCEPTED",
      status,
      revision: (existing?.revision ?? 0) + 1,
    };
  }
}

export const defaultMemoryWritePolicy = new MemoryWritePolicy();
export const decideMemoryWrite = (input: MemoryPolicyInput): MemoryWriteDecision => defaultMemoryWritePolicy.decide(input);
export const decide = decideMemoryWrite;
