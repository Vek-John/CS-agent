"use client";

import { AlertTriangle, CheckCircle2, FileUp, LoaderCircle, RotateCcw, ShieldCheck, Trash2, XCircle } from "lucide-react";
import styles from "./session-recovery-status.module.css";

export type SessionRecoveryStatusKind = "DORMANT" | "LOADING" | "REBUILDING" | "RECOVERED" | "REJECTED" | "DEGRADED";

export interface SessionRecoveryStatusProps {
  readonly status: SessionRecoveryStatusKind;
  readonly detail?: string;
  readonly onChooseDemo: () => void;
  readonly onDiscard?: () => void;
}

const COPY: Record<SessionRecoveryStatusKind, { title: string; detail: string; choose: boolean; discard: boolean }> = {
  DORMANT: { title: "发现未完成复盘", detail: "重新选择同一 Demo 即可继续。文件只在浏览器内解析，不会上传。", choose: true, discard: true },
  LOADING: { title: "正在读取恢复记录", detail: "正在检查本地复盘状态。文件只在浏览器内解析，不会上传。", choose: false, discard: false },
  REBUILDING: { title: "正在验证并重新解析", detail: "正在核对 Demo、玩家和最近教学点。文件只在浏览器内解析，不会上传。", choose: false, discard: true },
  RECOVERED: { title: "复盘已恢复", detail: "已停在最近教学点，等待你继续。", choose: false, discard: false },
  REJECTED: { title: "恢复未完成", detail: "Demo 或版本不匹配；原记录仍保留，可以重新选择。", choose: true, discard: true },
  DEGRADED: { title: "当前页可以继续回放", detail: "本地恢复存储不可用；刷新后不能恢复。", choose: true, discard: false },
};

function Icon({ kind }: { kind: SessionRecoveryStatusKind }) {
  if (kind === "RECOVERED") return <CheckCircle2 aria-hidden="true" />;
  if (kind === "REJECTED") return <XCircle aria-hidden="true" />;
  if (kind === "DEGRADED") return <AlertTriangle aria-hidden="true" />;
  if (kind === "LOADING" || kind === "REBUILDING") return <LoaderCircle aria-hidden="true" />;
  if (kind === "DORMANT") return <RotateCcw aria-hidden="true" />;
  return <ShieldCheck aria-hidden="true" />;
}

export function SessionRecoveryStatus({ status, detail, onChooseDemo, onDiscard }: SessionRecoveryStatusProps) {
  const copy = COPY[status];
  return (
    <section className={styles.status} data-recovery-state={status} aria-live="polite">
      <div className={styles.icon}><Icon kind={status} /></div>
      <div className={styles.copy}>
        <p className={styles.eyebrow}>复盘恢复</p>
        <h2>{copy.title}</h2>
        <p className={styles.detail}>{detail ?? copy.detail}</p>
      </div>
      <div className={styles.actions}>
        {copy.choose ? (
          <button type="button" className={styles.primary} onClick={onChooseDemo}>
            <FileUp aria-hidden="true" />
            到回放区选择 Demo
          </button>
        ) : null}
        {copy.discard && onDiscard ? (
          <button type="button" className={styles.secondary} onClick={onDiscard}>
            <Trash2 aria-hidden="true" />
            放弃恢复
          </button>
        ) : null}
      </div>
    </section>
  );
}
