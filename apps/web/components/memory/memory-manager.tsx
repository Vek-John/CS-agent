"use client";

import { useCallback, useEffect, useState } from "react";
import {
  confidenceLabel,
  defaultTeachingPreferences,
  memoryKindLabel,
  memoryStatusLabel,
  sourceCategoryLabel,
  teachingPreferenceOptions,
  memoryProfileFieldOptions,
  memoryProfileDetails,
  memoryRecordStateDescription,
  memoryRuntimePresentation,
  memorySourceLabels,
  profileSaveFeedback,
  visibleMemoryLimitations,
  type MemoryProfileFieldKey,
  type TeachingPreferenceKey,
  type MemorySourceCategory,
} from "./memory-ui";

type PublicPreferenceValue = string | number | boolean;

interface PublicPreference {
  key: string;
  value: PublicPreferenceValue;
  label?: string;
}

interface PublicMemoryRecord {
  memoryId: string;
  kind: string;
  source: string;
  sourceCategory: MemorySourceCategory;
  sourceLabel: string;
  scope: string;
  status: string;
  active: boolean;
  revision: number;
  content?: string;
  summary?: string;
  confidence?: number | null;
  preference?: PublicPreference;
  profile?: Record<string, string | number | boolean>;
  limitations: string[];
  sources: Array<{ namespace: string; source?: string; label?: string }>;
  counterEvidence: Array<{ namespace: string; source?: string; label?: string }>;
  corrections: Array<{ correctionId: string; content: string; createdAt: string; revision: number }>;
  createdAt: string;
  updatedAt: string;
}

interface MemoryStatusResponse {
  featureFlag: boolean;
  enabled: boolean;
  consent: "GRANTED" | "REVOKED" | "UNKNOWN";
  principalType: "ANONYMOUS";
  storage?: string;
  durable?: boolean;
  degradedReason?: string;
}

interface MemoryListResponse {
  records: PublicMemoryRecord[];
  limitations?: string[];
  brief?: { limitations?: string[] };
}

interface MemoryPreferencesResponse {
  preferences: Array<{ preference?: PublicPreference }>;
  degradedReason?: string;
}

interface MemoryProfileResponse {
  featureFlag?: boolean;
  enabled?: boolean;
  consent?: "GRANTED" | "REVOKED" | "UNKNOWN";
  profile?: Record<string, string | number | boolean> | null;
  degradedReason?: string;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: "same-origin",
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as T & { reason?: string; error?: string };
  if (!response.ok) throw new Error(payload.reason ?? payload.error ?? `请求失败（${response.status}）`);
  return payload;
}

function consentCopy(status: MemoryStatusResponse | null): string {
  if (!status?.featureFlag) return "长期记忆功能目前由部署开关关闭。";
  if (status.enabled) return "已授权。教练只会保留有来源、可纠正的跨 Demo 学习线索。";
  if (status.consent === "REVOKED") return "已撤回授权。新的跨 Demo 记忆不会被读取或写入。";
  return "尚未授权。当前复盘不会写入跨 Demo 记忆。";
}

