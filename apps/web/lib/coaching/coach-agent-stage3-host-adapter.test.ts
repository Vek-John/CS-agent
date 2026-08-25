import { describe, expect, it } from "vitest";
import {
  AgentToolRequestSchema,
  type AgentToolRequest,
  type CoachAgentEvent,
  type CoachAgentResult,
} from "@cs-coach/coach-agent/client";
import type {
  CandidateMaterial,
  CoachingRouteState,
  OutcomeImpact,
  TeachingCandidate,
  TeachingToolAckEvent,
  WinProbabilityTimelineV1,
} from "@cs-coach/contracts";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { CoachAgentStage3Controller } from "./coach-agent-stage3-controller";
import {
  CoachAgentStage3HostAdapter,
  STAGE3_TOOLS,
  buildStage3StartCue,
  createStage3HostAdapterStore,
  stableStage3IdentityToken,
  type Stage3HostAdapterInput,
} from "./coach-agent-stage3-host-adapter";

const HASH = "b".repeat(64);

function replaceCue(input: Stage3HostAdapterInput, cue: Stage3HostAdapterInput["cue"]): Stage3HostAdapterInput {
  return {
    ...input,
    cue,
    narration: { ...input.narration, cueId: cue.id, primaryFocusCode: cue.primary_focus_code ?? "" },
    plan: {
      ...input.plan,
      cues: [cue],
      segments: input.plan.segments.map((segment) => ({
        ...segment,
        cue_ids: segment.id === cue.segment_id ? [cue.id] : [],
      })),
    },
    routeState: {
      ...input.routeState,
      cueOrder: [cue.id],
      frozenCueIds: [cue.id],
      cueBindings: { [cue.id]: { candidateId: cue.candidate_id ?? "candidate", primaryFocusCode: cue.primary_focus_code ?? "" } },
      readiness: { [cue.id]: "READY" },
    },
  };
}

