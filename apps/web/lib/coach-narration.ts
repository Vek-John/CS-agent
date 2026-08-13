import type { Advice, CoachCue, Fact, Inference, ReviewPlan } from "@cs-coach/contracts";

export const COACHING_NARRATION_ENDPOINT = "/api/coaching/narrate";

export type NarrationStatus = "SUCCEEDED" | "DISABLED" | "FALLBACK";

export interface AnonymousNarrationFact {
  id: string;
  text: string;
  availability: "DECISION";
  observed_by_player: true;
}

export interface AnonymousNarrationInference {
  id: string;
  text: string;
  confidence: number;
  fact_refs: string[];
}

export interface AnonymousNarrationAdvice {
  id: string;
  text: string;
  trigger: string;
  fact_refs: string[];
}

export interface AnonymousNarrationCue {
  cue_id: string;
  cue_type: CoachCue["cue_type"];
  facts: AnonymousNarrationFact[];
  inferences: AnonymousNarrationInference[];
  advice: AnonymousNarrationAdvice[];
  limitations: string[];
}

export interface NarrationRequestPayload {
  cues: AnonymousNarrationCue[];
}

export interface NarrationResult {
  cue_id: string;
  title: string;
  question: string;
  inference_text: string;
}

export interface NarrationManifestInput {
  model?: string;
  prompt_version?: string;
  limitations?: string[];
}

export interface NarrationSuccessResponse {
  status: "SUCCEEDED";
  items: NarrationResult[];
  manifest?: NarrationManifestInput;
}

export interface NarrationStatusResponse {
  status: "DISABLED" | "FALLBACK";
}

export type NarrationResponse = NarrationSuccessResponse | NarrationStatusResponse;

interface NarrationHttpResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export type NarrationFetcher = (
  input: string,
  init?: RequestInit
) => Promise<NarrationHttpResponse>;

export interface EnrichNarrationOptions {
  endpoint?: string;
  fetcher?: NarrationFetcher;
  redaction?: NarrationRedactionContext;
}

export interface NarrationRedactionContext {
  playerNames?: readonly string[];
  additionalForbiddenValues?: readonly string[];
}

interface AliasMaps {
  cues: Map<string, string>;
  facts: Map<string, string>;
  inferences: Map<string, string>;
  advice: Map<string, string>;
}

const narrationRequests = new Map<string, Promise<ReviewPlan>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function collectUniqueIds(plan: ReviewPlan): void {
  const groups: Array<[string, string[]]> = [
    ["cue", plan.cues.map((cue) => cue.id)],
    ["fact", plan.cues.flatMap((cue) => cue.facts.map((fact) => fact.id))],
    ["inference", plan.cues.flatMap((cue) => cue.inferences.map((inference) => inference.id))],
    ["advice", plan.cues.flatMap((cue) => cue.advice.map((advice) => advice.id))]
  ];

  for (const [kind, ids] of groups) {
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      throw new Error(`Cannot narrate a plan with duplicate ${kind} IDs.`);
    }
  }
}