export function MemoryManager() {
  const [status, setStatus] = useState<MemoryStatusResponse | null>(null);
  const [records, setRecords] = useState<PublicMemoryRecord[]>([]);
  const [limitations, setLimitations] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});
  const [preferences, setPreferences] = useState<Record<TeachingPreferenceKey, string>>({ ...defaultTeachingPreferences });
  const [preferenceLoading, setPreferenceLoading] = useState(true);
  const [preferenceBusy, setPreferenceBusy] = useState<TeachingPreferenceKey | null>(null);
  const [preferenceMessage, setPreferenceMessage] = useState("");
  const [profile, setProfile] = useState<Record<MemoryProfileFieldKey, string>>({
    displayName: "",
    role: "",
    primaryMap: "",
    learningGoal: "",
  });
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setPreferenceLoading(true);
    setProfileLoading(true);
    try {
      const [nextStatus, next, nextPreferences, nextProfile] = await Promise.all([
        requestJson<MemoryStatusResponse>("/api/memory/status"),
        requestJson<MemoryListResponse>("/api/memory?limit=25"),
        requestJson<MemoryPreferencesResponse>("/api/memory/preferences"),
        requestJson<MemoryProfileResponse>("/api/memory/profile"),
      ]);
      setStatus(nextStatus);
      setRecords(next.records ?? []);
      const nextPreferenceValues = { ...defaultTeachingPreferences };
      for (const record of nextPreferences.preferences ?? []) {
        const preference = record.preference;
        if (!preference || typeof preference.key !== "string" || typeof preference.value !== "string") continue;
        if (preference.key in nextPreferenceValues) {
          nextPreferenceValues[preference.key as TeachingPreferenceKey] = preference.value;
        }
      }
      setPreferences(nextPreferenceValues);
      const nextProfileValues: Record<MemoryProfileFieldKey, string> = {
        displayName: "",
        role: "",
        primaryMap: "",
        learningGoal: "",
      };
      for (const option of memoryProfileFieldOptions) {
        const value = nextProfile.profile?.[option.key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          nextProfileValues[option.key] = String(value);
        }
      }
      setProfile(nextProfileValues);
      setLimitations(visibleMemoryLimitations([
        ...(next.limitations ?? []),
        ...(next.brief?.limitations ?? []),
        ...(nextPreferences.degradedReason ? [nextPreferences.degradedReason] : []),
        ...(nextProfile.degradedReason ? [nextProfile.degradedReason] : []),
        ...(nextStatus.degradedReason ? [nextStatus.degradedReason] : []),
      ]));
      setMessage("");
      setPreferenceMessage("");
      setProfileMessage("");
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : "记忆管理暂时不可用。";
      setMessage(nextMessage);
      setPreferenceMessage(nextMessage);
      setProfileMessage(nextMessage);
    } finally {
      setLoading(false);
      setPreferenceLoading(false);
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const setConsent = async (enabled: boolean) => {
    setBusy("consent");
    try {
      await requestJson("/api/memory/consent", { method: "POST", body: JSON.stringify({ enabled }) });
      setMessage(enabled ? "已开启长期记忆。" : "已撤回长期记忆授权。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "授权更新失败。");
    } finally {
      setBusy(null);
    }
  };

  const savePreference = async (key: TeachingPreferenceKey) => {
    const option = teachingPreferenceOptions.find((candidate) => candidate.key === key);
    const value = preferences[key];
    if (!option || !option.values.some((candidate) => candidate.value === value)) {
      setPreferenceMessage("请选择有效的教学偏好。");
      return;
    }
    setPreferenceBusy(key);
    try {
      const result = await requestJson<{ accepted: boolean; changed: boolean; idempotent: boolean }>("/api/memory/preferences", {
        method: "POST",
        body: JSON.stringify({ key, value, label: option.label }),
      });
      const savedMessage = result.idempotent ? `${option.label}保持不变，已确认当前设置。` : `${option.label}已保存，下一次复盘会使用它。`;
      await refresh();
      setPreferenceMessage(savedMessage);
    } catch (error) {
      setPreferenceMessage(error instanceof Error ? error.message : "教学偏好保存失败。");
    } finally {
      setPreferenceBusy(null);
    }
  };

  const saveProfile = async () => {
    const cleaned = Object.fromEntries(
      memoryProfileFieldOptions
        .map(({ key }) => [key, profile[key].trim()] as const)
        .filter(([, value]) => value.length > 0),
    );
    if (Object.keys(cleaned).length === 0) {
      setProfileMessage("至少填写一项资料后再保存。");
      return;
    }
    setProfileBusy(true);
    try {
      const result = await requestJson<{ accepted: boolean; changed: boolean; idempotent: boolean }>("/api/memory/profile", {
        method: "POST",
        body: JSON.stringify({ profile: cleaned }),
      });
      const savedMessage = profileSaveFeedback(result.idempotent);
      await refresh();
      setProfileMessage(savedMessage);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : "资料保存失败。");
    } finally {
      setProfileBusy(false);
    }
  };

  const confirm = async (record: PublicMemoryRecord) => {
    setBusy(record.memoryId);
    try {
      await requestJson(`/api/memory/${encodeURIComponent(record.memoryId)}/confirm`, { method: "POST", body: JSON.stringify({ source: "USER" }) });
      setMessage("已确认这条记忆，后续教练可以把它作为长期线索使用。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "确认失败。");
    } finally {
      setBusy(null);
    }
  };

  const correct = async (record: PublicMemoryRecord) => {
    const content = correctionDrafts[record.memoryId]?.trim() ?? "";
    if (!content) {
      setMessage("请先写下你希望教练记住的纠正内容。");
      return;
    }
    setBusy(record.memoryId);
    try {
      await requestJson(`/api/memory/${encodeURIComponent(record.memoryId)}/correct`, { method: "POST", body: JSON.stringify({ content, source: "USER" }) });
      setCorrectionDrafts((drafts) => ({ ...drafts, [record.memoryId]: "" }));
      setMessage("已保存你的纠正，用户内容会优先于原来的推断。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "纠正保存失败。");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (record: PublicMemoryRecord) => {
    if (typeof window !== "undefined" && !window.confirm("删除后这条记忆会留下不可复活的删除标记，确定继续吗？")) return;
    setBusy(record.memoryId);
    try {
      await requestJson(`/api/memory/${encodeURIComponent(record.memoryId)}`, { method: "DELETE", body: JSON.stringify({ reason: "用户从记忆管理面删除" }) });
      setMessage("已删除。这条记忆不会因迟到事件重新出现。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败。");
    } finally {
      setBusy(null);
    }
  };

  const removeAll = async () => {
    if (typeof window !== "undefined" && !window.confirm("这会删除当前匿名主体的全部长期记忆并留下防复活标记，确定继续吗？")) return;
    setBusy("all");
    try {
      const result = await requestJson<{ deleted: number; limited?: boolean }>("/api/memory", { method: "DELETE" });
      const resultMessage = `已删除 ${result.deleted} 条长期记忆。${result.limited ? "仍有更多记录，请再次执行清除。" : "迟到事件不会让它们重新出现。"}`;
      await refresh();
      setMessage(resultMessage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "全部删除失败。");
    } finally {
      setBusy(null);
    }
  };

  const runtimePresentation = memoryRuntimePresentation(status?.storage, status?.degradedReason);

  return (
    <main className="memory-page" aria-labelledby="memory-page-title">
      <header className="memory-page-header">
        <div>
          <a className="memory-back-link" href="/">返回复盘</a>
          <p className="memory-eyebrow">LONG-TERM COACHING MEMORY</p>
          <h1 id="memory-page-title">长期记忆</h1>
          <p className="memory-lede">只留下能帮助下一场复盘的线索。你始终可以查看来源、纠正内容，或删除它。</p>
        </div>
      </header>

      <section className="memory-consent-card" aria-labelledby="memory-consent-title">
        <div>
          <p className="memory-section-kicker">授权</p>
          <h2 id="memory-consent-title">让教练记住跨 Demo 的学习线索</h2>
          <p>{consentCopy(status)}</p>
          <small className="memory-note">当前使用匿名浏览器主体；清除本浏览器 Cookie 后，无法恢复或关联到原主体。</small>
          {runtimePresentation.localNote && <small className="memory-note">{runtimePresentation.localNote}</small>}
          {runtimePresentation.warning && <small className="memory-warning">当前处于降级状态：{runtimePresentation.warning}</small>}
        </div>
        <div className="memory-consent-actions" role="group" aria-label="长期记忆授权">
          <button type="button" className="memory-button memory-button-primary" disabled={busy === "consent" || !status?.featureFlag || status.enabled} onClick={() => void setConsent(true)}>开启记忆</button>
          <button type="button" className="memory-button memory-button-quiet" disabled={busy === "consent" || !status?.featureFlag || !status.enabled} onClick={() => void setConsent(false)}>撤回授权</button>
        </div>
      </section>

      <section className="memory-record-card memory-profile-card" aria-labelledby="memory-profile-title">
        <div className="memory-section-heading">
          <div>
            <p className="memory-section-kicker">用户资料</p>
            <h2 id="memory-profile-title">管理你主动填写的资料</h2>
          </div>
          <span className="memory-revision">明确填写 · 可随时修改</span>
        </div>
        <p className="memory-lede">这些资料只保存在你的匿名主体下，由你在这里管理；不会进入 Agent Brief，也不会发送给教练 Agent。</p>
        <div className="memory-profile-grid">
          {memoryProfileFieldOptions.map((option) => (
            <label className="memory-profile-field" key={option.key} htmlFor={`memory-profile-${option.key}`}>
              <span>{option.label}</span>
              <input
                id={`memory-profile-${option.key}`}
                value={profile[option.key]}
                maxLength={240}
                placeholder={option.placeholder}
                disabled={profileLoading || profileBusy || !status?.featureFlag || !status?.enabled}
                onChange={(event) => setProfile((current) => ({ ...current, [option.key]: event.target.value }))}
              />
            </label>
          ))}
        </div>
        <div className="memory-correction-footer">
          <small className="memory-note" role="status" aria-live="polite">{profileLoading ? "正在读取资料…" : profileMessage || (status?.enabled ? "可只填写你愿意保存和管理的内容。" : "开启长期记忆后可编辑资料。")}</small>
          <button type="button" className="memory-button memory-button-primary" disabled={profileLoading || profileBusy || !status?.featureFlag || !status?.enabled} onClick={() => void saveProfile()}>
            {profileBusy ? "保存中…" : "保存资料"}
          </button>
        </div>
      </section>

      <section className="memory-record-card" aria-labelledby="memory-preferences-title">
        <div className="memory-section-heading">
          <div>
            <p className="memory-section-kicker">教学偏好</p>
            <h2 id="memory-preferences-title">让教练按你的方式解释</h2>
          </div>
          <span className="memory-revision">仅在授权后生效</span>
        </div>
        <p className="memory-lede">这些设置会作为明确的用户偏好保存。你可以随时修改，不会改变回放本身。</p>
        <p className="memory-note" role="status" aria-live="polite">{preferenceLoading ? "正在读取教学偏好…" : preferenceMessage || (status?.enabled ? "选择后保存即可应用。" : "开启长期记忆后可编辑教学偏好。")}</p>
        <div className="memory-record-list">
          {teachingPreferenceOptions.map((option) => (
            <div className="memory-correction-form" key={option.key}>
              <label htmlFor={`memory-preference-${option.key}`}>{option.label}</label>
              <small className="memory-note">{option.description}</small>
              <select
                id={`memory-preference-${option.key}`}
                className="memory-button memory-button-quiet"
                value={preferences[option.key]}
                disabled={preferenceLoading || !status?.featureFlag || !status?.enabled || preferenceBusy !== null}
                onChange={(event) => setPreferences((current) => ({ ...current, [option.key]: event.target.value }))}
              >
                {option.values.map((value) => <option key={value.value} value={value.value}>{value.label}</option>)}
              </select>
              <div className="memory-correction-footer">
                <small>{status?.enabled ? "只保存这一个设置" : "尚未授权"}</small>
                <button
                  type="button"
                  className="memory-button memory-button-primary"
                  disabled={preferenceLoading || !status?.featureFlag || !status?.enabled || preferenceBusy !== null}
                  onClick={() => void savePreference(option.key)}
                >
                  {preferenceBusy === option.key ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="memory-status-row" role="status" aria-live="polite">
        {loading ? "正在读取你的记忆…" : message || `${records.length} 条可管理记忆`}
      </div>

      {limitations.length > 0 && (
        <aside className="memory-limitations" aria-label="当前限制">
          <strong>当前限制</strong>
          <ul>{limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        </aside>
      )}

      <section className="memory-records" aria-labelledby="memory-records-title">
        <div className="memory-section-heading">
          <div><p className="memory-section-kicker">可管理记录</p><h2 id="memory-records-title">教练记住了什么</h2></div>
          <div className="memory-record-actions">
            <button type="button" className="memory-button memory-button-quiet" onClick={() => void refresh()} disabled={loading || busy !== null}>刷新</button>
            {/* Deletion is a privacy exception and remains available when the
                recall feature flag is off. The API still performs the opaque
                principal/consent check; disabling this control based on the
                feature flag would make already-stored data impossible to
                erase from the UI. */}
            <button type="button" className="memory-button memory-button-danger" onClick={() => void removeAll()} disabled={loading || busy !== null}>删除全部</button>
          </div>
        </div>
        {!loading && records.length === 0 && <div className="memory-empty"><span aria-hidden="true">◌</span><p>{status?.consent === "REVOKED" ? "授权已撤回；记忆不会再被读取或写入。你仍可使用“删除全部”完成隐私清除。" : status?.enabled ? "目前还没有可管理的长期记忆。完成更多复盘后，候选线索会出现在这里。" : "开启授权后，这里会显示可以管理的记忆。"}</p></div>}
        <div className="memory-record-list">
          {records.map((record) => {
            const draft = correctionDrafts[record.memoryId] ?? "";
            return (
              <article className="memory-record-card" key={record.memoryId}>
                <div className="memory-record-topline">
                  <div className="memory-record-tags">
                    <span className={`memory-chip memory-chip-${record.sourceCategory.toLowerCase()}`}>{sourceCategoryLabel(record.sourceCategory)}</span>
                    <span className="memory-chip">{memoryKindLabel(record.kind)}</span>
                    <span className="memory-chip">{memoryStatusLabel(record.status)}</span>
                  </div>
                  <span className="memory-revision">修订 {record.revision}</span>
                </div>
                <h3>{record.summary || record.content || (record.kind === "PROFILE" ? "用户资料" : "未命名记忆")}</h3>
                {record.content && record.summary && record.content !== record.summary && <p className="memory-record-content">{record.content}</p>}
                {record.profile && <p className="memory-record-content">{memoryProfileDetails(record.profile)}</p>}
                <dl className="memory-record-meta">
                  <div><dt>来源</dt><dd>{record.sourceLabel}</dd></div>
                  <div><dt>置信度</dt><dd>{confidenceLabel(record.confidence)}</dd></div>
                  <div><dt>状态</dt><dd>{memoryRecordStateDescription(record)}</dd></div>
                </dl>
                {record.limitations.length > 0 && <p className="memory-record-limitations"><strong>限制：</strong>{record.limitations.join("；")}</p>}
                {record.sources.length > 0 && <p className="memory-record-sources"><strong>证据：</strong>{memorySourceLabels(record.sources).join("、")}</p>}
                {record.counterEvidence.length > 0 && <p className="memory-record-sources"><strong>相反证据：</strong>{record.counterEvidence.map((source) => source.label || source.namespace).join("、")}</p>}
                <div className="memory-record-actions">
                  {record.status !== "CONFIRMED" && record.status !== "DELETED" && <button type="button" className="memory-button memory-button-primary" disabled={busy === record.memoryId} onClick={() => void confirm(record)}>确认这条记忆</button>}
                  <button type="button" className="memory-button memory-button-danger" disabled={busy === record.memoryId} onClick={() => void remove(record)}>删除</button>
                </div>
                <div className="memory-correction-form">
                  <label htmlFor={`memory-correction-${record.memoryId}`}>纠正这条记忆</label>
                  <textarea id={`memory-correction-${record.memoryId}`} maxLength={800} value={draft} onChange={(event) => setCorrectionDrafts((drafts) => ({ ...drafts, [record.memoryId]: event.target.value }))} placeholder="例如：我通常会等明确的补枪信息，不是马上继续 peek。" />
                  <div className="memory-correction-footer"><small>{draft.length}/800</small><button type="button" className="memory-button memory-button-quiet" disabled={busy === record.memoryId || !draft.trim()} onClick={() => void correct(record)}>保存纠正</button></div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
