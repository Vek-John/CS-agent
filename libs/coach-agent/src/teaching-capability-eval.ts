import { DeterministicPolicyAdapter, type PolicyAdapter } from "./adapters";
import { buildTeachingCapabilities } from "./capability-builder";
import {
  PolicyInputSchema,
  PolicyOutputSchema,
  type AllowedEvidenceSummary,
  type CapabilityBuilderInput,
  type PolicyInput,
  type TeachingToolName,
} from "./types";

export interface TeachingCapabilityEvalCase {
  id: string;
  input: CapabilityBuilderInput;
  /** The legal capabilities the builder is expected to expose. */
  legalCapabilities: TeachingToolName[];
  /** Whether the policy should actually request a visual teaching move. */
  needVisual: boolean;
  preferredCapability: TeachingToolName | "FINISH_CUE";
  forbiddenCapabilities: TeachingToolName[];
  requiredEvidenceRefs: string[];
  acceptableAlternatives: TeachingToolName[];
}

export interface TeachingCapabilityEvalStats {
  totalCases: number;
  needToolAccuracy: number;
  preferredCapabilityAccuracyWhenNeeded: number;
  illegalSelectionAccuracy: number;
  requiredEvidenceAccuracy: number;
  legalCapabilityAccuracy: number;
  policySelectionCount: number;
  finishSelectionCount: number;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function baseInput(cueId: string, overrides: Partial<CapabilityBuilderInput> = {}): CapabilityBuilderInput {
  return {
    cueId,
    primaryFocusCode: "POSITIONING",
    decisionRefs: [],
    actionRefs: [],
    outcomeRefs: [],
    evidenceRefs: [],
    annotationRefs: [],
    actorRefs: [],
    calloutRefs: [],
    grenadeTrajectoryRefs: [],
    grenadeLandingRefs: [],
    outcomeGateStatus: "COMPLETE",
    modelStatus: "AVAILABLE",
    measurementRefs: [],
    negativeWinProbabilitySwingPercentagePoints: null,
    economyContext: { reliable: false, relevant: false, ref: null, economyClass: "UNKNOWN" },
    limitations: [],
    ...overrides,
  };
}

const allModalEvidence = {
  decisionRefs: ["decision-multi"],
  actionRefs: ["action-multi"],
  outcomeRefs: ["outcome-multi"],
  evidenceRefs: ["evidence-multi"],
  annotationRefs: ["annotation-multi"],
  actorRefs: ["actor-multi"],
  calloutRefs: ["callout-multi"],
  grenadeTrajectoryRefs: ["trajectory-multi"],
  grenadeLandingRefs: ["landing-multi"],
  measurementRefs: ["measurement-multi"],
  negativeWinProbabilitySwingPercentagePoints: -4,
  economyContext: { reliable: true, relevant: true, ref: "economy-multi", economyClass: "FORCE" as const },
};

export const teachingCapabilityEvalCases: readonly TeachingCapabilityEvalCase[] = [
  { id: "slow-action", input: baseInput("cue-slow-action", { primaryFocusCode: "TIMING_DECISION", actionRefs: ["a-slow-1"] }), legalCapabilities: ["REPLAY_CUE_SLOW"], needVisual: true, preferredCapability: "REPLAY_CUE_SLOW", forbiddenCapabilities: ["FOCUS_MAP_EVIDENCE", "SHOW_GRENADE_TRACE", "SHOW_WIN_RATE_IMPACT", "SHOW_ECONOMY_CONTEXT"], requiredEvidenceRefs: ["a-slow-1"], acceptableAlternatives: [] },
  { id: "decision-only-no-replay", input: baseInput("cue-decision-only", { primaryFocusCode: "TIMING_DECISION", decisionRefs: ["d-only-1"] }), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: ["REPLAY_CUE_SLOW"], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "outcome-only-no-replay", input: baseInput("cue-outcome-only", { primaryFocusCode: "TIMING_DECISION", outcomeRefs: ["o-only-1"] }), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: ["REPLAY_CUE_SLOW"], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "evidence-only-finish", input: baseInput("cue-evidence-only", { evidenceRefs: ["e-only-1"] }), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: ["REPLAY_CUE_SLOW"], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "map-annotation", input: baseInput("cue-map-annotation", { primaryFocusCode: "POSITIONING", annotationRefs: ["an-map-1"], actorRefs: ["actor-map-1"] }), legalCapabilities: ["FOCUS_MAP_EVIDENCE"], needVisual: true, preferredCapability: "FOCUS_MAP_EVIDENCE", forbiddenCapabilities: ["SHOW_GRENADE_TRACE", "SHOW_WIN_RATE_IMPACT", "SHOW_ECONOMY_CONTEXT"], requiredEvidenceRefs: ["an-map-1"], acceptableAlternatives: [] },
  { id: "map-callout", input: baseInput("cue-map-callout", { primaryFocusCode: "POSITIONING", annotationRefs: ["an-map-2"], calloutRefs: ["callout-map-2"] }), legalCapabilities: ["FOCUS_MAP_EVIDENCE"], needVisual: true, preferredCapability: "FOCUS_MAP_EVIDENCE", forbiddenCapabilities: [], requiredEvidenceRefs: ["an-map-2"], acceptableAlternatives: [] },
  { id: "map-no-space", input: baseInput("cue-map-none"), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: ["FOCUS_MAP_EVIDENCE"], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "map-evidence", input: baseInput("cue-map-evidence", { primaryFocusCode: "POSITIONING", annotationRefs: ["an-map-3"], evidenceRefs: ["e-map-3"] }), legalCapabilities: ["FOCUS_MAP_EVIDENCE"], needVisual: true, preferredCapability: "FOCUS_MAP_EVIDENCE", forbiddenCapabilities: [], requiredEvidenceRefs: ["an-map-3"], acceptableAlternatives: [] },
  { id: "grenade-full", input: baseInput("cue-grenade-full", { primaryFocusCode: "UTILITY_PURPOSE_AND_TEMPO", grenadeTrajectoryRefs: ["tr-grenade-1"], grenadeLandingRefs: ["land-grenade-1"] }), legalCapabilities: ["SHOW_GRENADE_TRACE"], needVisual: true, preferredCapability: "SHOW_GRENADE_TRACE", forbiddenCapabilities: ["FOCUS_MAP_EVIDENCE", "SHOW_WIN_RATE_IMPACT", "SHOW_ECONOMY_CONTEXT"], requiredEvidenceRefs: ["tr-grenade-1", "land-grenade-1"], acceptableAlternatives: [] },
  { id: "grenade-two", input: baseInput("cue-grenade-two", { primaryFocusCode: "UTILITY_PURPOSE_AND_TEMPO", grenadeTrajectoryRefs: ["tr-grenade-2"], grenadeLandingRefs: ["land-grenade-2"], evidenceRefs: ["e-grenade-2"] }), legalCapabilities: ["SHOW_GRENADE_TRACE"], needVisual: true, preferredCapability: "SHOW_GRENADE_TRACE", forbiddenCapabilities: [], requiredEvidenceRefs: ["land-grenade-2"], acceptableAlternatives: [] },
  { id: "grenade-no-landing", input: baseInput("cue-grenade-no-landing", { primaryFocusCode: "UTILITY_PURPOSE_AND_TEMPO", grenadeTrajectoryRefs: ["tr-grenade-3"] }), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: ["SHOW_GRENADE_TRACE"], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "grenade-no-trajectory", input: baseInput("cue-grenade-no-trajectory", { primaryFocusCode: "UTILITY_PURPOSE_AND_TEMPO", grenadeLandingRefs: ["land-grenade-4"] }), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: ["SHOW_GRENADE_TRACE"], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "win-rate-large-drop", input: baseInput("cue-win-large", { primaryFocusCode: "WIN_PROBABILITY_SWING_RESPONSE", outcomeRefs: ["outcome-win-1"], measurementRefs: ["measure-win-1"], negativeWinProbabilitySwingPercentagePoints: -5 }), legalCapabilities: ["SHOW_WIN_RATE_IMPACT"], needVisual: true, preferredCapability: "SHOW_WIN_RATE_IMPACT", forbiddenCapabilities: ["SHOW_ECONOMY_CONTEXT"], requiredEvidenceRefs: ["measure-win-1"], acceptableAlternatives: [] },
  { id: "win-rate-one-pp", input: baseInput("cue-win-one", { primaryFocusCode: "WIN_PROBABILITY_SWING_RESPONSE", outcomeRefs: ["outcome-win-2"], measurementRefs: ["measure-win-2"], negativeWinProbabilitySwingPercentagePoints: -1 }), legalCapabilities: ["SHOW_WIN_RATE_IMPACT"], needVisual: true, preferredCapability: "SHOW_WIN_RATE_IMPACT", forbiddenCapabilities: [], requiredEvidenceRefs: ["measure-win-2"], acceptableAlternatives: [] },
  { id: "win-rate-small-drop", input: baseInput("cue-win-small", { primaryFocusCode: "WIN_PROBABILITY_SWING_RESPONSE", measurementRefs: ["measure-win-3"], negativeWinProbabilitySwingPercentagePoints: -0.5 }), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: ["SHOW_WIN_RATE_IMPACT"], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "win-rate-no-model", input: baseInput("cue-win-no-model", { primaryFocusCode: "WIN_PROBABILITY_SWING_RESPONSE", measurementRefs: ["measure-win-4"], negativeWinProbabilitySwingPercentagePoints: -4, modelStatus: "UNAVAILABLE" }), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: ["SHOW_WIN_RATE_IMPACT"], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "economy-force", input: baseInput("cue-economy-force", { primaryFocusCode: "ECONOMY_CHANGES_RISK", economyContext: { reliable: true, relevant: true, ref: "economy-force-1", economyClass: "FORCE" } }), legalCapabilities: ["SHOW_ECONOMY_CONTEXT"], needVisual: true, preferredCapability: "SHOW_ECONOMY_CONTEXT", forbiddenCapabilities: ["SHOW_WIN_RATE_IMPACT"], requiredEvidenceRefs: ["economy-force-1"], acceptableAlternatives: [] },
  { id: "economy-eco", input: baseInput("cue-economy-eco", { primaryFocusCode: "ECONOMY_CHANGES_RISK", economyContext: { reliable: true, relevant: true, ref: "economy-eco-1", economyClass: "ECO" } }), legalCapabilities: ["SHOW_ECONOMY_CONTEXT"], needVisual: true, preferredCapability: "SHOW_ECONOMY_CONTEXT", forbiddenCapabilities: [], requiredEvidenceRefs: ["economy-eco-1"], acceptableAlternatives: [] },
  { id: "economy-unreliable", input: baseInput("cue-economy-unreliable", { primaryFocusCode: "ECONOMY_CHANGES_RISK", economyContext: { reliable: false, relevant: true, ref: "economy-bad-1", economyClass: "FULL" } }), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: ["SHOW_ECONOMY_CONTEXT"], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "finish-empty", input: baseInput("cue-finish-empty"), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: ["REPLAY_CUE_SLOW", "FOCUS_MAP_EVIDENCE", "SHOW_GRENADE_TRACE", "SHOW_WIN_RATE_IMPACT", "SHOW_ECONOMY_CONTEXT"], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "multi-ambiguous-finish", input: baseInput("cue-multi-finish", { primaryFocusCode: "UNRELATED_CONTEXT", ...allModalEvidence }), legalCapabilities: [], needVisual: false, preferredCapability: "FINISH_CUE", forbiddenCapabilities: [], requiredEvidenceRefs: [], acceptableAlternatives: [] },
  { id: "multi-position-policy", input: baseInput("cue-multi-position", { primaryFocusCode: "ADVANTAGE_OVERPEEK", ...allModalEvidence }), legalCapabilities: ["REPLAY_CUE_SLOW", "FOCUS_MAP_EVIDENCE"], needVisual: true, preferredCapability: "FOCUS_MAP_EVIDENCE", forbiddenCapabilities: [], requiredEvidenceRefs: ["decision-multi"], acceptableAlternatives: ["REPLAY_CUE_SLOW"] },
  { id: "multi-timing-policy", input: baseInput("cue-multi-timing", { primaryFocusCode: "ADVANTAGE_OVERPEEK", ...allModalEvidence }), legalCapabilities: ["REPLAY_CUE_SLOW", "FOCUS_MAP_EVIDENCE"], needVisual: true, preferredCapability: "REPLAY_CUE_SLOW", forbiddenCapabilities: [], requiredEvidenceRefs: ["action-multi"], acceptableAlternatives: [] },
];

function addSummary(
  summaries: Map<AllowedEvidenceSummary["namespace"], string[]>,
  namespace: AllowedEvidenceSummary["namespace"],
  refs: readonly string[],
): void {
  const values = summaries.get(namespace) ?? [];
  summaries.set(namespace, unique([...values, ...refs]));
}

export function policyInputForTeachingEval(
  testCase: TeachingCapabilityEvalCase,
  capabilities = buildTeachingCapabilities(testCase.input),
): PolicyInput {
  const input = testCase.input;
  const summaries = new Map<AllowedEvidenceSummary["namespace"], string[]>();
  addSummary(summaries, "DECISION", input.decisionRefs);
  addSummary(summaries, "ACTION", input.actionRefs);
  addSummary(summaries, "OUTCOME", input.outcomeRefs);
  addSummary(summaries, "MEASUREMENT", input.measurementRefs);
  addSummary(summaries, "EVIDENCE", [
    ...input.evidenceRefs,
    ...input.annotationRefs,
    ...input.actorRefs,
    ...input.calloutRefs,
    ...input.grenadeTrajectoryRefs,
    ...input.grenadeLandingRefs,
    ...(input.economyContext.ref ? [input.economyContext.ref] : []),
  ]);
  return PolicyInputSchema.parse({
    cueId: input.cueId,
    focus: input.primaryFocusCode,
    narrationSummary: {
      primaryFocusCode: input.primaryFocusCode,
      readiness: "READY",
      limitationCount: input.limitations.length,
      fields: {
        currentSituation: { text: "compact decision context", refs: unique([...input.decisionRefs, ...input.evidenceRefs]).slice(0, 8), limitations: [] },
        playerAction: { text: "compact verified action context", refs: unique(input.actionRefs).slice(0, 8), limitations: input.actionRefs.length === 0 ? ["NO_ACTION_FACT"] : [] },
        coreIssue: { text: "compact focus context", refs: unique([...input.decisionRefs, ...input.actionRefs]).slice(0, 8), limitations: [] },
        betterPlay: { text: "compact rule context", refs: unique([...input.actionRefs, ...input.evidenceRefs]).slice(0, 8), limitations: [] },
        outcomeImpact: { text: "compact outcome context", refs: unique([...input.outcomeRefs, ...input.measurementRefs]).slice(0, 8), limitations: input.measurementRefs.length === 0 ? ["NO_MEASUREMENT"] : [] },
      },
    },
    allowedEvidenceSummary: [...summaries.entries()]
      .filter(([, refs]) => refs.length > 0)
      .map(([namespace, refs]) => ({ namespace, refs })),
    phase: "PAUSED_FOR_COACHING",
    outcomeGateStatus: input.outcomeGateStatus,
    capabilities: capabilities.map(({ capabilityId, tool, evidenceRefs, estimatedDurationMs }) => ({
      capabilityId,
      tool,
      evidenceRefs,
      estimatedDurationMs,
    })),
    toolObservations: [],
    themes: [],
    limitations: input.limitations,
    budget: { policyCalls: 0, maxPolicyCalls: 1, alternativeAttempts: 0, maxAlternativeAttempts: 1 },
    maxMoves: 1,
  });
}

export async function runTeachingCapabilityEval(
  cases: readonly TeachingCapabilityEvalCase[] = teachingCapabilityEvalCases,
  policy: PolicyAdapter = new DeterministicPolicyAdapter(),
): Promise<TeachingCapabilityEvalStats> {
  let needToolPasses = 0;
  let preferredPasses = 0;
  let illegalSelectionPasses = 0;
  let requiredEvidencePasses = 0;
  let legalCapabilityPasses = 0;
  let policySelectionCount = 0;
  let finishSelectionCount = 0;

  for (const testCase of cases) {
    const capabilities = buildTeachingCapabilities(testCase.input);
    const legalTools = capabilities.map((capability) => capability.tool);
    if (JSON.stringify(legalTools) === JSON.stringify(testCase.legalCapabilities)) legalCapabilityPasses += 1;

    const policyInput = policyInputForTeachingEval(testCase, capabilities);
    const output = PolicyOutputSchema.parse(await policy.selectCapability(policyInput));
    const selected = output.action === "SELECT_CAPABILITY"
      ? capabilities.find((capability) => capability.capabilityId === output.capabilityId)
      : undefined;
    const selectedTool = selected?.tool;
    if (selectedTool) policySelectionCount += 1;
    else finishSelectionCount += 1;

    if (Boolean(selectedTool) === testCase.needVisual) needToolPasses += 1;
    if (
      testCase.needVisual &&
      (selectedTool === testCase.preferredCapability || testCase.acceptableAlternatives.includes(selectedTool as TeachingToolName))
    ) preferredPasses += 1;

    const selectedIsLegal = output.action === "FINISH_CUE" || Boolean(selected);
    if (selectedIsLegal && (!selectedTool || !testCase.forbiddenCapabilities.includes(selectedTool))) illegalSelectionPasses += 1;

    const required = new Set(testCase.requiredEvidenceRefs);
    const outputRefs = new Set(output.evidenceRefs);
    if ([...required].every((ref) => outputRefs.has(ref))) requiredEvidencePasses += 1;
  }

  const percentage = (passes: number, total: number) => total === 0 ? 100 : Math.round((passes / total) * 10000) / 100;
  const neededCases = cases.filter((testCase) => testCase.needVisual).length;
  return {
    totalCases: cases.length,
    needToolAccuracy: percentage(needToolPasses, cases.length),
    preferredCapabilityAccuracyWhenNeeded: percentage(preferredPasses, neededCases),
    illegalSelectionAccuracy: percentage(illegalSelectionPasses, cases.length),
    requiredEvidenceAccuracy: percentage(requiredEvidencePasses, cases.length),
    legalCapabilityAccuracy: percentage(legalCapabilityPasses, cases.length),
    policySelectionCount,
    finishSelectionCount,
  };
}

export function formatTeachingCapabilityEval(stats: TeachingCapabilityEvalStats): string {
  return `teaching-capability-eval cases=${stats.totalCases} need-tool=${stats.needToolAccuracy}% preferred-when-needed=${stats.preferredCapabilityAccuracyWhenNeeded}% illegal=${100 - stats.illegalSelectionAccuracy}% evidence=${stats.requiredEvidenceAccuracy}% legal-generation=${stats.legalCapabilityAccuracy}% policy-select=${stats.policySelectionCount} finish=${stats.finishSelectionCount}`;
}
