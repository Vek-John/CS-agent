import { describe, expect, it } from "vitest";
import {
  CoachAgentEventSchema,
  CoachAgentIdentitySchema,
  diagnoseTeachingCue,
  type CoachAgentEvent,
  type CoachAgentResult,
} from "@cs-coach/coach-agent";
import { buildLocalAgentMemoryEvents } from "./agent-events";

const identity = CoachAgentIdentitySchema.parse({
  runId: "run-local-memory",
  sessionId: "session-local-memory",
  demoId: "demo-local-memory",
  demoContentHash: "demo-local-hash",
  selectedPlayerId: "player-local",
  routeId: "route-local",
  routeHash: "route-local-hash",
});

function reflectionEvent(): Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }> {
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: "SUBMIT_REFLECTION",
    eventId: "local-memory-reflection",
    identity,
    cueId: "cue-local-memory",
    outcomeGateStatus: "COMPLETE",
    input: {
      cueId: "cue-local-memory",
      cue: { id: "cue-local-memory", primary_focus_code: "POSITIONING", limitations: [] },
      // This adapter test is intentionally not a parser/replay fixture. A
      // synthetic timestamp must never be presented as a canonical Demo tick;
      // provenance behavior is covered with stable IDs only.
      decisionFacts: [],
      playerActionFacts: [],
      outcomeFacts: [],
      focusCode: "POSITIONING",
      limitations: [],
    },
    reflection: { cueId: "cue-local-memory", rawText: "我想拿信息", selectedGoal: "GET_INFO", response: "ANSWERED", source: "USER", limitations: [] },
  }) as Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }>;
}

describe("local Agent memory event adapter", () => {
  it("emits bounded events with typed fact/evidence provenance after a completed cue", () => {
    const event = reflectionEvent();
    const diagnosis = diagnoseTeachingCue({
      ...(event.input as Parameters<typeof diagnoseTeachingCue>[0]),
      reflection: event.reflection,
    });
    const result = {
      identity,
      state: { cueCases: { [event.cueId]: diagnosis.cueCase }, learningThreads: [diagnosis.learningThread] },
    } as unknown as CoachAgentResult;
    const events = buildLocalAgentMemoryEvents(event, result, "principal-local-memory");
    expect(events[0]?.type).toBe("CUE_DIAGNOSED");
    const proposal = events[0]?.payload as { origin?: { typedSourceRefs?: readonly { namespace: string; refId: string }[] } };
    expect(proposal.origin?.typedSourceRefs ?? []).not.toContainEqual(expect.objectContaining({ namespace: "DEMO_FACT" }));
    expect(JSON.stringify(events)).not.toContain("available_at_tick");

    const retried = buildLocalAgentMemoryEvents({ ...event, eventId: "local-memory-reflection-retry" }, result, "principal-local-memory");
    expect(retried[0]?.idempotencyKey).toBe(events[0]?.idempotencyKey);
    expect(retried[0]?.proposalId).toBe(events[0]?.proposalId);
  });
});
