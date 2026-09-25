import type { NarrationBundle } from "@cs-coach/contracts";
import type { AnonymousNarrationRequest } from "./narrator-contract";

// Pure wire validation shared by the local projection and provider adapter.
export const MAX_REQUEST_BYTES = 48 * 1024;
const MAX_TEXT_LENGTH = 1600;

export class NarratorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarratorValidationError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
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

function safeText(value: unknown, maxLength = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function safeOutputText(value: unknown): value is string {
  return safeText(value) && !/\b(?:ticks?|frame|segment|order|route|ObservationState|renderer|lossless|TRADE|refId|schema|focus|pipeline|fallback|candidate)\b/i.test(value) && !/坐标/.test(value);
}

function arrayOfStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= MAX_TEXT_LENGTH);
}

function alias(value: unknown, prefix: "d" | "a" | "v" | "e" | "o" | "m"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}[1-9][0-9]{0,2}$`).test(value);
}

function assertAliasList(value: unknown, prefix: "d" | "a" | "v" | "e" | "o" | "m", name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => alias(item, prefix))) throw new NarratorValidationError(`${name} contains an invalid anonymous ref.`);
  const refs = [...value] as string[];
  if (new Set(refs).size !== refs.length) throw new NarratorValidationError(`${name} contains duplicate anonymous refs.`);
  return refs;
}

function assertRefsWithin(refs: readonly string[], allowed: ReadonlySet<string>, name: string): void {
  if (refs.some((ref) => !allowed.has(ref))) throw new NarratorValidationError(`${name} escapes its allowed namespace.`);
}

function parseClaim(value: unknown): { id: string; claimType: string; confidence: number; limitations: string[] } {
  if (!isRecord(value) || !exactKeys(value, ["id", "claimType", "confidence", "limitations"]) || !alias(value.id, "d") || !safeText(value.claimType, 120) || !finite(value.confidence) || value.confidence < 0 || value.confidence > 1 || !arrayOfStrings(value.limitations)) {
    throw new NarratorValidationError("Anonymous decision claim is invalid.");
  }
  return { id: value.id, claimType: value.claimType, confidence: value.confidence, limitations: [...value.limitations] };
}

function parseSimpleText(value: unknown, name: string): { id: string; text: string } {
  if (!isRecord(value) || !exactKeys(value, ["id", "text"]) || !nonEmpty(value.id) || !safeText(value.text)) throw new NarratorValidationError(`${name} is invalid.`);
  return { id: value.id, text: value.text };
}

function parseInference(value: unknown): { id: string; text: string; confidence: number; factRefs: string[] } {
  if (!isRecord(value) || !exactKeys(value, ["id", "text", "confidence", "factRefs"]) || !nonEmpty(value.id) || !safeText(value.text) || !finite(value.confidence) || value.confidence < 0 || value.confidence > 1 || !Array.isArray(value.factRefs) || !value.factRefs.every((ref) => alias(ref, "d"))) throw new NarratorValidationError("Anonymous inference is invalid.");
  return { id: value.id, text: value.text, confidence: value.confidence, factRefs: [...value.factRefs] as string[] };
}

function parseAdvice(value: unknown): { id: string; text: string; trigger: string; factRefs: string[] } {
  if (!isRecord(value) || !exactKeys(value, ["id", "text", "trigger", "factRefs"]) || !alias(value.id, "v") || !safeText(value.text) || !safeText(value.trigger) || !Array.isArray(value.factRefs) || !value.factRefs.every((ref) => alias(ref, "d"))) throw new NarratorValidationError("Anonymous advice is invalid.");
  return { id: value.id, text: value.text, trigger: value.trigger, factRefs: [...value.factRefs] as string[] };
}

function parseEvidence(value: unknown): { id: string; label: string; factRefs: string[] } {
  if (!isRecord(value) || !exactKeys(value, ["id", "label", "factRefs"]) || !alias(value.id, "e") || !safeText(value.label, 240) || !Array.isArray(value.factRefs) || !value.factRefs.every((ref) => alias(ref, "d"))) throw new NarratorValidationError("Anonymous evidence is invalid.");
  return { id: value.id, label: value.label, factRefs: [...value.factRefs] as string[] };
}

function parseCoachingPackage(value: unknown): AnonymousNarrationRequest["coachingPackage"] {
  if (!isRecord(value) || !exactKeys(value, ["cueId", "candidateId", "primaryFocusCode", "decisionContext", "playerAction", "inferences", "advice", "evidence", "allowedRefs", "limitations", ...(value.observableSummary === undefined ? [] : ["observableSummary"])])) throw new NarratorValidationError("Anonymous CoachingPackage shape is invalid.");
  if (value.cueId !== "c1" || value.candidateId !== "k1" || !safeText(value.primaryFocusCode, 120) || !arrayOfStrings(value.limitations) || !isRecord(value.decisionContext) || !exactKeys(value.decisionContext, ["facts", "claims"]) || !Array.isArray(value.decisionContext.facts) || !Array.isArray(value.decisionContext.claims) || !Array.isArray(value.playerAction) || !Array.isArray(value.inferences) || !Array.isArray(value.advice) || !Array.isArray(value.evidence) || !isRecord(value.allowedRefs) || !exactKeys(value.allowedRefs, ["decision", "action", "advice", "evidence"])) throw new NarratorValidationError("Anonymous CoachingPackage fields are invalid.");
  const allowedRefs = {
    decision: assertAliasList(value.allowedRefs.decision, "d", "decision refs"),
    action: assertAliasList(value.allowedRefs.action, "a", "action refs"),
    advice: assertAliasList(value.allowedRefs.advice, "v", "advice refs"),
    evidence: assertAliasList(value.allowedRefs.evidence, "e", "evidence refs")
  };
  const facts = value.decisionContext.facts.map((item) => parseSimpleText(item, "Anonymous decision fact"));
  const claims = value.decisionContext.claims.map(parseClaim);
  const playerAction = value.playerAction.map((item) => parseSimpleText(item, "Anonymous player action"));
  const inferences = value.inferences.map(parseInference);
  const advice = value.advice.map(parseAdvice);
  const evidence = value.evidence.map(parseEvidence);
  assertRefsWithin(facts.map((item) => item.id), new Set(allowedRefs.decision), "decision facts");
  assertRefsWithin(claims.map((item) => item.id), new Set(allowedRefs.decision), "decision claims");
  assertRefsWithin(playerAction.map((item) => item.id), new Set(allowedRefs.action), "player actions");
  assertRefsWithin(advice.map((item) => item.id), new Set(allowedRefs.advice), "advice");
  assertRefsWithin(evidence.map((item) => item.id), new Set(allowedRefs.evidence), "evidence");
  assertRefsWithin(inferences.flatMap((item) => item.factRefs), new Set(allowedRefs.decision), "inference refs");
  assertRefsWithin(advice.flatMap((item) => item.factRefs), new Set(allowedRefs.decision), "advice fact refs");
  assertRefsWithin(evidence.flatMap((item) => item.factRefs), new Set(allowedRefs.decision), "evidence fact refs");
  return {
    cueId: "c1",
    candidateId: "k1",
    primaryFocusCode: value.primaryFocusCode,
    ...(value.observableSummary === undefined ? {} : { observableSummary: arrayOfStrings(value.observableSummary) && value.observableSummary.length <= 12 ? [...value.observableSummary] : (() => { throw new NarratorValidationError("Observable summary is invalid."); })() }),
    decisionContext: { facts, claims },
    playerAction,
    inferences,
    advice,
    evidence,
    allowedRefs,
    limitations: [...value.limitations]
  };
}

function parseOutcomePackage(value: unknown): AnonymousNarrationRequest["outcomePackage"] {
  if (!isRecord(value) || !exactKeys(value, ["cueId", "candidateId", "outcomeFacts", "deathKillHpRefs", "measurementRefs", "confounders", "limitations", ...(value.winProbabilityImpact === undefined ? [] : ["winProbabilityImpact"]) ])) throw new NarratorValidationError("Anonymous OutcomePackage shape is invalid.");
  if (value.cueId !== "c1" || value.candidateId !== "k1" || !Array.isArray(value.outcomeFacts) || !arrayOfStrings(value.confounders) || !arrayOfStrings(value.limitations)) throw new NarratorValidationError("Anonymous OutcomePackage fields are invalid.");
  const outcomeFacts = value.outcomeFacts.map((item) => {
    if (!isRecord(item) || !exactKeys(item, ["id", "text", "outcomeKind"]) || !alias(item.id, "o") || !safeText(item.text) || !safeText(item.outcomeKind, 80)) throw new NarratorValidationError("Anonymous outcome fact is invalid.");
    return { id: item.id, text: item.text, outcomeKind: item.outcomeKind };
  });
  const deathKillHpRefs = assertAliasList(value.deathKillHpRefs, "o", "death/kill/hp refs");
  const measurementRefs = assertAliasList(value.measurementRefs, "m", "measurement refs");
  const outcomeIds = new Set(outcomeFacts.map((fact) => fact.id));
  assertRefsWithin(deathKillHpRefs, outcomeIds, "death/kill/hp refs");
  let winProbabilityImpact: { text: string; confidence: string; limitations: string[] } | undefined;
  if (value.winProbabilityImpact !== undefined) {
    if (!isRecord(value.winProbabilityImpact) || !exactKeys(value.winProbabilityImpact, ["text", "confidence", "limitations"]) || !safeText(value.winProbabilityImpact.text) || !safeText(value.winProbabilityImpact.confidence, 80) || !arrayOfStrings(value.winProbabilityImpact.limitations)) throw new NarratorValidationError("Anonymous outcome impact is invalid.");
    winProbabilityImpact = { text: value.winProbabilityImpact.text, confidence: value.winProbabilityImpact.confidence, limitations: [...value.winProbabilityImpact.limitations] };
  }
  if ((measurementRefs.length > 0) !== (winProbabilityImpact !== undefined)) throw new NarratorValidationError("measurementRefs must exist exactly when WinProbabilityImpact exists.");
  if (outcomeFacts.length === 0 && measurementRefs.length === 0) throw new NarratorValidationError("Narration requires an outcome fact or measurement ref.");
  return { cueId: "c1", candidateId: "k1", outcomeFacts, deathKillHpRefs, ...(winProbabilityImpact ? { winProbabilityImpact } : {}), measurementRefs, confounders: [...value.confounders], limitations: [...value.limitations] };
}

export function parseNarrationRequest(value: unknown, byteLength = 0): AnonymousNarrationRequest {
  if (byteLength > MAX_REQUEST_BYTES) throw new NarratorValidationError("Narration request is too large.");
  if (!isRecord(value) || !exactKeys(value, ["coachingPackage", "outcomePackage", ...(value.approvedNarration === undefined ? [] : ["approvedNarration"])])) throw new NarratorValidationError("Narration request must contain exactly CoachingPackage and OutcomePackage.");
  const coachingPackage = parseCoachingPackage(value.coachingPackage);
  const outcomePackage = parseOutcomePackage(value.outcomePackage);
  if (coachingPackage.decisionContext.facts.length === 0) throw new NarratorValidationError("Narration request is not eligible without decision, action, and advice refs.");
  const request: AnonymousNarrationRequest = { coachingPackage, outcomePackage };
  if (value.approvedNarration !== undefined) request.approvedNarration = parseProviderBundle(value.approvedNarration, request, false);
  else {
    // Legacy packets do not contain proof of applicability. Preserve the job,
    // but remove their concrete tactical suggestions from the provider input.
    request.coachingPackage.advice = [];
    request.coachingPackage.allowedRefs.advice = [];
  }
  return request;
}

interface NarrationFieldWire {
  text: string;
  refs: string[];
  confidence?: number;
  limitations?: string[];
}

function parseField(value: unknown, allowed: ReadonlySet<string>, name: string, allowEmpty = false): NarrationFieldWire {
  if (!isRecord(value)) throw new NarratorValidationError(`${name} is not an object.`);
  const keys = ["text", "refs", ...(value.confidence === undefined ? [] : ["confidence"]), ...(value.limitations === undefined ? [] : ["limitations"])] as string[];
  const confidence = value.confidence;
  if (!exactKeys(value, keys) || !safeOutputText(value.text) || !Array.isArray(value.refs) || !value.refs.every((ref) => typeof ref === "string") || (confidence !== undefined && (!finite(confidence) || confidence < 0 || confidence > 1)) || (value.limitations !== undefined && !arrayOfStrings(value.limitations))) throw new NarratorValidationError(`${name} has an invalid shape.`);
  const refs = [...value.refs] as string[];
  if ((!allowEmpty && refs.length === 0) || new Set(refs).size !== refs.length || refs.some((ref) => !allowed.has(ref))) throw new NarratorValidationError(`${name} contains an invalid ref.`);
  return { text: value.text, refs, ...(confidence === undefined ? {} : { confidence }), ...(value.limitations === undefined ? {} : { limitations: [...value.limitations] }) };
}

export function parseProviderBundle(value: unknown, request: AnonymousNarrationRequest, checkSemantics = true): NarrationBundle {
  if (!isRecord(value) || !exactKeys(value, ["cueId", "candidateId", "primaryFocusCode", "currentSituation", "playerAction", "coreIssue", "betterPlay", "outcomeImpact"]) || value.cueId !== "c1" || value.candidateId !== "k1" || value.primaryFocusCode !== request.coachingPackage.primaryFocusCode) throw new NarratorValidationError("Narration provider changed identity or primaryFocusCode.");
  const decision = new Set(request.coachingPackage.allowedRefs.decision);
  const action = new Set(request.coachingPackage.allowedRefs.action);
  const advice = new Set(request.coachingPackage.allowedRefs.advice);
  const evidence = new Set(request.coachingPackage.allowedRefs.evidence);
  const outcome = new Set([...request.outcomePackage.outcomeFacts.map((fact) => fact.id), ...request.outcomePackage.measurementRefs]);
  const currentSituation = parseField(value.currentSituation, decision, "currentSituation");
  const playerAction = parseField(value.playerAction, action, "playerAction", action.size === 0);
  const coreIssue = parseField(value.coreIssue, new Set([...decision, ...action]), "coreIssue");
  const betterPlay = parseField(value.betterPlay, new Set([...decision, ...action, ...advice, ...evidence]), "betterPlay");
  const outcomeImpact = parseField(value.outcomeImpact, outcome, "outcomeImpact");
  if (advice.size > 0 && !betterPlay.refs.some((ref) => advice.has(ref))) throw new NarratorValidationError("betterPlay requires an advice ref.");
  if (currentSituation.refs.some((ref) => outcome.has(ref)) || playerAction.refs.some((ref) => outcome.has(ref)) || betterPlay.refs.some((ref) => outcome.has(ref))) throw new NarratorValidationError("Outcome refs crossed into decision-side fields.");
  const bundle = { cueId: "c1", candidateId: "k1", primaryFocusCode: request.coachingPackage.primaryFocusCode, currentSituation, playerAction, coreIssue, betterPlay, outcomeImpact };
  if (checkSemantics) {
    // References alone do not prove a sentence. Keep the deterministic semantic
    // projection closed until a provable paraphrase representation is available.
    const approved = fallbackBundle(request);
    for (const key of ["currentSituation", "playerAction", "coreIssue", "betterPlay", "outcomeImpact"] as const) {
      if (bundle[key].text !== approved[key].text || JSON.stringify([...bundle[key].refs].sort()) !== JSON.stringify([...approved[key].refs].sort()) || bundle[key].confidence !== approved[key].confidence || JSON.stringify(bundle[key].limitations ?? []) !== JSON.stringify(approved[key].limitations ?? [])) throw new NarratorValidationError(`${key} introduces unapproved meaning.`);
    }
  }
  return bundle;
}

export function fallbackBundle(request: AnonymousNarrationRequest): NarrationBundle {
  if (request.approvedNarration) return request.approvedNarration;
  const decision = request.coachingPackage.allowedRefs.decision;
  const action = request.coachingPackage.allowedRefs.action;
  const advice = request.coachingPackage.allowedRefs.advice;
  const evidence = request.coachingPackage.allowedRefs.evidence;
  const outcomes = [...request.outcomePackage.outcomeFacts.map((fact) => fact.id), ...request.outcomePackage.measurementRefs];
  const situation = request.coachingPackage.decisionContext.facts[0]?.text ?? "当前决策事实有限。";
  const actionText = request.coachingPackage.playerAction[0]?.text ?? "当前记录不足以确认具体行动意图。";
  const adviceText = "目前还不能确认哪种替代处理在当时可行。";
  const outcomeFactText = request.outcomePackage.outcomeFacts[0]?.text;
  const outcomeImpactText = request.outcomePackage.winProbabilityImpact?.text;
  const outcomeText = [outcomeFactText, outcomeImpactText].filter((text): text is string => Boolean(text)).join(" ") || "结果测量已完成。";
  return {
    cueId: "c1",
    candidateId: "k1",
    primaryFocusCode: request.coachingPackage.primaryFocusCode,
    currentSituation: { text: situation, refs: [decision[0]] },
    playerAction: { text: actionText, refs: action.slice(0, 1) },
    coreIssue: { text: "这段结果不足以判断当时的选择是否有问题。", refs: [...decision.slice(0, 1), ...action.slice(0, 1)] },
    betterPlay: { text: adviceText, refs: decision.slice(0, 1) },
    outcomeImpact: { text: outcomeText, refs: [...outcomes] }
  };
}
