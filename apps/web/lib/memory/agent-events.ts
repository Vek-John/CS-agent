import {
  MemoryEventSchema,
  MemoryProposalSchema,
  buildMemoryProposal,
  stableMemoryToken,
  type MemoryEvent,
  type MemoryEventType,
  type MemoryProposal,
} from "@cs-coach/memory";
import type { CoachAgentEvent, CoachAgentResult } from "@cs-coach/coach-agent";
import type { CueCase } from "@cs-coach/contracts";
import type { ClaimMemoryOpportunityInput } from "@cs-coach/review-library";

const PRODUCER_VERSION = "local-coach-agent-memory.v1";
const BEHAVIOR_OPPORTUNITY_SOURCE_PREFIX = "behavior-opportunity-source-";

type BehaviorSourceRef = MemoryProposal["origin"]["typedSourceRefs"][number];

function stableEvidenceSourceParts(refs: readonly BehaviorSourceRef[]): string[] {
  return refs
    .filter((ref) =>
      ref.namespace === "DEMO_FACT" ||
      ref.namespace === "OBSERVATION_CLAIM" ||
      ref.namespace === "PRO_EVIDENCE",
    )
    .map((ref) => `${ref.namespace}:${ref.refId.trim()}`)
    .sort();
}

function behaviorOpportunitySourceRefId(
  event: Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" | "SUBMIT_DISAGREEMENT" }>,
  cueCase: CueCase,
  refs: readonly BehaviorSourceRef[],
): string {
  const input = event.input as unknown as DiagnosisInputProvenance;
  const candidateId = bounded(cueCase.candidateId ?? input.candidateId ?? input.material?.candidateId, 160);
  const evidenceParts = stableEvidenceSourceParts(refs);
  const sourceParts = candidateId
    ? ["candidate", candidateId]
    : evidenceParts.length > 0
      ? ["evidence", ...evidenceParts]
      : ["legacy-cue", event.cueId];
  return `${BEHAVIOR_OPPORTUNITY_SOURCE_PREFIX}${stableMemoryToken(sourceParts.join("|"))}`;
}

function behaviorOpportunitySourceId(proposal: MemoryProposal): string {
  const marker = proposal.origin.typedSourceRefs.find(
    (ref) =>
      ref.namespace === "SESSION" &&
      ref.refId.startsWith(BEHAVIOR_OPPORTUNITY_SOURCE_PREFIX),
  );
  if (marker) return marker.refId;
  const evidenceParts = stableEvidenceSourceParts(proposal.origin.typedSourceRefs);
  if (evidenceParts.length > 0) {
    return `${BEHAVIOR_OPPORTUNITY_SOURCE_PREFIX}${stableMemoryToken(["evidence", ...evidenceParts].join("|"))}`;
  }
  // Existing v1 events did not carry an explicit source marker. Retaining a
  // cue fallback keeps those already-posted events readable and idempotent.
  return `legacy-cue-${proposal.origin.cueId}`;
}

/**
 * A behavior-evidence identity must survive a Host session replacement.  The
 * route hash is the analysis-evidence revision: reopening the same Review
 * revision keeps the key stable, while an explicit reanalysis can retain a
 * separately versioned provenance record without pretending it is a new Demo.
 */
export function stableBehaviorEvidenceKey(input: {
  readonly userId: string;
  readonly demoContentHash: string;
  readonly selectedPlayerId: string;
  readonly stableCueSourceId: string;
  readonly taxonomyCode: string;
  readonly analysisEvidenceRevision: string;
  readonly effect: "DIAGNOSIS" | "TRANSFER_APPLICATION";
  readonly evidenceRevision?: number;
}): string {
  return `behavior-evidence-${stableMemoryToken([
    input.userId,
    input.demoContentHash,
    input.selectedPlayerId,
    input.stableCueSourceId,
    input.taxonomyCode,
    input.analysisEvidenceRevision,
    input.effect,
    String(input.evidenceRevision ?? 0),
  ].join("|"))}`;
}

/**
 * Projects a posted behavior event into the desktop database's stable
 * opportunity claim. The analysis revision remains on the evidence row; it is
 * deliberately absent from the unique opportunity identity.
 */
export function desktopBehaviorOpportunityClaim(
  event: MemoryEvent,
  selectedPlayerId: string,
  analysisEvidenceRevision: string,
): ClaimMemoryOpportunityInput | undefined {
  const eventType = event.type ?? event.eventType;
  if (eventType !== "CUE_DIAGNOSED" && eventType !== "TRANSFER_RULE_APPLIED")
    return undefined;
  const parsed = MemoryProposalSchema.safeParse(event.payload);
  if (!parsed.success) return undefined;
  const proposal = parsed.data as unknown as MemoryProposal;
  const effect = eventType === "CUE_DIAGNOSED" ? "diagnosis" : "transfer-application";
  const sourceId = behaviorOpportunitySourceId(proposal);
  return {
    userId: event.userId,
    demoContentHash: proposal.origin.demoContentHash.toLowerCase(),
    selectedPlayerId,
    stableCueSourceId: `${sourceId}:${effect}`.slice(0, 200),
    taxonomyCode: proposal.logicalKey,
    analysisEvidenceRevision,
    evidenceKey: event.idempotencyKey,
    evidence: {
      eventType,
      proposalId: proposal.proposalId,
      cueId: proposal.origin.cueId,
      caseId: proposal.origin.caseId ?? null,
      sourceThreadId: proposal.origin.sourceThreadId ?? null,
      verdictRevision: proposal.verdict?.revision ?? null,
    },
  };
}

