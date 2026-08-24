import {
  CoachAgentStateSchema,
  type CoachAgentState,
} from "./types";

/**
 * Pure completion compaction seam for the DO owner. It is deliberately not
 * called by the saver: 04 can choose when a completed session is safe to
 * replace with this summary while retaining the same session identity.
 */
export function compactCompletedCoachRunState(state: CoachAgentState): CoachAgentState {
  const checked = CoachAgentStateSchema.parse(state);
  if (checked.sessionStatus !== "COMPLETED") return checked;
  return CoachAgentStateSchema.parse({
    ...checked,
    trace: checked.trace.slice(-8),
    toolHistory: checked.toolHistory.slice(-4),
    completedCueSummaries: checked.completedCueSummaries.slice(-3),
    observedSegmentIds: checked.observedSegmentIds.slice(-20),
    summaryThemes: checked.summaryThemes.slice(0, 3),
  });
}
