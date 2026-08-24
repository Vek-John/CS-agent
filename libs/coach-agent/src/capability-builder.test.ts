import { describe, expect, it } from "vitest";
import { buildTeachingCapabilities } from "./capability-builder";
import { TeachingCapabilitySchema } from "./types";
import type { CapabilityBuilderInput } from "./types";

function input(overrides: Partial<CapabilityBuilderInput> = {}): CapabilityBuilderInput {
  return {
    cueId: "cue-17",
    primaryFocusCode: "POSITIONING",
    decisionRefs: ["decision-1"],
    actionRefs: ["action-1"],
    outcomeRefs: ["outcome-1"],
    evidenceRefs: ["evidence-1"],
    annotationRefs: ["annotation-1"],
    actorRefs: ["actor-1"],
    calloutRefs: ["callout-1"],
    grenadeTrajectoryRefs: ["trajectory-1"],
    grenadeLandingRefs: ["landing-1"],
    outcomeGateStatus: "COMPLETE",
    modelStatus: "AVAILABLE",
    measurementRefs: ["measurement-1"],
    negativeWinProbabilitySwingPercentagePoints: -3.2,
    economyContext: {
      reliable: true,
      relevant: true,
      ref: "economy-1",
      economyClass: "FORCE",
    },
    limitations: [],
    ...overrides,
  };
}

describe("buildTeachingCapabilities", () => {
  it("deterministically builds each bound tool only under its focus qualification", () => {
    const first = buildTeachingCapabilities(input({ primaryFocusCode: "ADVANTAGE_OVERPEEK" }));
    const second = buildTeachingCapabilities(input({ primaryFocusCode: "ADVANTAGE_OVERPEEK" }));
    const grenade = buildTeachingCapabilities(input({ primaryFocusCode: "UTILITY_PURPOSE_AND_TEMPO" }));
    const impact = buildTeachingCapabilities(input({ primaryFocusCode: "WIN_PROBABILITY_SWING_RESPONSE" }));
    const economy = buildTeachingCapabilities(input({ primaryFocusCode: "ECONOMY_CHANGES_RISK" }));
    const all = [...first, ...grenade, ...impact, ...economy];

    expect(first).toEqual(second);
    expect(all.map((capability) => capability.tool)).toEqual([
      "REPLAY_CUE_SLOW",
      "FOCUS_MAP_EVIDENCE",
      "SHOW_GRENADE_TRACE",
      "SHOW_ECONOMY_CONTEXT",
      "SHOW_WIN_RATE_IMPACT",
      "SHOW_ECONOMY_CONTEXT",
      "SHOW_ECONOMY_CONTEXT",
    ]);
    expect(all.find((capability) => capability.tool === "REPLAY_CUE_SLOW")?.boundArgs).toEqual({ tool: "REPLAY_CUE_SLOW", cueId: "cue-17", speed: 0.5 });
    expect(all.find((capability) => capability.tool === "FOCUS_MAP_EVIDENCE")?.boundArgs).toMatchObject({ annotationRefs: ["annotation-1"], actorRefs: ["actor-1"] });
    expect(all.find((capability) => capability.tool === "SHOW_GRENADE_TRACE")?.boundArgs).toMatchObject({ trajectoryRefs: ["trajectory-1"], landingRefs: ["landing-1"] });
    expect(all.find((capability) => capability.tool === "SHOW_WIN_RATE_IMPACT")?.boundArgs).toEqual({ tool: "SHOW_WIN_RATE_IMPACT", cueId: "cue-17", measurementRef: "measurement-1" });
    expect(all.find((capability) => capability.tool === "SHOW_ECONOMY_CONTEXT")?.boundArgs).toMatchObject({ economyRef: "economy-1", economyClass: "FORCE" });
  });

  it("does not invent map, grenade, win-rate, or economy capabilities when evidence is unavailable", () => {
    const capabilities = buildTeachingCapabilities(
      input({
        annotationRefs: [],
        actorRefs: [],
        calloutRefs: [],
        grenadeTrajectoryRefs: [],
        grenadeLandingRefs: ["landing-only"],
        primaryFocusCode: "POSITIONING",
        outcomeGateStatus: "LOCKED",
        modelStatus: "UNAVAILABLE",
        measurementRefs: ["measurement-1"],
        negativeWinProbabilitySwingPercentagePoints: -3,
        economyContext: { reliable: false, relevant: true, ref: "economy-1", economyClass: "FULL" },
      }),
    );

    expect(capabilities.map((capability) => capability.tool)).toEqual([]);
  });

  it.each([
    ["non-negative swing", 0],
    ["small negative swing", -0.99],
    ["missing swing", null],
  ])("does not build SHOW_WIN_RATE_IMPACT for %s", (_label, swing) => {
    const capabilities = buildTeachingCapabilities(
      input({ negativeWinProbabilitySwingPercentagePoints: swing }),
    );
    expect(capabilities.some((capability) => capability.tool === "SHOW_WIN_RATE_IMPACT")).toBe(false);
  });

  it("does not treat an outcome-only fact as a replay teaching opportunity", () => {
    const capabilities = buildTeachingCapabilities(
      input({ decisionRefs: [], actionRefs: [], outcomeRefs: ["outcome-only"] }),
    );
    expect(capabilities.some((capability) => capability.tool === "REPLAY_CUE_SLOW")).toBe(false);
  });

  it("does not treat a decision-only fact as a verified player action", () => {
    const capabilities = buildTeachingCapabilities(
      input({ decisionRefs: ["decision-only"], actionRefs: [], outcomeRefs: [] }),
    );
    expect(capabilities.some((capability) => capability.tool === "REPLAY_CUE_SLOW")).toBe(false);
  });

  it.each([
    "SURVIVE_CONTACT",
    "SURVIVE_THE_NEXT_CONTACT",
    "CONVERT_ADVANTAGE",
    "OBJECTIVE_TIMING",
  ])("makes contact focus %s eligible for slow replay when action evidence exists", (primaryFocusCode) => {
    const capabilities = buildTeachingCapabilities(input({
      primaryFocusCode,
      actionRefs: ["action-contact"],
      annotationRefs: [],
    }));
    expect(capabilities.map((capability) => capability.tool)).toContain("REPLAY_CUE_SLOW");
  });

  it.each([
    "SURVIVE_CONTACT",
    "SURVIVE_THE_NEXT_CONTACT",
    "CONVERT_ADVANTAGE",
    "OBJECTIVE_TIMING",
    "UTILITY_PURPOSE_AND_TEMPO",
    "WIN_PROBABILITY_SWING_RESPONSE",
  ])("makes real Director focus %s eligible for reliable economy context", (primaryFocusCode) => {
    const capabilities = buildTeachingCapabilities(input({
      primaryFocusCode,
      economyContext: { reliable: true, relevant: true, ref: "economy-real", economyClass: "ECO" },
    }));
    expect(capabilities.map((capability) => capability.tool)).toContain("SHOW_ECONOMY_CONTEXT");
  });

  it("rejects unapproved builder fields instead of accepting a caller-injected parameter", () => {
    expect(() => buildTeachingCapabilities({ ...input(), tick: 42 } as CapabilityBuilderInput)).toThrow();
  });

  it("rejects unknown tools and malformed bound arguments", () => {
    expect(() => TeachingCapabilitySchema.parse({
      capabilityId: "cap-unknown-tool",
      tool: "NOT_A_TOOL",
      boundArgs: {},
      evidenceRefs: [],
      estimatedDurationMs: 1_000,
    })).toThrow();
  });
});