function bounded(value: unknown, max = 1_200): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

interface ProvenanceItem {
  readonly id?: unknown;
}

interface DiagnosisInputProvenance {
  readonly candidateId?: unknown;
  readonly material?: {
    readonly candidateId?: unknown;
    readonly evidence?: readonly ProvenanceItem[];
  };
  readonly decisionFacts?: readonly ProvenanceItem[];
  readonly playerActionFacts?: readonly ProvenanceItem[];
  readonly outcomeFacts?: readonly ProvenanceItem[];
}

function provenanceRefs(event: Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" | "SUBMIT_DISAGREEMENT" }>, cueCase: CueCase) {
  const refs: Array<{ namespace: "DEMO_FACT" | "OBSERVATION_CLAIM" | "PRO_EVIDENCE"; refId: string; label: string }> = [];
  const seen = new Set<string>();
  const add = (namespace: "DEMO_FACT" | "OBSERVATION_CLAIM" | "PRO_EVIDENCE", refId: unknown, label: string) => {
    if (typeof refId !== "string" || !refId.trim()) return;
    const key = `${namespace}|${refId}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ namespace, refId: refId.trim(), label });
  };
  const input = event.input as unknown as DiagnosisInputProvenance;
  for (const fact of input.decisionFacts ?? []) add("DEMO_FACT", fact.id, "decision-time Demo fact");
  for (const fact of input.playerActionFacts ?? []) add("DEMO_FACT", fact.id, "player-action Demo fact");
  for (const fact of input.outcomeFacts ?? []) add("DEMO_FACT", fact.id, "outcome Demo fact");
  for (const evidence of input.material?.evidence ?? []) add("PRO_EVIDENCE", evidence.id, "bounded coaching evidence");
  for (const ref of Array.isArray(cueCase?.diagnosticResult?.evidenceRefs) ? cueCase.diagnosticResult.evidenceRefs : []) add("OBSERVATION_CLAIM", ref, "diagnostic observation claim");
  for (const ref of Array.isArray(cueCase?.verdict?.evidenceRefs) ? cueCase.verdict.evidenceRefs : []) add("OBSERVATION_CLAIM", ref, "verdict observation claim");
  // Leave room for claims, verdict/rule provenance and the stable source
  // marker while respecting MemoryProposal's 64-ref bound.
  return refs.slice(0, 45);
}

function eventForProposal(proposal: MemoryProposal, eventType: MemoryEventType, userId: string, sessionId: string, demoContentHash: string): MemoryEvent {
  const idempotencyKey = proposal.idempotencyKey;
  return MemoryEventSchema.parse({
    schemaVersion: "memory-event.v1",
    eventId: `memory-event-${stableMemoryToken(idempotencyKey)}`,
    type: eventType,
    eventType,
    userId,
    sessionId,
    demoContentHash,
    proposalId: proposal.proposalId,
    ...(proposal.targetMemoryId ? { targetMemoryId: proposal.targetMemoryId } : {}),
    operation: proposal.operation,
    idempotencyKey,
    producerVersion: PRODUCER_VERSION,
    payload: proposal,
    createdAt: proposal.createdAt,
  }) as unknown as MemoryEvent;
}

/**
 * Localhost's process-local runtime has no Durable Object. This helper keeps
 * its optional memory path on the same bounded proposal/event contract as the
 * production DO path; callers still gate it with feature flag + consent.
 */
export function buildLocalAgentMemoryEvents(
  event: CoachAgentEvent,
  result: CoachAgentResult,
  userId: string,
): readonly MemoryEvent[] {
  if (event.type === "COMPLETE_SESSION") {
    if (result.state.sessionStatus !== "COMPLETED") return [];
    const identity = result.identity;
    const idempotencyKey = `memory-session-${stableMemoryToken(`${userId}|${identity.demoContentHash}|${identity.selectedPlayerId}|${identity.routeHash}`)}`;
    return [MemoryEventSchema.parse({
      schemaVersion: "memory-event.v1",
      eventId: `memory-event-${stableMemoryToken(idempotencyKey)}`,
      type: "SESSION_COMPLETED",
      eventType: "SESSION_COMPLETED",
      userId,
      sessionId: identity.sessionId,
      demoContentHash: identity.demoContentHash,
      idempotencyKey,
      producerVersion: PRODUCER_VERSION,
      payload: { reason: "SESSION_COMPLETED" },
      createdAt: new Date().toISOString(),
    }) as unknown as MemoryEvent];
  }
  if (event.type !== "SUBMIT_REFLECTION" && event.type !== "SUBMIT_DISAGREEMENT") return [];
  if (event.type === "SUBMIT_REFLECTION" && event.reflection.response === "SKIPPED") return [];
  const cueCase = result.state.cueCases?.[event.cueId] as CueCase | undefined;
  const learningThread = result.state.learningThreads?.find((thread) => thread.evidenceCueIds.includes(event.cueId)) ?? result.state.learningThreads?.at(-1);
  if (!cueCase || !learningThread || !["AWAITING_CONFIRMATION", "COMPLETED", "DISAGREED"].includes(cueCase.status) || !cueCase.verdict || !cueCase.diagnosticResult) return [];
  const identity = result.identity;
  const sourceRefs = provenanceRefs(event, cueCase);
  const built = buildMemoryProposal({
    userId,
    sessionId: identity.sessionId,
    demoContentHash: identity.demoContentHash,
    cueCase,
    learningThread,
    outcomeGateStatus: event.outcomeGateStatus,
    provenanceRefs: sourceRefs,
    producerVersion: PRODUCER_VERSION,
  });
  const sourceRefId = behaviorOpportunitySourceRefId(event, cueCase, built.origin.typedSourceRefs);
  const base = MemoryProposalSchema.parse({
    ...built,
    origin: {
      ...built.origin,
      typedSourceRefs: [
        ...built.origin.typedSourceRefs,
        {
          namespace: "SESSION",
          refId: sourceRefId,
          demoContentHash: identity.demoContentHash,
          sessionId: identity.sessionId,
          cueId: event.cueId,
          caseId: cueCase.caseId,
          threadId: learningThread.threadId,
          label: "stable behavior opportunity source",
        },
      ],
    },
  }) as unknown as MemoryProposal;
  // The event envelope ID is transport metadata and may change on a client
  // retry. Use the deterministic source/revision aggregate identity instead so
  // local fallback and Durable Object producers converge on one idempotency
  // key and never count a retried reflection twice.
  const revision = Number(cueCase.verdict?.revision ?? cueCase.attemptBudget?.disagreement ?? 0);
  const eventType: MemoryEvent["type"] = event.type === "SUBMIT_DISAGREEMENT" ? "USER_CORRECTED_COACH" : "CUE_DIAGNOSED";
  const diagnosisEvidenceKey = stableBehaviorEvidenceKey({
    userId,
    demoContentHash: identity.demoContentHash,
    selectedPlayerId: identity.selectedPlayerId,
    stableCueSourceId: sourceRefId,
    taxonomyCode: base.logicalKey,
    analysisEvidenceRevision: identity.routeHash,
    effect: "DIAGNOSIS",
    evidenceRevision: revision,
  });
  let proposal = MemoryProposalSchema.parse({
    ...base,
    proposalId: `proposal-${stableMemoryToken(`${diagnosisEvidenceKey}|${eventType}`)}`,
    eventType,
    idempotencyKey: `memory-idem-${stableMemoryToken(`${diagnosisEvidenceKey}|${eventType}`)}`,
  }) as unknown as MemoryProposal;
  if (event.type === "SUBMIT_DISAGREEMENT") {
    proposal = MemoryProposalSchema.parse({
      ...proposal,
      operation: "CORRECT",
      targetMemoryId: `memory-${stableMemoryToken(base.logicalKey)}`,
      correction: {
        correctionId: event.reflection.reflectionId ?? `correction-${stableMemoryToken(`${identity.sessionId}|${event.cueId}|${revision}`)}`,
        content: bounded(event.reflection.rawText) || "用户不同意当前教练判断。",
        source: "USER",
      },
    }) as unknown as MemoryProposal;
  }
  const primary = eventForProposal(proposal, eventType, userId, identity.sessionId, identity.demoContentHash);
  const events: MemoryEvent[] = [primary];
  if (event.type === "SUBMIT_REFLECTION" && learningThread.evidenceCueIds.some((cueId) => cueId !== event.cueId)) {
    const outcome = learningThread.successfulCueIds.includes(event.cueId)
      ? "SUCCESS"
      : learningThread.conflictingCueIds.includes(event.cueId)
        ? "CONFLICT"
        : undefined;
    if (outcome) {
      const applicationEvidenceKey = stableBehaviorEvidenceKey({
        userId,
        demoContentHash: identity.demoContentHash,
        selectedPlayerId: identity.selectedPlayerId,
        stableCueSourceId: sourceRefId,
        taxonomyCode: base.logicalKey,
        analysisEvidenceRevision: identity.routeHash,
        effect: "TRANSFER_APPLICATION",
        evidenceRevision: revision,
      });
      const application = MemoryProposalSchema.parse({
        ...base,
        proposalId: `proposal-${stableMemoryToken(`${applicationEvidenceKey}|${outcome}`)}`,
        operation: "UPDATE",
        eventType: "TRANSFER_RULE_APPLIED",
        applicationOutcome: outcome,
        idempotencyKey: `memory-idem-${stableMemoryToken(`${applicationEvidenceKey}|${outcome}`)}`,
      }) as unknown as MemoryProposal;
      events.push(eventForProposal(application, "TRANSFER_RULE_APPLIED", userId, identity.sessionId, identity.demoContentHash));
    }
  }
  return events;
}
