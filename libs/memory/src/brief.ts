import type { LearningThread } from "@cs-coach/contracts";
import { MEMORY_BRIEF_VERSION, type MemoryCorrection, type MemoryRecord, type UserMemoryBrief } from "./domain";
import { MemoryBriefSchema } from "./schemas";

export const MAX_BRIEF_THREADS = 2;
export const MAX_BRIEF_MEMORIES = 3;
export const MAX_BRIEF_CORRECTIONS = 2;
/**
 * The Agent receives a smaller projection than the management API. This is a
 * deterministic character-based approximation (JSON characters / 3) rather
 * than a tokenizer dependency, so the bound remains stable
 * in Node, Workers and browsers. The wire schema still enforces its 16 KiB
 * byte ceiling as a second defense.
 */
export const MAX_AGENT_MEMORY_BRIEF_TOKENS = 800;
const AGENT_BRIEF_CHARS_PER_TOKEN = 3;
const AGENT_PREFERENCE_KEYS = new Set(["explanationDepth", "preferredEvidence", "reflectionFrequency"]);

export interface MemoryBriefBuildInput {
  records: readonly MemoryRecord[];
  /** Preferences are read through their own bounded repository query so a
   * crowded learning-record page cannot hide an explicit user setting. */
  preferenceRecords?: readonly MemoryRecord[];
  threads?: readonly LearningThread[];
  semanticRecords?: readonly MemoryRecord[];
  generatedAt?: string;
  limitations?: readonly string[];
  structuredStatus?: "AVAILABLE" | "UNAVAILABLE" | "EMPTY";
  semanticStatus?: "OPTIONAL" | "UNAVAILABLE" | "USED";
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string, max: number): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const token = key(value);
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(value);
    if (result.length >= max) break;
  }
  return result;
}

function statusWeight(status: MemoryRecord["status"]): number {
  switch (status) {
    case "DISPUTED":
      return 8;
    case "STABLE":
      return 6;
    case "CONFIRMED":
      return 7;
    case "REPEATED":
      return 5;
    case "IMPROVING":
      return 4;
    case "OBSERVED":
      return 3;
    case "ACTIVE":
    case "EMERGING":
      return 2;
    case "CANDIDATE":
      return 1;
    case "SUPERSEDED":
      return 0;
    default:
      return 0;
  }
}

function copyCorrections(records: readonly MemoryRecord[]): MemoryCorrection[] {
  return records
    .filter((record) => !["DELETED", "SUPERSEDED", "ARCHIVED", "RESOLVED"].includes(record.status))
    .flatMap((record) => [...record.corrections])
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .filter((correction, index, values) => values.findIndex((candidate) => candidate.correctionId === correction.correctionId) === index)
    .slice(0, MAX_BRIEF_CORRECTIONS);
}

function toCrossDemoThread(record: MemoryRecord): LearningThread | undefined {
  if (!record.thread || !record.active || ["DELETED", "DISPUTED", "SUPERSEDED", "ARCHIVED", "RESOLVED"].includes(record.status)) return undefined;
  return { ...record.thread, scope: "CROSS_DEMO" };
}

function short(value: unknown, max = 180): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, max);
  return normalized || undefined;
}

function compactTransferRule(rule: LearningThread["transferRule"] | MemoryRecord["transferRule"]): Record<string, unknown> | undefined {
  if (!rule) return undefined;
  return {
    ...(short(rule.when, 140) ? { when: short(rule.when, 140) } : {}),
    ...(short(rule.do, 180) ? { do: short(rule.do, 180) } : {}),
    ...(short(rule.unless, 140) ? { unless: short(rule.unless, 140) } : {}),
    confidence: rule.confidence,
  };
}

