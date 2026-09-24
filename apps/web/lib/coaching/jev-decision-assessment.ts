import {
  DECISION_ASSESSMENT_VERSIONS as V,
  type DecisionAssessmentPacket, type DecisionAssessmentResult
} from "@cs-coach/contracts";
import { parseDecisionAssessmentPacket, validateDecisionAssessmentResult } from "@cs-coach/review-planner";

export interface DecisionProviderAttempt {
  status: "SUCCEEDED" | "FALLBACK";
  result?: DecisionAssessmentResult;
  /** Parsed but rejected output: audit only, never a teaching-consumable result. */
  diagnosticResult?: DecisionAssessmentResult;
  rejectionReasons?: readonly string[];
  actualModel?: string;
  reason?: string;
  latencyMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}
export interface DecisionProviderOptions { fetcher?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }
/** Match the existing Director/Narrator generation default; never a Jev model alias. */
export const DEFAULT_DECISION_COMPARISON_MODEL = "deepseek-v4-flash";
const URL_JEV = "https://api.typesafe.ai/v1/systemone";
const EMPTY_USAGE: DecisionProviderAttempt["usage"] = { inputTokens: null, outputTokens: null, costUsd: null };
const ATOMS = {
  riskWarranted: {
    instructions: "Evaluate whether the actual recontact is warranted by player-known decision evidence. A numerical advantage alone does not prohibit active contest. Consider objective urgency, reliable new information and trade support. Missing information is UNKNOWN, never proof of a mistake. This tactical rubric is an unvalidated coaching hypothesis.",
    criteria: { WARRANTED: "Specific known conditions justify active recontact; other actions may also be reasonable.", UNWARRANTED: "Known conditions positively support avoiding this risk, not merely an absence of justification.", UNKNOWN: "Evidence cannot distinguish warranted from unwarranted recontact." }
  },
  alternativePreferable: {
    instructions: "Does the decision evidence establish that a supplied applicable alternative is preferable to the actual action? Only objectiveAllowsDelay, tradeWindow and safeReachableCover checked YES can support their corresponding alternative. Missing alternatives do not prove forced choice.",
    criteria: { PREFERABLE: "A verified applicable wait/trade/cover alternative is preferable in these known conditions.", NOT_ESTABLISHED: "Evidence supports multiple reasonable actions without proving an alternative superior.", UNKNOWN: "Evidence is insufficient to compare actions." }
  },
  contextSufficient: {
    instructions: "Is the legal evidence sufficient for the two tactical judgments? USER_PROVIDED assertions are uncertain, not Demo facts. Count advantage and an observed action alone are insufficient. Unknown timing, visibility, communication or applicability can change the judgment.",
    criteria: { SUFFICIENT: "Relevant timing, support and information conditions are sufficiently established by supplied evidence.", INSUFFICIENT: "Missing or uncertain information can change the judgment." }
  }
} as const;

/** New question version applies only to the factual movement/fire pilot. Legacy prompts stay byte-for-byte unchanged. */
const RETURN_AND_FIRE_ATOMS = {
  riskWarranted: {
    instructions: "Evaluate only the supplied RETURN_AND_FIRE action: attributed self movement returned to an earlier position and the player fired. This is not REPEEK or renewed enemy contact. It does not establish enemy exposure, line of sight, visibility, cover, target identity, or tactical purpose. Do not infer these from firing, position return, or player-count advantage. contactStatus UNVERIFIED is a material evidence limit. Distinguish what the action proves from whether a tactical judgment is supported.",
    criteria: { WARRANTED: "Known tactical evidence establishes that the observed action is warranted.", UNWARRANTED: "Known tactical evidence establishes that the observed action is unwarranted.", UNKNOWN: "The factual movement/fire action does not establish enough contact and visibility context to judge tactical reasonableness." }
  },
  alternativePreferable: {
    instructions: "Evaluate whether an alternative can be compared to the recorded RETURN_AND_FIRE action. Returning to a position and firing does not establish enemy contact, a protected position, or an intentional re-peek. No target, exposure, or visibility is verified. An applicable code check is not evidence that its alternative is tactically preferable. Do not treat missing evidence as multiple demonstrated reasonable choices.",
    criteria: { PREFERABLE: "Evidence establishes a tactically preferable and applicable alternative.", NOT_ESTABLISHED: "Evidence demonstrates multiple reasonable tactical actions without a unique preference.", UNKNOWN: "Unverified contact and visibility prevent a supported tactical comparison." }
  },
  contextSufficient: {
    instructions: "Assess the information needed to judge this RETURN_AND_FIRE action. The producer establishes only self position return and attributed fire; enemy contact and visibility remain UNVERIFIED. Counts, coordinates or a shot do not prove a re-peek, enemy exposure or cover. User-provided assertions retain uncertainty. Decide whether this missing contact information prevents the tactical judgments.",
    criteria: { SUFFICIENT: "Relevant contact, visibility and tactical applicability are established by legal evidence.", INSUFFICIENT: "The action facts do not establish contact and visibility needed for tactical judgment." }
  }
} as const;

