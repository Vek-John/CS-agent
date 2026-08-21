import type {
  CandidateSet,
  DirectorDecision,
  DirectorDecisionSet,
  DirectorRequest,
  CandidateSignalKind,
  CandidateResultSummary
} from "@cs-coach/contracts";
import {
  buildDirectorRequest,
  deterministicDirectorFallback
} from "@cs-coach/review-planner";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 32;
const MAX_REQUEST_BYTES = 48 * 1024;
const ALLOWED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
export const DEEPSEEK_DIRECTOR_PROMPT_VERSION = "deepseek-teaching-director/1.0.1";

export interface DirectorProviderCandidate {
  candidate_id: string;
  source_kind: CandidateSignalKind;
  deterministic_score: number;
  missing_fields: string[];
  limitations: string[];
  reason_refs: string[];
  evidence_refs: string[];
  result_summary: CandidateResultSummary;
  allowed_focus_codes: string[];
}

export interface DirectorProviderRequest {
  candidate_set_id: string;
  candidate_set_version: string;
  candidate_set_hash: string;
  candidates: DirectorProviderCandidate[];
  max_selected: number;
}

export interface DirectorProviderDecision {
  candidate_id: string;
  priority: number;
  primary_focus_code: string;
  selection_reason: string;
  reason_refs: string[];
  evidence_refs: string[];
  confidence: number;
}

export interface DirectorProviderResult {
  status: "SUCCEEDED" | "FALLBACK" | "DISABLED";
  selected: DirectorProviderDecision[];
  model?: string;
  reason?: string;
  manifest: {
    model?: string;
    prompt_version: string;
    status: "SUCCEEDED" | "FALLBACK" | "DISABLED";
    limitations: string[];
  };
}

interface DirectorRequestMapping {
  candidateByAlias: Record<string, {
    candidateId: string;
    reasonByAlias: Record<string, string>;
    evidenceByAlias: Record<string, string>;
  }>;
}

export interface DirectorProviderRequestContext {
  request: DirectorProviderRequest;
  mapping: DirectorRequestMapping;
}

export interface DeepSeekDirectorEnv {
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
}

interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export class DirectorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectorValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function alias(value: unknown, prefix: "c" | "r" | "e"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}\\d{1,3}$`).test(value);
}

function safeText(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/\b(?:tick|frame|segment|route|order)\b/i.test(value);
}

function parseProviderCandidate(value: unknown): DirectorProviderCandidate {
  if (!isRecord(value) || !exactKeys(value, ["candidate_id", "source_kind", "deterministic_score", "missing_fields", "limitations", "reason_refs", "evidence_refs", "result_summary", "allowed_focus_codes"])) throw new DirectorValidationError("Director candidate summary shape is invalid.");
  if (!alias(value.candidate_id, "c") || !["DEATH", "KILL", "BOMB", "UTILITY", "HP_CHANGE", "WIN_RATE_DROP"].includes(String(value.source_kind)) || !finite(value.deterministic_score) || !Array.isArray(value.missing_fields) || !Array.isArray(value.limitations) || !Array.isArray(value.reason_refs) || !Array.isArray(value.evidence_refs) || !isRecord(value.result_summary) || !Array.isArray(value.allowed_focus_codes)) throw new DirectorValidationError("Director candidate summary contains invalid fields.");
  if (!value.missing_fields.every((item) => typeof item === "string") || !value.limitations.every((item) => typeof item === "string") || !value.reason_refs.every((item) => alias(item, "r")) || !value.evidence_refs.every((item) => alias(item, "e")) || !value.allowed_focus_codes.every((item) => typeof item === "string" && item.length <= 120)) throw new DirectorValidationError("Director candidate summary contains invalid refs or focus codes.");
  const summary = value.result_summary;
  if (typeof summary.selectedPlayerDeath !== "boolean" || !["PISTOL", "ECO", "FORCE", "FULL", "UNKNOWN"].includes(String(summary.economyClass)) || typeof summary.concurrentEvents !== "boolean" || !Array.isArray(summary.missingFields) || !Array.isArray(summary.limitations)) throw new DirectorValidationError("Director result summary is invalid.");
  return {
    candidate_id: value.candidate_id,
    source_kind: value.source_kind as CandidateSignalKind,
    deterministic_score: value.deterministic_score,
    missing_fields: [...value.missing_fields],
    limitations: [...value.limitations],
    reason_refs: [...value.reason_refs],
    evidence_refs: [...value.evidence_refs],
    result_summary: summary as unknown as CandidateResultSummary,
    allowed_focus_codes: [...value.allowed_focus_codes]
  };
}

export function parseDirectorRequest(value: unknown, byteLength = 0): DirectorProviderRequest {
  if (byteLength > MAX_REQUEST_BYTES) throw new DirectorValidationError("Director request is too large.");
  if (!isRecord(value) || !exactKeys(value, ["candidate_set_id", "candidate_set_version", "candidate_set_hash", "candidates", "max_selected"])) throw new DirectorValidationError("Director request shape is invalid.");
  const rawMaxSelected = value.max_selected;
  if (!nonEmpty(value.candidate_set_id) || !nonEmpty(value.candidate_set_version) || !nonEmpty(value.candidate_set_hash) || !Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES || typeof rawMaxSelected !== "number" || !Number.isInteger(rawMaxSelected) || rawMaxSelected < 0 || rawMaxSelected > 8) throw new DirectorValidationError("Director request contains invalid bounds.");
  const maxSelected = rawMaxSelected;
  const candidates = value.candidates.map(parseProviderCandidate);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.candidate_id)) throw new DirectorValidationError("Director request contains duplicate candidate aliases.");
    seen.add(candidate.candidate_id);
  }
  return {
    candidate_set_id: value.candidate_set_id,
    candidate_set_version: value.candidate_set_version,
    candidate_set_hash: value.candidate_set_hash,
    candidates,
    max_selected: maxSelected
  };
}

function parseProviderDecision(
  value: unknown,
  expectedCandidates: Set<string>,
  allowedRefs?: Record<string, { reasonRefs: ReadonlySet<string>; evidenceRefs: ReadonlySet<string> }>,
  allowedFocusCodes?: Record<string, ReadonlySet<string>>
): DirectorProviderDecision {
  if (!isRecord(value) || !exactKeys(value, ["candidate_id", "priority", "primary_focus_code", "selection_reason", "reason_refs", "evidence_refs", "confidence"])) throw new DirectorValidationError("Director decision shape is invalid.");
  if (!alias(value.candidate_id, "c") || !expectedCandidates.has(value.candidate_id) || !finite(value.priority) || value.priority < 0 || !safeText(value.primary_focus_code, 120) || !safeText(value.selection_reason, 800) || !Array.isArray(value.reason_refs) || !Array.isArray(value.evidence_refs) || !finite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new DirectorValidationError("Director decision contains invalid fields.");
  if (!value.reason_refs.every((ref) => alias(ref, "r")) || !value.evidence_refs.every((ref) => alias(ref, "e"))) throw new DirectorValidationError("Director decision contains invalid refs.");
  const decision = {
    candidate_id: value.candidate_id,
    priority: value.priority,
    primary_focus_code: value.primary_focus_code.trim(),
    selection_reason: value.selection_reason.trim(),
    reason_refs: [...value.reason_refs],
    evidence_refs: [...value.evidence_refs],
    confidence: value.confidence
  };
  const allowed = allowedRefs?.[decision.candidate_id];
  if (allowed && (decision.reason_refs.some((ref) => !allowed.reasonRefs.has(ref)) || decision.evidence_refs.some((ref) => !allowed.evidenceRefs.has(ref)))) throw new DirectorValidationError("Director decision references an unknown or cross-candidate ref.");
  if (allowedFocusCodes?.[decision.candidate_id] && !allowedFocusCodes[decision.candidate_id].has(decision.primary_focus_code)) throw new DirectorValidationError("Director decision uses an unallowlisted primary_focus_code.");
  return decision;
}

export function parseDirectorResponse(
  value: unknown,
  expectedCandidateAliases: readonly string[],
  allowedRefs?: Record<string, { reasonRefs: ReadonlySet<string>; evidenceRefs: ReadonlySet<string> }>,
  allowedFocusCodes?: Record<string, ReadonlySet<string>>
): DirectorProviderDecision[] {
  if (!isRecord(value) || !exactKeys(value, ["selected"]) || !Array.isArray(value.selected) || value.selected.length > 8) throw new DirectorValidationError("Director response must contain exactly selected[].");
  const expected = new Set(expectedCandidateAliases);
  const seen = new Set<string>();
  const selected = value.selected.map((item) => parseProviderDecision(item, expected, allowedRefs, allowedFocusCodes));
  for (const decision of selected) {
    if (seen.has(decision.candidate_id)) throw new DirectorValidationError("Director response contains a duplicate candidate.");
    seen.add(decision.candidate_id);
  }
  return selected;
}

function focusFor(kind: CandidateSignalKind): string {
  return kind === "DEATH" ? "SURVIVE_THE_NEXT_CONTACT" : kind === "KILL" ? "CONVERT_ADVANTAGE" : kind === "BOMB" ? "OBJECTIVE_TIMING" : kind === "UTILITY" ? "UTILITY_PURPOSE_AND_TEMPO" : kind === "WIN_RATE_DROP" ? "WIN_PROBABILITY_SWING_RESPONSE" : "SURVIVE_CONTACT";
}

export function buildDirectorProviderRequestContext(set: CandidateSet, maxSelected = 8): DirectorProviderRequestContext {
  const source: DirectorRequest = buildDirectorRequest(set, maxSelected);
  const candidateByAlias: DirectorRequestMapping["candidateByAlias"] = {};
  const candidates = source.candidates.map((summary, index) => {
    const candidateAlias = `c${index + 1}`;
    const reasonByAlias: Record<string, string> = {};
    const evidenceByAlias: Record<string, string> = {};
    summary.reasonRefs.forEach((ref, refIndex) => { reasonByAlias[`r${refIndex + 1}`] = ref; });
    summary.evidenceRefs.forEach((ref, refIndex) => { evidenceByAlias[`e${refIndex + 1}`] = ref; });
    candidateByAlias[candidateAlias] = { candidateId: summary.candidateId, reasonByAlias, evidenceByAlias };
    return {
      candidate_id: candidateAlias,
      source_kind: summary.sourceKind,
      deterministic_score: summary.deterministicScore,
      missing_fields: [...summary.missingFields],
      limitations: [...summary.limitations],
      reason_refs: Object.keys(reasonByAlias),
      evidence_refs: Object.keys(evidenceByAlias),
      result_summary: summary.resultSummary,
      allowed_focus_codes: [...summary.allowedFocusCodes]
    } satisfies DirectorProviderCandidate;
  });
  return {
    request: {
      candidate_set_id: "candidate-set-anonymous",
      candidate_set_version: source.candidateSetVersion,
      candidate_set_hash: source.candidateSetHash,
      candidates,
      max_selected: source.maxSelected
    },
    mapping: { candidateByAlias }
  };
}

function fallbackProviderResult(request: DirectorProviderRequest, reason: string): DirectorProviderResult {
  const selected = [...request.candidates].sort((left, right) => right.deterministic_score - left.deterministic_score || left.candidate_id.localeCompare(right.candidate_id)).slice(0, request.max_selected).map((candidate, index) => ({
    candidate_id: candidate.candidate_id,
    priority: index + 1,
    primary_focus_code: focusFor(candidate.source_kind),
    selection_reason: "模型不可用，按确定性候选分数回退。",
    reason_refs: candidate.reason_refs.slice(0, 3),
    evidence_refs: candidate.evidence_refs.slice(0, 3),
    confidence: candidate.deterministic_score >= 5 ? 0.72 : 0.55
  }));
  return {
    status: request.candidates.length === 0 ? "DISABLED" : "FALLBACK",
    selected,
    reason,
    manifest: { prompt_version: DEEPSEEK_DIRECTOR_PROMPT_VERSION, status: request.candidates.length === 0 ? "DISABLED" : "FALLBACK", limitations: [reason] }
  };
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new DirectorValidationError("Provider response is not JSON."); }
}

function systemPrompt(): string {
  return [
    "You are a provider-neutral CS2 Teaching Director.",
    "Return JSON only with exactly one top-level key selected.",
    "Select only supplied candidate aliases; never create candidates or refs.",
    "Do not echo candidate_set_id, candidate_set_version, candidate_set_hash, candidates, or max_selected in the response; do not use a selections key.",
    "The selected value must be an array of objects, and every object must contain exactly candidate_id, priority, primary_focus_code, selection_reason, reason_refs, evidence_refs, confidence.",
    "Shape example: {selected:[{candidate_id:'c1',priority:1,primary_focus_code:'SURVIVE_THE_NEXT_CONTACT',selection_reason:'...',reason_refs:['r1'],evidence_refs:['e1'],confidence:0.8}]}. reason_refs and evidence_refs must be arrays of supplied aliases.",
    "Each selection has exactly one primary_focus_code.",
    "Do not emit ticks, frames, segments, order, route, player identity, or final coaching prose.",
    "Keep selection_reason concise and grounded in supplied refs."
  ].join(" ");
}

export async function directWithDeepSeek(
  request: DirectorProviderRequest,
  env: DeepSeekDirectorEnv,
  fetcher: FetchLike = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<DirectorProviderResult> {
  let safeRequest: DirectorProviderRequest;
  try {
    safeRequest = parseDirectorRequest(request, new TextEncoder().encode(JSON.stringify(request)).byteLength);
  } catch {
    return fallbackProviderResult({ candidate_set_id: "invalid", candidate_set_version: "invalid", candidate_set_hash: "invalid", candidates: [], max_selected: 0 }, "INVALID_REQUEST");
  }
  const key = env.DEEPSEEK_API_KEY?.trim();
  if (!key) return fallbackProviderResult(safeRequest, "MISSING_API_KEY");
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
  if (!ALLOWED_MODELS.has(model)) return fallbackProviderResult(safeRequest, "MODEL_NOT_ALLOWED");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(DEEPSEEK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: JSON.stringify(safeRequest) }
        ],
        temperature: 0,
        max_tokens: 1800,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" }
      })
    });
    if (!response.ok) return fallbackProviderResult(safeRequest, "UPSTREAM_HTTP");
    const payload = await readJson(response);
    if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) || payload.choices[0].finish_reason !== "stop" || !isRecord(payload.choices[0].message) || typeof payload.choices[0].message.content !== "string") return fallbackProviderResult(safeRequest, "UPSTREAM_FINISH");
    let parsed: unknown;
    try { parsed = JSON.parse(payload.choices[0].message.content); } catch { return fallbackProviderResult(safeRequest, "UPSTREAM_JSON"); }
    const allowedRefs = Object.fromEntries(safeRequest.candidates.map((candidate) => [candidate.candidate_id, {
      reasonRefs: new Set(candidate.reason_refs),
      evidenceRefs: new Set(candidate.evidence_refs)
    }]));
    const allowedFocusCodes = Object.fromEntries(safeRequest.candidates.map((candidate) => [candidate.candidate_id, new Set(candidate.allowed_focus_codes)]));
    const selected = parseDirectorResponse(parsed, safeRequest.candidates.map((candidate) => candidate.candidate_id), allowedRefs, allowedFocusCodes);
    return { status: "SUCCEEDED", selected, model, manifest: { model, prompt_version: DEEPSEEK_DIRECTOR_PROMPT_VERSION, status: "SUCCEEDED", limitations: [] } };
  } catch (error) {
    return fallbackProviderResult(safeRequest, error instanceof DirectorValidationError ? "UPSTREAM_SCHEMA" : error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

export function mapDirectorProviderResult(
  set: CandidateSet,
  context: DirectorProviderRequestContext,
  result: DirectorProviderResult
): DirectorDecisionSet {
  if (result.status !== "SUCCEEDED") return deterministicDirectorFallback(set, result.reason ?? "DIRECTOR_FALLBACK", context.request.max_selected);
  const selected: DirectorDecision[] = result.selected.map((item) => {
    const binding = context.mapping.candidateByAlias[item.candidate_id];
    if (!binding) throw new DirectorValidationError("Provider result references an unknown candidate alias.");
    const reasonRefs = item.reason_refs.map((ref) => binding.reasonByAlias[ref]).filter((ref): ref is string => Boolean(ref));
    const evidenceRefs = item.evidence_refs.map((ref) => binding.evidenceByAlias[ref]).filter((ref): ref is string => Boolean(ref));
    return {
      candidateId: binding.candidateId,
      priority: item.priority,
      primaryFocusCode: item.primary_focus_code,
      selectionReason: item.selection_reason,
      reasonRefs,
      evidenceRefs,
      confidence: item.confidence
    };
  });
  return {
    candidateSetId: set.id,
    candidateSetVersion: set.version,
    candidateSetHash: set.hash,
    selected,
    manifest: { status: "SUCCEEDED", provider: "DEEPSEEK", model: result.model, promptVersion: result.manifest.prompt_version, limitations: result.manifest.limitations }
  };
}

export async function requestTeachingDirector(
  set: CandidateSet,
  options: { endpoint?: string; fetcher?: FetchLike; maxSelected?: number; signal?: AbortSignal } = {}
): Promise<DirectorDecisionSet> {
  if (set.candidates.length === 0) return deterministicDirectorFallback(set, "NO_CANDIDATES", options.maxSelected);
  const context = buildDirectorProviderRequestContext(set, options.maxSelected);
  const endpoint = options.endpoint ?? "/api/coaching/direct";
  try {
    const fetcher = options.fetcher ?? fetch;
    const response = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/json" }, ...(options.signal ? { signal: options.signal } : {}), body: JSON.stringify(context.request) });
    if (!response.ok) return deterministicDirectorFallback(set, `HTTP_${response.status}`, context.request.max_selected);
    const raw = await response.json() as unknown;
    const result = raw && typeof raw === "object" && "selected" in raw ? raw as DirectorProviderResult : fallbackProviderResult(context.request, "INVALID_RESPONSE");
    return mapDirectorProviderResult(set, context, result);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return deterministicDirectorFallback(set, error instanceof Error ? error.message : "DIRECTOR_REQUEST_FAILED", context.request.max_selected);
  }
}

export const directorLimits = {
  maxCandidates: MAX_CANDIDATES,
  maxRequestBytes: MAX_REQUEST_BYTES,
  allowedModels: [...ALLOWED_MODELS]
} as const;
