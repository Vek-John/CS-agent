import { describe, expect, it } from "vitest";
import { buildTeachingCapabilities } from "./capability-builder";
import {
  buildStage2CapabilityInput,
  stage2TestDemoCueReference,
} from "./stage2-cue-fixture";

describe("Stage2 parsed test_demo cue reference", () => {
  it("keeps one canonical old-planner cue compact and does not call it a current route", () => {
    expect(stage2TestDemoCueReference.source.currentDirectorRoute).toBe(false);
    expect(stage2TestDemoCueReference.source.plannerVersion).toBe("demo-planner/1.1.0");
    expect(stage2TestDemoCueReference.source.cueCount).toBe(5);
    expect(stage2TestDemoCueReference.cue.candidateId).toBeNull();
    expect(stage2TestDemoCueReference.cue.primaryFocusCode).toBeNull();
    expect(JSON.stringify(stage2TestDemoCueReference)).not.toMatch(/rawReplay|frames|player_state_tracks|grenade_tracks|coordinates/i);
  });

  it("preserves real decision/outcome refs without manufacturing an action or model impact", () => {
    const input = buildStage2CapabilityInput("SURVIVE_THE_NEXT_CONTACT");
    const capabilities = buildTeachingCapabilities(input);
    expect(input.actionRefs).toEqual([]);
    expect(input.negativeWinProbabilitySwingPercentagePoints).toBeNull();
    expect(capabilities.map((capability) => capability.tool)).toEqual(["FOCUS_MAP_EVIDENCE"]);
    expect(input.limitations).toContain("没有 verified player-action fact；不能把结果事实或 advice 反推成 action ref。");
  });
});