function compactThread(thread: LearningThread): Record<string, unknown> {
  return {
    scope: "CROSS_DEMO",
    ...(short(thread.hingeCode, 80) ? { hingeCode: short(thread.hingeCode, 80) } : {}),
    trigger: {
      ...(short(thread.trigger.situation, 180) ? { situation: short(thread.trigger.situation, 180) } : {}),
      conditions: thread.trigger.conditions.slice(0, 3).map((condition) => short(condition, 120)).filter((value): value is string => Boolean(value)),
    },
    userModel: Object.fromEntries(
      (["goal", "belief", "expectedTeammateAction"] as const)
        .map((key) => [key, short(thread.userModel[key], 140)] as const)
        .filter(([, value]) => Boolean(value)),
    ),
    diagnosis: {
      ...(short(thread.diagnosis.type, 80) ? { type: short(thread.diagnosis.type, 80) } : {}),
      ...(short(thread.diagnosis.summary, 200) ? { summary: short(thread.diagnosis.summary, 200) } : {}),
      confidence: thread.diagnosis.confidence,
    },
    ...(compactTransferRule(thread.transferRule) ? { transferRule: compactTransferRule(thread.transferRule) } : {}),
    status: thread.status,
  };
}

function compactRecord(record: MemoryRecord): Record<string, unknown> {
  const compact = {
    kind: record.kind,
    source: record.source,
    scope: record.scope,
    status: record.status,
    active: record.active,
    ...(short(record.summary, 220) ? { summary: short(record.summary, 220) } : {}),
    ...(short(record.content, 220) ? { content: short(record.content, 220) } : {}),
    // Thread semantics are carried once in the dedicated activeThreads
    // channel. Repeating the full thread inside each memory wastes most of the
    // context budget and can crowd out a user correction.
    claims: record.claims.slice(0, 3).map((claim) => ({
      type: claim.type,
      ...(short(claim.content, 160) ? { content: short(claim.content, 160) } : {}),
      verification: claim.verification,
    })),
    ...(record.verdict ? {
      verdict: {
        type: record.verdict.type,
        confidence: record.verdict.confidence,
        ...(short(record.verdict.explanation, 180) ? { explanation: short(record.verdict.explanation, 180) } : {}),
      },
    } : {}),
    ...(compactTransferRule(record.transferRule) ? { transferRule: compactTransferRule(record.transferRule) } : {}),
    ...(record.preference && AGENT_PREFERENCE_KEYS.has(record.preference.key) ? {
      preference: {
        key: record.preference.key,
        value: record.preference.value,
        ...(short(record.preference.label, 100) ? { label: short(record.preference.label, 100) } : {}),
      },
    } : {}),
    inferences: record.inferences.slice(0, 3).map((inference) => ({
      ...(short(inference.summary, 180) ? { summary: short(inference.summary, 180) } : {}),
      confidence: inference.confidence,
    })),
    advice: record.advice.slice(0, 3).map((advice) => ({
      ...(short(advice.when, 120) ? { when: short(advice.when, 120) } : {}),
      ...(short(advice.do, 160) ? { do: short(advice.do, 160) } : {}),
      ...(short(advice.unless, 120) ? { unless: short(advice.unless, 120) } : {}),
      confidence: advice.confidence,
    })),
  };
  return compact;
}

