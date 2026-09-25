import type { SessionRecoveryRecord, SessionRecoveryResult, SessionRecoveryRuntime } from "@cs-coach/coach-agent/client";

export interface RecoveryDiscardOwner {
  generation: number;
  historyEpoch: number;
  runtime: SessionRecoveryRuntime | undefined;
  record: Pick<SessionRecoveryRecord, "recoveryId" | "sessionId" | "runId"> | undefined;
}

export interface RecoveryDiscardInput {
  runtime: SessionRecoveryRuntime;
  record: SessionRecoveryRecord;
  eventId: string;
  readOwner: () => RecoveryDiscardOwner;
  onStart: () => void;
  onDiscarded: () => void;
  accept: (result: SessionRecoveryResult) => void;
  onFailure: (result?: SessionRecoveryResult) => void;
}

const DISCARD_NOT_CONFIRMED = "尚未确认放弃成功，已保留恢复资料；基础回放仍可继续。";

export function hostRecoveryStatusDetail(result: SessionRecoveryResult | undefined): string | undefined {
  return result?.reason === DISCARD_NOT_CONFIRMED ? DISCARD_NOT_CONFIRMED
    : result?.reason ? "恢复过程暂未完成，请按下方操作继续。" : undefined;
}

export function recoveryDiscardFailureResult(record: SessionRecoveryRecord, result?: SessionRecoveryResult): SessionRecoveryResult {
  return { schemaVersion: "session-recovery-runtime.v1", status: result?.status === "REJECTED" ? "REJECTED" : "DEGRADED",
    recoveryId: record.recoveryId, record, effects: [],
    reason: DISCARD_NOT_CONFIRMED,
  };
}

/** Actual Host discard entry; a stored record is sufficient without a loaded Demo/session. */
export class HostRecoveryDiscard {
  #operation = 0;
  #pending?: { isCurrent: () => boolean; recoveryId: string; promise: Promise<void> };

  discard(input: RecoveryDiscardInput): Promise<void> {
    if (this.#pending?.isCurrent() && this.#pending.recoveryId === input.record.recoveryId) return this.#pending.promise;
    const owner = { ...input.readOwner() };
    const { recoveryId, sessionId, runId } = input.record;
    const operation = ++this.#operation;
    const isCurrent = () => {
      const live = input.readOwner();
      return operation === this.#operation && owner.runtime === input.runtime && live.runtime === input.runtime
        && live.generation === owner.generation && live.historyEpoch === owner.historyEpoch
        && live.record?.recoveryId === recoveryId && live.record.sessionId === sessionId && live.record.runId === runId;
    };
    if (!isCurrent()) return Promise.resolve();
    input.onStart();
    const promise = this.#dispatch(input, isCurrent).finally(() => {
      if (this.#pending?.promise === promise) this.#pending = undefined;
    });
    this.#pending = { isCurrent, recoveryId, promise };
    return promise;
  }

  async #dispatch(input: RecoveryDiscardInput, isCurrent: () => boolean): Promise<void> {
    let result: SessionRecoveryResult;
    try {
      result = await input.runtime.dispatch({ type: "DISCARD_RECOVERY", eventId: input.eventId, recoveryId: input.record.recoveryId });
    } catch {
      if (isCurrent()) input.onFailure();
      return;
    }
    if (!isCurrent()) return;
    if (result.status !== "READY" || result.recoveryId !== null || result.record !== null) {
      input.onFailure(result);
      return;
    }
    input.onDiscarded();
    input.accept(result);
  }
}

/** A landing timeout already sent before discard can still return after deletion. */
export async function dispatchDiscardableLandingTimeout(input: {
  runtime: SessionRecoveryRuntime;
  record: SessionRecoveryRecord;
  eventId: string;
  isCurrent: () => boolean;
  accept: (result: SessionRecoveryResult) => void;
}): Promise<void> {
  if (!input.isCurrent()) return;
  let result: SessionRecoveryResult;
  try {
    result = await input.runtime.dispatch({ type: "RECOVERY_HANDSHAKE_FAILED", eventId: input.eventId,
      recoveryId: input.record.recoveryId, reason: "PLAYBACK_LANDING_TIMEOUT", degraded: true });
  } catch {
    result = { schemaVersion: "session-recovery-runtime.v1", status: "DEGRADED", recoveryId: input.record.recoveryId,
      record: input.record, effects: [], reason: "PLAYBACK_LANDING_TIMEOUT" };
  }
  if (input.isCurrent()) input.accept(result);
}
