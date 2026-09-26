import { describe, expect, it } from "vitest";
import {
  CoachAgentEventSchema,
  type CoachAgentEvent,
} from "./types";
import { FakePolicyAdapter } from "./adapters";
import { createCoachAgentRuntime } from "./runtime";
import { fixtureIdentity, startCueEvent } from "./test-fixtures";

const cueId = "cue-diagnosis-bootstrap";

function reflectionEvent(
  eventId: string,
  reflection: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): CoachAgentEvent {
  const eventCueId = typeof overrides.cueId === "string" ? overrides.cueId : cueId;
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: "SUBMIT_REFLECTION",
    eventId,
    identity: fixtureIdentity,
    cueId: eventCueId,
    outcomeGateStatus: "COMPLETE",
    input: {
      cueId: eventCueId,
      cue: { id: eventCueId, primary_focus_code: "POSITIONING", limitations: [] },
      decisionFacts: [{
        id: "fact-decision",
        text: "决策前仍有可选处理。",
        availability: "DECISION",
        available_at_tick: 100,
        source: "DEMO",
        observed_by_player: true,
      }],
      playerActionFacts: [{
        id: "fact-action",
        text: "玩家主动接触。",
        actorPlayerId: fixtureIdentity.selectedPlayerId,
        availableAtTick: 100,
        source: "DEMO",
        evidenceRefs: ["fact-decision"],
        limitations: [],
      }],
      outcomeFacts: [{
        id: "fact-outcome",
        text: "随后发生负向接触结果。",
        availableAtTick: 120,
        source: "DEMO",
        outcomeKind: "HP_CHANGE",
        evidenceRefs: ["fact-action"],
        limitations: [],
      }],
      focusCode: "POSITIONING",
      limitations: [],
    },
    reflection: {
      cueId: eventCueId,
      selectedGoal: "GET_INFO",
      response: "ANSWERED",
      source: "USER",
      limitations: [],
      ...reflection,
    },
    ...overrides,
  });
}

function disagreementEvent(eventId: string, rawText: string): CoachAgentEvent {
  const event = reflectionEvent(eventId, { rawText });
  return { ...event, type: "SUBMIT_DISAGREEMENT" } as CoachAgentEvent;
}