function fixtureInput(overrides: Partial<Stage3HostAdapterInput> = {}): Stage3HostAdapterInput {
  const base = createFixtureReviewPlan(createSyntheticMirageTimeline());
  const source = base.cues[0];
  if (!source) throw new Error("fixture cue missing");
  const cue = {
    ...source,
    primary_focus_code: "SURVIVE_THE_NEXT_CONTACT",
    observable_fact_refs: ["decision-ref"],
    action_fact_refs: ["action-ref"],
    outcome_fact_refs: ["outcome-ref"],
    evidence: [{ id: "evidence-ref", source: "RULE" as const, label: "决策证据", fact_refs: ["decision-ref"] }],
    advice: [{ id: "advice-ref", text: "等队友补枪", trigger: "接触前", fact_refs: ["decision-ref"] }],
    annotations: [{
      id: "annotation-world",
      type: "POINT" as const,
      coordinate_space: "WORLD" as const,
      point: { x: 120, y: -80, z: 0 },
      label: "关键站位",
    }],
  };
  const plan = {
    ...base,
    status: "COMPLETE" as const,
    cues: [cue],
    segments: base.segments.map((segment) => ({
      ...segment,
      cue_ids: segment.id === cue.segment_id ? [cue.id] : [],
    })),
  };
  const routeState: CoachingRouteState = {
    routeFrozen: true,
    routeFingerprint: "route-fingerprint-stage3",
    candidateSetId: "candidate-set-stage3",
    candidateSetHash: "candidate-hash-stage3",
    selectedCueCount: 1,
    readiness: { [cue.id]: "READY" },
    cueOrder: [cue.id],
    cueBindings: { [cue.id]: { candidateId: cue.candidate_id ?? "candidate", primaryFocusCode: cue.primary_focus_code ?? "" } },
    startable: true,
    consumedCueIds: [],
    frozenCueIds: [cue.id],
  };
  const candidate: TeachingCandidate = {
    candidateId: cue.candidate_id ?? "candidate",
    roundNumber: 2,
    source: { kind: "UTILITY", refs: ["trajectory-observed"] },
    preRollStart: cue.decision_tick - 64,
    decisionTick: cue.decision_tick,
    revealTick: cue.reveal_tick - 1,
    outcomeEnd: cue.outcome_end_tick,
    factRefs: ["decision-ref"],
    observableClaimRefs: [],
    actionRefs: ["action-ref"],
    outcomeRefs: ["outcome-ref"],
    evidenceRefs: ["evidence-ref"],
    winRateSignalRefs: ["measurement-ref"],
    economySignalRefs: ["economy-ref"],
    missingFields: [],
    limitations: [],
    deterministicScore: 1,
    resultSummary: {
      winProbabilityBefore: 0.7,
      winProbabilityAfter: 0.5,
      winProbabilityDelta: -0.2,
      winProbabilityPercentagePoints: -20,
      selectedPlayerDeath: false,
      economyClass: "FORCE",
      concurrentEvents: false,
      missingFields: [],
      limitations: [],
    },
  };
  const material: CandidateMaterial = {
    candidateId: candidate.candidateId,
    decisionFacts: [],
    playerActionFacts: [],
    outcomeFacts: [],
    inferences: [],
    advice: [],
    evidence: [],
    economy: "FORCE",
    limitations: [],
  };
  const outcomeImpact: OutcomeImpact = {
    cueId: cue.id,
    beforeProbability: 0.7,
    afterProbability: 0.5,
    delta: -0.2,
    percentagePoints: -20,
    relativeChange: -0.28,
    attribution: "MODEL_SWING",
    confidence: "HIGH",
    text: "胜率出现明显负向摆动。",
    limitations: [],
  };
  const winProbabilityTimeline = { status: "AVAILABLE" } as WinProbabilityTimelineV1;
  const input: Stage3HostAdapterInput = {
    plan,
    routeState,
    cue,
    narration: {
      cueId: cue.id,
      candidateId: cue.candidate_id ?? "candidate",
      primaryFocusCode: cue.primary_focus_code ?? "",
      currentSituation: { text: "当前情况", refs: ["decision-ref"] },
      playerAction: { text: "玩家动作", refs: ["action-ref"] },
      coreIssue: { text: "核心问题", refs: ["decision-ref", "action-ref"] },
      betterPlay: { text: "更好处理", refs: ["advice-ref"] },
      outcomeImpact: { text: "结果影响", refs: ["outcome-ref"] },
    },
    outcomeGate: { cueId: cue.id, outcomeEndTick: cue.outcome_end_tick, status: "COMPLETE", completedAtTick: cue.outcome_end_tick },
    currentSessionPhase: "PAUSED_FOR_COACHING",
    analysis: { demo_id: plan.demo_id, selected_steam_id: plan.player_id, metadata: { demo_content_hash: HASH } },
    demoContentHash: HASH,
    selectedPlayerId: plan.player_id,
    sessionId: "stage3-session",
    runId: "stage3-run",
    generation: 1,
    tickRate: 64,
    evidence: { candidate, material, outcomeImpact, winProbabilityTimeline },
  };
  return { ...input, ...overrides };
}

function requestFor(
  start: ReturnType<typeof buildStage3StartCue>,
  tool: (typeof STAGE3_TOOLS)[number],
  callId: string,
): AgentToolRequest {
  const capability = start.capabilities.find((item) => item.tool === tool);
  if (!capability) throw new Error(`missing ${tool} capability`);
  return AgentToolRequestSchema.parse({
    callId,
    runId: start.event.identity.runId,
    cueId: start.event.cueId,
    capabilityId: capability.capabilityId,
    tool: capability.tool,
    evidenceRefs: capability.evidenceRefs,
  });
}

function ackFor(request: AgentToolRequest, tool: TeachingToolAckEvent["tool"], status: TeachingToolAckEvent["status"] = "SUCCEEDED"): TeachingToolAckEvent {
  return {
    type: "TEACHING_TOOL_ACK",
    schemaVersion: "cs2d-teaching-tool-ack.v1",
    tool,
    callId: request.callId,
    runId: request.runId,
    generation: 1,
    cueId: request.cueId,
    ...(tool === "FOCUS_MAP_EVIDENCE" ? { annotationRef: "annotation-world" } : {}),
    status,
    observationCode: status === "SUCCEEDED" ? (tool === "REPLAY_CUE_SLOW" ? "CUE_PLAYED" : "EVIDENCE_SHOWN") : "UNAVAILABLE",
    completed: status === "SUCCEEDED",
    limitations: [],
  };
}

