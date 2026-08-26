import { describe, expect, it } from "vitest";
import type {
  Fact,
  LearningThread,
  OutcomeFact,
  PlayerActionFact,
  PlayerStateSample,
  TeachingDiagnosisInput,
  UserReflection,
} from "@cs-coach/contracts";
import {
  buildUserClaims,
  diagnoseCue,
  TeachingDiagnosisInputSchema,
  reviseDiagnosis,
} from "./teaching-diagnosis";

const selectedPlayerId = "player-selected";

function reflection(overrides: Partial<UserReflection> = {}): UserReflection {
  return {
    cueId: "cue-risk",
    selectedGoal: "OTHER",
    response: "ANSWERED",
    source: "USER",
    limitations: [],
    ...overrides,
  };
}

function decisionFact(id = "decision-1"): Fact {
  return {
    id,
    text: "决策前玩家仍存活并看到了可处理的接触窗口。",
    availability: "DECISION",
    available_at_tick: 100,
    source: "DEMO",
    observed_by_player: true,
  };
}

function actionFact(id = "action-1"): PlayerActionFact {
  return {
    id,
    text: "玩家向接触窗口移动并主动开火。",
    actorPlayerId: selectedPlayerId,
    availableAtTick: 105,
    source: "DEMO",
    evidenceRefs: ["decision-1"],
    limitations: [],
  };
}

function outcomeFact(id = "outcome-1", outcomeKind: OutcomeFact["outcomeKind"] = "HP_CHANGE"): OutcomeFact {
  return {
    id,
    text: outcomeKind === "DEATH" ? "玩家随后阵亡。" : "玩家随后受到伤害。",
    availableAtTick: 120,
    source: "DEMO",
    outcomeKind,
    evidenceRefs: ["action-1"],
    limitations: [],
  };
}

function decisionState(overrides: Partial<PlayerStateSample> = {}): PlayerStateSample {
  return {
    player_id: selectedPlayerId,
    tick: 100,
    side: "T",
    world_position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    alive: true,
    health: 100,
    armor: 100,
    has_helmet: true,
    money: 4_000,
    equipment_value: 4_000,
    inventory: [{ item_id: "ak47", item_class: "WEAPON", count: 1 }],
    fact_refs: ["decision-1"],
    missing_fields: [],
    ...overrides,
  };
}

function input(overrides: Partial<TeachingDiagnosisInput> = {}): TeachingDiagnosisInput {
  return {
    cueId: "cue-risk",
    reflection: reflection(),
    decisionFacts: [decisionFact()],
    playerActionFacts: [actionFact()],
    outcomeFacts: [],
    ...overrides,
  };
}

