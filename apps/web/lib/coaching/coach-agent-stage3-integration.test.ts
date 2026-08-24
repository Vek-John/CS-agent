import { describe, expect, it } from "vitest";
import { AgentToolRequestSchema, type CoachAgentResult } from "@cs-coach/coach-agent/client";
import { createCoachAgentRuntime, type PolicyAdapter } from "@cs-coach/coach-agent";
import type {
  CandidateMaterial,
  CoachingRouteState,
  NarrationBundle,
  OutcomeImpact,
  TeachingToolAckEvent,
  TeachingCandidate,
  WinProbabilityTimelineV1,
} from "@cs-coach/contracts";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import {
  CoachAgentStage3HostAdapter,
  buildStage3StartCue,
  createStage3HostAdapterStore,
  type Stage3HostAdapterInput,
} from "./coach-agent-stage3-host-adapter";
import { CoachAgentStage3Controller } from "./coach-agent-stage3-controller";

const HASH = "c".repeat(64);

function fixtureInput(overrides: Partial<Stage3HostAdapterInput> = {}): Stage3HostAdapterInput {
  const base = createFixtureReviewPlan(createSyntheticMirageTimeline());
  const source = base.cues[0];
  if (!source) throw new Error("stage3 integration cue missing");
  const cue = {
    ...source,
    primary_focus_code: "SURVIVE_THE_NEXT_CONTACT",
    observable_fact_refs: ["decision-ref"],
    action_fact_refs: ["action-ref"],
    outcome_fact_refs: ["outcome-ref"],
    evidence: [{ id: "evidence-ref", source: "RULE" as const, label: "站位证据", fact_refs: ["decision-ref"] }],
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
    routeFingerprint: "route-fingerprint-stage3-integration",
    candidateSetId: "candidate-set-stage3-integration",
    candidateSetHash: "candidate-hash-stage3-integration",
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
  const narration: NarrationBundle = {
    cueId: cue.id,
    candidateId: cue.candidate_id ?? "candidate",
    primaryFocusCode: cue.primary_focus_code ?? "",
    currentSituation: { text: "当前情况", refs: ["decision-ref"] },
    playerAction: { text: "玩家动作", refs: ["action-ref"] },
    coreIssue: { text: "核心问题", refs: ["decision-ref", "action-ref"] },
    betterPlay: { text: "更好处理", refs: ["advice-ref"] },
    outcomeImpact: { text: "结果影响", refs: ["outcome-ref"] },
  };
  return {
    plan,
    routeState,
    cue,
    narration,
    outcomeGate: { cueId: cue.id, outcomeEndTick: cue.outcome_end_tick, status: "COMPLETE", completedAtTick: cue.outcome_end_tick },
    currentSessionPhase: "PAUSED_FOR_COACHING",
    analysis: { demo_id: plan.demo_id, selected_steam_id: plan.player_id, metadata: { demo_content_hash: HASH } },
    demoContentHash: HASH,
    selectedPlayerId: plan.player_id,
    sessionId: "stage3-host-session",
    runId: "stage3-host-run",
    generation: 1,
    tickRate: 64,
    evidence: { candidate, material, outcomeImpact, winProbabilityTimeline: { status: "AVAILABLE" } as WinProbabilityTimelineV1 },
    ...overrides,
  };
}

function ackFor(request: ReturnType<typeof AgentToolRequestSchema.parse>, generation: number): TeachingToolAckEvent {
  return {
    type: "TEACHING_TOOL_ACK",
    schemaVersion: "cs2d-teaching-tool-ack.v1",
    tool: "FOCUS_MAP_EVIDENCE",
    callId: request.callId,
    runId: request.runId,
    generation,
    cueId: request.cueId,
    annotationRef: "annotation-world",
    status: "SUCCEEDED",
    observationCode: "EVIDENCE_SHOWN",
    completed: true,
    limitations: [],
  };
}

describe("Stage 3 Host ↔ Coach Agent black-box integration", () => {
  it("keeps the Agent request compact, binds values only in Host command, and resumes exactly once", async () => {
    const input = fixtureInput();
    const store = createStage3HostAdapterStore();
    const adapter = new CoachAgentStage3HostAdapter(store);
    const prepared = adapter.prepareStart(input);
    const mapCapability = prepared.capabilities.find((capability) => capability.tool === "FOCUS_MAP_EVIDENCE");
    if (!mapCapability) throw new Error("map capability missing");
    const policy: PolicyAdapter = {
      selectCapability: async () => ({
        action: "SELECT_CAPABILITY",
        capabilityId: mapCapability.capabilityId,
        evidenceRefs: ["annotation-world"],
        rationaleCode: "POSITION_NEEDS_MAP_FOCUS",
        confidence: 0.9,
      }),
    };
    const runtime = createCoachAgentRuntime({ policy });
    for (let segmentIndex = 0; segmentIndex < (prepared.event.routeSegmentIndex ?? 0); segmentIndex += 1) {
      await runtime.dispatch({
        version: "coach-agent-event.v2",
        type: "OBSERVE_SEGMENT",
        eventId: `stage3-pre-segment-${segmentIndex}`,
        identity: prepared.event.identity,
        segmentId: `stage3-pre-segment-${segmentIndex}`,
        segmentIndex,
        mode: "BRIEF",
        currentSessionPhase: "PLAYING",
      });
    }
    const started = await runtime.dispatch(prepared.event);
    const request = AgentToolRequestSchema.parse(started.effects[0]);
    const compact = JSON.stringify(request);
    expect(compact).not.toMatch(/boundArgs|tick|coordinate|player|frames|prompt/i);

    const context = { generation: 1, currentSessionPhase: "PAUSED_FOR_COACHING" as const, outcomeGate: input.outcomeGate };
    const command = adapter.createTeachingToolCommand(request, context);
    expect(command).toMatchObject({
      type: "teachingTool",
      tool: "FOCUS_MAP_EVIDENCE",
      args: { annotationRef: "annotation-world", focusWorld: { x: 120, y: -80 } },
    });
    if (!command || command.type !== "teachingTool") throw new Error("Host did not create a teachingTool command");
    expect(adapter.createTeachingToolCommand(request, context)).toBeUndefined();

    const ack = ackFor(request, command!.generation);
    const result = adapter.acceptTeachingToolAck(request, ack, context);
    expect(result?.observation.code).toBe("EVIDENCE_SHOWN");
    expect(adapter.acceptTeachingToolAck(request, ack, context)).toBeUndefined();
    const resume = adapter.createResumeEvent(request, result!, context, "stage3-integration-resume");
    expect(resume?.type).toBe("RESUME_TOOL");
    expect(adapter.createResumeEvent(request, result!, context, "stage3-integration-resume-duplicate")).toBeUndefined();

    const completed = await runtime.dispatch(resume!);
    const duplicate = await runtime.dispatch(resume!);
    expect(completed.effects).toEqual([]);
    expect(duplicate.effects).toEqual([]);
    expect(completed.state.toolHistory).toHaveLength(1);
  });

  it("reuses stable capability IDs across adapter reconstruction and rejects the old effect epoch", () => {
    const input = fixtureInput();
    const store = createStage3HostAdapterStore();
    const first = new CoachAgentStage3HostAdapter(store);
    const firstStart = first.prepareStart(input);
    const firstCapability = firstStart.capabilities.find((capability) => capability.tool === "FOCUS_MAP_EVIDENCE");
    if (!firstCapability) throw new Error("map capability missing");
    const pending = AgentToolRequestSchema.parse({
      callId: "stage3-ledger-pending",
      runId: firstStart.event.identity.runId,
      cueId: firstStart.event.cueId,
      capabilityId: firstCapability.capabilityId,
      tool: firstCapability.tool,
      evidenceRefs: ["annotation-world"],
    });
    const context = { generation: 1, currentSessionPhase: "PAUSED_FOR_COACHING" as const, outcomeGate: input.outcomeGate };
    expect(first.createTeachingToolCommand(pending, context)).toMatchObject({ generation: 1 });

    const rebuilt = new CoachAgentStage3HostAdapter(store);
    const rebuiltStart = rebuilt.prepareStart(input);
    expect(rebuiltStart.capabilities.map((capability) => capability.capabilityId)).toEqual(firstStart.capabilities.map((capability) => capability.capabilityId));
    expect(rebuilt.createTeachingToolCommand(pending, context)).toBeUndefined();
    expect(() => rebuilt.createTeachingToolCommand({ ...pending, callId: "stage3-ledger-replacement" }, context)).toThrow(/callId|attempted|successful/i);
    expect(() => rebuilt.acceptTeachingToolAck(pending, ackFor(pending, 1), context)).toThrow(/stale|match|generation/i);
  });

  it("re-enters an interrupted cue through the real Host adapter ledger without reposting its old call", async () => {
    const input = fixtureInput();
    const store = createStage3HostAdapterStore();
    const adapter = new CoachAgentStage3HostAdapter(store);
    const prepared = adapter.prepareStart(input);
    const capability = prepared.capabilities.find((candidate) => candidate.tool === "FOCUS_MAP_EVIDENCE");
    if (!capability) throw new Error("map capability missing");
    const request = AgentToolRequestSchema.parse({
      callId: "stage3-rewalk-call",
      runId: prepared.event.identity.runId,
      cueId: prepared.event.cueId,
      capabilityId: capability.capabilityId,
      tool: capability.tool,
      evidenceRefs: ["annotation-world"],
    });
    const events: string[] = [];
    const posted: unknown[] = [];
    const dispatch = async (event: { type?: string }): Promise<CoachAgentResult> => {
      events.push(event.type ?? "START_CUE");
      if (event.type === "OBSERVE_SEGMENT") return { status: "COMPLETED", effects: [] } as unknown as CoachAgentResult;
      if (event.type === "USER_TAKEOVER") return { status: "USER_TAKEOVER", effects: [] } as unknown as CoachAgentResult;
      if (event.type === "RESUME_TOOL") return { status: "COMPLETED", effects: [] } as unknown as CoachAgentResult;
      return { status: "WAITING_TOOL", effects: [request] } as unknown as CoachAgentResult;
    };
    const controller = new CoachAgentStage3Controller({
      adapter,
      dispatch,
      post: (command) => posted.push(command),
      bridgeAvailable: () => true,
      isLive: () => true,
    });

    controller.start(input);
    for (let index = 0; index < 64; index += 1) await Promise.resolve();
    expect(posted).toHaveLength(1);
    const firstCommand = posted[0];
    if (!firstCommand || typeof firstCommand !== "object" || !("generation" in firstCommand)) {
      throw new Error("first teaching command missing");
    }

    await controller.takeover(input, "用户接管回放。", input.generation);
    controller.acceptAck(ackFor(request, Number(firstCommand.generation)));
    controller.start(input);
    for (let index = 0; index < 16; index += 1) await Promise.resolve();

    expect(posted).toHaveLength(1);
    expect(events.filter((type) => type === "RESUME_TOOL")).toHaveLength(1);
    expect(controller.currentState.status).toBe("COMPLETED");
  });
});