function approximateTokens(value: unknown): number {
  try {
    return Math.ceil(JSON.stringify(value).length / AGENT_BRIEF_CHARS_PER_TOKEN);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Converts the full domain brief into the identity-free projection accepted by
 * Coach Agent. It is deliberately separate from `buildUserMemoryBrief`: the
 * management surface can retain its bounded record metadata while the Agent
 * receives only teaching semantics and a deterministic context budget.
 */
export function buildAgentMemoryBrief(input: UserMemoryBrief): Record<string, unknown> {
  // Provider/transport briefs are already schema-checked, but they may be
  // stale (for example an environment override surviving a deletion). Keep a
  // second projection boundary here so terminal or session-scoped data can
  // never reach the Agent merely because it has a valid wire shape.
  const activeMemoryStatuses = new Set(["OBSERVED", "REPEATED", "IMPROVING", "STABLE", "EMERGING", "ACTIVE", "CONFIRMED"]);
  const activeThreadStatuses = new Set(["OPEN", "TAUGHT", "UNDERSTOOD", "APPLIED_ONCE", "REPEATED", "STABLE"]);
  // Only the bounded teaching controls are meaningful to the Agent. Keep
  // extensible/management-only preference keys (which could contain an
  // email, handle or other stable identifier) on the user-facing domain
  // brief, but never forward them across the Agent seam.
  const eligibleMemories = input.memories.filter((record) =>
    record.scope === "CROSS_DEMO" && record.active && !record.preference &&
    record.kind !== "PROFILE" && !record.profile &&
    !["PREFERENCE", "COACHING_PREFERENCE"].includes(record.kind) && activeMemoryStatuses.has(record.status),
  );
  // Corrections are a separate teaching channel: a DISPUTED aggregate is
  // intentionally absent from active memories, but its user correction must
  // remain visible so the next session can revisit it. Only suppress a
  // correction when the provider explicitly identifies its target as a
  // DELETED aggregate.
  const deletedMemoryIds = new Set(input.memories
    .filter((record) => record.status === "DELETED")
    .map((record) => record.memoryId));
  const eligibleThreads = input.activeThreads.filter((thread) =>
    thread.scope === "CROSS_DEMO" && activeThreadStatuses.has(thread.status),
  );
  const candidate: Record<string, unknown> = {
    schemaVersion: MEMORY_BRIEF_VERSION,
    generatedAt: input.generatedAt,
    preferences: Object.fromEntries(Object.entries(input.preferences ?? {})
      .filter(([key]) => AGENT_PREFERENCE_KEYS.has(key))
      .slice(0, 8)
      .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 100) : value])),
    activeThreads: eligibleThreads.slice(0, MAX_BRIEF_THREADS).map(compactThread),
    memories: eligibleMemories.slice(0, MAX_BRIEF_MEMORIES).map(compactRecord),
    corrections: input.corrections.filter((correction) => !deletedMemoryIds.has(correction.memoryId)).slice(0, MAX_BRIEF_CORRECTIONS).map((correction) => ({
      content: short(correction.content, 220) ?? "",
      source: "USER",
      revision: correction.revision,
    })),
    limitations: input.limitations.map((limitation) => short(limitation, 180)).filter((value): value is string => Boolean(value)).slice(0, 8),
    source: input.source,
    ...(input.structuredStatus ? { structuredStatus: input.structuredStatus } : {}),
    ...(input.semanticStatus ? { semanticStatus: input.semanticStatus } : {}),
  };

  // Remove the least important sections first if an unusually verbose record
  // still exceeds the target. Every result remains a valid top-level brief.
  if (approximateTokens(candidate) > MAX_AGENT_MEMORY_BRIEF_TOKENS) {
    candidate.corrections = (candidate.corrections as unknown[]).slice(0, 1);
  }
  if (approximateTokens(candidate) > MAX_AGENT_MEMORY_BRIEF_TOKENS) {
    candidate.memories = (candidate.memories as unknown[]).slice(0, 1);
  }
  if (approximateTokens(candidate) > MAX_AGENT_MEMORY_BRIEF_TOKENS) {
    candidate.activeThreads = (candidate.activeThreads as unknown[]).slice(0, 1);
  }
  if (approximateTokens(candidate) > MAX_AGENT_MEMORY_BRIEF_TOKENS) {
    candidate.limitations = (candidate.limitations as string[]).slice(0, 2);
  }
  if (approximateTokens(candidate) > MAX_AGENT_MEMORY_BRIEF_TOKENS) {
    candidate.preferences = Object.fromEntries(Object.entries(candidate.preferences as Record<string, unknown>).slice(0, 4));
  }
  if (approximateTokens(candidate) > MAX_AGENT_MEMORY_BRIEF_TOKENS) {
    return {
      schemaVersion: MEMORY_BRIEF_VERSION,
      generatedAt: input.generatedAt,
      preferences: {},
      activeThreads: [],
      memories: [],
      corrections: [],
      limitations: ["Memory brief was trimmed to the safe teaching context budget."],
      source: "EMPTY",
      structuredStatus: input.structuredStatus ?? "UNAVAILABLE",
      semanticStatus: input.semanticStatus ?? "OPTIONAL",
    };
  }
  return candidate;
}

