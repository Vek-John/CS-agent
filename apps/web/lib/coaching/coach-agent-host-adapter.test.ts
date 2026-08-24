import { describe, expect, it, vi } from "vitest";
import { AgentToolRequestSchema } from "@cs-coach/coach-agent/client";
import type { CoachingRouteState } from "@cs-coach/contracts";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import {
  CoachAgentHostAdapter,
  STAGE2_ACK_TIMEOUT_MS,
  Stage2AckTimeoutController,
  buildStage2StartCue,
  selectFirstStage2Cue,
  stage2WorldPoint,
  type CoachAgentHostAdapterInput,
} from "./coach-agent-host-adapter";

const HASH = "a".repeat(64);

function fixtureInput(overrides: Partial<CoachAgentHostAdapterInput> = {}): CoachAgentHostAdapterInput {
  const base = createFixtureReviewPlan(createSyntheticMirageTimeline());
  const source = base.cues[0];
  if (!source) throw new Error("fixture cue missing");
  const cue = {
    ...source,
    primary_focus_code: "SURVIVE_CONTACT",
    observable_fact_refs: ["decision-ref"],
    action_fact_refs: ["action-ref"],
    outcome_fact_refs: ["outcome-ref"],
    evidence: [{ id: "evidence-ref", source: "RULE" as const, label: "站位证据", fact_refs: ["decision-ref"] }],
    advice: [{ id: "advice-ref", text: "先等补枪", trigger: "接触前", fact_refs: ["decision-ref"] }],
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
    segments: base.segments.map((segment, index) => ({
      ...segment,
      cue_ids: index === 0 ? [cue.id] : [],
    })),
  };
  const routeState: CoachingRouteState = {
    routeFrozen: true,
    routeFingerprint: "route-fingerprint-stage2",
    candidateSetId: "candidate-set-stage2",
    candidateSetHash: "candidate-hash-stage2",
    selectedCueCount: 1,
    readiness: { [cue.id]: "READY" },
    cueOrder: [cue.id],
    cueBindings: { [cue.id]: { candidateId: cue.candidate_id ?? "candidate", primaryFocusCode: "SURVIVE_CONTACT" } },
    startable: true,
    consumedCueIds: [],
    frozenCueIds: [cue.id],
  };
  const input: CoachAgentHostAdapterInput = {
    plan,
    routeState,
    cue,
    narration: {
      cueId: cue.id,
      candidateId: cue.candidate_id ?? "candidate",
      primaryFocusCode: "SURVIVE_CONTACT",
      currentSituation: { text: "当前情况", refs: ["decision-ref"] },
      playerAction: { text: "玩家动作", refs: ["action-ref"] },
      coreIssue: { text: "核心问题", refs: ["decision-ref", "action-ref"] },
      betterPlay: { text: "更好处理", refs: ["advice-ref"] },
      outcomeImpact: { text: "结果", refs: ["outcome-ref"] },
    },
    outcomeGate: { cueId: cue.id, outcomeEndTick: cue.outcome_end_tick, status: "COMPLETE", completedAtTick: cue.outcome_end_tick },
    currentSessionPhase: "PAUSED_FOR_COACHING",
    analysis: { demo_id: plan.demo_id, selected_steam_id: plan.player_id, metadata: { demo_content_hash: HASH } },
    demoContentHash: HASH,
    selectedPlayerId: plan.player_id,
    sessionId: "stage2-session",
    runId: "stage2-run",
    generation: 1,
  };
  return { ...input, ...overrides };
}

function requestFromStart(start: ReturnType<typeof buildStage2StartCue>) {
  const capability = start.capabilities[0];
  if (!capability) throw new Error("Stage2 capability missing");
  return AgentToolRequestSchema.parse({
    callId: "stage2-call-1",
    runId: start.event.identity.runId,
    cueId: start.event.cueId,
    capabilityId: capability.capabilityId,
    tool: capability.tool,
    evidenceRefs: capability.evidenceRefs.filter((ref) => ref === "annotation-world" || ref === "evidence-ref"),
  });
}

