import {
  PolicyInputSchema,
  PolicyOutputSchema,
  deterministicPolicyOutput,
  type PolicyInput,
  type PolicyOutput,
} from "@cs-coach/coach-agent";
import type { PolicyAdapter, PolicyTraceMeta } from "@cs-coach/coach-agent";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 32 * 1024;
const ALLOWED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
export const DEEPSEEK_COACH_POLICY_PROMPT_VERSION = "deepseek-coach-policy/1.0.0";

export interface DeepSeekCoachPolicyEnv {
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_URL?: string;
  DEEPSEEK_ALLOW_EMPTY_KEY?: boolean;
}

interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface CoachPolicyManifest {
  status: "SUCCEEDED" | "FALLBACK" | "DISABLED";
  provider: "DEEPSEEK" | "DETERMINISTIC";
  model?: string;
  tokenCount?: number;
  reason?: string;
  limitations: string[];
}

export interface CoachPolicyResult {
  status: "SUCCEEDED" | "FALLBACK" | "DISABLED";
  output: PolicyOutput;
  manifest: CoachPolicyManifest;
}

export class CoachPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoachPolicyValidationError";
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

function deterministicResult(input: PolicyInput, reason: string): CoachPolicyResult {
  const output = deterministicPolicyOutput(input);
  const status = input.capabilities.length === 0 ? "DISABLED" : "FALLBACK";
  return {
    status,
    output,
    manifest: {
      status,
      provider: "DETERMINISTIC",
      reason,
      limitations: [reason],
    },
  };
}

function providerTokenCount(payload: Record<string, unknown>): number | null {
  const usage = payload.usage;
  if (!isRecord(usage)) return null;
  const total = usage.total_tokens;
  if (typeof total === "number" && Number.isInteger(total) && total >= 0) return total;
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  if (
    typeof prompt === "number" && Number.isInteger(prompt) && prompt >= 0 &&
    typeof completion === "number" && Number.isInteger(completion) && completion >= 0
  ) {
    return prompt + completion;
  }
  return null;
}

export function parseCoachPolicyRequest(value: unknown, byteLength = 0): PolicyInput {
  if (byteLength > MAX_REQUEST_BYTES) throw new CoachPolicyValidationError("Coach Policy request is too large.");
  const parsed = PolicyInputSchema.safeParse(value);
  if (!parsed.success) throw new CoachPolicyValidationError("Coach Policy request shape is invalid.");
  const capabilityIds = parsed.data.capabilities.map((capability) => capability.capabilityId);
  if (new Set(capabilityIds).size !== capabilityIds.length) throw new CoachPolicyValidationError("Coach Policy request contains duplicate capabilities.");
  return parsed.data;
}

function parsePolicyOutput(value: unknown, input: PolicyInput): PolicyOutput {
  const parsed = PolicyOutputSchema.safeParse(value);
  if (!parsed.success) throw new CoachPolicyValidationError("Coach Policy output shape is invalid.");
  const output = parsed.data;
  const allowedEvidence = new Set(input.allowedEvidenceSummary.flatMap((summary) => summary.refs));
  if (output.action === "FINISH_CUE") {
    if (output.evidenceRefs.some((ref) => !allowedEvidence.has(ref))) throw new CoachPolicyValidationError("Coach Policy output references an unknown evidence ref.");
    return output;
  }
  const capability = input.capabilities.find(({ capabilityId }) => capabilityId === output.capabilityId);
  if (!capability) throw new CoachPolicyValidationError("Coach Policy output selected an unavailable capability.");
  const allowedCapabilityRefs = new Set(capability.evidenceRefs);
  if (output.evidenceRefs.some((ref) => !allowedCapabilityRefs.has(ref) || !allowedEvidence.has(ref))) throw new CoachPolicyValidationError("Coach Policy output references an illegal capability ref.");
  return output;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CoachPolicyValidationError("Provider response is not JSON.");
  }
}

function systemPrompt(): string {
  return [
    "You are a CS2 coaching capability selector.",
    "Return JSON only with exactly action, capabilityId when selecting, evidenceRefs, rationaleCode, and confidence.",
    "Select only a supplied capabilityId. Never create or alter boundArgs, tools, evidence, player identity, ticks, coordinates, or visible coaching prose.",
    "If memoryBrief is present, treat it only as a bounded hypothesis: activeThreads request a CHECK_TRANSFER-style re-check and user corrections request REINFORCE/clarify; re-check the current cue evidence before any conclusion and never present a remembered inference as a Demo fact. When the provider is unavailable, the deterministic fallback applies the same small evidence-first re-check bias.",
    "Use exactly one of these rationaleCode values: TIMING_NEEDS_SLOW_REPLAY, POSITION_NEEDS_MAP_FOCUS, UTILITY_NEEDS_TRAJECTORY, IMPACT_NEEDS_WIN_RATE, ECONOMY_CHANGES_RISK, NO_EXTRA_VISUAL_VALUE.",
    "Use FINISH_CUE when no supplied visual capability adds value. Do not emit any extra fields.",
  ].join(" ");
}

