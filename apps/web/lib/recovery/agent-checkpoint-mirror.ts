import { checkpointThreadIdForSession, type CoachAgentEvent, type CoachAgentResult, type SessionRecoveryRecord, type SessionRecoveryRuntime, type SessionRecoveryResult } from "@cs-coach/coach-agent/client";
import type { ReviewPlan } from "@cs-coach/contracts";
import type { HistoryPersistenceController } from "../review-history/history-persistence-controller";
import type { RecoveryAgentCheckpointMeta } from "./cs2d-session-recovery";
import { buildStage3Identity, type Stage3IdentityInput } from "../coaching/coach-agent-stage3-host-adapter";

export interface AgentMirrorOwner {
  generation: number; historyEpoch: number;
  sessionId?: string;
  identity?: Stage3IdentityInput;
  recoveryIdentity?: { recoveryId: string; sessionId: string; runId: string };
  runtime?: SessionRecoveryRuntime; record?: SessionRecoveryRecord;
  history?: HistoryPersistenceController;
  takenOver: boolean; recovering: boolean;
}
export interface AgentMirrorInput {
  event: CoachAgentEvent; result: CoachAgentResult;
  read: () => AgentMirrorOwner;
  checkpoint: (checkpoint: RecoveryAgentCheckpointMeta) => void;
  stable: (checkpoint: RecoveryAgentCheckpointMeta) => SessionRecoveryRecord | undefined;
  accept: (result: SessionRecoveryResult) => void;
  failure: () => void;
  eventId: () => string;
}

function recordMatches(record: SessionRecoveryRecord | undefined, identity: CoachAgentResult["identity"], recoveryId: string): boolean {
  return !!record && record.recoveryId === recoveryId && record.sessionId === identity.sessionId && record.runId === identity.runId
    && record.demoContentHash === identity.demoContentHash && record.selectedPlayerId === identity.selectedPlayerId
    && record.routeId === identity.routeId && record.routeHash === identity.routeHash;
}

/** Capture ownership before the first ref write or await; a first checkpoint needs no existing record. */
function captureOwner(input: AgentMirrorInput): { owner: AgentMirrorOwner; current: () => boolean } {
  const owner = { ...input.read() };
  const history = owner.history; const epoch = history?.ownershipGeneration;
  const reviewId = history?.reviewId; const revisionId = history?.revisionId;
  const recoveryId = owner.recoveryIdentity?.recoveryId;
  const identity = input.event.identity;
  const sameIdentity = (candidate: CoachAgentResult["identity"]) => Object.entries(identity).every(([key,value]) => candidate[key as keyof typeof candidate] === value);
  const current = () => {
    const live = input.read();
    if (!recoveryId || !live.identity || !sameIdentity(input.result.identity) || live.takenOver || live.recovering
      || live.generation !== owner.generation || live.historyEpoch !== owner.historyEpoch
      || live.runtime !== owner.runtime || live.sessionId !== identity.sessionId
      || live.recoveryIdentity?.recoveryId !== recoveryId || live.recoveryIdentity.sessionId !== identity.sessionId || live.recoveryIdentity.runId !== identity.runId
      || live.history !== history || history?.ownershipGeneration !== epoch
      || (reviewId !== undefined && history?.reviewId !== reviewId) || (revisionId !== undefined && history?.revisionId !== revisionId)
      || (live.record && !recordMatches(live.record, identity, recoveryId))) return false;
    try { return sameIdentity(buildStage3Identity(live.identity)); } catch { return false; }
  };
  return { owner, current };
}

/** Production Host mirror seam: preserve artifact -> head order and never publish a draft as durable. */
export async function mirrorAgentCheckpoint(input: AgentMirrorInput): Promise<void> {
  const { event, result } = input;
  if (result.status === "WAITING_TOOL" || event.type === "RESUME_TOOL" || event.type === "RECONNECT_REPLAY") return;
  const { owner, current } = captureOwner(input);
  if (!current()) return;
  const checkpoint: RecoveryAgentCheckpointMeta = { checkpointId: result.checkpoint.checkpointId, activeCueId: result.state.activeCueId,
    currentSessionPhase: result.state.currentSessionPhase, routeCursor: result.state.routeCursor, sessionStatus: result.state.sessionStatus };
  input.checkpoint(checkpoint); // Observed Graph checkpoint, not a durable-library acknowledgement.
  const { runtime, record, history } = owner;
  if (!runtime || !record) return;
  const stable = input.stable(checkpoint);
  if (!stable || stable.agentCheckpointId !== checkpoint.checkpointId || !recordMatches(stable, event.identity, record.recoveryId)) return;
  try {
    const persisted = await runtime.dispatch({ type: "STABLE_BOUNDARY_REACHED", eventId: input.eventId(), recoveryId: record.recoveryId,
      boundary: stable.boundary, cueProgress: stable.cueProgress, routeReadiness: stable.routeReadiness, narrationArtifacts: stable.narrationArtifacts,
      agentCheckpointId: result.checkpoint.checkpointId, updatedAt: Date.now() });
    if (!current()) return;
    const durable = persisted.record;
    if ((persisted.status !== "READY" && persisted.status !== "DEGRADED") || persisted.recoveryId !== record.recoveryId
      || !recordMatches(durable ?? undefined, event.identity, record.recoveryId) || !durable
      || durable.agentCheckpointId !== checkpoint.checkpointId || durable.boundary.boundaryId !== stable.boundary.boundaryId) {
      input.failure(); return;
    }
    // A matching DEGRADED memory record can still become durable in the library.
    if (history && (durable.boundary.kind === "CUE_PAUSED" || durable.boundary.kind === "WRAP_UP")) {
      const recoveryArtifactKey = `${durable.boundary.boundaryId}:${durable.agentCheckpointId}`;
      await history.artifact("SESSION_RECOVERY", recoveryArtifactKey, durable, "session-recovery-record.v2");
      if (!current()) return;
      if (history.reviewId && !history.revisionId) { input.failure(); return; }
      if (history.reviewId && history.revisionId) {
        await history.stableHead({ recoveryArtifactKey,
          sessionId: durable.sessionId, runId: durable.runId, demoContentHash: durable.demoContentHash, selectedPlayerId: durable.selectedPlayerId, routeId: durable.routeId,
          routeHash: durable.routeHash, recoveryBoundary: durable.boundary.kind,
          checkpointThreadId: checkpointThreadIdForSession(durable.sessionId), checkpointNamespace: "", checkpointId: durable.agentCheckpointId,
          ...(durable.boundary.kind === "CUE_PAUSED" ? { currentCueId: durable.boundary.cueId } : {}),
          defaultRouteCursor: durable.boundary.segmentIndex, completedCueCount: durable.cueProgress.completedCueIds.length,
          totalCueCount: (durable.frozenReviewPlan as ReviewPlan).cues.length, stableProgress: durable.cueProgress,
          ...(durable.boundary.kind === "WRAP_UP" ? { reviewStatus: "COMPLETED", completedAt: new Date(durable.updatedAt).toISOString() } : { reviewStatus: "IN_PROGRESS" }),
        });
        if (!current()) return;
      }
    }
    input.accept(persisted);
  } catch { if (current()) input.failure(); }
}
