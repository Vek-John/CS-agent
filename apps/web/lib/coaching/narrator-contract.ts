import type { CoachingPackage, NarrationBundle, NarrationManifest, NarrationResult, ObservationClaim, OutcomePackage } from "@cs-coach/contracts";
import {
  assertValidNarrationBundle,
  assertPackageNamespaces,
  buildCoachingPackage,
  buildOutcomeImpactForCue,
  buildOutcomePackage,
  deterministicNarrationBundle
} from "@cs-coach/review-planner";

export { buildCoachingPackage, buildOutcomeImpactForCue, buildOutcomePackage } from "@cs-coach/review-planner";

export interface AnonymousNarrationField {
  text: string;
  refs: string[];
  confidence?: number;
  limitations?: string[];
}

export interface AnonymousNarrationRequest {
  coachingPackage: {
    cueId: string;
    candidateId: string;
    primaryFocusCode: string;
    decisionContext: {
      facts: Array<{ id: string; text: string }>;
      claims: Array<{ id: string; claimType: string; confidence: number; limitations: string[] }>;
    };
    playerAction: Array<{ id: string; text: string }>;
    inferences: Array<{ id: string; text: string; confidence: number; factRefs: string[] }>;
    advice: Array<{ id: string; text: string; trigger: string; factRefs: string[] }>;
    evidence: Array<{ id: string; label: string; factRefs: string[] }>;
    allowedRefs: {
      decision: string[];
      action: string[];
      advice: string[];
      evidence: string[];
    };
    limitations: string[];
  };
  outcomePackage: {
    cueId: string;
    candidateId: string;
    outcomeFacts: Array<{ id: string; text: string; outcomeKind: string }>;
    deathKillHpRefs: string[];
    winProbabilityImpact?: { text: string; confidence: string; limitations: string[] };
    measurementRefs: string[];
    confounders: string[];
    limitations: string[];
  };
}

