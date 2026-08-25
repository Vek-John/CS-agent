import {
  SessionRecoveryEventSchema,
  SessionRecoveryResultSchema,
  type SessionRecoveryEvent,
  type SessionRecoveryRecord,
  type SessionRecoveryResult,
  type SessionRecoveryRuntime,
} from "@cs-coach/coach-agent/client";
import {
  HostRecoveryStore,
  type HostRecoveryStoreOptions,
} from "./host-recovery-store";

export interface SessionRecoveryRuntimeOptions extends HostRecoveryStoreOptions {
  readonly now?: () => number;
}

const NO_RECORD_REASON = "没有未完成的复盘。";
const DORMANT_REASON = "发现未完成复盘；重新选择同一 Demo 即可继续。";
const MISMATCH_REASON = "当前 Demo 或分析版本不匹配；原记录仍保留。";

function shortReason(reason: string): string {
  return reason.slice(0, 200);
}

export class BrowserSessionRecoveryRuntime implements SessionRecoveryRuntime {
  private readonly store: HostRecoveryStore;
  private readonly now: () => number;
  private currentRecord: SessionRecoveryRecord | undefined;
  private dispatchTail: Promise<SessionRecoveryResult> = Promise.resolve({
    schemaVersion: "session-recovery-runtime.v1",
    status: "DORMANT",
    recoveryId: null,
    record: null,
    effects: [],
    reason: NO_RECORD_REASON,
  });

  constructor(options: SessionRecoveryRuntimeOptions = {}) {
    this.store = new HostRecoveryStore(options);
    this.now = options.now ?? Date.now;
  }

  dispatch(event: SessionRecoveryEvent): Promise<SessionRecoveryResult> {
    const next = this.dispatchTail
      .then(() => this.apply(event))
      .catch(() => this.errorResult("恢复状态暂时不可用；基础回放仍可继续。"));
    this.dispatchTail = next;
    return next;
  }

  private result(
    status: SessionRecoveryResult["status"],
    recoveryId: string | null,
    record: SessionRecoveryRecord | null,
    effects: SessionRecoveryResult["effects"] = [],
    reason: string | null = null,
  ): SessionRecoveryResult {
    const storeStatus = this.store.status;
    const finalStatus = storeStatus.degraded && ["READY", "REBUILDING", "DORMANT", "RECOVERED"].includes(status)
      ? "DEGRADED"
      : status;
    return SessionRecoveryResultSchema.parse({
      schemaVersion: "session-recovery-runtime.v1",
      status: finalStatus,
      recoveryId,
      record,
      effects,
      reason: finalStatus === "DEGRADED" && storeStatus.reason
        ? storeStatus.reason
        : reason ?? (storeStatus.degraded ? storeStatus.reason : null),
    });
  }

  private errorResult(reason: string): SessionRecoveryResult {
    return this.result("DEGRADED", this.currentRecord?.recoveryId ?? null, this.currentRecord ?? null, [], reason);
  }

  private async recordFor(recoveryId: string): Promise<SessionRecoveryRecord | undefined> {
    if (this.currentRecord?.recoveryId === recoveryId) return this.currentRecord;
    const record = await this.store.get(recoveryId);
    if (record) this.currentRecord = record;
    return record;
  }

  private reject(recoveryId: string | null, reason: string): SessionRecoveryResult {
    return this.result("REJECTED", recoveryId, this.currentRecord ?? null, [], shortReason(reason));
  }

