import {
  assertValidSessionWrapUpBundle,
  buildSessionWrapUpRequest,
  deterministicSessionWrapUpResult,
  SessionWrapUpBundleSchema,
  SessionWrapUpRequestSchema,
  SessionWrapUpResultSchema,
  type SessionWrapUpBuildInput,
  type SessionWrapUpRequest,
  type SessionWrapUpResult,
} from "@cs-coach/coach-agent/client";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 32 * 1024;
const ALLOWED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
export const DEEPSEEK_WRAP_UP_PROMPT_VERSION = "deepseek-session-wrap-up/1.0.0";

export interface DeepSeekWrapUpEnv {
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
}

interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export class SessionWrapUpProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionWrapUpProviderValidationError";
  }
}

interface AnonymousWrapUpPacket {
  request: SessionWrapUpRequest;
  reverseFocus: Record<string, string>;
  reverseCue: Record<string, string>;
  reverseEvidence: Record<string, string>;
  reverseAdvice: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function aliases(values: readonly string[], prefix: string): { forward: Record<string, string>; reverse: Record<string, string> } {
  const forward: Record<string, string> = {};
  const reverse: Record<string, string> = {};
  unique(values).forEach((value, index) => {
    const anonymous = `${prefix}${index + 1}`;
    forward[value] = anonymous;
    reverse[anonymous] = value;
  });
  return { forward, reverse };
}

function mappedRefs(values: readonly string[], mapping: Record<string, string>, name: string): string[] {
  return values.map((value) => {
    const mapped = mapping[value];
    if (!mapped) throw new SessionWrapUpProviderValidationError(`${name} contains an unmapped ref.`);
    return mapped;
  });
}

function buildAnonymousPacket(request: SessionWrapUpRequest): AnonymousWrapUpPacket {
  const focusAliases = aliases(request.themes.map((theme) => theme.focus), "f");
  const cueIds = request.themes.flatMap((theme) => theme.cueRefs);
  const evidenceIds = request.themes.flatMap((theme) => theme.evidenceRefs);
  const adviceIds = request.themes.flatMap((theme) => theme.adviceRefs);
  const sourceRefs = request.completedCues.flatMap((cue) => [
    ...cue.coreIssue.refs,
    ...cue.betterPlay.refs,
    ...cue.advice.flatMap((advice) => advice.refs),
  ]);
  const cueAliases = aliases(cueIds, "c");
  const evidenceAliases = aliases(evidenceIds, "e");
  const adviceAliases = aliases(adviceIds, "v");
  const sourceAliases = aliases(sourceRefs, "r");
  const mapField = (field: SessionWrapUpRequest["completedCues"][number]["coreIssue"]) => ({
    text: field.text,
    refs: mappedRefs(field.refs, sourceAliases.forward, "cue source refs"),
    limitations: [...field.limitations],
  });
  const anonymousRequest = SessionWrapUpRequestSchema.parse({
    schemaVersion: request.schemaVersion,
    themes: request.themes.map((theme) => ({
      ...theme,
      focus: focusAliases.forward[theme.focus],
      cueRefs: mappedRefs(theme.cueRefs, cueAliases.forward, "theme cue refs"),
      evidenceRefs: mappedRefs(theme.evidenceRefs, evidenceAliases.forward, "theme evidence refs"),
      adviceRefs: mappedRefs(theme.adviceRefs, adviceAliases.forward, "theme advice refs"),
    })),
    completedCues: request.completedCues.map((cue) => ({
      cueId: cueAliases.forward[cue.cueId],
      focus: focusAliases.forward[cue.focus],
      coreIssue: mapField(cue.coreIssue),
      betterPlay: mapField(cue.betterPlay),
      advice: cue.advice.map((advice) => ({
        id: adviceAliases.forward[advice.id],
        text: advice.text,
        refs: mappedRefs(advice.refs, sourceAliases.forward, "advice source refs"),
      })),
    })),
    limitations: [...request.limitations],
  });
  return {
    request: anonymousRequest,
    reverseFocus: focusAliases.reverse,
    reverseCue: cueAliases.reverse,
    reverseEvidence: evidenceAliases.reverse,
    reverseAdvice: adviceAliases.reverse,
  };
}

function assertAnonymousPacket(value: SessionWrapUpRequest): SessionWrapUpRequest {
  const focusPattern = /^f[1-9][0-9]{0,2}$/;
  const cuePattern = /^c[1-9][0-9]{0,2}$/;
  const evidencePattern = /^e[1-9][0-9]{0,2}$/;
  const advicePattern = /^v[1-9][0-9]{0,2}$/;
  const sourcePattern = /^r[1-9][0-9]{0,2}$/;
  const themeFocuses = new Set<string>();
  for (const theme of value.themes) {
    if (themeFocuses.has(theme.focus) || new Set(theme.cueRefs).size !== theme.cueRefs.length || new Set(theme.evidenceRefs).size !== theme.evidenceRefs.length || new Set(theme.adviceRefs).size !== theme.adviceRefs.length) {
      throw new SessionWrapUpProviderValidationError("Anonymous wrap-up themes are duplicated.");
    }
    themeFocuses.add(theme.focus);
    if (!focusPattern.test(theme.focus) || theme.cueRefs.some((ref) => !cuePattern.test(ref)) || theme.evidenceRefs.some((ref) => !evidencePattern.test(ref)) || theme.adviceRefs.some((ref) => !advicePattern.test(ref))) {
      throw new SessionWrapUpProviderValidationError("Anonymous wrap-up theme refs are invalid.");
    }
  }
  const cueIds = new Set<string>();
  for (const cue of value.completedCues) {
    if (cueIds.has(cue.cueId)) throw new SessionWrapUpProviderValidationError("Anonymous wrap-up contains duplicate cues.");
    cueIds.add(cue.cueId);
    if (!cuePattern.test(cue.cueId) || !focusPattern.test(cue.focus) || cue.coreIssue.refs.some((ref) => !sourcePattern.test(ref)) || cue.betterPlay.refs.some((ref) => !sourcePattern.test(ref)) || cue.advice.some((advice) => !advicePattern.test(advice.id) || advice.refs.some((ref) => !sourcePattern.test(ref)))) {
      throw new SessionWrapUpProviderValidationError("Anonymous wrap-up cue refs are invalid.");
    }
    const theme = value.themes.find((candidate) => candidate.focus === cue.focus);
    if (!theme || !theme.cueRefs.includes(cue.cueId) || cue.advice.some((advice) => !theme.adviceRefs.includes(advice.id))) {
      throw new SessionWrapUpProviderValidationError("Anonymous wrap-up cue is not owned by its theme.");
    }
  }
  for (const theme of value.themes) {
    const representative = value.completedCues.find((cue) => theme.cueRefs.includes(cue.cueId));
    if (!representative || !representative.advice.some((advice) => theme.adviceRefs.includes(advice.id))) {
      throw new SessionWrapUpProviderValidationError("Anonymous wrap-up theme has no legal representative advice.");
    }
  }
  return value;
}

export function parseSessionWrapUpRequest(value: unknown, byteLength = 0): SessionWrapUpRequest {
  if (byteLength > MAX_REQUEST_BYTES) throw new SessionWrapUpProviderValidationError("Session wrap-up request is too large.");
  const parsed = SessionWrapUpRequestSchema.safeParse(value);
  if (!parsed.success) throw new SessionWrapUpProviderValidationError("Session wrap-up request shape is invalid.");
  return assertAnonymousPacket(parsed.data);
}

function mapBundleToReal(rawBundle: unknown, packet: AnonymousWrapUpPacket, realRequest: SessionWrapUpRequest) {
  const anonymousBundle = SessionWrapUpBundleSchema.parse(rawBundle);
  const mapped = {
    schemaVersion: anonymousBundle.schemaVersion,
    themes: anonymousBundle.themes.map((theme) => ({
      focus: packet.reverseFocus[theme.focus] ?? theme.focus,
      summary: {
        text: theme.summary.text,
        refs: theme.summary.refs.map((ref) => packet.reverseCue[ref] ?? packet.reverseEvidence[ref] ?? ref),
      },
      trainingAdvice: {
        text: theme.trainingAdvice.text,
        refs: theme.trainingAdvice.refs.map((ref) => packet.reverseAdvice[ref] ?? ref),
      },
    })),
    limitations: [...anonymousBundle.limitations],
  };
  return assertValidSessionWrapUpBundle(mapped, realRequest);
}

function mapClientResult(rawResult: unknown, packet: AnonymousWrapUpPacket, realRequest: SessionWrapUpRequest): SessionWrapUpResult {
  if (!isRecord(rawResult) || !exactKeys(rawResult, ["status", "bundle", "manifest"])) throw new SessionWrapUpProviderValidationError("Session wrap-up response shape is invalid.");
  const parsed = SessionWrapUpResultSchema.safeParse(rawResult);
  if (!parsed.success) throw new SessionWrapUpProviderValidationError("Session wrap-up response schema is invalid.");
  const { status, manifest } = parsed.data;
  if (manifest.status !== status || (status === "SUCCEEDED" && manifest.provider !== "DEEPSEEK") || (status !== "SUCCEEDED" && manifest.provider !== "DETERMINISTIC")) {
    throw new SessionWrapUpProviderValidationError("Session wrap-up response status/provider mismatch.");
  }
  return {
    ...parsed.data,
    bundle: mapBundleToReal(parsed.data.bundle, packet, realRequest),
  };
}

function fallbackResult(request: SessionWrapUpRequest, reason: string, model?: string): SessionWrapUpResult {
  const result = deterministicSessionWrapUpResult(request, reason);
  return model ? { ...result, manifest: { ...result.manifest, model } } : result;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SessionWrapUpProviderValidationError("Provider response is not JSON.");
  }
}

