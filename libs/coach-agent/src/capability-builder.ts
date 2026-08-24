import {
  CapabilityBuilderInputSchema,
  TeachingCapabilitySchema,
  type CapabilityBuilderInput,
  type TeachingCapability,
} from "./types";

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function capabilityId(cueId: string, suffix: string): string {
  const slug = cueId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cue";
  return `cap-${slug}-${suffix}`;
}

function commonRefs(input: CapabilityBuilderInput): string[] {
  return unique([
    ...input.decisionRefs,
    ...input.actionRefs,
    ...input.outcomeRefs,
    ...input.evidenceRefs,
  ]);
}

function normalizedFocus(input: CapabilityBuilderInput): string {
  return input.primaryFocusCode.trim().toUpperCase();
}

function isTimingFocus(focus: string): boolean {
  return ["SURVIVE_CONTACT", "SURVIVE_THE_NEXT_CONTACT", "CONVERT_ADVANTAGE", "OBJECTIVE_TIMING", "ADVANTAGE_OVERPEEK", "RECHECK_ADVANTAGE_OVERPEEK", "TIMING_DECISION"]
    .includes(focus) || /(TIMING|PEEK|SHORT_DECISION|MICRO_DECISION)/.test(focus);
}

function isMapFocus(focus: string): boolean {
  return [
    "POSITIONING",
    "SURVIVE_CONTACT",
    "SURVIVE_THE_NEXT_CONTACT",
    "CONVERT_ADVANTAGE",
    "TRADE_DISTANCE",
    "TRADE_SPACING",
    "ROTATE",
    "RETAKE",
    "RISK_LINE",
    "ADVANTAGE_OVERPEEK",
  ].includes(focus) || /(POSITION|TRADE|ROTATE|RETAKE|RISK_LINE|COVERAGE)/.test(focus);
}

function isUtilityFocus(focus: string): boolean {
  return focus === "UTILITY_PURPOSE_AND_TEMPO" || /(UTILITY|GRENADE|SMOKE|FLASH)/.test(focus);
}

function isImpactFocus(focus: string): boolean {
  return focus === "WIN_PROBABILITY_SWING_RESPONSE" || /(WIN_RATE|WIN_PROBABILITY|IMPACT)/.test(focus);
}

function isEconomyFocus(focus: string): boolean {
  return [
    "SURVIVE_CONTACT",
    "SURVIVE_THE_NEXT_CONTACT",
    "CONVERT_ADVANTAGE",
    "OBJECTIVE_TIMING",
    "UTILITY_PURPOSE_AND_TEMPO",
    "WIN_PROBABILITY_SWING_RESPONSE",
    "ECONOMY_CHANGES_RISK",
  ].includes(focus) || /(ECONOMY|BUY|FORCE|ECO)/.test(focus);
}

export function buildTeachingCapabilities(rawInput: CapabilityBuilderInput): TeachingCapability[] {
  const input = CapabilityBuilderInputSchema.parse(rawInput);
  const capabilities: TeachingCapability[] = [];
  const baseRefs = commonRefs(input);
  const focus = normalizedFocus(input);

  // A decision/outcome fact alone is not a replayable teaching opportunity.
  // The verified player action must exist before a slow replay is legal.
  if (input.actionRefs.length > 0 && isTimingFocus(focus)) {
    capabilities.push(
      TeachingCapabilitySchema.parse({
        capabilityId: capabilityId(input.cueId, "slow-replay"),
        tool: "REPLAY_CUE_SLOW",
        boundArgs: { tool: "REPLAY_CUE_SLOW", cueId: input.cueId, speed: 0.5 },
        evidenceRefs: baseRefs,
        estimatedDurationMs: 12_000,
      }),
    );
  }

  if (input.annotationRefs.length > 0 && isMapFocus(focus)) {
    capabilities.push(
      TeachingCapabilitySchema.parse({
        capabilityId: capabilityId(input.cueId, "map-focus"),
        tool: "FOCUS_MAP_EVIDENCE",
        boundArgs: {
          tool: "FOCUS_MAP_EVIDENCE",
          cueId: input.cueId,
          annotationRefs: [...input.annotationRefs],
          actorRefs: [...input.actorRefs],
          calloutRefs: [...input.calloutRefs],
        },
        evidenceRefs: unique([...input.annotationRefs, ...baseRefs]),
        estimatedDurationMs: 8_000,
      }),
    );
  }

  if (isUtilityFocus(focus) && input.grenadeTrajectoryRefs.length > 0 && input.grenadeLandingRefs.length > 0) {
    capabilities.push(
      TeachingCapabilitySchema.parse({
        capabilityId: capabilityId(input.cueId, "grenade-trace"),
        tool: "SHOW_GRENADE_TRACE",
        boundArgs: {
          tool: "SHOW_GRENADE_TRACE",
          cueId: input.cueId,
          trajectoryRefs: [...input.grenadeTrajectoryRefs],
          landingRefs: [...input.grenadeLandingRefs],
        },
        evidenceRefs: unique([
          ...input.grenadeTrajectoryRefs,
          ...input.grenadeLandingRefs,
          ...baseRefs,
        ]),
        estimatedDurationMs: 9_000,
      }),
    );
  }

  const negativeSwing = input.negativeWinProbabilitySwingPercentagePoints;
  if (
    input.outcomeGateStatus === "COMPLETE" &&
    input.modelStatus === "AVAILABLE" &&
    isImpactFocus(focus) &&
    input.measurementRefs.length > 0 &&
    negativeSwing !== null &&
    negativeSwing <= -1
  ) {
    capabilities.push(
      TeachingCapabilitySchema.parse({
        capabilityId: capabilityId(input.cueId, "win-rate-impact"),
        tool: "SHOW_WIN_RATE_IMPACT",
        boundArgs: {
          tool: "SHOW_WIN_RATE_IMPACT",
          cueId: input.cueId,
          measurementRef: input.measurementRefs[0],
        },
        evidenceRefs: unique([...input.measurementRefs, ...input.outcomeRefs, ...baseRefs]),
        estimatedDurationMs: 7_000,
      }),
    );
  }

  const economy = input.economyContext;
  if (isEconomyFocus(focus) && economy.reliable && economy.relevant && economy.ref && economy.economyClass !== "UNKNOWN") {
    capabilities.push(
      TeachingCapabilitySchema.parse({
        capabilityId: capabilityId(input.cueId, "economy-context"),
        tool: "SHOW_ECONOMY_CONTEXT",
        boundArgs: {
          tool: "SHOW_ECONOMY_CONTEXT",
          cueId: input.cueId,
          economyRef: economy.ref,
          economyClass: economy.economyClass,
        },
        evidenceRefs: unique([economy.ref, ...baseRefs]),
        estimatedDurationMs: 6_000,
      }),
    );
  }

  return capabilities;
}