  private async apply(rawEvent: SessionRecoveryEvent): Promise<SessionRecoveryResult> {
    const parsed = SessionRecoveryEventSchema.safeParse(rawEvent);
    if (!parsed.success) return this.reject(null, "恢复事件校验失败；基础回放仍可继续。");
    const event = parsed.data;

    switch (event.type) {
      case "BOOT": {
        const record = await this.store.boot();
        this.currentRecord = record;
        return this.result("DORMANT", record?.recoveryId ?? null, record ?? null, [], record ? DORMANT_REASON : NO_RECORD_REASON);
      }
      case "SESSION_STARTED": {
        if (event.record.status !== "INCOMPLETE") return this.reject(event.record.recoveryId, "恢复记录版本不兼容；请开始新的复盘。");
        const record = await this.store.upsert(event.record);
        this.currentRecord = record;
        return this.result("READY", record.recoveryId, record);
      }
      case "REPLAY_LOADING": {
        const record = await this.recordFor(event.recoveryId);
        if (!record) return this.reject(event.recoveryId, "未找到这场未完成复盘；请重新开始。");
        return this.result("REBUILDING", record.recoveryId, record, [{ type: "REQUEST_REPLAY", recoveryId: record.recoveryId }]);
      }
      case "REPLAY_READY": {
        const record = await this.recordFor(event.recoveryId);
        if (!record) return this.reject(event.recoveryId, "未找到这场未完成复盘；请重新开始。");
        if (event.demoContentHash.toLowerCase() !== record.demoContentHash.toLowerCase()) {
          return this.reject(record.recoveryId, "Demo 内容不匹配；原记录仍保留。");
        }
        if (!event.availablePlayerIds.includes(record.selectedPlayerId)) {
          return this.reject(record.recoveryId, "原复盘玩家不在当前 Demo；原记录仍保留。");
        }
        return this.result("READY", record.recoveryId, record, [{
          type: "SELECT_PLAYER",
          recoveryId: record.recoveryId,
          playerId: record.selectedPlayerId,
        }]);
      }
      case "ANALYSIS_READY": {
        const record = await this.recordFor(event.recoveryId);
        if (!record) return this.reject(event.recoveryId, "未找到这场未完成复盘；请重新开始。");
        const versionsMatch = event.versions.parser === record.versions.parser &&
          event.versions.analysisAdapter === record.versions.analysisAdapter &&
          event.versions.planner === record.versions.planCompiler;
        const identityMatches = event.demoContentHash.toLowerCase() === record.demoContentHash.toLowerCase() &&
          event.selectedPlayerId === record.selectedPlayerId &&
          event.routeId === record.routeId &&
          event.routeHash === record.routeHash;
        if (!versionsMatch || !identityMatches) return this.reject(record.recoveryId, MISMATCH_REASON);
        return this.result("REBUILDING", record.recoveryId, record, [
          { type: "REQUEST_SESSION_REHYDRATE", recoveryId: record.recoveryId },
          { type: "SEEK_RECOVERY_BOUNDARY", recoveryId: record.recoveryId, boundary: record.boundary },
          { type: "RECONNECT_AGENT", recoveryId: record.recoveryId },
        ]);
      }
      case "STABLE_BOUNDARY_REACHED": {
        const record = await this.recordFor(event.recoveryId);
        if (!record) return this.reject(event.recoveryId, "未找到这场未完成复盘；请重新开始。");
        const updated = await this.store.update(event.recoveryId, (current) => {
          if (!current) return undefined;
          const toolLedger = event.toolLedgerEntry
            ? [...current.toolLedger.filter((entry) => entry.callId !== event.toolLedgerEntry!.callId), event.toolLedgerEntry].slice(-64)
            : current.toolLedger;
          return {
            ...current,
            updatedAt: Math.max(current.updatedAt, event.updatedAt, this.now()),
            boundary: event.boundary,
            cueProgress: event.cueProgress,
            routeReadiness: event.routeReadiness,
            narrationArtifacts: event.narrationArtifacts,
            toolLedger,
            agentCheckpointId: event.agentCheckpointId,
          };
        });
        this.currentRecord = updated;
        return updated
          ? this.result("READY", updated.recoveryId, updated)
          : this.reject(event.recoveryId, "恢复记录更新失败；基础回放仍可继续。");
      }
      case "TOOL_LEDGER_UPDATED": {
        const record = await this.recordFor(event.recoveryId);
        if (!record) return this.reject(event.recoveryId, "未找到这场未完成复盘；请重新开始。");
        const updated = await this.store.update(event.recoveryId, (current) => {
          if (!current) return undefined;
          const ledger = [...current.toolLedger.filter((entry) => entry.callId !== event.entry.callId), event.entry];
          return {
            ...current,
            updatedAt: Math.max(current.updatedAt, event.updatedAt, this.now()),
            toolLedger: ledger.slice(-64),
            agentCheckpointId: event.agentCheckpointId,
          };
        });
        this.currentRecord = updated;
        return updated
          ? this.result("READY", updated.recoveryId, updated)
          : this.reject(event.recoveryId, "工具恢复记录更新失败；基础回放仍可继续。");
      }
      case "SESSION_COMPLETED":
      case "DISCARD_RECOVERY": {
        const record = await this.recordFor(event.recoveryId);
        if (!record) return this.reject(event.recoveryId, "未找到这场未完成复盘；请重新开始。");
        await this.store.delete(event.recoveryId);
        this.currentRecord = undefined;
        return this.result("READY", null, null, [], event.type === "SESSION_COMPLETED" ? "复盘已完成。" : "已放弃这场未完成复盘。");
      }
      case "RECOVERY_HANDSHAKE_COMPLETED": {
        const record = await this.recordFor(event.recoveryId);
        if (!record) return this.reject(event.recoveryId, "未找到这场未完成复盘；请重新开始。");
        return this.result("RECOVERED", record.recoveryId, record, [], "已恢复到最近教学点，等待继续。");
      }
      case "RECOVERY_HANDSHAKE_FAILED": {
        const record = await this.recordFor(event.recoveryId);
        if (!record) return this.reject(event.recoveryId, "未找到这场未完成复盘；请重新开始。");
        return this.result(event.degraded ? "DEGRADED" : "REJECTED", record.recoveryId, record, [], event.reason);
      }
    }
  }
}

export function createSessionRecoveryRuntime(options: SessionRecoveryRuntimeOptions = {}): SessionRecoveryRuntime {
  return new BrowserSessionRecoveryRuntime(options);
}