describe("CoachAgentStage3HostAdapter", () => {
  it("creates stable run tokens from the complete demo/route/player identity", () => {
    const same = stableStage3IdentityToken("a".repeat(64), "route-1", "route-hash-1", "player-1");
    expect(same).toBe(stableStage3IdentityToken("a".repeat(64), "route-1", "route-hash-1", "player-1"));
    expect(same).not.toBe(stableStage3IdentityToken("a".repeat(64), "route-1", "route-hash-1", "player-2"));
    expect(same).not.toBe(stableStage3IdentityToken("b".repeat(64), "route-1", "route-hash-1", "player-1"));
    expect(same).not.toBe(stableStage3IdentityToken("a".repeat(64), "route-1", "route-hash-2", "player-1"));
  });

  it("builds all five tools from route-owned evidence and sends the full compact narration whitelist", () => {
    const input = fixtureInput();
    const focusCases: readonly [string, (typeof STAGE3_TOOLS)[number]][] = [
      ["OBJECTIVE_TIMING", "REPLAY_CUE_SLOW"],
      ["SURVIVE_THE_NEXT_CONTACT", "FOCUS_MAP_EVIDENCE"],
      ["UTILITY_PURPOSE_AND_TEMPO", "SHOW_GRENADE_TRACE"],
      ["WIN_PROBABILITY_SWING_RESPONSE", "SHOW_WIN_RATE_IMPACT"],
      ["SURVIVE_THE_NEXT_CONTACT", "SHOW_ECONOMY_CONTEXT"],
    ];
    for (const [focus, tool] of focusCases) {
      const start = buildStage3StartCue(replaceCue(input, { ...input.cue, primary_focus_code: focus }));
      expect(start.capabilities.map((capability) => capability.tool)).toContain(tool);
    }
    const start = buildStage3StartCue(input);
    expect(start.event.version).toBe("coach-agent-event.v2");
    expect(start.event.routeSegmentIndex).toBe(input.plan.segments.findIndex((segment) => segment.id === input.cue.segment_id));
    expect(start.event.segmentMode).toBe(input.plan.segments.find((segment) => segment.id === input.cue.segment_id)?.mode);
    expect(start.event.presentableSummary).toMatchObject({
      completionStatus: "COMPLETED",
      presentationStatus: "PRESENTABLE",
      cueId: input.cue.id,
      focus: input.cue.primary_focus_code,
      adviceRefs: ["advice-ref"],
      economyContext: "FORCE",
      conflictEvidence: false,
    });
    expect(start.event.narrationSummary).toMatchObject({
      primaryFocusCode: "SURVIVE_THE_NEXT_CONTACT",
      fields: {
        currentSituation: { text: "当前情况", refs: ["decision-ref"], limitations: [] },
        playerAction: { text: "玩家动作", refs: ["action-ref"], limitations: [] },
      },
    });
  });

  it("keeps canonical bound args out of AgentToolRequest while allowing them in the Host command", () => {
    const input = replaceCue(fixtureInput(), { ...fixtureInput().cue, primary_focus_code: "OBJECTIVE_TIMING" });
    const adapter = new CoachAgentStage3HostAdapter();
    const start = adapter.prepareStart(input);
    const context = { generation: 1, currentSessionPhase: "PAUSED_FOR_COACHING" as const, outcomeGate: input.outcomeGate };
    const request = requestFor(start, "REPLAY_CUE_SLOW", "stage3-slow-call");
    expect(JSON.stringify(request)).not.toMatch(/boundArgs|startCanonicalTick|focusWorld|trajectoryRefs|playerId|speed/);
    const command = adapter.createTeachingToolCommand(request, context);
    expect(command).toMatchObject({
      type: "teachingTool",
      tool: "REPLAY_CUE_SLOW",
      args: { startCanonicalTick: input.cue.decision_tick - 64, speed: 0.5 },
    });
    expect(JSON.stringify(command)).toContain("startCanonicalTick");
    expect(adapter.createTeachingToolCommand(request, context)).toBeUndefined();
  });

  it("serializes a Chinese economy presentation label without leaking focus taxonomy", () => {
    const input = fixtureInput();
    const adapter = new CoachAgentStage3HostAdapter();
    const start = adapter.prepareStart(input);
    const request = requestFor(start, "SHOW_ECONOMY_CONTEXT", "stage3-economy-label");
    const command = adapter.createTeachingToolCommand(request, { generation: 1, currentSessionPhase: "PAUSED_FOR_COACHING", outcomeGate: input.outcomeGate });
    expect(command).toMatchObject({ args: { tool: "SHOW_ECONOMY_CONTEXT", economyClass: "FORCE", focusLabel: "这次接触的可承受风险会随经济改变" } });
    expect(JSON.stringify(command)).not.toContain("SURVIVE_THE_NEXT_CONTACT");
  });

  it("requires occurred grenade refs, a meaningful model swing, and an explicit focus/economy mapping", () => {
    const input = fixtureInput();
    const futureCandidate = {
      ...input.evidence.candidate!,
      revealTick: input.cue.reveal_tick + 1,
    };
    const future = buildStage3StartCue({ ...input, evidence: { ...input.evidence, candidate: futureCandidate } });
    expect(future.capabilities.some((capability) => capability.tool === "SHOW_GRENADE_TRACE")).toBe(false);

    const noActionCue = { ...input.cue, action_fact_refs: [] };
    const noAction = buildStage3StartCue(replaceCue(input, noActionCue));
    expect(noAction.capabilities.some((capability) => capability.tool === "REPLAY_CUE_SLOW")).toBe(false);

    const noWorldCue = { ...input.cue, annotations: [] };
    const noWorld = buildStage3StartCue(replaceCue(input, noWorldCue));
    expect(noWorld.capabilities.some((capability) => capability.tool === "FOCUS_MAP_EVIDENCE")).toBe(false);

    const unavailableModel = buildStage3StartCue({
      ...input,
      evidence: { ...input.evidence, winProbabilityTimeline: { status: "UNAVAILABLE" } as WinProbabilityTimelineV1 },
    });
    expect(unavailableModel.capabilities.some((capability) => capability.tool === "SHOW_WIN_RATE_IMPACT")).toBe(false);

    const unrelatedEconomy = buildStage3StartCue(replaceCue(input, { ...input.cue, primary_focus_code: "SURVIVE_THE_NEXT_CONTACT" }));
    expect(unrelatedEconomy.capabilities.some((capability) => capability.tool === "SHOW_ECONOMY_CONTEXT")).toBe(true);
    const unknownFocus = buildStage3StartCue(replaceCue(input, { ...input.cue, primary_focus_code: "UNKNOWN_FOCUS" }));
    expect(unknownFocus.capabilities.some((capability) => capability.tool === "SHOW_ECONOMY_CONTEXT")).toBe(false);
  });

  it("accepts slow replay CUE_PLAYED, resumes once after success, and blocks a second success for the cue", () => {
    const input = replaceCue(fixtureInput(), { ...fixtureInput().cue, primary_focus_code: "OBJECTIVE_TIMING" });
    const adapter = new CoachAgentStage3HostAdapter();
    const start = adapter.prepareStart(input);
    const context = { generation: 1, currentSessionPhase: "PAUSED_FOR_COACHING" as const, outcomeGate: input.outcomeGate };
    const request = requestFor(start, "REPLAY_CUE_SLOW", "stage3-slow-success");
    adapter.createTeachingToolCommand(request, context);
    const result = adapter.acceptTeachingToolAck(request, ackFor(request, "REPLAY_CUE_SLOW"), context);
    expect(result?.observation.code).toBe("CUE_PLAYED");
    expect(adapter.acceptTeachingToolAck(request, ackFor(request, "REPLAY_CUE_SLOW"), context)).toBeUndefined();
    const resume = adapter.createResumeEvent(request, result!, context, "stage3-resume-success");
    expect(resume?.type).toBe("RESUME_TOOL");
    expect(adapter.createResumeEvent(request, result!, context, "stage3-resume-duplicate")).toBeUndefined();
    expect(() => adapter.createTeachingToolCommand({ ...request, callId: "stage3-slow-second" }, context)).toThrow(/successful/i);
  });

  it("allows a failed tool alternative, but cancellation invalidates old requests and ACKs across a reprepare", () => {
    const input = replaceCue(fixtureInput(), { ...fixtureInput().cue, primary_focus_code: "ADVANTAGE_OVERPEEK" });
    const adapter = new CoachAgentStage3HostAdapter();
    const start = adapter.prepareStart(input);
    const context = { generation: 1, currentSessionPhase: "PAUSED_FOR_COACHING" as const, outcomeGate: input.outcomeGate };
    const mapRequest = requestFor(start, "FOCUS_MAP_EVIDENCE", "stage3-map-failed");
    adapter.createTeachingToolCommand(mapRequest, context);
    const failed = adapter.acceptTeachingToolAck(mapRequest, ackFor(mapRequest, "FOCUS_MAP_EVIDENCE", "FAILED"), context);
    expect(failed?.status).toBe("FAILED");
    expect(adapter.createResumeEvent(mapRequest, failed!, context, "stage3-resume-failed")?.type).toBe("RESUME_TOOL");
    const slowRequest = requestFor(start, "REPLAY_CUE_SLOW", "stage3-slow-alternative");
    expect(adapter.createTeachingToolCommand(slowRequest, context)).toMatchObject({ tool: "REPLAY_CUE_SLOW" });

    adapter.cancel(1);
    expect(adapter.createTeachingToolCommand(mapRequest, context)).toBeUndefined();
    expect(() => adapter.acceptTeachingToolAck(slowRequest, ackFor(slowRequest, "REPLAY_CUE_SLOW"), context)).toThrow(/registered|generation/i);
    expect(adapter.createResumeEvent(mapRequest, failed!, context, "stage3-resume-after-cancel")).toBeUndefined();

    const nextInput = { ...input, generation: 2 };
    const nextStart = adapter.prepareStart(nextInput);
    const nextContext = { generation: 2, currentSessionPhase: "PAUSED_FOR_COACHING" as const, outcomeGate: input.outcomeGate };
    expect(adapter.createTeachingToolCommand(mapRequest, nextContext)).toBeUndefined();
    expect(() => adapter.createTeachingToolCommand(requestFor(nextStart, "FOCUS_MAP_EVIDENCE", "stage3-map-next"), nextContext)).toThrow(/callId|bound|attempted|successful/i);
  });

  it("keeps capability IDs stable across adapter reconstruction while rejecting an old effect epoch", () => {
    const input = fixtureInput();
    const store = createStage3HostAdapterStore();
    const first = new CoachAgentStage3HostAdapter(store);
    const firstStart = first.prepareStart(input);
    const context = { generation: 1, currentSessionPhase: "PAUSED_FOR_COACHING" as const, outcomeGate: input.outcomeGate };
    const pending = requestFor(firstStart, "FOCUS_MAP_EVIDENCE", "stage3-rebuild-pending");
    const firstCommand = first.createTeachingToolCommand(pending, context);
    expect(firstCommand).toMatchObject({ type: "teachingTool", generation: 1 });

    const rebuilt = new CoachAgentStage3HostAdapter(store);
    const rebuiltStart = rebuilt.prepareStart(input);
    expect(rebuiltStart.capabilities.map((capability) => capability.capabilityId)).toEqual(firstStart.capabilities.map((capability) => capability.capabilityId));
    expect(rebuilt.createTeachingToolCommand(pending, context)).toBeUndefined();
    expect(() => rebuilt.acceptTeachingToolAck(pending, ackFor(pending, "FOCUS_MAP_EVIDENCE"), context)).toThrow(/stale|match/i);
    expect(() => rebuilt.createTeachingToolCommand({ ...pending, callId: "stage3-rebuild-replacement" }, context)).toThrow(/callId|already bound/i);
  });

  it("uses a new lifecycle event for takeover recovery while keeping capability IDs stable", () => {
    const input = fixtureInput();
    const adapter = new CoachAgentStage3HostAdapter();
    const initial = adapter.prepareStart(input);
    adapter.cancel(1);
    const restored = adapter.prepareStart({ ...input, resumeFromTakeover: true });
    expect(restored.event.resumeFromTakeover).toBe(true);
    expect(restored.event.eventId).not.toBe(initial.event.eventId);
    expect(restored.event.eventId).toMatch(/restore/);
    expect(restored.capabilities.map((capability) => capability.capabilityId)).toEqual(initial.capabilities.map((capability) => capability.capabilityId));
  });

  it("catches up skipped prefix segments serially and advances through adjacent cues", async () => {
    const input = fixtureInput();
    const store = createStage3HostAdapterStore();
    const adapter = new CoachAgentStage3HostAdapter(store);
    const events: CoachAgentEvent[] = [];
    const controller = new CoachAgentStage3Controller({
      adapter,
      dispatch: async (event) => {
        events.push(event);
        return { status: "COMPLETED", effects: [] } as unknown as CoachAgentResult;
      },
      post: () => undefined,
      bridgeAvailable: () => true,
      isLive: () => true,
    });
    controller.start(input);
    for (let index = 0; index < 96; index += 1) await Promise.resolve();
    expect(events.slice(0, 3).map((event) => event.type)).toEqual(["OBSERVE_SEGMENT", "OBSERVE_SEGMENT", "OBSERVE_SEGMENT"]);
    expect(events[3]?.type).toBe("START_CUE");
    expect(store.lastSyncedCursor).toBe(3);

    const secondCue = {
      ...input.cue,
      id: "cue-stage3-adjacent",
      segment_id: input.plan.segments[4]?.id ?? input.cue.segment_id,
    };
    const secondInput: Stage3HostAdapterInput = {
      ...input,
      cue: secondCue,
      generation: 2,
      plan: {
        ...input.plan,
        cues: [input.cue, secondCue],
        segments: input.plan.segments.map((segment) => ({
          ...segment,
          cue_ids: segment.id === input.cue.segment_id ? [input.cue.id] : segment.id === secondCue.segment_id ? [secondCue.id] : [],
        })),
      },
      routeState: {
        ...input.routeState,
        cueOrder: [input.cue.id, secondCue.id],
        frozenCueIds: [input.cue.id, secondCue.id],
        cueBindings: {
          [input.cue.id]: { candidateId: input.cue.candidate_id ?? "candidate", primaryFocusCode: input.cue.primary_focus_code ?? "" },
          [secondCue.id]: { candidateId: secondCue.candidate_id ?? "candidate", primaryFocusCode: secondCue.primary_focus_code ?? "" },
        },
        readiness: { [input.cue.id]: "READY", [secondCue.id]: "READY" },
      },
      narration: { ...input.narration, cueId: secondCue.id },
      outcomeGate: { ...input.outcomeGate, cueId: secondCue.id },
    };
    controller.start(secondInput);
    for (let index = 0; index < 96; index += 1) await Promise.resolve();
    expect(events.at(-1)?.type).toBe("START_CUE");
    expect(events.filter((event) => event.type === "OBSERVE_SEGMENT")).toHaveLength(3);
    expect(store.lastSyncedCursor).toBe(4);
  });

  it("releases a pending observer on network failure and retries the same eventId during recovery", async () => {
    const input = fixtureInput();
    const store = createStage3HostAdapterStore();
    const adapter = new CoachAgentStage3HostAdapter(store);
    const events: CoachAgentEvent[] = [];
    let failFirst = true;
    const controller = new CoachAgentStage3Controller({
      adapter,
      dispatch: async (event) => {
        events.push(event);
        if (failFirst) {
          failFirst = false;
          throw new Error("network down");
        }
        return { status: "COMPLETED", effects: [] } as unknown as CoachAgentResult;
      },
      post: () => undefined,
      bridgeAvailable: () => true,
      isLive: () => true,
    });
    controller.start(input);
    for (let index = 0; index < 96; index += 1) await Promise.resolve();
    expect(store.lifecycleDegraded).toBe(true);
    expect(store.lifecycleEventIds.size).toBe(0);
    controller.recover(input);
    for (let index = 0; index < 128; index += 1) await Promise.resolve();
    expect(events.filter((event) => event.type === "OBSERVE_SEGMENT")[0]?.eventId).toBe(events.filter((event) => event.type === "OBSERVE_SEGMENT")[1]?.eventId);
    expect(store.lifecycleEventIds.get(events[1]?.eventId ?? "")).toBe("CONFIRMED");
    expect(store.lastSyncedCursor).toBe(3);
  });

  it("builds a stable manual visit event without a default route index", () => {
    const input = fixtureInput();
    const adapter = new CoachAgentStage3HostAdapter();
    const first = adapter.prepareManualStart(input, "visit-cue-4");
    const second = adapter.prepareManualStart(input, "visit-cue-4");
    expect(first.event).toMatchObject({
      type: "START_MANUAL_CUE_VISIT",
      visitId: "visit-cue-4",
      targetSegmentIndex: input.plan.segments.findIndex((segment) => segment.id === input.cue.segment_id),
    });
    expect(first.event.eventId).toBe(second.event.eventId);
    expect("routeSegmentIndex" in first.event).toBe(false);
    expect(first.capabilities.map((capability) => capability.capabilityId)).toEqual(second.capabilities.map((capability) => capability.capabilityId));
    expect(adapter.lifecycleCursor).toBe(-1);
  });
});
