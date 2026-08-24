import { describe, expect, it } from "vitest";
import { compactCompletedCoachRunState } from "./checkpoint-compaction";
import { createCoachAgentRuntime } from "./runtime";
import { resumeEvent, startCueEvent } from "./test-fixtures";

describe("completed CoachRun checkpoint compaction seam", () => {
  it("keeps route/session summary identity while reducing completed-run history", async () => {
    const runtime = createCoachAgentRuntime();
    const started = await runtime.dispatch(startCueEvent());
    const completed = await runtime.dispatch(resumeEvent(started.effects[0], { eventId: "event-compact-done" }));
    const session = await runtime.dispatch({
      version: "coach-agent-event.v2",
      type: "COMPLETE_SESSION",
      eventId: "event-compact-session",
      identity: completed.identity,
    });
    const compacted = compactCompletedCoachRunState(session.state);

    expect(compacted.sessionStatus).toBe("COMPLETED");
    expect(compacted.routeHash).toBe(session.state.routeHash);
    expect(compacted.completedCueIds).toEqual(session.state.completedCueIds);
    expect(compacted.sessionSummaryInput).toEqual(session.state.sessionSummaryInput);
    expect(compacted.trace.length).toBeLessThanOrEqual(8);
    expect(compacted.toolHistory.length).toBeLessThanOrEqual(4);
    expect(compacted.completedCueSummaries.length).toBeLessThanOrEqual(3);
  });
});
