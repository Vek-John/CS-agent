export type MemorySourceCategory = "USER" | "INFERENCE" | "EVIDENCE";

export const supportedLocalMemoryReason = "LOCAL_IN_MEMORY_STORAGE";

export interface MemoryRuntimePresentation {
  localNote?: string;
  warning?: string;
}

export const teachingPreferenceOptions = [
  {
    key: "explanationDepth",
    label: "解释深度",
    description: "控制每次复盘中建议解释的展开程度。",
    values: [
      { value: "BRIEF", label: "简洁" },
      { value: "NORMAL", label: "标准" },
      { value: "DEEP", label: "深入" },
    ],
  },
  {
    key: "preferredEvidence",
    label: "优先证据",
    description: "告诉教练你更容易从哪一种证据开始理解。",
    values: [
      { value: "MAP", label: "地图" },
      { value: "REPLAY", label: "回放" },
      { value: "TIMELINE", label: "时间线" },
      { value: "NUMBERS", label: "数据" },
    ],
  },
  {
    key: "reflectionFrequency",
    label: "反思频率",
    description: "控制教练在复盘中邀请你反思的频率。",
    values: [
      { value: "LOW", label: "较少" },
      { value: "NORMAL", label: "标准" },
      { value: "HIGH_AMBIGUITY_ONLY", label: "仅高歧义处" },
    ],
  },
] as const;

export type TeachingPreferenceKey = (typeof teachingPreferenceOptions)[number]["key"];
export type TeachingPreferenceValue = (typeof teachingPreferenceOptions)[number]["values"][number]["value"];

export const defaultTeachingPreferences: Record<TeachingPreferenceKey, string> = {
  explanationDepth: "NORMAL",
  preferredEvidence: "MAP",
  reflectionFrequency: "NORMAL",
};

/**
 * The profile editor intentionally exposes a small, human-readable subset of
 * the generic bounded profile contract.  The API still accepts additional
 * bounded fields for future clients, while this surface stays easy to scan
 * and never asks for account identifiers or secrets.
 */
export const memoryProfileFieldOptions = [
  { key: "displayName", label: "称呼", placeholder: "例如：小林" },
  { key: "role", label: "常用定位", placeholder: "例如：support" },
  { key: "primaryMap", label: "常练地图", placeholder: "例如：Mirage" },
  { key: "learningGoal", label: "当前学习目标", placeholder: "例如：更稳定地等待补枪" },
] as const;

export type MemoryProfileFieldKey = (typeof memoryProfileFieldOptions)[number]["key"];

export function memorySourceLabels(
  sources: ReadonlyArray<{ namespace: string; label?: string }>,
): string[] {
  return [...new Set(sources.map((source) => source.label || source.namespace))];
}

export function memoryProfileDetails(
  profile: Readonly<Record<string, string | number | boolean>>,
): string {
  const labels = new Map<string, string>(
    memoryProfileFieldOptions.map((option) => [option.key, option.label]),
  );
  return Object.entries(profile)
    .map(([key, value]) => `${labels.get(key) ?? key}：${String(value)}`)
    .join(" · ");
}

export function memoryRuntimePresentation(storage?: string, degradedReason?: string): MemoryRuntimePresentation {
  const usesLocalInMemoryStorage = storage === "IN_MEMORY" || degradedReason === supportedLocalMemoryReason;
  return {
    ...(usesLocalInMemoryStorage ? { localNote: "localhost 使用临时的进程内存储；重启本地服务后会清空。" } : {}),
    ...(degradedReason && degradedReason !== supportedLocalMemoryReason ? { warning: degradedReason } : {}),
  };
}

export function visibleMemoryLimitations(limitations: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(limitations.filter((limitation): limitation is string => Boolean(limitation) && limitation !== supportedLocalMemoryReason))];
}

export function profileSaveFeedback(idempotent: boolean): string {
  return idempotent
    ? "资料没有变化，已确认当前内容；不会进入 Agent Brief。"
    : "资料已保存。这是你管理的资料，不会进入 Agent Brief。";
}

export function memoryRecordStateDescription(record: { kind: string; status: string; active: boolean }): string {
  if (record.kind === "PROFILE") return "用户管理资料，不进入 Agent Brief";
  if (record.status === "DISPUTED") return "已纠正，等待当前证据复核";
  return record.active ? "会影响后续教练优先级" : "仅作为待确认候选";
}

export const memoryStatusLabels: Record<string, string> = {
  CANDIDATE: "待确认",
  OBSERVED: "已观察",
  REPEATED: "已重复",
  IMPROVING: "改善中",
  STABLE: "稳定",
  RESOLVED: "已解决",
  ARCHIVED: "已归档",
  DELETED: "已删除",
  DISPUTED: "用户已纠正",
  SUPERSEDED: "已被替代",
  EMERGING: "正在形成",
  ACTIVE: "生效中",
  CONFIRMED: "已确认",
};

export const memoryKindLabels: Record<string, string> = {
  PREFERENCE: "偏好",
  PROFILE: "用户资料",
  COACHING_PREFERENCE: "教练偏好",
  PLAYSTYLE: "打法风格",
  HABIT: "习惯",
  DECISION_MODEL: "决策模型",
  LEARNING_THREAD: "学习主题",
  USER_CLAIM: "用户主张",
  COACH_VERDICT: "教练判断",
  TRANSFER_RULE: "迁移规则",
  CORRECTION: "用户纠正",
};

export function sourceCategoryLabel(category: MemorySourceCategory | string): string {
  if (category === "USER") return "用户提供";
  if (category === "INFERENCE") return "教练推断";
  return "可追溯证据";
}

export function confidenceLabel(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "未提供";
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function memoryStatusLabel(status: string): string {
  return memoryStatusLabels[status] ?? status;
}

export function memoryKindLabel(kind: string): string {
  return memoryKindLabels[kind] ?? kind;
}
