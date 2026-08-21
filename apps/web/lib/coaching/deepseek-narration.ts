/** @deprecated Legacy decision-only report adapter; /api/coaching/narrate uses deepseek-narrator.ts. */
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CUES = 32;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 12;
const MAX_TEXT_LENGTH = 1600;
const MAX_TITLE_LENGTH = 120;
export const DEEPSEEK_PROMPT_VERSION = "deepseek-cue-narration/1.2.0";
const EXPLICIT_TICK_PATTERN = /(?:\bticks?\s*(?:[:=#-]|\s)\s*\d+\b|第\s*\d+\s*(?:tick|帧|刻)|(?:tick|帧|刻)\s*[:=#-]?\s*\d+)/i;
const EXPLICIT_URL_PATTERN = /(?:https?:\/\/|file:\/\/|data:|mailto:)/i;
const ABS_UNIX_PATH_PATTERN = /\/(?:Users|home|tmp|var|private|Volumes)\/[^\s"'，。；;）】)}]+/i;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:[\\/][^\s"'，。；;）】)}]+/i;
const SENSITIVE_FILE_PATH_PATTERN = /(?:[\w.-]+[\\/])+[\w.-]+\.(?:dem|json|replay|log|txt)\b/i;
const COORDINATE_PATTERN = /(?:\b[xyz]\s*[:=]\s*-?\d+(?:\.\d+)?\b|\b(?:x|y|z)\s*-?\d+(?:\.\d+)?\b|\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)?\s*\)|\bcoordinates?\b|坐标)/i;
const OUTCOME_PATTERN = /(?:\b(?:result|outcome|afterwards|subsequently|eventually|ultimately|death|died|killed|won|lost)\b|随后被击杀|随后死亡|最终死亡|已经死亡|死亡后|回合结果|结果是|赢下本回合|输掉本回合|赢得回合)/i;
const STABLE_ID_PATTERN = /(?:\b7656119\d{10}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b(?:player|user|demo|match|session|steam)[_:.\-][A-Za-z0-9_-]+\b)/i;
const QUESTION_PROMPT_PATTERN = /(?:你会怎么做|请选择|猜一猜|先回答|what would you do|please choose|guess what|answer first)/i;
const LOWERCASE_INTERNAL_ALIAS_PATTERN = /\b(?:f|i|a|r)\d{1,3}\b/;

const ALLOWED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const ALLOWED_CUE_TYPES = new Set(["DECISION", "HABIT_RECHECK"]);

export type NarrationStatus = "SUCCEEDED" | "FALLBACK" | "DISABLED";

export interface NarrationFact {
  id: string;
  text: string;
  availability: "DECISION";
  observed_by_player: boolean;
}

export interface NarrationInference {
  id: string;
  text: string;
  confidence: number;
  fact_refs: string[];
}

export interface NarrationAdvice {
  id: string;
  text: string;
  trigger: string;
  fact_refs: string[];
  rule_id?: string | null;
}

export interface NarrationCueInput {
  cue_id: string;
  cue_type: "DECISION" | "HABIT_RECHECK";
  facts: NarrationFact[];
  inferences: NarrationInference[];
  advice: NarrationAdvice[];
  limitations: string[];
}

export interface NarrationRequest {
  cues: NarrationCueInput[];
}

export interface NarrationItem {
  cue_id: string;
  title: string;
  explanation: string;
}

export interface NarrationResult {
  status: NarrationStatus;
  items: NarrationItem[];
  model?: string;
  manifest?: {
    model: string;
    prompt_version: string;
  };
  reason?: string;
}

export interface DeepSeekEnv {
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown };
  }>;
}

interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export class NarrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarrationValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type IdKind = "cue" | "fact" | "inference" | "advice" | "rule";

const ID_PATTERNS: Record<IdKind, RegExp> = {
  cue: /^c(?:[1-9]|[12][0-9]|3[0-2])$/,
  fact: /^f[1-9][0-9]{0,2}$/,
  inference: /^i[1-9][0-9]{0,2}$/,
  advice: /^a[1-9][0-9]{0,2}$/,
  rule: /^r[1-9][0-9]{0,2}$/
};

function isTypedId(value: unknown, kind: IdKind): value is string {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH && ID_PATTERNS[kind].test(value);
}

function hasUnsafeInputText(text: string): boolean {
  return EXPLICIT_TICK_PATTERN.test(text)
    || EXPLICIT_URL_PATTERN.test(text)
    || ABS_UNIX_PATH_PATTERN.test(text)
    || WINDOWS_PATH_PATTERN.test(text)
    || SENSITIVE_FILE_PATH_PATTERN.test(text)
    || COORDINATE_PATTERN.test(text)
    || OUTCOME_PATTERN.test(text)
    || STABLE_ID_PATTERN.test(text)
    || QUESTION_PROMPT_PATTERN.test(text);
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !hasUnsafeInputText(value);
}