export async function directCoachPolicy(
  rawInput: unknown,
  env: DeepSeekCoachPolicyEnv,
  fetcher: FetchLike = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<CoachPolicyResult> {
  let input: PolicyInput;
  try {
    input = parseCoachPolicyRequest(rawInput, new TextEncoder().encode(JSON.stringify(rawInput)).byteLength);
  } catch (error) {
    if (error instanceof CoachPolicyValidationError) throw error;
    throw new CoachPolicyValidationError("Coach Policy request shape is invalid.");
  }
  if (input.capabilities.length === 0) return deterministicResult(input, "NO_CAPABILITIES");
  const key = env.DEEPSEEK_API_KEY?.trim();
  if (!key && !env.DEEPSEEK_ALLOW_EMPTY_KEY) return deterministicResult(input, "MISSING_API_KEY");
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
  if (!env.DEEPSEEK_URL && !ALLOWED_MODELS.has(model)) return deterministicResult(input, "MODEL_NOT_ALLOWED");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(env.DEEPSEEK_URL ?? DEEPSEEK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: JSON.stringify(input) },
        ],
        temperature: 0,
        max_tokens: 500,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) return deterministicResult(input, "UPSTREAM_HTTP");
    const payload = await readJson(response);
    if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) || payload.choices[0].finish_reason !== "stop" || !isRecord(payload.choices[0].message) || typeof payload.choices[0].message.content !== "string") return deterministicResult(input, "UPSTREAM_FINISH");
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.choices[0].message.content);
    } catch {
      return deterministicResult(input, "UPSTREAM_JSON");
    }
    try {
      const output = parsePolicyOutput(parsed, input);
      return {
        status: "SUCCEEDED",
        output,
        manifest: {
          status: "SUCCEEDED",
          provider: "DEEPSEEK",
          model,
          ...(providerTokenCount(payload) !== null ? { tokenCount: providerTokenCount(payload)! } : {}),
          limitations: [],
        },
      };
    } catch {
      return deterministicResult(input, "UPSTREAM_SCHEMA");
    }
  } catch (error) {
    return deterministicResult(
      input,
      error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "UPSTREAM_ERROR",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseClientResult(value: unknown, input: PolicyInput): CoachPolicyResult {
  if (!isRecord(value) || !exactKeys(value, ["status", "output", "manifest"])) throw new CoachPolicyValidationError("Coach Policy response shape is invalid.");
  const manifest = value.manifest;
  const allowedManifestKeys = new Set(["status", "provider", "model", "tokenCount", "reason", "limitations"]);
  if (!["SUCCEEDED", "FALLBACK", "DISABLED"].includes(String(value.status)) || !isRecord(manifest) || Object.keys(manifest).some((key) => !allowedManifestKeys.has(key)) || !Array.isArray(manifest.limitations) || !manifest.limitations.every((item) => typeof item === "string") || (manifest.tokenCount !== undefined && (!Number.isInteger(manifest.tokenCount) || Number(manifest.tokenCount) < 0))) throw new CoachPolicyValidationError("Coach Policy response manifest is invalid.");
  const status = value.status as CoachPolicyResult["status"];
  if (manifest.status !== status || !["DEEPSEEK", "DETERMINISTIC"].includes(String(manifest.provider)) || (status === "SUCCEEDED" && manifest.provider !== "DEEPSEEK") || (status !== "SUCCEEDED" && manifest.provider !== "DETERMINISTIC")) throw new CoachPolicyValidationError("Coach Policy response status/provider mismatch.");
  const output = parsePolicyOutput(value.output, input);
  return {
    status,
    output,
    manifest: {
      status,
      provider: manifest.provider as CoachPolicyManifest["provider"],
      ...(typeof manifest.model === "string" ? { model: manifest.model } : {}),
      ...(typeof manifest.tokenCount === "number" ? { tokenCount: manifest.tokenCount } : {}),
      ...(typeof manifest.reason === "string" ? { reason: manifest.reason } : {}),
      limitations: [...manifest.limitations] as string[],
    },
  };
}

export async function requestCoachPolicy(
  rawInput: PolicyInput,
  options: { endpoint?: string; fetcher?: FetchLike; signal?: AbortSignal } = {},
): Promise<CoachPolicyResult> {
  const input = parseCoachPolicyRequest(rawInput, new TextEncoder().encode(JSON.stringify(rawInput)).byteLength);
  if (input.capabilities.length === 0) return deterministicResult(input, "NO_CAPABILITIES");
  try {
    const response = await (options.fetcher ?? fetch)(options.endpoint ?? "/api/coaching/policy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify(input),
    });
    if (!response.ok) return deterministicResult(input, `HTTP_${response.status}`);
    return parseClientResult(await response.json(), input);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return deterministicResult(input, "POLICY_REQUEST_FAILED");
  }
}

export function createDeepSeekCoachPolicyAdapter(options: {
  endpoint?: string;
  fetcher?: FetchLike;
  signal?: AbortSignal;
  onResult?: (result: CoachPolicyResult) => void;
} = {}): PolicyAdapter {
  let lastTraceMeta: PolicyTraceMeta | null = null;
  return {
    selectCapability: async (input) => {
      const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      let result: CoachPolicyResult;
      try {
        result = await requestCoachPolicy(input, options);
      } catch (error) {
        const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        lastTraceMeta = {
          provider: null,
          model: null,
          tokenCount: null,
          latencyMs: Math.max(0, Math.round(finishedAt - startedAt)),
        };
        throw error;
      }
      const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      lastTraceMeta = {
        provider: result.manifest.provider,
        model: result.manifest.model ?? null,
        tokenCount: result.manifest.tokenCount ?? null,
        latencyMs: Math.max(0, Math.round(finishedAt - startedAt)),
      };
      // Keep this callback outside the request catch: a persistence/bridge
      // failure must not erase truthful provider metadata already received.
      options.onResult?.(result);
      return result.output;
    },
    consumeLastTraceMeta: () => {
      const traceMeta = lastTraceMeta;
      lastTraceMeta = null;
      return traceMeta;
    },
  };
}

export const coachPolicyLimits = {
  maxRequestBytes: MAX_REQUEST_BYTES,
  timeoutMs: REQUEST_TIMEOUT_MS,
  allowedModels: [...ALLOWED_MODELS],
} as const;
