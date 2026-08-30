import type {
  MemoryAdvice,
  MemoryCorrection,
  MemoryInference,
  MemoryPreference,
  MemoryProposal,
  MemoryRecord,
  MemorySourceRef,
  MemoryWriteDecision,
} from "./domain";
import { MEMORY_RECORD_VERSION, type MemoryKind } from "./domain";
import { stableMemoryToken } from "./proposal";

export interface MemoryReducerInput {
  userId: string;
  proposal: MemoryProposal;
  decision: MemoryWriteDecision;
  current?: MemoryRecord;
  now?: string;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string, max: number): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const token = key(value);
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(value);
    if (result.length >= max) break;
  }
  return result;
}

function refsKey(ref: MemorySourceRef): string {
  return `${ref.namespace}|${ref.refId}|${ref.demoContentHash}|${ref.sessionId}|${ref.cueId}`;
}

function sourceRefForCorrection(proposal: MemoryProposal, correctionId: string): MemorySourceRef {
  const first = proposal.origin.typedSourceRefs[0];
  return {
    namespace: "USER_CLAIM",
    refId: correctionId,
    demoContentHash: first.demoContentHash,
    sessionId: first.sessionId,
    cueId: first.cueId,
    caseId: first.caseId,
    threadId: first.threadId,
    label: "user correction",
  };
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function isObservationProposal(proposal: MemoryProposal): boolean {
  return proposal.eventType === "CUE_DIAGNOSED" ||
    proposal.eventType === "TRANSFER_RULE_TAUGHT" ||
    proposal.eventType === "TRANSFER_RULE_APPLIED";
}

function lifecycleRank(status: MemoryRecord["status"]): number {
  switch (status) {
    case "STABLE": return 6;
    case "IMPROVING": return 5;
    case "REPEATED": return 4;
    case "EMERGING": return 3;
    case "OBSERVED": return 2;
    case "CANDIDATE": return 1;
    default: return 0;
  }
}

function activeLifecycle(status: MemoryRecord["status"]): boolean {
  return !["CANDIDATE", "DELETED", "SUPERSEDED", "ARCHIVED", "RESOLVED"].includes(status);
}

function inferFromProposal(proposal: MemoryProposal): MemoryInference[] {
  if (!proposal.thread) return [];
  return [
    {
      id: `inference-${proposal.thread.threadId}`,
      summary: proposal.thread.diagnosis.summary,
      confidence: clampConfidence(proposal.thread.diagnosis.confidence),
      refs: proposal.origin.typedSourceRefs.filter((ref) => ref.namespace === "VERDICT" || ref.namespace === "USER_CLAIM"),
    },
  ];
}

function adviceFromProposal(proposal: MemoryProposal): MemoryAdvice[] {
  const rule = proposal.transferRule ?? proposal.thread?.transferRule;
  if (!rule) return [];
  const refs = proposal.origin.typedSourceRefs.filter((ref) => ref.namespace === "TRANSFER_RULE");
  return [
    {
      id: rule.ruleId,
      when: rule.when,
      do: rule.do,
      ...(rule.unless ? { unless: rule.unless } : {}),
      confidence: clampConfidence(rule.confidence),
      refs,
    },
  ];
}

function preferenceFromProposal(proposal: MemoryProposal): MemoryPreference | undefined {
  return proposal.preference;
}

function sourceForProposal(proposal: MemoryProposal): MemoryRecord["source"] {
  if (proposal.eventType === "USER_CORRECTED_COACH" || proposal.operation === "CORRECT") return "USER_CORRECTION";
  if (proposal.eventType === "USER_CONFIRMED" || proposal.operation === "CONFIRM") return "USER_CONFIRMED";
  if (proposal.eventType === "USER_PROFILE_STATED" || proposal.kind === "PROFILE" || proposal.profile) return "USER_EXPLICIT";
  if (proposal.eventType === "USER_PREFERENCE_STATED" || proposal.kind === "PREFERENCE" || proposal.kind === "COACHING_PREFERENCE" || proposal.preference) return "USER_EXPLICIT";
  if (proposal.eventType === "TRANSFER_RULE_TAUGHT" || proposal.eventType === "TRANSFER_RULE_APPLIED" || proposal.kind === "TRANSFER_RULE") return "COACH_RULE_DERIVED";
  return "AGENT_INFERRED";
}

function mergeThread(current: MemoryRecord | undefined, proposal: MemoryProposal): MemoryRecord["thread"] {
  const incoming = proposal.thread;
  if (!incoming) return current?.thread;
  const prior = current?.thread;
  return {
    ...incoming,
    scope: "CROSS_DEMO",
    evidenceCueIds: uniqueBy([...(prior?.evidenceCueIds ?? []), ...incoming.evidenceCueIds], (value) => value, 64),
    successfulCueIds: uniqueBy([...(prior?.successfulCueIds ?? []), ...incoming.successfulCueIds], (value) => value, 64),
    conflictingCueIds: uniqueBy([...(prior?.conflictingCueIds ?? []), ...incoming.conflictingCueIds], (value) => value, 64),
    // Status of a persisted MemoryRecord is the source of truth for lifecycle;
    // the thread status remains the contracts/session semantic projection.
    status: incoming.status,
  };
}

function makeTombstone(input: MemoryReducerInput, now: string): MemoryRecord {
  const { proposal, decision, current } = input;
  const memoryId = current?.memoryId ?? `memory-${stableMemoryToken(proposal.logicalKey)}`;
  const revision = decision.revision ?? ((current?.revision ?? 0) + 1);
  return {
    schemaVersion: MEMORY_RECORD_VERSION,
    memoryId,
    userId: input.userId,
    kind: current?.kind ?? proposal.kind,
    source: current?.source ?? "USER_EXPLICIT",
    scope: "CROSS_DEMO",
    logicalKey: proposal.logicalKey,
    status: "DELETED",
    active: false,
    revision,
    // A deletion tombstone retains only lifecycle/provenance metadata needed
    // to reject late events. Do not keep the deleted user's content, claims,
    // thread, or evidence in the current projection.
    claims: [],
    facts: [],
    inferences: [],
    advice: [],
    evidence: [],
    counterEvidenceRefs: [],
    sourceRefs: [],
    demoContentHashes: [],
    corrections: [],
    ...(current ? { previousRevisionId: `${current.memoryId}:r${current.revision}` } : {}),
    createdAt: current?.createdAt ?? proposal.createdAt,
    updatedAt: now,
    deletedAt: now,
    tombstone: { deletedBy: "USER", ...(proposal.deleteReason ? { reason: proposal.deleteReason } : {}) },
    // Do not carry the former projection's text/limitations into a deletion
    // tombstone.  The tombstone is an anti-resurrection marker, not a hidden
    // recovery channel for data the user asked us to delete.
    limitations: ["Deleted by user; late events cannot resurrect this record."],
    producerVersion: proposal.producerVersion,
    lastIdempotencyKey: proposal.idempotencyKey,
    occurrenceCount: current?.occurrenceCount ?? 0,
    successfulApplicationCount: current?.successfulApplicationCount ?? 0,
    conflictingApplicationCount: current?.conflictingApplicationCount ?? 0,
  };
}

/** Pure aggregate reducer.  It never performs I/O or mutates the prior revision. */
export class MemoryReducer {
  reduce(input: MemoryReducerInput): MemoryRecord | undefined;
  reduce(current: MemoryRecord | undefined, proposal: MemoryProposal, decision: MemoryWriteDecision, now?: string, userId?: string): MemoryRecord | undefined;
  reduce(
    inputOrCurrent: MemoryReducerInput | MemoryRecord | undefined,
    proposalArg?: MemoryProposal,
    decisionArg?: MemoryWriteDecision,
    nowArg?: string,
    userIdArg?: string,
  ): MemoryRecord | undefined {
    const input: MemoryReducerInput =
      inputOrCurrent && "proposal" in inputOrCurrent
        ? inputOrCurrent
        : {
            current: inputOrCurrent as MemoryRecord | undefined,
            proposal: proposalArg as MemoryProposal,
            decision: decisionArg as MemoryWriteDecision,
            now: nowArg,
            userId: userIdArg ?? (proposalArg as MemoryProposal).userId,
          };
    const { proposal, decision, current } = input;
    if (!decision.accepted) return current;
    const now = input.now ?? new Date().toISOString();
    if (decision.action === "DELETE") return makeTombstone(input, now);

    const memoryId = current?.memoryId ?? `memory-${stableMemoryToken(proposal.logicalKey)}`;
    const revision = decision.revision ?? ((current?.revision ?? 0) + 1);
    const sourceRefs = uniqueBy(
      [...(current?.sourceRefs ?? []), ...proposal.origin.typedSourceRefs],
      refsKey,
      64,
    );
    const demoContentHashes = uniqueBy(
      [...(current?.demoContentHashes ?? []), proposal.origin.demoContentHash],
      (value) => value,
      64,
    );
    const claims = uniqueBy([...(current?.claims ?? []), ...proposal.claims], (claim) => claim.claimId, 16);
    const inferences = uniqueBy([...(current?.inferences ?? []), ...inferFromProposal(proposal)], (item) => item.id, 16);
    const advice = uniqueBy([...(current?.advice ?? []), ...adviceFromProposal(proposal)], (item) => item.id, 16);
    const incomingFactRefs = proposal.origin.typedSourceRefs
      .filter((ref) => ref.namespace === "DEMO_FACT" || ref.namespace === "OBSERVATION_CLAIM")
      .map((ref) => ({ ref, kind: ref.namespace as "DEMO_FACT" | "OBSERVATION_CLAIM" }));
    const incomingEvidenceRefs = proposal.origin.typedSourceRefs.filter((ref) => ref.namespace === "PRO_EVIDENCE");
    const incomingCounterEvidenceRefs = proposal.applicationOutcome === "CONFLICT"
      ? proposal.origin.typedSourceRefs.filter((ref) =>
          ref.namespace === "PRO_EVIDENCE" || ref.namespace === "DEMO_FACT" || ref.namespace === "OBSERVATION_CLAIM",
        )
      : [];
    const corrections: MemoryCorrection[] = [...(current?.corrections ?? [])];
    const preservesUserCorrection = Boolean(current?.corrections.length) && decision.action !== "CORRECT";
    let content = preservesUserCorrection ? current?.content : proposal.content ?? current?.content;
    let summary = preservesUserCorrection ? current?.summary : proposal.thread?.diagnosis.summary ?? current?.summary;
    let status = preservesUserCorrection ? current?.status ?? "DISPUTED" : decision.status ?? proposal.lifecycle;
    let active = preservesUserCorrection ? true : activeLifecycle(status);
    let confirmedAt = current?.confirmedAt;
    let kind: MemoryKind = current?.kind ?? proposal.kind;
    let preference = preferenceFromProposal(proposal) ?? current?.preference;
    // A profile proposal is a bounded snapshot of the fields the user
    // explicitly supplied. Replacing rather than merging keeps the eight-field
    // schema invariant and lets a user remove an older field by omission.
    const profile = proposal.profile ?? current?.profile;
    const isExplicitStandaloneInput = proposal.eventType === "USER_PROFILE_STATED" ||
      proposal.eventType === "USER_PREFERENCE_STATED";
    const observation = isObservationProposal(proposal);
    const occurrenceCount = Math.min(10_000, (current?.occurrenceCount ?? 0) + (observation ? 1 : 0));
    const successfulApplicationCount = Math.min(
      10_000,
      (current?.successfulApplicationCount ?? 0) + (proposal.eventType === "TRANSFER_RULE_APPLIED" && proposal.applicationOutcome === "SUCCESS" ? 1 : 0),
    );
    const conflictingApplicationCount = Math.min(
      10_000,
      (current?.conflictingApplicationCount ?? 0) + (proposal.eventType === "TRANSFER_RULE_APPLIED" && proposal.applicationOutcome === "CONFLICT" ? 1 : 0),
    );

    if (!preservesUserCorrection && proposal.eventType === "TRANSFER_RULE_APPLIED") {
      const distinctDemoCount = new Set(demoContentHashes).size;
      const proposedStatus = distinctDemoCount >= 2
        ? proposal.applicationOutcome === "SUCCESS"
          ? successfulApplicationCount >= 2 ? "STABLE" : "IMPROVING"
          : occurrenceCount >= 2 ? "REPEATED" : status
        : current?.status ?? "CANDIDATE";
      if (lifecycleRank(proposedStatus) >= lifecycleRank(status)) status = proposedStatus;
      active = activeLifecycle(status);
    }

    if (decision.action === "CORRECT") {
      const correctionPayload = proposal.correction;
      if (correctionPayload) {
        const correctionId = correctionPayload.correctionId;
        const correction: MemoryCorrection = {
          correctionId,
          memoryId,
          content: correctionPayload.content,
          source: "USER",
          createdAt: now,
          revision,
          refs: proposal.origin.typedSourceRefs.length ? proposal.origin.typedSourceRefs : [sourceRefForCorrection(proposal, correctionId)],
        };
        corrections.push(correction);
        content = correction.content;
        summary = correction.content;
        // A user correction is an authoritative teaching input even when the
        // original model proposal was still a candidate. Keep it visible to
        // the next-session brief while retaining the explicit DISPUTED state.
        active = true;
        kind = current?.kind ?? proposal.kind;
      }
    }
    if (decision.action === "CONFIRM") {
      status = "CONFIRMED";
      active = true;
      confirmedAt = input.now ?? proposal.createdAt;
    }
    if (kind === "PREFERENCE" || kind === "COACHING_PREFERENCE") active = true;
    if (kind === "PROFILE" || profile) {
      kind = "PROFILE";
      status = "CONFIRMED";
      active = true;
    }

    const incomingSource = sourceForProposal(proposal);
    const source = current &&
      ["USER_CORRECTION", "USER_CONFIRMED", "USER_EXPLICIT", "USER"].includes(current.source) &&
      ["AGENT_INFERRED", "COACH_RULE_DERIVED", "COACH"].includes(incomingSource)
      ? current.source
      : incomingSource;

    return {
      schemaVersion: MEMORY_RECORD_VERSION,
      memoryId,
      userId: input.userId,
      kind,
      source,
      scope: "CROSS_DEMO",
      logicalKey: proposal.logicalKey,
      status,
      active,
      revision,
      ...(content ? { content } : {}),
      ...(summary ? { summary } : {}),
      ...(mergeThread(current, proposal) ? { thread: mergeThread(current, proposal) } : {}),
      claims,
      ...(proposal.verdict ?? current?.verdict ? { verdict: proposal.verdict ?? current?.verdict } : {}),
      ...(proposal.transferRule ?? current?.transferRule ? { transferRule: proposal.transferRule ?? current?.transferRule } : {}),
      ...(preference ? { preference } : {}),
      ...(profile ? { profile } : {}),
      facts: uniqueBy(
        [...(current?.facts ?? []), ...incomingFactRefs],
        (fact) => refsKey(fact.ref),
        64,
      ),
      inferences,
      advice,
      evidence: uniqueBy(
        [...(current?.evidence ?? []), ...(proposal.applicationOutcome === "CONFLICT" ? [] : incomingEvidenceRefs)],
        refsKey,
        64,
      ),
      counterEvidenceRefs: uniqueBy(
        [...(current?.counterEvidenceRefs ?? []), ...incomingCounterEvidenceRefs],
        refsKey,
        64,
      ),
      sourceRefs,
      demoContentHashes,
      corrections: uniqueBy(corrections, (correction) => correction.correctionId, 8),
      ...(current ? { previousRevisionId: `${current.memoryId}:r${current.revision}` } : {}),
      createdAt: current?.createdAt ?? proposal.createdAt,
      updatedAt: now,
      ...(confirmedAt ? { confirmedAt } : {}),
      limitations: uniqueBy(
        [
          ...(current?.limitations ?? []),
          ...(proposal.thread?.diagnosis.summary || isExplicitStandaloneInput
            ? []
            : ["No structured diagnosis was supplied."]),
        ],
        (value) => value,
        16,
      ),
      producerVersion: proposal.producerVersion,
      lastIdempotencyKey: proposal.idempotencyKey,
      occurrenceCount,
      successfulApplicationCount,
      conflictingApplicationCount,
    };
  }
}

export const defaultMemoryReducer = new MemoryReducer();
export const reduceMemory = (input: MemoryReducerInput): MemoryRecord | undefined => defaultMemoryReducer.reduce(input);
export const reduce = reduceMemory;