function hasUnsafeNarrationOutput(text: string): boolean {
  return hasUnsafeInputText(text) || LOWERCASE_INTERNAL_ALIAS_PATTERN.test(text);
}

function validateFact(value: unknown): NarrationFact {
  if (!isRecord(value) || Object.keys(value).some((key) => !["id", "text", "availability", "observed_by_player"].includes(key))) {
    throw new NarrationValidationError("fact fields are not allowed");
  }
  if (!isTypedId(value.id, "fact") || !isSafeText(value.text, MAX_TEXT_LENGTH) || value.availability !== "DECISION" || value.observed_by_player !== true) {
    throw new NarrationValidationError("invalid decision fact");
  }
  return {
    id: value.id,
    text: value.text,
    availability: "DECISION",
    observed_by_player: true
  };
}

function validateInference(value: unknown): NarrationInference {
  if (!isRecord(value) || Object.keys(value).some((key) => !["id", "text", "confidence", "fact_refs"].includes(key))) {
    throw new NarrationValidationError("inference fields are not allowed");
  }
  if (!isTypedId(value.id, "inference") || !isSafeText(value.text, MAX_TEXT_LENGTH) || typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 || !Array.isArray(value.fact_refs) || !value.fact_refs.every((ref) => isTypedId(ref, "fact"))) {
    throw new NarrationValidationError("invalid inference");
  }
  return {
    id: value.id,
    text: value.text,
    confidence: value.confidence,
    fact_refs: [...value.fact_refs]
  };
}

function validateAdvice(value: unknown): NarrationAdvice {
  if (!isRecord(value) || Object.keys(value).some((key) => !["id", "text", "trigger", "fact_refs", "rule_id"].includes(key))) {
    throw new NarrationValidationError("advice fields are not allowed");
  }
  if (!isTypedId(value.id, "advice") || !isSafeText(value.text, MAX_TEXT_LENGTH) || !isSafeText(value.trigger, MAX_TEXT_LENGTH) || !Array.isArray(value.fact_refs) || !value.fact_refs.every((ref) => isTypedId(ref, "fact")) || (value.rule_id !== undefined && value.rule_id !== null && !isTypedId(value.rule_id, "rule"))) {
    throw new NarrationValidationError("invalid advice");
  }
  return {
    id: value.id,
    text: value.text,
    trigger: value.trigger,
    fact_refs: [...value.fact_refs],
    ...(value.rule_id === undefined ? {} : { rule_id: value.rule_id as string | null })
  };
}

function validateCue(value: unknown): NarrationCueInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !["cue_id", "cue_type", "facts", "inferences", "advice", "limitations"].includes(key))) {
    throw new NarrationValidationError("cue fields are not allowed");
  }
  if (!isTypedId(value.cue_id, "cue") || typeof value.cue_type !== "string" || !ALLOWED_CUE_TYPES.has(value.cue_type) || !Array.isArray(value.facts) || !Array.isArray(value.inferences) || !Array.isArray(value.advice) || !Array.isArray(value.limitations) || !value.limitations.every((item) => isSafeText(item, MAX_TEXT_LENGTH))) {
    throw new NarrationValidationError("invalid cue");
  }
  const facts = value.facts.map(validateFact);
  const factIds = new Set(facts.map((fact) => fact.id));
  if (factIds.size !== facts.length) throw new NarrationValidationError("fact IDs must be unique within a cue");
  const inferences = value.inferences.map(validateInference);
  const advice = value.advice.map(validateAdvice);
  if (new Set(inferences.map((item) => item.id)).size !== inferences.length) throw new NarrationValidationError("inference IDs must be unique within a cue");
  if (new Set(advice.map((item) => item.id)).size !== advice.length) throw new NarrationValidationError("advice IDs must be unique within a cue");
  for (const item of [...inferences, ...advice]) {
    if (!item.fact_refs.every((factRef) => factIds.has(factRef))) {
      throw new NarrationValidationError("cue reference escapes supplied facts");
    }
  }
  return {
    cue_id: value.cue_id,
    cue_type: value.cue_type as NarrationCueInput["cue_type"],
    facts,
    inferences,
    advice,
    limitations: [...value.limitations]
  };
}

export function parseNarrationRequest(value: unknown, byteLength = 0): NarrationRequest {
  if (byteLength > MAX_REQUEST_BYTES) throw new NarrationValidationError("request too large");
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "cues") || !Array.isArray(value.cues) || value.cues.length === 0 || value.cues.length > MAX_CUES) {
    throw new NarrationValidationError("request must contain 1 to 32 cues");
  }
  const cues = value.cues.map(validateCue);
  const ids = cues.map((cue) => cue.cue_id);
  if (new Set(ids).size !== ids.length) throw new NarrationValidationError("cue IDs must be unique");
  return { cues };
}

function providerPayload(request: NarrationRequest): Record<string, unknown> {
  return {
    cues: request.cues.map((cue) => ({
      cue_id: cue.cue_id,
      cue_type: cue.cue_type,
      facts: cue.facts,
      inferences: cue.inferences,
      advice: cue.advice,
      limitations: cue.limitations
    }))
  };
}