describe("teaching diagnosis trust and evidence boundaries", () => {
  it("keeps a skipped TRADE reflection as a USER goal claim and falls back without upgrading it", () => {
    const output = diagnoseCue(input({
      reflection: reflection({ cueId: "cue-trade-skip", selectedGoal: "TRADE", response: "SKIPPED" }),
      cueId: "cue-trade-skip",
      playerActionFacts: [],
    }));

    expect(output.cueCase.status).toBe("FALLBACK");
    expect(output.cueCase.pedagogyMode).toBe("DEFER");
    expect(output.cueCase.claims.every((claim) => claim.source === "USER")).toBe(true);
    expect(output.cueCase.claims.find((claim) => claim.type === "GOAL")).toMatchObject({
      source: "USER",
      verification: "SUPPORTED",
    });
    expect(output.cueCase.diagnosticResult).toMatchObject({
      capabilityId: "VERIFY_TRADE_ASSUMPTION",
      status: "UNVERIFIABLE",
    });
    expect(output.cueCase.limitations.join(" ")).toMatch(/跳过了反思/);
  });

  it("turns free-text teammate expectations into a bounded USER claim", () => {
    const claims = buildUserClaims(reflection({
      rawText: "我以为队友会跟我一起补枪",
      questionType: undefined,
    }));
    const teammateClaim = claims.find((claim) => claim.type === "TEAMMATE_BELIEF");

    expect(teammateClaim).toMatchObject({
      source: "USER",
      verification: "UNTESTED",
    });
    expect(teammateClaim?.content).toContain("我以为队友会跟我一起补枪");
    expect(teammateClaim?.limitations).toEqual([]);
  });

  it("infers a free-text goal for the GOAL claim and LearningThread user model", () => {
    const textReflection = reflection({
      cueId: "cue-text-goal",
      selectedGoal: undefined,
      rawText: "我想拿信息",
    });
    const claims = buildUserClaims(textReflection);
    expect(claims.find((claim) => claim.type === "GOAL")?.content).toContain("拿信息");

    const output = diagnoseCue(input({
      cueId: "cue-text-goal",
      reflection: textReflection,
      decisionState: decisionState(),
    }));
    expect(output.learningThread.userModel.goal).toBe("GET_INFO");
    expect(output.cueCase.hinge?.kind).toBe("INFORMATION");
    expect(output.cueCase.selectedCapabilityId).toBe("VERIFY_INFORMATION_ASSUMPTION");
  });

  it("marks a well-funded risk condition as supported when the outcome is neutral", () => {
    const output = diagnoseCue(input({ decisionState: decisionState() }));

    expect(output.cueCase.diagnosticResult?.status).toBe("SUPPORTED");
    expect(output.cueCase.verdict).toMatchObject({
      type: "GOAL_AND_ACTION_ALIGNED",
      confidence: 0.84,
    });
    expect(output.learningThread.diagnosis.type).toBe("RISK_MODEL");
  });

  it("marks a low-resource risk condition as failed after a negative outcome", () => {
    const output = diagnoseCue(input({
      decisionState: decisionState({ health: 30, armor: 0, has_helmet: false }),
      outcomeFacts: [outcomeFact("outcome-death", "DEATH")],
    }));

    expect(output.cueCase.diagnosticResult?.status).toBe("CONTRADICTED");
    expect(output.cueCase.verdict).toMatchObject({ type: "GOAL_VALID_CONDITION_FAILED" });
    expect(output.learningThread.conflictingCueIds).toEqual(["cue-risk"]);
  });

  it("uses the identity-free resource projection when the full state stays in Host", () => {
    const projected = {
      health: 30,
      armor: 0,
      hasHelmet: false,
      inventoryCount: 1,
      evidenceRefs: ["decision-1"],
    };
    TeachingDiagnosisInputSchema.parse(input({
      decisionResources: projected,
      outcomeFacts: [outcomeFact("projected-death", "DEATH")],
    }));
    const output = diagnoseCue(input({
      decisionResources: projected,
      outcomeFacts: [outcomeFact("projected-death", "DEATH")],
    }));
    expect(output.cueCase.diagnosticResult?.status).toBe("CONTRADICTED");
    expect(output.cueCase.diagnosticResult?.measurements.map((item) => item.id)).toContain("measurement-cue-risk-health");
    expect(() => TeachingDiagnosisInputSchema.parse(input({
      decisionResources: { ...projected, tick: 100 } as unknown as TeachingDiagnosisInput["decisionResources"],
    }))).toThrow();
  });

  it("leaves a risk verdict inconclusive when neither state nor economy is available", () => {
    const output = diagnoseCue(input());

    expect(output.cueCase.diagnosticResult).toMatchObject({ status: "UNVERIFIABLE" });
    expect(output.cueCase.verdict).toMatchObject({ type: "INCONCLUSIVE" });
    expect(output.learningThread.status).toBe("OPEN");
    expect(output.cueCase.pedagogyMode).toBe("DEFER");
  });

  it("does not use the risk checker to pretend it verified a timing hinge", () => {
    const output = diagnoseCue(input({
      cueId: "cue-timing",
      reflection: reflection({ cueId: "cue-timing", selectedGoal: "DELAY" }),
      decisionState: decisionState(),
    }));

    expect(output.cueCase.hinge).toMatchObject({ kind: "TIMING", conditionCode: "TIMING_WINDOW" });
    expect(output.cueCase.selectedCapabilityId).toBe("VERIFY_EXPOSURE_ASSUMPTION");
    expect(output.cueCase.diagnosticResult).toMatchObject({
      capabilityId: "VERIFY_EXPOSURE_ASSUMPTION",
      status: "UNVERIFIABLE",
    });
    expect(output.cueCase.verdict?.type).toBe("INCONCLUSIVE");
    expect(output.cueCase.transferRule?.when).toMatch(/拖延|等待/);
  });

  it("never verifies a TRADE assumption from proximity-only facts", () => {
    const output = diagnoseCue(input({
      cueId: "cue-trade",
      reflection: reflection({ cueId: "cue-trade", selectedGoal: "TRADE" }),
      decisionState: decisionState(),
      outcomeFacts: [outcomeFact()],
    }));

    expect(output.cueCase.selectedCapabilityId).toBe("VERIFY_TRADE_ASSUMPTION");
    expect(output.cueCase.diagnosticResult?.status).toBe("UNVERIFIABLE");
    expect(output.cueCase.verdict?.type).toBe("INCONCLUSIVE");
    expect(output.cueCase.transferRule?.unless).toMatch(/无法验证/);
  });

  it("partially supports an explicit teammate coverage gap and keeps evidence on the USER claim", () => {
    const output = diagnoseCue(input({
      cueId: "cue-trade-gap",
      reflection: reflection({ cueId: "cue-trade-gap", selectedGoal: "TRADE", rawText: "我以为队友会跟我一起补枪" }),
      decisionFacts: [{ ...decisionFact("decision-trade-gap"), text: "决策时队友未到位，无法覆盖同一枪线。" }],
      playerActionFacts: [actionFact("action-trade-gap")],
    }));
    const teammateClaim = output.cueCase.claims.find((claim) => claim.type === "TEAMMATE_BELIEF");
    const evidenceRefs = output.cueCase.diagnosticResult?.evidenceRefs ?? [];

    expect(output.cueCase.diagnosticResult).toMatchObject({ status: "PARTIALLY_SUPPORTED" });
    expect(output.cueCase.hinge?.verification).toBe("PARTIALLY_SUPPORTED");
    expect(output.cueCase.diagnosticResult?.explanation).toContain("空间/时机部分可由 Demo 支持，但逐玩家 LOS、阻挡、语音仍未知");
    expect(teammateClaim).toMatchObject({ source: "USER", verification: "PARTIALLY_SUPPORTED" });
    expect(teammateClaim?.supportingRefs).toEqual(expect.arrayContaining([...evidenceRefs]));
    expect(output.learningThread.userModel.expectedTeammateAction).toContain("队友会跟我一起补枪");
  });

  it("strictly parses bounded existing LearningThread snapshots", () => {
    const first = diagnoseCue(input({ decisionState: decisionState() }));
    const parsed = TeachingDiagnosisInputSchema.parse(input({ existingThreads: [first.learningThread] }));

    expect(parsed.existingThreads).toHaveLength(1);
    expect(() => TeachingDiagnosisInputSchema.parse(input({
      existingThreads: [{ ...first.learningThread, unexpected: true } as unknown as LearningThread],
    }))).toThrow();
  });

  it("keeps voice disagreement as USER context, preserves Demo facts, and lowers confidence", () => {
    const originalInput = input({
      cueId: "cue-disagreement",
      reflection: reflection({ cueId: "cue-disagreement" }),
      decisionState: decisionState(),
    });
    const factsBefore = structuredClone(originalInput.decisionFacts);
    const previous = diagnoseCue(originalInput);
    const revised = reviseDiagnosis({
      previous,
      input: originalInput,
      disagreement: reflection({
        cueId: "cue-disagreement",
        rawText: "我当时听到队友报点，说 A 点有两个人。",
        questionType: "TACTICAL_CONTEXT",
      }),
    });

    expect(originalInput.decisionFacts).toEqual(factsBefore);
    expect(originalInput.decisionFacts.every((fact) => fact.source === "DEMO")).toBe(true);
    expect(revised.cueCase.claims.some((claim) => claim.type === "TACTICAL_CONTEXT")).toBe(true);
    expect(revised.cueCase.claims.filter((claim) => claim.type === "TACTICAL_CONTEXT").every((claim) => claim.source === "USER")).toBe(true);
    expect(revised.cueCase.hinge).toMatchObject({ kind: "SYNC", conditionCode: "TEAM_SYNC" });
    expect(revised.cueCase.selectedCapabilityId).toBe("VERIFY_SYNC_ASSUMPTION");
    expect(revised.cueCase.diagnosticResult).toMatchObject({ status: "UNVERIFIABLE" });
    expect(revised.cueCase.verdict?.type).toBe("TEAM_EXECUTION");
    expect(revised.cueCase.attemptBudget).toMatchObject({ disagreement: 1, alternateDiagnostic: 1 });
    expect(revised.cueCase.diagnosticResult?.explanation).toMatch(/可能改变判断.*无法验证.*若.*成立.*合理解释/);
    expect(revised.cueCase.transferRule?.unless).toMatch(/保持条件化/);
    expect(revised.cueCase.limitations.join(" ")).toMatch(/异议内容没有被写入 Demo 事实/);
    expect(revised.cueCase.verdict?.revision).toBe(1);
    expect(revised.cueCase.verdict?.confidence ?? 1).toBeLessThan(previous.cueCase.verdict?.confidence ?? 0);
  });

  it("treats a hearing disagreement as conditional information context", () => {
    const originalInput = input({
      cueId: "cue-footsteps-disagreement",
      reflection: reflection({ cueId: "cue-footsteps-disagreement" }),
      decisionState: decisionState(),
    });
    const previous = diagnoseCue(originalInput);
    const revised = reviseDiagnosis({
      previous,
      input: originalInput,
      disagreement: reflection({
        cueId: "cue-footsteps-disagreement",
        rawText: "我听到了脚步，所以我认为可以继续推进。",
      }),
    });

    expect(revised.cueCase.hinge?.kind).toBe("INFORMATION");
    expect(revised.cueCase.selectedCapabilityId).toBe("VERIFY_INFORMATION_ASSUMPTION");
    expect(revised.cueCase.verdict?.type).toBe("INCONCLUSIVE");
    expect(revised.cueCase.diagnosticResult?.explanation).toMatch(/可能改变判断.*无法验证.*若.*成立.*合理解释/);
    expect(revised.cueCase.claims.find((claim) => claim.type === "TACTICAL_CONTEXT")).toBeUndefined();
    expect(revised.cueCase.claims.find((claim) => claim.type === "ENEMY_BELIEF")).toMatchObject({
      source: "USER",
      verification: "UNVERIFIABLE",
    });
  });

  it("updates the same session LearningThread with repeated and conflicting cue evidence", () => {
    const first = diagnoseCue(input({ cueId: "cue-thread-1", reflection: reflection({ cueId: "cue-thread-1" }), decisionState: decisionState() }));
    const second = diagnoseCue(input({
      cueId: "cue-thread-2",
      reflection: reflection({ cueId: "cue-thread-2", rawText: "我以为这个风险可以承受" }),
      decisionState: decisionState({ health: 30, armor: 0, has_helmet: false }),
      outcomeFacts: [outcomeFact("outcome-thread-2", "DEATH")],
      existingThreads: [first.learningThread] as readonly LearningThread[],
    }));

    expect(second.learningThread.threadId).toBe(first.learningThread.threadId);
    expect(second.learningThread.hingeCode).toBe(first.learningThread.hingeCode);
    expect(second.learningThread.status).toBe("REPEATED");
    expect(second.learningThread.evidenceCueIds).toEqual(["cue-thread-1", "cue-thread-2"]);
    expect(second.learningThread.successfulCueIds).toEqual(["cue-thread-1"]);
    expect(second.learningThread.conflictingCueIds).toEqual(["cue-thread-2"]);
    expect(second.learningThread.userModel.belief).toContain("我以为这个风险可以承受");
  });
});