export interface NarratorRequestContext {
  request: AnonymousNarrationRequest;
  coachingPackage: CoachingPackage;
  outcomePackage: OutcomePackage;
  aliases: {
    decision: Record<string, string>;
    action: Record<string, string>;
    advice: Record<string, string>;
    evidence: Record<string, string>;
    outcome: Record<string, string>;
    measurement: Record<string, string>;
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function aliasesFor(ids: readonly string[], prefix: string): Record<string, string> {
  return Object.fromEntries(ids.map((id, index) => [id, `${prefix}${index + 1}`]));
}

function remap(refs: readonly string[], aliases: Record<string, string>): string[] {
  return refs.map((ref) => aliases[ref]).filter((ref): ref is string => Boolean(ref));
}

function safeClaim(claim: ObservationClaim): { id: string; claimType: string; confidence: number; limitations: string[] } {
  return {
    id: claim.id,
    claimType: claim.claim_type,
    confidence: claim.confidence,
    limitations: [...claim.limitations]
  };
}

export function buildNarratorRequestContext(
  coachingPackage: CoachingPackage,
  outcomePackage: OutcomePackage
): NarratorRequestContext {
  assertPackageNamespaces(coachingPackage, outcomePackage);
  const decisionIds = coachingPackage.allowedRefs.decision;
  const actionIds = coachingPackage.allowedRefs.action;
  const adviceIds = coachingPackage.allowedRefs.advice;
  const evidenceIds = coachingPackage.allowedRefs.evidence;
  const outcomeIds = outcomePackage.outcomeFacts.map((fact) => fact.id);
  const measurementIds = outcomePackage.measurementRefs;
  const aliases = {
    decision: aliasesFor(decisionIds, "d"),
    action: aliasesFor(actionIds, "a"),
    advice: aliasesFor(adviceIds, "v"),
    evidence: aliasesFor(evidenceIds, "e"),
    outcome: aliasesFor(outcomeIds, "o"),
    measurement: aliasesFor(measurementIds, "m")
  };
  const request: AnonymousNarrationRequest = {
    coachingPackage: {
      cueId: "c1",
      candidateId: "k1",
      primaryFocusCode: coachingPackage.primaryFocusCode,
      decisionContext: {
        facts: coachingPackage.decisionContext.facts.map((fact) => ({ id: aliases.decision[fact.id], text: fact.text })),
        claims: coachingPackage.decisionContext.claims.map(safeClaim).map((claim) => ({ ...claim, id: aliases.decision[claim.id] ?? claim.id }))
      },
      playerAction: coachingPackage.playerAction.map((fact) => ({ id: aliases.action[fact.id], text: fact.text })),
      inferences: coachingPackage.inferences.map((inference) => ({ id: `i${inference.id}`, text: inference.text, confidence: inference.confidence, factRefs: remap(inference.fact_refs, aliases.decision) })),
      advice: coachingPackage.advice.map((advice) => ({ id: aliases.advice[advice.id], text: advice.text, trigger: advice.trigger, factRefs: remap(advice.fact_refs, aliases.decision) })),
      evidence: coachingPackage.evidence.map((evidence) => ({ id: aliases.evidence[evidence.id], label: evidence.label, factRefs: remap(evidence.fact_refs, aliases.decision) })),
      allowedRefs: {
        decision: Object.values(aliases.decision),
        action: Object.values(aliases.action),
        advice: Object.values(aliases.advice),
        evidence: Object.values(aliases.evidence)
      },
      limitations: [...coachingPackage.limitations]
    },
    outcomePackage: {
      cueId: "c1",
      candidateId: "k1",
      outcomeFacts: outcomePackage.outcomeFacts.map((fact) => ({ id: aliases.outcome[fact.id], text: fact.text, outcomeKind: fact.outcomeKind })),
      deathKillHpRefs: remap(outcomePackage.deathKillHpRefs, aliases.outcome),
      ...(outcomePackage.winProbabilityImpact ? { winProbabilityImpact: { text: outcomePackage.winProbabilityImpact.text, confidence: outcomePackage.winProbabilityImpact.confidence, limitations: [...outcomePackage.winProbabilityImpact.limitations] } } : {}),
      measurementRefs: remap(measurementIds, aliases.measurement),
      confounders: [...outcomePackage.confounders],
      limitations: [...outcomePackage.limitations]
    }
  };
  return { request, coachingPackage, outcomePackage, aliases };
}

export function narrationJobIsEligible(context: NarratorRequestContext): boolean {
  const request = context.request;
  return request.coachingPackage.decisionContext.facts.length > 0 &&
    request.coachingPackage.playerAction.length > 0 &&
    request.coachingPackage.advice.length > 0 &&
    (request.outcomePackage.outcomeFacts.length > 0 || request.outcomePackage.measurementRefs.length > 0);
}

function remapBundle(bundle: NarrationBundle, context: NarratorRequestContext): NarrationBundle {
  if (bundle.cueId !== "c1" || bundle.candidateId !== "k1") throw new Error("Narration provider changed anonymous identity.");
  if (bundle.primaryFocusCode !== context.coachingPackage.primaryFocusCode) throw new Error("Narration provider changed primaryFocusCode.");
  const reverse = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([real, anonymous]) => [anonymous, real]));
  const decision = reverse(context.aliases.decision);
  const action = reverse(context.aliases.action);
  const advice = reverse(context.aliases.advice);
  const evidence = reverse(context.aliases.evidence);
  const outcome = reverse({ ...context.aliases.outcome, ...context.aliases.measurement });
  const remapField = (field: { text: string; refs: readonly string[]; confidence?: number; limitations?: readonly string[] }, refs: Record<string, string>) => ({ ...field, refs: field.refs.map((ref) => refs[ref]).filter((ref): ref is string => Boolean(ref)) });
  return {
    ...bundle,
    cueId: context.coachingPackage.cueId,
    candidateId: context.coachingPackage.candidateId,
    primaryFocusCode: context.coachingPackage.primaryFocusCode,
    currentSituation: remapField(bundle.currentSituation, decision),
    playerAction: remapField(bundle.playerAction, action),
    coreIssue: remapField(bundle.coreIssue, { ...decision, ...action }),
    betterPlay: remapField(bundle.betterPlay, { ...decision, ...action, ...advice, ...evidence }),
    outcomeImpact: remapField(bundle.outcomeImpact, outcome)
  };
}

