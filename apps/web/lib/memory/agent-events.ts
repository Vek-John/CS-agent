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

const PRODUCER_VERSION = "local-coach-agent-memory.v1";

function bounded(value: unknown, max = 1_200): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

interface ProvenanceItem {
  readonly id?: unknown;
}

interface DiagnosisInputProvenance {
  readonly decisionFacts?: readonly ProvenanceItem[];
  readonly playerActionFacts?: readonly ProvenanceItem[];
  readonly outcomeFacts?: readonly ProvenanceItem[];
  readonly material?: { readonly evidence?: readonly ProvenanceItem[] };
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
  return refs.slice(0, 48);
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
    const idempotencyKey = `memory-session-${stableMemoryToken(`${userId}|${identity.sessionId}|${identity.demoContentHash}`)}`;
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
  const base = buildMemoryProposal({
    userId,
    sessionId: identity.sessionId,
    demoContentHash: identity.demoContentHash,
    cueCase,
    learningThread,
    outcomeGateStatus: event.outcomeGateStatus,
    provenanceRefs: provenanceRefs(event, cueCase),
    producerVersion: PRODUCER_VERSION,
  });
  // The event envelope ID is transport metadata and may change on a client
  // retry. Use the deterministic cue/revision aggregate identity instead so
  // local fallback and Durable Object producers converge on one idempotency
  // key and never count a retried reflection twice.
  const revision = Number(cueCase.verdict?.revision ?? cueCase.attemptBudget?.disagreement ?? 0);
  const eventType: MemoryEvent["type"] = event.type === "SUBMIT_DISAGREEMENT" ? "USER_CORRECTED_COACH" : "CUE_DIAGNOSED";
  let proposal = MemoryProposalSchema.parse({
    ...base,
    proposalId: `proposal-${stableMemoryToken(`${base.proposalId}|${eventType}|${revision}`)}`,
    eventType,
    idempotencyKey: `memory-idem-${stableMemoryToken(`${userId}|${eventType}|${identity.sessionId}|${identity.demoContentHash}|${event.cueId}|${revision}|${base.logicalKey}`)}`,
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
      const application = MemoryProposalSchema.parse({
        ...base,
        proposalId: `proposal-${stableMemoryToken(`${base.proposalId}|application|${outcome}`)}`,
        operation: "UPDATE",
        eventType: "TRANSFER_RULE_APPLIED",
        applicationOutcome: outcome,
        idempotencyKey: `memory-idem-${stableMemoryToken(`${userId}|TRANSFER_RULE_APPLIED|${identity.sessionId}|${identity.demoContentHash}|${event.cueId}|${revision}|${base.logicalKey}|${outcome}`)}`,
      }) as unknown as MemoryProposal;
      events.push(eventForProposal(application, "TRANSFER_RULE_APPLIED", userId, identity.sessionId, identity.demoContentHash));
    }
  }
  return events;
}
