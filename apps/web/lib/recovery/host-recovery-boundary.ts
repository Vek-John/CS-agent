import type { SessionRecoveryEvent, SessionRecoveryRecord, SessionRecoveryResult, SessionRecoveryRuntime } from "@cs-coach/coach-agent/client";

type BoundaryEvent = Extract<SessionRecoveryEvent, { type: "SESSION_COMPLETED" | "STABLE_BOUNDARY_REACHED" }>;

export interface RecoveryBoundaryOwner {
  generation: number;
  historyEpoch: number;
  operationEpoch: number;
  runtime: SessionRecoveryRuntime | undefined;
  sessionId: string | undefined;
  sessionPhase?: string;
  completedHeadConfirmed?: boolean;
  record: Pick<SessionRecoveryRecord, "recoveryId" | "sessionId" | "runId"> | undefined;
  takenOver: boolean;
  recovering: boolean;
}

/** Capture primitive identity, not a record object which legitimately changes at stable points. */
export function captureRecoveryBoundaryOwner(read: () => RecoveryBoundaryOwner, completing = false): () => boolean {
  const owner = { ...read() };
  const { recoveryId, sessionId, runId } = owner.record ?? {};
  return () => {
    const live = read();
    return !!owner.runtime && !!recoveryId && owner.sessionId === sessionId
      && (!live.takenOver || (completing && live.sessionPhase === "COMPLETED" && live.completedHeadConfirmed === true)) && !live.recovering
      && live.generation === owner.generation && live.historyEpoch === owner.historyEpoch
      && live.operationEpoch === owner.operationEpoch && live.runtime === owner.runtime
      && live.sessionId === sessionId && live.record?.sessionId === sessionId
      && live.record?.recoveryId === recoveryId && live.record?.runId === runId;
  };
}

/** A failed/degraded delete must not erase the current in-memory recovery identity. */
export function recoveryBoundaryFailureResult(record: SessionRecoveryRecord, result?: SessionRecoveryResult): SessionRecoveryResult {
  return { schemaVersion: "session-recovery-runtime.v1",
    status: result?.status === "REJECTED" ? "REJECTED" : "DEGRADED",
    recoveryId: record.recoveryId, record, effects: [],
    reason: result && (result.status === "REJECTED" || result.status === "DEGRADED") && result.reason
      ? result.reason : "恢复状态保存未完成；基础回放仍可继续。",
  };
}

/** The Host's completion/stable-boundary effect dispatch and publication seam. */
export async function dispatchHostRecoveryBoundary(input: {
  runtime: SessionRecoveryRuntime;
  event: BoundaryEvent;
  record: SessionRecoveryRecord;
  isCurrent: () => boolean;
  onCompleted: () => void;
  accept: (result: SessionRecoveryResult) => void;
  onFailure: (result?: SessionRecoveryResult) => void;
}): Promise<void> {
  if (!input.isCurrent()) return;
  let result: SessionRecoveryResult;
  try {
    result = await input.runtime.dispatch(input.event);
  } catch {
    if (input.isCurrent()) input.onFailure();
    return;
  }
  if (!input.isCurrent()) return;
  if (input.event.type === "SESSION_COMPLETED") {
    // DEGRADED may mean an in-memory delete after durable storage failed.
    if (result.status !== "READY" || result.recoveryId !== null || result.record !== null) {
      input.onFailure(result);
      return;
    }
    input.onCompleted();
  } else if ((result.status !== "READY" && result.status !== "DEGRADED")
    || result.recoveryId !== input.record.recoveryId
    || result.record?.recoveryId !== input.record.recoveryId
    || result.record.sessionId !== input.record.sessionId || result.record.runId !== input.record.runId) {
    input.onFailure(result);
    return;
  }
  input.accept(result);
}
