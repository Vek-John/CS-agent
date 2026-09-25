import type { CoachingSessionState, CueCase } from "@cs-coach/contracts";

/** Guard the existing Host transition; replay is not another diagnostic submission. */
export function requestTeachingDiagnosisReplay(
  requested: { sessionId: string; cueId: string },
  read: () => { session?: CoachingSessionState; cueCase?: CueCase; busy: boolean; takenOver: boolean },
  transition: (action: { type: "REPLAY_OUTCOME" }) => void,
): boolean {
  const { session, cueCase, busy, takenOver } = read();
  if (busy || takenOver || !session || session.id !== requested.sessionId || session.current_cue_id !== requested.cueId
    || session.manual_cue_visit || session.phase !== "PAUSED_FOR_COACHING"
    || !session.revealed_cue_ids.includes(requested.cueId)
    || session.outcome_completion?.cueId !== requested.cueId || session.outcome_completion.status !== "COMPLETE"
    || cueCase?.cueId !== requested.cueId || cueCase.status === "REFLECTION_PENDING" || cueCase.status === "FALLBACK"
    || !cueCase.reflection || !cueCase.hinge || !cueCase.diagnosticResult || !cueCase.verdict || !cueCase.transferRule) return false;
  transition({ type: "REPLAY_OUTCOME" });
  return true;
}