describe("Coach Agent teaching diagnosis bootstrap", () => {
  it("revises a goal without rebuilding a phantom teammate belief from its rejected wording", async () => {
    const runtime = createCoachAgentRuntime();
    await runtime.dispatch(reflectionEvent("goal-context-original", { selectedGoal: "TRADE", rawText: "我想给队友补枪" }));
    const submission = reflectionEvent("goal-context-revised", { selectedGoal: undefined, rawText: "不是给队友补枪，是保枪" });
    const revised = await runtime.dispatch({ ...submission, type: "SUBMIT_DISAGREEMENT" } as CoachAgentEvent);
    const result = revised.state.cueCases[cueId];
    expect(result.hinge?.kind).toBe("RISK");
    expect(result.claims.map(claim => claim.type)).toEqual(["GOAL"]);
    expect(result.reflection?.selectedGoal).toBe("SAVE");
    expect(result.previousReflection?.rawText).toBe("我想给队友补枪");
    expect(result.attemptBudget.disagreement).toBe(1);
  });

  it("revises two separately bounded long reflections through the real runtime without fallback or duplicate attempts", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("must not call Policy") });
    const runtime = createCoachAgentRuntime({ policy });
    const originalText = "原思路".repeat(160) + "我当时没有看到敌人。";
    const newText = "补充说明".repeat(120) + "没有确认队友位置。";
    const first = await runtime.dispatch(reflectionEvent("long-first", { rawText: originalText }));
    const event = disagreementEvent("long-revision", newText);
    const revised = await runtime.dispatch(event);
    const c = revised.state.cueCases[cueId];
    expect(c.status).toBe("DISAGREED");
    expect(c.previousReflection?.rawText).toBe(originalText);
    expect(c.reflection?.rawText).toBe(newText);
    expect(c.caseId).toBe(first.state.cueCases[cueId].caseId);
    expect(c.attemptBudget.disagreement).toBe(1);
    expect(revised.state.learningThreads).toHaveLength(1);
    const duplicate = await runtime.dispatch(event);
    expect(duplicate.state.cueCases[cueId]).toEqual(c);
    const second = await runtime.dispatch(disagreementEvent("second-revision", "不再执行第二次复核"));
    expect(second.state.cueCases[cueId]).toEqual(c);
    expect(policy.calls).toHaveLength(0);
  });

  it("bootstraps the first reflection without route/tick state or visual Policy", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("diagnosis must not call visual Policy") });
    const runtime = createCoachAgentRuntime({ policy });
    const result = await runtime.dispatch(reflectionEvent("diagnosis-first"));

    expect(result.status).toBe("COMPLETED");
    expect(result.effects).toEqual([]);
    expect(result.state.activeCueId).toBe(cueId);
    expect(result.state.currentSessionPhase).toBe("PAUSED_FOR_COACHING");
    expect(result.state.outcomeGateStatus).toBe("COMPLETE");
    expect(result.state.activeSegmentId).toBeNull();
    expect(result.state.routeCursor).toBe(-1);
    expect(result.state.cueCases[cueId]?.cueId).toBe(cueId);
    expect(result.state.learningThreads).toHaveLength(1);
    expect(policy.calls).toHaveLength(0);
  });

  it("does not bootstrap a reflection without a cue-bound completed-outcome packet", async () => {
    const runtime = createCoachAgentRuntime();
    const base = reflectionEvent("diagnosis-input-fixture");
    if (base.type !== "SUBMIT_REFLECTION") throw new Error("reflection fixture should be a submission event");
    const event = reflectionEvent("diagnosis-missing-outcome", {}, {
      input: {
        ...base.input,
        outcomeFacts: [],
      },
    });

    const result = await runtime.dispatch(event);

    expect(result.status).toBe("DORMANT");
    expect(result.restored).toBe("DORMANT_MISSING");
    expect(result.state.activeCueId).toBeNull();
    expect(result.state.cueCases).toEqual({});
  });

  it("records SKIPPED, deduplicates a repeated event, and exhausts a second reflection", async () => {
    const runtime = createCoachAgentRuntime();
    const skipped = await runtime.dispatch(reflectionEvent("diagnosis-skip", { response: "SKIPPED" }));
    const duplicate = await runtime.dispatch(reflectionEvent("diagnosis-skip", { response: "SKIPPED" }));
    const repeated = await runtime.dispatch(reflectionEvent("diagnosis-skip-again", { response: "SKIPPED" }));

    expect(skipped.state.cueCases[cueId]?.reflection?.response).toBe("SKIPPED");
    expect(skipped.state.learningThreads).toHaveLength(0);
    expect(duplicate.state.cueCases[cueId]?.attemptBudget.reflection).toBe(1);
    expect(duplicate.state.trace).toEqual(skipped.state.trace);
    expect(repeated.state.cueCases[cueId]?.attemptBudget.reflection).toBe(1);
    expect(repeated.state.fallbackReasons).toContain("DIAGNOSIS_ATTEMPT_EXHAUSTED");
  });

  it("binds a next cue after a completed diagnosis without reviving visual route state", async () => {
    const policy = new FakePolicyAdapter({ failure: new Error("diagnosis must not call visual Policy") });
    const runtime = createCoachAgentRuntime({ policy });
    const first = await runtime.dispatch(reflectionEvent("diagnosis-first-continuous"));
    const secondCueId = "cue-diagnosis-next";
    const second = await runtime.dispatch(reflectionEvent(
      "diagnosis-second-continuous",
      { selectedGoal: "DELAY" },
      { cueId: secondCueId },
    ));

    expect(first.state.cueCases[cueId]?.cueId).toBe(cueId);
    expect(second.status).toBe("COMPLETED");
    expect(second.effects).toEqual([]);
    expect(second.state.activeCueId).toBe(secondCueId);
    expect(second.state.currentSessionPhase).toBe("PAUSED_FOR_COACHING");
    expect(second.state.activeSegmentId).toBeNull();
    expect(second.state.activeCueSource).toBeNull();
    expect(second.state.activeNarrationPolicySummary).toBeNull();
    expect(second.state.activeAllowedEvidenceSummary).toEqual([]);
    expect(second.state.availableCapabilities).toEqual([]);
    expect(second.state.cueCases[cueId]?.cueId).toBe(cueId);
    expect(second.state.cueCases[secondCueId]?.cueId).toBe(secondCueId);
    expect(policy.calls).toHaveLength(0);
  });

  it("projects a recalled cross-Demo thread into CHECK_TRANSFER for the next cue", async () => {
    const runtime = createCoachAgentRuntime();
    const brief = {
      schemaVersion: "memory-brief.v1" as const,
      generatedAt: "2026-08-28T00:00:00.000Z",
      activeThreads: [{ scope: "CROSS_DEMO", status: "STABLE" }],
      memories: [],
      corrections: [],
      limitations: [],
      source: "STRUCTURED" as const,
    };
    const started = await runtime.dispatch(startCueEvent({
      eventId: "memory-mode-start",
      capabilities: [],
      memoryBrief: brief,
    }));
    const reflection = reflectionEvent("memory-mode-reflection", { selectedGoal: "OTHER" }, {
      cueId: "cue-memory-mode",
    });
    if (reflection.type !== "SUBMIT_REFLECTION") throw new Error("memory mode fixture should be a reflection");
    const next = await runtime.dispatch({
      ...reflection,
      input: {
        ...reflection.input,
        decisionResources: {
          health: 100,
          armor: 100,
          hasHelmet: true,
          inventoryCount: 1,
          evidenceRefs: ["fact-decision"],
        },
      },
    });

    expect(started.state.memoryBrief).toMatchObject({ activeThreads: brief.activeThreads });
    expect(next.state.cueCases["cue-memory-mode"]?.pedagogyMode).toBe("CHECK_TRANSFER");
  });

  it("allows one disagreement only after a case and thread exist", async () => {
    const runtime = createCoachAgentRuntime();
    const first = await runtime.dispatch(reflectionEvent("diagnosis-answer"));
    const beforeCase = first.state.cueCases[cueId];
    if (!beforeCase) throw new Error("first reflection should create a cue case");

    const revised = await runtime.dispatch(disagreementEvent("diagnosis-disagreement", "当时我确实听到了队友报点。"));
    const revisedCase = revised.state.cueCases[cueId];
    expect(revisedCase?.caseId).toBe(beforeCase.caseId);
    expect(revisedCase?.status).toBe("DISAGREED");
    expect(revisedCase?.attemptBudget.disagreement).toBe(1);
    expect(revised.state.learningThreads).toHaveLength(1);

    const second = await runtime.dispatch(disagreementEvent("diagnosis-disagreement-again", "再补充一次。"));
    expect(second.state.cueCases[cueId]?.attemptBudget.disagreement).toBe(1);
    expect(second.state.fallbackReasons).toContain("DIAGNOSIS_ATTEMPT_EXHAUSTED");
  });

  it("rejects an illegal outcome gate before creating a diagnosis checkpoint", () => {
    const runtime = createCoachAgentRuntime();
    const invalid = {
      ...reflectionEvent("diagnosis-invalid-gate"),
      outcomeGateStatus: "LOCKED",
    } as unknown as CoachAgentEvent;

    expect(() => runtime.dispatch(invalid)).toThrow();
  });
});