function systemPrompt(): string {
  return [
    "You are a CS2 coaching session wrap-up narrator.",
    "Return JSON only with exactly one top-level key bundle.",
    "Return exactly the supplied repeated themes; never add, remove, rename, or merge a theme.",
    "Each theme must contain exactly focus, summary, and trainingAdvice.",
    "Echo focus exactly and cite only supplied anonymous cue/evidence refs in summary and advice refs in trainingAdvice.",
    "Reuse the supplied coreIssue, betterPlay, and advice meaning; do not invent facts, events, teammates, player identity, ticks, routes, replay, frames, prompts, or chain of thought.",
    "A singleton is not a habit. Keep the tone concise and practical for a Chinese CS2 player.",
  ].join(" ");
}

export async function directSessionWrapUp(
  rawInput: unknown,
  env: DeepSeekWrapUpEnv,
  fetcher: FetchLike = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<SessionWrapUpResult> {
  let request: SessionWrapUpRequest;
  try {
    const serialized = JSON.stringify(rawInput);
    request = parseSessionWrapUpRequest(rawInput, new TextEncoder().encode(serialized).byteLength);
  } catch (error) {
    if (error instanceof SessionWrapUpProviderValidationError) throw error;
    throw new SessionWrapUpProviderValidationError("Session wrap-up request shape is invalid.");
  }
  if (request.themes.length === 0) return deterministicSessionWrapUpResult(request, "NO_REPEATED_THEME");
  const key = env.DEEPSEEK_API_KEY?.trim();
  if (!key) return deterministicSessionWrapUpResult(request, "MISSING_API_KEY");
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
  if (!ALLOWED_MODELS.has(model)) return fallbackResult(request, "MODEL_NOT_ALLOWED", model);

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
          { role: "user", content: JSON.stringify(request) },
        ],
        temperature: 0,
        max_tokens: 700,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) return deterministicSessionWrapUpResult(request, "UPSTREAM_HTTP");
    let payload: unknown;
    try {
      payload = await readJson(response);
    } catch {
      return deterministicSessionWrapUpResult(request, "UPSTREAM_JSON");
    }
    if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) || payload.choices[0].finish_reason !== "stop" || !isRecord(payload.choices[0].message) || typeof payload.choices[0].message.content !== "string") {
      return deterministicSessionWrapUpResult(request, "UPSTREAM_FINISH");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.choices[0].message.content);
    } catch {
      return deterministicSessionWrapUpResult(request, "UPSTREAM_JSON");
    }
    try {
      if (!isRecord(parsed) || !exactKeys(parsed, ["bundle"])) return deterministicSessionWrapUpResult(request, "UPSTREAM_SCHEMA");
      const bundle = assertValidSessionWrapUpBundle(parsed.bundle, request);
      return {
        status: "SUCCEEDED",
        bundle,
        manifest: { status: "SUCCEEDED", provider: "DEEPSEEK", model, limitations: [] },
      };
    } catch {
      return deterministicSessionWrapUpResult(request, "UPSTREAM_SCHEMA");
    }
  } catch (error) {
    return deterministicSessionWrapUpResult(request, error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "UPSTREAM_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestSessionWrapUp(
  input: SessionWrapUpBuildInput,
  options: { endpoint?: string; fetcher?: FetchLike; signal?: AbortSignal } = {},
): Promise<SessionWrapUpResult> {
  const realRequest = buildSessionWrapUpRequest(input);
  if (realRequest.themes.length === 0) return deterministicSessionWrapUpResult(realRequest, "NO_REPEATED_THEME");
  const packet = buildAnonymousPacket(realRequest);
  try {
    const response = await (options.fetcher ?? fetch)(options.endpoint ?? "/api/coaching/wrap-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify(packet.request),
    });
    if (!response.ok) return fallbackResult(realRequest, `HTTP_${response.status}`);
    return mapClientResult(await response.json(), packet, realRequest);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return fallbackResult(realRequest, "WRAP_UP_REQUEST_FAILED");
  }
}

export const sessionWrapUpLimits = {
  maxRequestBytes: MAX_REQUEST_BYTES,
  timeoutMs: REQUEST_TIMEOUT_MS,
  allowedModels: [...ALLOWED_MODELS],
} as const;