export function mapNarrationBundle(bundle: NarrationBundle, context: NarratorRequestContext): NarrationBundle {
  const mapped = remapBundle(bundle, context);
  assertValidNarrationBundle(mapped, context.coachingPackage, context.outcomePackage);
  return mapped;
}

export function deterministicNarrationFallback(context: NarratorRequestContext): NarrationBundle {
  return deterministicNarrationBundle(context.coachingPackage, context.outcomePackage);
}

interface NarrationFetcher {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

function fallbackResult(context: NarratorRequestContext, reason: string): NarrationResult {
  const bundle = deterministicNarrationFallback(context);
  assertValidNarrationBundle(bundle, context.coachingPackage, context.outcomePackage);
  const manifest: NarrationManifest = {
    status: "FALLBACK",
    provider: "DETERMINISTIC",
    reason,
    promptVersion: "review-planner/deterministic-narration/1.0.0",
    limitations: [reason]
  };
  return { status: "FALLBACK", bundle, manifest };
}

/** Client seam: anonymize once, call the single-cue provider, then remap and validate. */
export async function requestNarrationBundle(
  context: NarratorRequestContext,
  options: { endpoint?: string; fetcher?: NarrationFetcher; signal?: AbortSignal } = {}
): Promise<NarrationResult> {
  if (!narrationJobIsEligible(context)) return fallbackResult(context, "NARRATION_NOT_ELIGIBLE");
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(options.endpoint ?? "/api/coaching/narrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify(context.request)
    });
    if (!response.ok) return fallbackResult(context, `HTTP_${response.status}`);
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fallbackResult(context, "CLIENT_SCHEMA");
    const value = payload as Record<string, unknown>;
    if (!exactKeys(value, ["status", "bundle", "manifest"]) || !["SUCCEEDED", "FALLBACK", "DISABLED"].includes(String(value.status)) || !value.manifest || typeof value.manifest !== "object" || Array.isArray(value.manifest)) return fallbackResult(context, "CLIENT_SCHEMA");
    const manifestValue = value.manifest as Record<string, unknown>;
    const manifestKeys = ["status", "provider", "promptVersion", "limitations", ...(manifestValue.reason === undefined ? [] : ["reason"]), ...(manifestValue.model === undefined ? [] : ["model"])];
    const responseStatus = String(value.status);
    const manifestStatus = String(manifestValue.status);
    const provider = String(manifestValue.provider);
    if (!exactKeys(manifestValue, manifestKeys) || responseStatus !== manifestStatus || !["SUCCEEDED", "FALLBACK", "DISABLED"].includes(manifestStatus) || !["DETERMINISTIC", "DEEPSEEK"].includes(provider) || (responseStatus === "SUCCEEDED" && provider !== "DEEPSEEK") || (responseStatus !== "SUCCEEDED" && provider !== "DETERMINISTIC") || typeof manifestValue.promptVersion !== "string" || !Array.isArray(manifestValue.limitations) || !manifestValue.limitations.every((item) => typeof item === "string") || (manifestValue.reason !== undefined && typeof manifestValue.reason !== "string") || (manifestValue.model !== undefined && typeof manifestValue.model !== "string")) return fallbackResult(context, "CLIENT_SCHEMA");
    const bundle = mapNarrationBundle(value.bundle as NarrationBundle, context);
    const manifest: NarrationManifest = {
      status: manifestValue.status as NarrationManifest["status"],
      provider: manifestValue.provider as NarrationManifest["provider"],
      ...(typeof manifestValue.reason === "string" ? { reason: manifestValue.reason } : {}),
      ...(typeof manifestValue.model === "string" ? { model: manifestValue.model } : {}),
      promptVersion: manifestValue.promptVersion,
      limitations: [...manifestValue.limitations]
    };
    return { status: manifest.status, bundle, manifest };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return fallbackResult(context, "CLIENT_SCHEMA");
  }
}