/** Every question shares exactly this outcome-free state. Evidence choices are
 * separate semantic support judgments; their membership alone is never support. */
export function buildJevHttpBody(input: DecisionAssessmentPacket) {
  const packet = parseDecisionAssessmentPacket(input);
  const questions: Record<string, unknown> = {};
  for (const [name, atom] of Object.entries(packet.action.kind === "RETURN_AND_FIRE" ? RETURN_AND_FIRE_ATOMS : ATOMS)) {
    questions[name] = { type: "choice", ...atom };
    const relevant = packet.evidence.filter((e) => name === "alternativePreferable"
      ? ["objectiveAllowsDelay", "tradeWindow", "safeReachableCover"].includes(e.role)
      : name === "contextSufficient" ? ["objectiveAllowsDelay", "tradeWindow", "safeReachableCover"].includes(e.role) : e.role !== "OBSERVATION");
    for (const [category, definition] of Object.entries(atom.criteria)) for (const e of relevant) questions[`${name}Evidence_${category}_${e.alias}`] = {
      type: "choice",
      instructions: `Does evidence ${e.alias} (${e.role}) directly support the specific proposition ${category}: ${definition}? Evaluate this proposition independently; other questions' answers are unavailable. Judgment scope: ${atom.instructions} Do not confuse relevance with support.`,
      criteria: { SUPPORTED: "This specific evidence supports this proposition.", UNSUPPORTED: "This evidence does not support this proposition or support is uncertain." }
    };
  }
  questions.limitation = { type: "choice", instructions: "Select the most material limitation of this evaluation. All tactical principles remain unvalidated even when another limitation is selected.", criteria: {
    MISSING_CONTEXT: "Relevant decision information is missing.", USER_CONTEXT_UNVERIFIED: "User-supplied context is uncertain.", MULTIPLE_REASONABLE_ACTIONS: "Multiple actions may be reasonable.", PRINCIPLE_UNVALIDATED: "The tactical rubric has not been validated by CS2 coaches."
  } };
  return { model: V.model, state: packet, questions };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function choice(value: unknown, criteria: Readonly<Record<string, unknown>>): { choice: string; confidence: number; probabilities: Record<string, number> } {
  if (!record(value) || value.type !== "choice" || typeof value.choice !== "string" || !Object.hasOwn(criteria, value.choice) || typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 || !record(value.probabilities)) throw new Error("UPSTREAM_SCHEMA");
  const keys = Object.keys(criteria);
  const rawProbabilities = value.probabilities;
  if (Object.keys(rawProbabilities).length !== keys.length || keys.some((k) => typeof rawProbabilities[k] !== "number" || !Number.isFinite(rawProbabilities[k]) || (rawProbabilities[k] as number) < 0 || (rawProbabilities[k] as number) > 1)) throw new Error("UPSTREAM_PROBABILITY");
  const probabilities = value.probabilities as Record<string, number>;
  if (Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > 0.001 || probabilities[value.choice] + 0.000001 < Math.max(...Object.values(probabilities))) throw new Error("UPSTREAM_PROBABILITY");
  return { choice: value.choice, confidence: value.confidence, probabilities };
}
function usage(value: unknown, jev: boolean): DecisionProviderAttempt["usage"] {
  if (!record(value)) return { ...EMPTY_USAGE };
  const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const inputTokens = number(value.input_tokens ?? value.prompt_tokens);
  return { inputTokens, outputTokens: number(value.output_tokens ?? value.completion_tokens), costUsd: jev && inputTokens !== null ? inputTokens * 0.042 / 1_000_000 : null };
}
export function parseJevResponse(packet: DecisionAssessmentPacket, payload: unknown, expectedModel: string = V.model): DecisionAssessmentResult {
  const body = buildJevHttpBody(packet);
  if (!record(payload) || payload.model !== expectedModel || !record(payload.answers) || Object.keys(payload.answers).length !== Object.keys(body.questions).length) throw new Error("UPSTREAM_MODEL_OR_SCHEMA");
  const atoms: Record<string, unknown> = {};
  for (const name of Object.keys(ATOMS)) {
    const question = body.questions[name] as { criteria: Record<string, string> };
    const atom = choice(payload.answers[name], question.criteria);
    const refs: string[] = [];
    for (const [key, question] of Object.entries(body.questions)) {
      if (!key.startsWith(`${name}Evidence_${atom.choice}_`)) continue;
      const support = choice(payload.answers[key], (question as { criteria: Record<string, string> }).criteria);
      if (support.choice === "SUPPORTED") refs.push(key.slice(`${name}Evidence_${atom.choice}_`.length));
    }
    atoms[name] = { ...atom, refs };
  }
  const limitation = choice(payload.answers.limitation, (body.questions.limitation as { criteria: Record<string, string> }).criteria);
  return { model: expectedModel, questionVersion: packet.questionVersion, ...atoms, limitationCodes: [...new Set([limitation.choice, "PRINCIPLE_UNVALIDATED", ...(packet.state.observations.some(o => o.source === "USER_PROVIDED") ? ["USER_CONTEXT_UNVERIFIED"] : [])])] } as unknown as DecisionAssessmentResult;
}

/** Deadline covers fetch and body decoding, even a test transport that ignores AbortSignal. No retries. */
async function boundedAttempt(work: (signal: AbortSignal) => Promise<DecisionProviderAttempt>, options: DecisionProviderOptions): Promise<DecisionProviderAttempt> {
  const start = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (() => void) | undefined;
  const fail = (reason: string): DecisionProviderAttempt => ({ status: "FALLBACK", reason, latencyMs: Math.round(performance.now() - start), usage: { ...EMPTY_USAGE } });
  try {
    if (options.signal?.aborted) return fail("CANCELLED");
    const aborted = new Promise<DecisionProviderAttempt>((resolve) => {
      rejectAbort = () => { controller.abort(); resolve(fail("CANCELLED")); };
      options.signal?.addEventListener("abort", rejectAbort, { once: true });
      timer = setTimeout(() => { controller.abort(); resolve(fail("TIMEOUT")); }, Math.max(1, Math.min(options.timeoutMs ?? 2500, 10_000)));
    });
    const result = await Promise.race([work(controller.signal), aborted]);
    if (options.signal?.aborted) return fail("CANCELLED");
    return { ...result, latencyMs: Math.round(performance.now() - start) };
  } catch { return fail(controller.signal.aborted ? "CANCELLED" : "UPSTREAM_ERROR"); }
  finally { if (timer) clearTimeout(timer); if (rejectAbort) options.signal?.removeEventListener("abort", rejectAbort); }
}
const failure = (reason: string, used = { ...EMPTY_USAGE }): DecisionProviderAttempt => ({ status: "FALLBACK", reason, latencyMs: 0, usage: used });

export async function assessWithJev(packet: DecisionAssessmentPacket, env: { JEV_API_KEY?: string }, options: DecisionProviderOptions = {}): Promise<DecisionProviderAttempt> {
  let body: ReturnType<typeof buildJevHttpBody>;
  try { body = buildJevHttpBody(packet); } catch { return failure("INVALID_REQUEST"); }
  if (!env.JEV_API_KEY?.trim()) return failure("MISSING_API_KEY");
  return boundedAttempt(async (signal) => {
    const response = await (options.fetcher ?? fetch)(URL_JEV, { method: "POST", signal, headers: { "content-type": "application/json", authorization: `Bearer ${env.JEV_API_KEY}` }, body: JSON.stringify(body) });
    if (!response.ok) return failure(`HTTP_${response.status}`);
    const payload: unknown = await response.json();
    const used = usage(record(payload) ? payload.usage : null, true);
    try {
      const result = parseJevResponse(packet, payload);
      const validation = validateDecisionAssessmentResult(packet, result);
      if (!validation.valid) return { ...failure("VALIDATION_REJECTED", used), diagnosticResult: result, rejectionReasons: validation.rejectionReasons };
      return { status: "SUCCEEDED", result, latencyMs: 0, usage: used };
    } catch (error) { return failure(error instanceof Error && /^UPSTREAM_/.test(error.message) ? error.message : "UPSTREAM_SCHEMA", used); }
  }, options);
}

/** Offline comparator only: same state/rubric, separate protocol and generation configuration. */
export async function compareWithGenerationModel(packet: DecisionAssessmentPacket, env: { DEEPSEEK_API_KEY?: string; DEEPSEEK_MODEL?: string; DEEPSEEK_URL?: string; DEEPSEEK_ALLOW_EMPTY_KEY?: boolean }, options: DecisionProviderOptions = {}): Promise<DecisionProviderAttempt> {
  let body: ReturnType<typeof buildJevHttpBody>;
  try { body = buildJevHttpBody(packet); } catch { return failure("INVALID_REQUEST"); }
  if (!env.DEEPSEEK_API_KEY && !env.DEEPSEEK_ALLOW_EMPTY_KEY) return failure("MISSING_API_KEY");
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_DECISION_COMPARISON_MODEL;
  return boundedAttempt(async (signal) => {
    const response = await (options.fetcher ?? fetch)(env.DEEPSEEK_URL ?? "https://api.deepseek.com/chat/completions", { method: "POST", signal, headers: { "content-type": "application/json", ...(env.DEEPSEEK_API_KEY ? { authorization: `Bearer ${env.DEEPSEEK_API_KEY}` } : {}) }, body: JSON.stringify({ model, temperature: 0, thinking: { type: "disabled" }, max_tokens: 2400, response_format: { type: "json_object" }, messages: [
      { role: "system", content: "Evaluate only this supplied state. Return JSON only with {model,answers}, one choice answer per question with {type:'choice',choice,confidence,probabilities}. Use the supplied criteria, exact keys and probability distributions. Do not add coaching prose. These are self-reported probabilities, not native calibrated token probabilities." },
      { role: "user", content: JSON.stringify({ state: body.state, questions: body.questions, model }) }
    ] }) });
    if (!response.ok) return failure(`HTTP_${response.status}`);
    const payload = await response.json();
    const used = usage(payload?.usage, false);
    try {
      if (payload?.choices?.[0]?.finish_reason !== "stop") return failure("UPSTREAM_FINISH", used);
      const actualModel = typeof payload.model === "string" && (payload.model === model || /^deepseek-[a-z0-9.-]{1,100}$/.test(payload.model)) ? payload.model : undefined;
      const result = { ...parseJevResponse(packet, JSON.parse(payload.choices[0].message.content), model), model: actualModel ?? model };
      const validation = validateDecisionAssessmentResult(packet, result, { allowedModel: result.model });
      if (!validation.valid) return { ...failure("VALIDATION_REJECTED", used), diagnosticResult: result, rejectionReasons: validation.rejectionReasons, ...(actualModel ? { actualModel } : {}) };
      // Evaluation provenance explicitly separates this provider from Jev.
      return { status: "SUCCEEDED", result, latencyMs: 0, usage: used, ...(actualModel ? { actualModel } : {}) };
    } catch { return failure("UPSTREAM_SCHEMA", used); }
  }, options);
}