function nextAlias(prefix: string, counters: Record<string, number>): string {
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  return `${prefix}${counters[prefix]}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactionValues(plan: ReviewPlan, context: NarrationRedactionContext): string[] {
  return [
    plan.id,
    plan.demo_id,
    plan.player_id,
    ...plan.cues.flatMap((cue) => [
      cue.id,
      ...cue.facts.map((fact) => fact.id),
      ...cue.inferences.map((inference) => inference.id),
      ...cue.advice.flatMap((advice) => [advice.id, advice.rule_id ?? ""])
    ]),
    ...(context.playerNames ?? []),
    ...(context.additionalForbiddenValues ?? [])
  ].filter((value, index, values) => value.trim().length > 1 && values.indexOf(value) === index);
}

function sanitizeNarrationText(text: string, forbiddenValues: readonly string[]): string {
  let sanitized = text;
  const playerLikeValues = new Set(forbiddenValues.filter((value) => /[^a-z0-9_-]/i.test(value)));
  for (const value of [...forbiddenValues].sort((left, right) => right.length - left.length)) {
    const replacement = playerLikeValues.has(value) ? "你" : "匿名引用";
    sanitized = sanitized.replace(new RegExp(escapeRegExp(value), "g"), replacement);
  }

  return sanitized
    .replace(/(?:https?:\/\/|file:\/\/)[^\s,，。；;]+/gi, "本地引用")
    .replace(/(?:^|[\s(（])(?:[A-Za-z]:)?[\\/][^\s,，。；;]+/g, "$1本地引用")
    .replace(/\b(?:canonical\s+)?tick\s*(?:id|number)?\s*(?:is|=|:)?\s*\d+\b/gi, "当前时刻")
    .replace(/\b(?:at|on)\s+tick\s+\d+\b/gi, "在当前时刻")
    .replace(/\btick\s*[:=#]?\s*\d+\b/gi, "当前时刻")
    .replace(/\bcanonical\s+ticks?\b/gi, "规范时刻")
    .replace(/\bticks?\b/gi, "当前时刻")
    .replace(/\b7656119\d{10}\b/g, "该玩家")
    .replace(/\b(?:annotations?|trajectory|paths?|outcomes?|reveals?|death|died|killed|kills?)\b/gi, "")
    .replace(/死亡|被击杀|击杀|结果|回看|揭示/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function isOutcomeScopedLimitation(text: string): boolean {
  return /死亡|被击杀|击杀|结果|回看|揭示|坐标|\bWORLD\b|\brenderer\b|\bmap manifest\b|\bradar\b|\b(?:outcomes?|reveals?|death|died|killed|kills?)\b/i.test(text);
}

function decisionFacts(cue: CoachCue): Fact[] {
  const observableIds = new Set(cue.observable_fact_refs);
  return cue.facts.filter(
    (fact) => fact.availability === "DECISION" && fact.observed_by_player && observableIds.has(fact.id)
  );
}

function remapFactRefs(refs: string[], aliases: Map<string, string>): string[] {
  return refs.flatMap((ref) => {
    const alias = aliases.get(ref);
    return alias ? [alias] : [];
  });
}

function anonymousFact(
  fact: Fact,
  aliases: AliasMaps,
  counters: Record<string, number>,
  forbiddenValues: readonly string[]
): AnonymousNarrationFact {
  const alias = nextAlias("f", counters);
  aliases.facts.set(fact.id, alias);
  return {
    id: alias,
    text: sanitizeNarrationText(fact.text, forbiddenValues),
    availability: "DECISION",
    observed_by_player: true
  };
}

function anonymousInference(
  inference: Inference,
  aliases: AliasMaps,
  counters: Record<string, number>,
  forbiddenValues: readonly string[]
): AnonymousNarrationInference {
  const alias = nextAlias("i", counters);
  aliases.inferences.set(inference.id, alias);
  return {
    id: alias,
    text: sanitizeNarrationText(inference.text, forbiddenValues),
    confidence: inference.confidence,
    fact_refs: remapFactRefs(inference.fact_refs, aliases.facts)
  };
}

function anonymousAdvice(
  advice: Advice,
  aliases: AliasMaps,
  counters: Record<string, number>,
  forbiddenValues: readonly string[]
): AnonymousNarrationAdvice {
  const alias = nextAlias("a", counters);
  aliases.advice.set(advice.id, alias);
  return {
    id: alias,
    text: sanitizeNarrationText(advice.text, forbiddenValues),
    trigger: sanitizeNarrationText(advice.trigger, forbiddenValues),
    fact_refs: remapFactRefs(advice.fact_refs, aliases.facts)
  };
}

export function buildNarrationPayload(
  plan: ReviewPlan,
  context: NarrationRedactionContext = {}
): NarrationRequestPayload {
  collectUniqueIds(plan);

  const aliases: AliasMaps = {
    cues: new Map(),
    facts: new Map(),
    inferences: new Map(),
    advice: new Map()
  };
  const counters: Record<string, number> = {};
  const forbiddenValues = redactionValues(plan, context);

  const cues = plan.cues.map((cue) => {
    const cueAlias = nextAlias("c", counters);
    aliases.cues.set(cue.id, cueAlias);
    return {
      cue_id: cueAlias,
      cue_type: cue.cue_type,
      facts: decisionFacts(cue).map((fact) => anonymousFact(fact, aliases, counters, forbiddenValues)),
      inferences: cue.inferences.map((inference) => anonymousInference(inference, aliases, counters, forbiddenValues)),
      advice: cue.advice.map((advice) => anonymousAdvice(advice, aliases, counters, forbiddenValues)),
      limitations: cue.limitations
        .filter((limitation) => !isOutcomeScopedLimitation(limitation))
        .map((limitation) => sanitizeNarrationText(limitation, forbiddenValues))
    };
  });

  return { cues };
}

function resultArray(record: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.cues)) return record.cues;
  if (Array.isArray(record.narrations)) return record.narrations;
  return undefined;
}

function parseNarrationResult(value: unknown): NarrationResult {
  if (!isRecord(value)) throw new Error("Narration result is not an object.");
  const explanation = value.explanation;
  const directText = explanation ?? (isRecord(value.inference) ? value.inference.text : value.inference_text);
  if (
    !nonEmptyString(value.cue_id) ||
    !nonEmptyString(value.title) ||
    !nonEmptyString(directText)
  ) {
    throw new Error("Narration result is missing a cue alias or replacement text.");
  }
  return {
    cue_id: value.cue_id,
    title: value.title.trim(),
    // Keep the legacy ReviewPlan.question field in sync with the direct
    // explanation. The coaching UI speaks this text; it must not turn a
    // model response into a new prediction prompt.
    question: directText.trim(),
    inference_text: directText.trim()
  };
}

export function parseNarrationResponse(value: unknown): NarrationResponse {
  if (!isRecord(value) || (value.status !== "SUCCEEDED" && value.status !== "DISABLED" && value.status !== "FALLBACK")) {
    throw new Error("Narration response has an unknown status.");
  }

  if (value.status !== "SUCCEEDED") return { status: value.status };

  const rawItems = resultArray(value);
  if (!rawItems) throw new Error("Successful narration response has no cue results.");
  const items = rawItems.map(parseNarrationResult);
  const manifestValue = value.manifest ?? value.narration_manifest;
  let manifest: NarrationManifestInput | undefined;
  if (manifestValue !== undefined) {
    if (!isRecord(manifestValue)) throw new Error("Narration manifest is invalid.");
    manifest = {};
    if (manifestValue.model !== undefined) {
      if (!nonEmptyString(manifestValue.model)) throw new Error("Narration model is invalid.");
      manifest.model = manifestValue.model;
    }
    if (manifestValue.prompt_version !== undefined) {
      if (!nonEmptyString(manifestValue.prompt_version)) throw new Error("Narration prompt version is invalid.");
      manifest.prompt_version = manifestValue.prompt_version;
    }
    if (manifestValue.limitations !== undefined) {
      if (!Array.isArray(manifestValue.limitations) || !manifestValue.limitations.every(nonEmptyString)) {
        throw new Error("Narration limitations are invalid.");
      }
      manifest.limitations = [...manifestValue.limitations];
    }
  }

  if (value.model !== undefined) {
    if (!nonEmptyString(value.model)) throw new Error("Narration model is invalid.");
    manifest = { ...(manifest ?? {}), model: value.model };
  }

  return { status: "SUCCEEDED", items, ...(manifest ? { manifest } : {}) };
}

function applyNarration(plan: ReviewPlan, response: NarrationSuccessResponse): ReviewPlan {
  const expectedAliases = new Set(plan.cues.map((_, index) => `c${index + 1}`));
  const resultByCue = new Map<string, NarrationResult>();
  for (const result of response.items) {
    if (!expectedAliases.has(result.cue_id) || resultByCue.has(result.cue_id)) {
      throw new Error("Narration response contains duplicate or unknown cue aliases.");
    }
    resultByCue.set(result.cue_id, result);
  }
  if (resultByCue.size !== expectedAliases.size) {
    throw new Error("Narration response does not cover every cue.");
  }

  return {
    ...plan,
    cues: plan.cues.map((cue, index) => {
      const result = resultByCue.get(`c${index + 1}`);
      if (!result) throw new Error("Narration response cannot be mapped to cue.");
      if (cue.inferences.length === 0) throw new Error("Narration response has no inference target.");
      return {
        ...cue,
        title: result.title,
        question: result.question,
        inferences: cue.inferences.map((inference, inferenceIndex) =>
          inferenceIndex === 0 ? { ...inference, text: result.inference_text } : inference
        )
      };
    }),
    generation_manifest: {
      ...plan.generation_manifest,
      provider: "DEEPSEEK",
      status: "SUCCEEDED",
      narration_deterministic: false,
      ...(response.manifest?.model ? { model: response.manifest.model } : {}),
      // A successful model response must never retain the deterministic
      // template's prompt version. Session 02 supplies the real version;
      // keep an explicit non-template marker for older compatible responses.
      prompt_version: response.manifest?.prompt_version ?? "deepseek/unspecified",
      ...(response.manifest?.limitations ? { limitations: [...response.manifest.limitations] } : {})
    }
  };
}

async function requestNarration(
  plan: ReviewPlan,
  options: EnrichNarrationOptions
): Promise<ReviewPlan> {
  let payload: NarrationRequestPayload;
  try {
    payload = buildNarrationPayload(plan, options.redaction);
  } catch {
    return plan;
  }
  if (payload.cues.length === 0) return plan;

  try {
    const fetcher = options.fetcher ?? fetch;
    const response = await fetcher(options.endpoint ?? COACHING_NARRATION_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) return plan;
    const parsed = parseNarrationResponse(await response.json());
    if (parsed.status !== "SUCCEEDED") return plan;
    return applyNarration(plan, parsed);
  } catch {
    return plan;
  }
}

export function enrichReviewPlanWithNarration(
  plan: ReviewPlan,
  options: EnrichNarrationOptions = {}
): Promise<ReviewPlan> {
  const cached = narrationRequests.get(plan.id);
  if (cached) return cached;
  const request = requestNarration(plan, options);
  narrationRequests.set(plan.id, request);
  return request;
}

export function resetNarrationRequestCacheForTests(): void {
  narrationRequests.clear();
}