export function approximateMemoryBriefTokens(value: unknown): number {
  return approximateTokens(value);
}

/** Builds a read-only, hard-bounded projection suitable for agent input. */
export function buildUserMemoryBrief(input: MemoryBriefBuildInput): UserMemoryBrief {
  // A disputed projection is deliberately not presented as an active memory.
  // Its user correction is still copied into the separate, bounded correction
  // channel below so the next teaching pass can ask the right question.
  const candidates = uniqueBy(
    [...input.records, ...(input.semanticRecords ?? [])]
      .filter((record) => record.active && !record.preference && !["PREFERENCE", "COACHING_PREFERENCE"].includes(record.kind) &&
        !["DELETED", "DISPUTED", "SUPERSEDED", "ARCHIVED", "RESOLVED"].includes(record.status))
      .sort((left, right) => statusWeight(right.status) - statusWeight(left.status) || right.updatedAt.localeCompare(left.updatedAt)),
    (record) => record.logicalKey,
    MAX_BRIEF_MEMORIES,
  );
  const threadCandidates = uniqueBy(
    [
      ...(input.threads ?? []),
      ...input.records.map(toCrossDemoThread).filter((thread): thread is LearningThread => Boolean(thread)),
    ].filter((thread) => thread.scope === "CROSS_DEMO" &&
      ["OPEN", "TAUGHT", "UNDERSTOOD", "APPLIED_ONCE", "REPEATED", "STABLE"].includes(thread.status)),
    (thread) => thread.threadId,
    MAX_BRIEF_THREADS,
  );
  const corrections = copyCorrections([...input.records, ...(input.semanticRecords ?? [])]);
  const preferenceRecords = [
    ...(input.preferenceRecords ?? []),
    ...input.records,
    ...(input.semanticRecords ?? []),
  ]
    .filter((record) => record.preference && !["DELETED", "DISPUTED", "SUPERSEDED", "ARCHIVED", "RESOLVED"].includes(record.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const preferences: Record<string, string | number | boolean> = {};
  for (const record of preferenceRecords) {
    const preference = record.preference;
    if (!preference || preference.key in preferences) continue;
    preferences[preference.key] = preference.value;
    if (Object.keys(preferences).length >= 8) break;
  }
  const limitations = [...new Set([...(input.limitations ?? []), ...(input.semanticRecords ? [] : [])])]
    .map((value) => value.replace(/\s+/g, " ").trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 16);
  const brief: UserMemoryBrief = {
    schemaVersion: MEMORY_BRIEF_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    preferences,
    activeThreads: threadCandidates,
    memories: candidates,
    corrections,
    limitations,
    source: input.semanticRecords?.length
      ? "STRUCTURED_PLUS_SEMANTIC"
      : candidates.length || threadCandidates.length || Object.keys(preferences).length || corrections.length
        ? "STRUCTURED"
        : "EMPTY",
    structuredStatus: input.structuredStatus ?? (input.records.length ? "AVAILABLE" : "EMPTY"),
    semanticStatus: input.semanticStatus ?? (input.semanticRecords?.length ? "USED" : "OPTIONAL"),
  };
  return MemoryBriefSchema.parse(brief) as unknown as UserMemoryBrief;
}

export const buildMemoryBrief = buildUserMemoryBrief;
