import { MAX_REQUEST_BYTES, NarratorValidationError, parseNarrationRequest, parseProviderBundle, fallbackBundle, isRecord, exactKeys } from "./narrator-validation";
export { NarratorValidationError, parseNarrationRequest } from "./narrator-validation";
import type { NarrationResult } from "@cs-coach/contracts";

import type { AnonymousNarrationRequest } from "./narrator-contract";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 15_000;
const ALLOWED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
export const DEEPSEEK_NARRATOR_PROMPT_VERSION = "deepseek-narration-bundle/2.0.0";

export interface DeepSeekNarratorEnv {
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_URL?: string;
  DEEPSEEK_ALLOW_EMPTY_KEY?: boolean;
}

interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

function fallbackResult(request: AnonymousNarrationRequest, reason: string, model?: string): NarrationResult {
  return {
    status: "FALLBACK",
    bundle: fallbackBundle(request),
    manifest: {
      status: "FALLBACK",
      provider: "DETERMINISTIC",
      ...(model ? { model } : {}),
      promptVersion: DEEPSEEK_NARRATOR_PROMPT_VERSION,
      reason,
      limitations: [reason]
    }
  };
}

function systemPrompt(): string {
  return [
    "You are a provider-neutral CS2 coaching narrator.",
    "Return JSON only with exactly one top-level key bundle.",
    "The bundle must contain exactly cueId, candidateId, primaryFocusCode, currentSituation, playerAction, coreIssue, betterPlay, outcomeImpact.",
    "Echo cueId=c1, candidateId=k1, and primaryFocusCode exactly; use only supplied anonymous refs.",
    "Every one of the five narration fields must be an object with exactly text and refs; never return a narration field as a bare string. refs must be a non-empty array of the supplied anonymous IDs.",
    "Shape example: currentSituation={text:'...',refs:['d1']}, playerAction={text:'...',refs:['a1']}, coreIssue={text:'...',refs:['d1','a1']}, betterPlay={text:'...',refs:['v1','e1']}, outcomeImpact={text:'...',refs:['o1','m1']}.",
    "currentSituation cites decision refs only; playerAction cites action refs only; coreIssue cites decision/action refs; betterPlay must cite an advice ref and may cite decision/action/advice/evidence refs; outcomeImpact cites outcome/measurement refs only.",
    "Every field is one short sentence. Use concise, direct Simplified Chinese CS player language; prefer架枪、预瞄、小身位 peek、补枪、eco、强起 and similar concrete terms.",
    "Never print primaryFocusCode or any uppercase taxonomy token in prose. Copy approvedNarration exactly when supplied. Each sentence is a closed, verified semantic projection; new wording or additional tactics will be rejected. When advice is unavailable, preserve uncertainty. Death and damage alone never establish decision error.",
    "Do not mention a win-rate percentage when the supplied impact is absent or rounds to zero percentage points.",
    "Do not invent a crosshair placement, callout, teammate intent, enemy position, or setup that was not supplied.",
    "Do not emit segment, order, route, tick, frame, player identity, raw replay, or new refs. Do not introduce a new coaching taxonomy or advice semantic."
  ].join(" ");
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new NarratorValidationError("Provider response is not JSON."); }
}

export async function narrateWithDeepSeek(
  request: AnonymousNarrationRequest,
  env: DeepSeekNarratorEnv,
  fetcher: FetchLike = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<NarrationResult> {
  let safeRequest: AnonymousNarrationRequest;
  try {
    const serialized = JSON.stringify(request);
    safeRequest = parseNarrationRequest(request, new TextEncoder().encode(serialized).byteLength);
  } catch {
    throw new NarratorValidationError("Invalid narration request.");
  }
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey && !env.DEEPSEEK_ALLOW_EMPTY_KEY) return fallbackResult(safeRequest, "MISSING_API_KEY");
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
  if (!env.DEEPSEEK_URL && !ALLOWED_MODELS.has(model)) return fallbackResult(safeRequest, "MODEL_NOT_ALLOWED", model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(env.DEEPSEEK_URL ?? DEEPSEEK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
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
    if (!response.ok) return fallbackResult(safeRequest, "UPSTREAM_HTTP", model);
    const payload = await readJson(response);
    if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) || payload.choices[0].finish_reason !== "stop" || !isRecord(payload.choices[0].message) || typeof payload.choices[0].message.content !== "string") return fallbackResult(safeRequest, "UPSTREAM_FINISH", model);
    let parsed: unknown;
    try { parsed = JSON.parse(payload.choices[0].message.content); } catch { return fallbackResult(safeRequest, "UPSTREAM_JSON", model); }
    if (!isRecord(parsed) || !exactKeys(parsed, ["bundle"])) return fallbackResult(safeRequest, "UPSTREAM_SCHEMA", model);
    const bundle = parseProviderBundle(parsed.bundle, safeRequest);
    return {
      status: "SUCCEEDED",
      bundle,
      manifest: { status: "SUCCEEDED", provider: "DEEPSEEK", model, promptVersion: DEEPSEEK_NARRATOR_PROMPT_VERSION, limitations: [] }
    };
  } catch (error) {
    return fallbackResult(safeRequest, error instanceof NarratorValidationError ? "UPSTREAM_SCHEMA" : error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "UPSTREAM_ERROR", model);
  } finally {
    clearTimeout(timeout);
  }
}

export const narrationLimits = {
  maxRequestBytes: MAX_REQUEST_BYTES,
  allowedModels: [...ALLOWED_MODELS]
} as const;
