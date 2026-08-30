import {
  PolicyInputSchema,
  type PolicyInput,
  type PolicyOutput,
  type TeachingToolName,
} from "./types";

type FocusFamily = "TIMING" | "POSITION" | "UTILITY" | "IMPACT" | "ECONOMY";

function normalized(value: string): string {
  return value.trim().toUpperCase();
}

function focusFamily(value: string): FocusFamily | undefined {
  const focus = normalized(value);
  if (/(TIMING|PEEK|CONTACT|ADVANTAGE|SURVIVE)/.test(focus)) return "TIMING";
  if (/(POSITION|MAP|SPACING|COVER|ROTATE)/.test(focus)) return "POSITION";
  if (/(UTILITY|GRENADE|SMOKE|FLASH|MOLOTOV)/.test(focus)) return "UTILITY";
  if (/(WIN|IMPACT|PROBABILITY)/.test(focus)) return "IMPACT";
  if (/(ECONOMY|RISK|BUY)/.test(focus)) return "ECONOMY";
  return undefined;
}

function familyForTool(tool: TeachingToolName): FocusFamily {
  switch (tool) {
    case "REPLAY_CUE_SLOW": return "TIMING";
    case "FOCUS_MAP_EVIDENCE": return "POSITION";
    case "SHOW_GRENADE_TRACE": return "UTILITY";
    case "SHOW_WIN_RATE_IMPACT": return "IMPACT";
    case "SHOW_ECONOMY_CONTEXT": return "ECONOMY";
  }
}

function rationaleForTool(tool: TeachingToolName): PolicyOutput["rationaleCode"] {
  switch (tool) {
    case "REPLAY_CUE_SLOW": return "TIMING_NEEDS_SLOW_REPLAY";
    case "FOCUS_MAP_EVIDENCE": return "POSITION_NEEDS_MAP_FOCUS";
    case "SHOW_GRENADE_TRACE": return "UTILITY_NEEDS_TRAJECTORY";
    case "SHOW_WIN_RATE_IMPACT": return "IMPACT_NEEDS_WIN_RATE";
    case "SHOW_ECONOMY_CONTEXT": return "ECONOMY_CHANGES_RISK";
  }
}

function evidenceNamespaces(input: PolicyInput, refs: readonly string[]): Set<string> {
  const referenceSet = new Set(refs);
  return new Set(
    input.allowedEvidenceSummary
      .filter((summary) => summary.refs.some((ref) => referenceSet.has(ref)))
      .map((summary) => summary.namespace),
  );
}

function evidenceScore(tool: TeachingToolName, namespaces: Set<string>): number {
  switch (tool) {
    case "REPLAY_CUE_SLOW":
      return namespaces.has("ACTION") || namespaces.has("DECISION") ? 1 : 0;
    case "SHOW_WIN_RATE_IMPACT":
      return namespaces.has("MEASUREMENT") ? 1 : 0;
    case "FOCUS_MAP_EVIDENCE":
    case "SHOW_GRENADE_TRACE":
    case "SHOW_ECONOMY_CONTEXT":
      return namespaces.has("EVIDENCE") ? 1 : 0;
  }
}

/**
 * A memory brief is a teaching hint, never a fact source.  When the provider
 * is unavailable the deterministic fallback still gives that hint a small,
 * evidence-preserving effect: an active cross-Demo thread asks for a fresh
 * transfer check, while a user correction gets the strongest re-check bias.
 * The current cue evidence/focus score remains dominant, so memory cannot
 * select an unavailable or unsupported capability.
 */
function memorySignalScore(input: PolicyInput, tool: TeachingToolName): number {
  const brief = input.memoryBrief;
  if (!brief) return 0;
  const corrections = Array.isArray(brief.corrections) ? brief.corrections.length : 0;
  const activeThreads = Array.isArray(brief.activeThreads) ? brief.activeThreads.length : 0;
  if (corrections > 0) return tool === "REPLAY_CUE_SLOW" ? 3 : tool === "FOCUS_MAP_EVIDENCE" ? 1 : 0;
  if (activeThreads > 0) return tool === "REPLAY_CUE_SLOW" ? 2 : tool === "FOCUS_MAP_EVIDENCE" ? 1 : 0;
  return 0;
}

function finish(): PolicyOutput {
  return {
    action: "FINISH_CUE",
    evidenceRefs: [],
    rationaleCode: "NO_EXTRA_VISUAL_VALUE",
    confidence: 0,
  };
}

/**
 * Deterministic policy seam shared by graph fallback, provider fallback and
 * evals. It can only choose a supplied capability; it never binds arguments.
 * A unique focus/evidence match is required. Ambiguous legal capabilities
 * intentionally finish instead of inventing a teaching priority.
 */
export function deterministicPolicyOutput(rawInput: PolicyInput): PolicyOutput {
  const input = PolicyInputSchema.parse(rawInput);
  if (
    input.outcomeGateStatus !== "COMPLETE" ||
    !["READY", "FALLBACK"].includes(input.narrationSummary.readiness) ||
    input.capabilities.length === 0
  ) {
    return finish();
  }

  const family = focusFamily(`${input.narrationSummary.primaryFocusCode} ${input.focus}`);
  const scored = input.capabilities.map((capability) => {
    const namespaces = evidenceNamespaces(input, capability.evidenceRefs);
    const focusScore = family === familyForTool(capability.tool) ? 4 : 0;
    const score = focusScore + evidenceScore(capability.tool, namespaces) + memorySignalScore(input, capability.tool);
    return { capability, score };
  });
  const bestScore = Math.max(...scored.map((item) => item.score));
  if (bestScore <= 0) return finish();
  const best = scored.filter((item) => item.score === bestScore);
  if (best.length !== 1) return finish();

  const selected = best[0].capability;
  const allowedRefs = new Set(input.allowedEvidenceSummary.flatMap((summary) => summary.refs));
  const evidenceRefs = selected.evidenceRefs.filter((ref) => allowedRefs.has(ref)).slice(0, 4);
  if (selected.evidenceRefs.length > 0 && evidenceRefs.length === 0) return finish();
  return {
    action: "SELECT_CAPABILITY",
    capabilityId: selected.capabilityId,
    evidenceRefs,
    rationaleCode: rationaleForTool(selected.tool),
    confidence: bestScore >= 5 ? 0.95 : 0.7,
  };
}