function systemPrompt(): string {
  return [
    "You are a CS2 coaching narration adapter.",
    "Return JSON only. The top-level object must contain exactly one key named items; never name it cues.",
    "Each item must contain exactly cue_id, title, and explanation, with exactly one item per supplied cue.",
    'Exact JSON shape example: {"items":[{"cue_id":"c1","title":"简短标题","explanation":"简短讲解"}]}.',
    "Use only the supplied decision-time facts, inferences, advice and limitations.",
    "Do not add players, identities, positions, ticks, outcomes, voice comms, paths, files, demos or citations.",
    "Write natural Simplified Chinese and retain supplied map callouts.",
    "Sound like an experienced CS2 player or streamer: keep it short, concrete and conversational; avoid academic or report-like wording.",
    "State what the player should do now and why. Prefer supplied callouts such as B小、警家、中路 and familiar terms such as 架枪、预瞄、拉出去、补枪、头甲、eco、磕枪、换位 when the supplied material supports them.",
    "Do not replace concrete actions with abstractions such as 空间控制、资源关系、风险暴露 or 决策窗口.",
    "Never invent a callout, teammate comm, enemy location, crossfire, trade setup, rotation or save condition that is not supplied.",
    "Speak directly: state the coaching judgment and its reason; do not ask the user to predict, choose, guess or answer first.",
    "Do not change the advice semantics; make the wording concise, direct and honest about uncertainty."
  ].join(" ");
}

function extractItems(value: unknown, expectedIds: string[]): NarrationItem[] {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.items) || value.items.length !== expectedIds.length) {
    throw new NarrationValidationError("provider response shape is invalid");
  }
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const items = value.items.map((item): NarrationItem => {
    if (!isRecord(item) || Object.keys(item).some((key) => !["cue_id", "title", "explanation"].includes(key)) || Object.keys(item).length !== 3 || !isTypedId(item.cue_id, "cue") || !expected.has(item.cue_id) || seen.has(item.cue_id) || !isSafeText(item.title, MAX_TITLE_LENGTH) || !isSafeText(item.explanation, MAX_TEXT_LENGTH) || hasUnsafeNarrationOutput(item.title) || hasUnsafeNarrationOutput(item.explanation)) {
      throw new NarrationValidationError("provider response contains invalid fields or cue IDs");
    }
    seen.add(item.cue_id);
    return { cue_id: item.cue_id, title: item.title.trim(), explanation: item.explanation.trim() };
  });
  if (seen.size !== expected.size) throw new NarrationValidationError("provider response cue IDs do not match request");
  return items;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new NarrationValidationError("provider response is not JSON");
  }
}

export async function narrateWithDeepSeek(
  request: NarrationRequest,
  env: DeepSeekEnv,
  fetcher: FetchLike = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<NarrationResult> {
  let safeRequest: NarrationRequest;
  try {
    const serialized = JSON.stringify(request);
    const byteLength = new TextEncoder().encode(serialized).byteLength;
    safeRequest = parseNarrationRequest(request, byteLength);
  } catch {
    return { status: "FALLBACK", items: [], reason: "INVALID_REQUEST" };
  }
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return { status: "DISABLED", items: [], reason: "MISSING_API_KEY" };
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
  if (!ALLOWED_MODELS.has(model)) return { status: "FALLBACK", items: [], reason: "MODEL_NOT_ALLOWED" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(DEEPSEEK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: JSON.stringify(providerPayload(safeRequest)) }
        ],
        temperature: 0.2,
        max_tokens: 2400,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" }
      })
    });
    if (!response.ok) return { status: "FALLBACK", items: [], model, reason: "UPSTREAM_HTTP" };
    const payload = await readJson(response) as ChatCompletionResponse;
    const choice = payload.choices?.[0];
    if (!choice || choice.finish_reason !== "stop" || typeof choice.message?.content !== "string") {
      return { status: "FALLBACK", items: [], model, reason: "UPSTREAM_FINISH" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(choice.message.content);
    } catch {
      return { status: "FALLBACK", items: [], model, reason: "UPSTREAM_JSON" };
    }
    const items = extractItems(parsed, safeRequest.cues.map((cue) => cue.cue_id));
    return {
      status: "SUCCEEDED",
      items,
      model,
      manifest: { model, prompt_version: DEEPSEEK_PROMPT_VERSION }
    };
  } catch (error) {
    if (error instanceof NarrationValidationError) return { status: "FALLBACK", items: [], model, reason: "UPSTREAM_SCHEMA" };
    return { status: "FALLBACK", items: [], model, reason: error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "UPSTREAM_ERROR" };
  } finally {
    clearTimeout(timeout);
  }
}

export const narrationLimits = {
  maxCues: MAX_CUES,
  maxRequestBytes: MAX_REQUEST_BYTES,
  allowedModels: [...ALLOWED_MODELS]
} as const;