describe("CoachAgentHostAdapter", () => {
  it("bounds a lost iframe ACK and permits the caller to recover", () => {
    vi.useFakeTimers();
    try {
      const timedOut: number[] = [];
      const controller = new Stage2AckTimeoutController();
      controller.arm(7, (generation) => timedOut.push(generation));
      vi.advanceTimersByTime(STAGE2_ACK_TIMEOUT_MS - 1);
      expect(timedOut).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(timedOut).toEqual([7]);
      controller.clear();
      vi.advanceTimersByTime(STAGE2_ACK_TIMEOUT_MS);
      expect(timedOut).toEqual([7]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not build or dispatch a capability before a complete outcome gate", () => {
    const input = fixtureInput({
      outcomeGate: { ...fixtureInput().outcomeGate, status: "LOCKED" },
    });
    expect(() => buildStage2StartCue(input)).toThrow(/outcome gate/i);
  });

  it("selects the first eligible frozen-route cue and keeps route/hash identity immutable", () => {
    const input = fixtureInput();
    const selected = selectFirstStage2Cue(input.plan, input.routeState);
    expect(selected?.id).toBe(input.cue.id);
    const start = buildStage2StartCue(input);
    expect(start.capabilities).toHaveLength(1);
    expect(start.capabilities[0]?.tool).toBe("FOCUS_MAP_EVIDENCE");
    expect(start.event.identity.demoContentHash).toBe(HASH);
    expect(start.event.identity.routeId).toBe(input.plan.id);
    expect(start.event.identity.routeHash).toBe(input.routeState.routeFingerprint);
    expect(start.event.identity.demoId).toBe(input.analysis.demo_id);
    expect(input.routeState.routeFingerprint).toBe("route-fingerprint-stage2");
  });

  it("does not invent a capability when the cue has no WORLD point annotation", () => {
    const original = fixtureInput();
    const cue = { ...original.cue, annotations: [] };
    const input = {
      ...original,
      cue,
      plan: { ...original.plan, cues: [cue] },
    };
    const start = buildStage2StartCue(input);
    expect(start.capabilities).toEqual([]);
    expect(selectFirstStage2Cue(input.plan, input.routeState)).toBeUndefined();
  });

  it("binds map coordinates only from the registered annotation and dedupes command/ACK/resume", () => {
    const input = fixtureInput();
    const adapter = new CoachAgentHostAdapter();
    const start = adapter.prepareStart(input);
    const request = requestFromStart(start);
    const context = { generation: 1, currentSessionPhase: "PAUSED_FOR_COACHING" as const, outcomeGate: input.outcomeGate };
    expect(stage2WorldPoint(input.cue, "annotation-world")?.point).toEqual({ x: 120, y: -80, z: 0 });
    (input.cue.annotations[0] as { point: { x: number; y: number; z: number } }).point = { x: 999, y: 999, z: 0 };
    (input.routeState as { routeFingerprint: string }).routeFingerprint = "mutated-after-start";
    const command = adapter.createFocusMapCommand(request, context);
    expect(command).toMatchObject({ type: "focusMapEvidence", focusWorld: { x: 120, y: -80 }, annotationRef: "annotation-world" });
    expect(adapter.createFocusMapCommand(request, context)).toBeUndefined();

    const ack = {
      type: "TEACHING_TOOL_ACK" as const,
      schemaVersion: "cs2d-teaching-tool-ack.v1" as const,
      tool: "FOCUS_MAP_EVIDENCE" as const,
      callId: request.callId,
      runId: request.runId,
      generation: 1,
      cueId: request.cueId,
      annotationRef: "annotation-world",
      status: "SUCCEEDED" as const,
      observationCode: "EVIDENCE_SHOWN" as const,
      completed: true,
      limitations: [],
    };
    const result = adapter.acceptTeachingToolAck(request, ack, context);
    expect(result?.observation.code).toBe("EVIDENCE_SHOWN");
    expect(adapter.acceptTeachingToolAck(request, ack, context)).toBeUndefined();
    const resume = adapter.createResumeEvent(request, result!, context, "stage2-resume-1");
    expect(resume?.type).toBe("RESUME_TOOL");
    expect(adapter.createResumeEvent(request, result!, context, "stage2-resume-duplicate")).toBeUndefined();
  });

  it("rejects stale identity/evidence and cancelled generations before a side effect", () => {
    const input = fixtureInput();
    const adapter = new CoachAgentHostAdapter();
    const start = adapter.prepareStart(input);
    const request = requestFromStart(start);
    const context = { generation: 1, currentSessionPhase: "PAUSED_FOR_COACHING" as const, outcomeGate: input.outcomeGate };
    expect(() => adapter.createFocusMapCommand({ ...request, cueId: "other-cue" }, context)).toThrow(/identity/i);
    expect(() => adapter.createFocusMapCommand({ ...request, evidenceRefs: ["not-registered"] }, context)).toThrow(/evidence/i);
    expect(() => adapter.createFocusMapCommand(request, { ...context, currentSessionPhase: "REPLAYING" })).toThrow(/phase/i);
    adapter.cancel(1);
    expect(() => adapter.createFocusMapCommand(request, context)).toThrow(/registered|cancelled/i);
    const ack = {
      type: "TEACHING_TOOL_ACK" as const,
      schemaVersion: "cs2d-teaching-tool-ack.v1" as const,
      tool: "FOCUS_MAP_EVIDENCE" as const,
      callId: request.callId,
      runId: request.runId,
      generation: 1,
      cueId: request.cueId,
      annotationRef: "annotation-world",
      status: "SUCCEEDED" as const,
      observationCode: "EVIDENCE_SHOWN" as const,
      completed: true,
      limitations: [],
    };
    expect(() => adapter.acceptTeachingToolAck(request, ack, context)).toThrow(/registered|cancelled/i);
    expect(() => adapter.createResumeEvent(request, {
      callId: request.callId,
      status: "SUCCEEDED",
      observation: { code: "EVIDENCE_SHOWN", completed: true },
      limitations: [],
    }, context, "stage2-resume-stale")).toThrow(/registered|cancelled/i);
    expect(adapter.capabilityCount).toBe(0);
  });
});
