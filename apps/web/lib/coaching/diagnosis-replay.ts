import type { CoachingSessionState, CueCase, ReviewPlan } from "@cs-coach/contracts";
import { canReplayOutcome, type OutcomeReplayAction, type OutcomeReplayTarget } from "@cs-coach/session";
import { stableStage3IdentityToken } from "./coach-agent-stage3-host-adapter";

interface ReplayHostState { plan?: ReviewPlan; session?: CoachingSessionState; cueCase?: CueCase; busy: boolean; takenOver: boolean; intentEpoch?: number }

export function requestCurrentOutcomeReplay(
  requested: OutcomeReplayTarget,
  read: () => ReplayHostState,
  transition: (action: OutcomeReplayAction) => void,
  requireDiagnosis = false,
  expectedEpoch?: number,
): boolean {
  const { plan, session, cueCase, busy, takenOver, intentEpoch } = read();
  const action: OutcomeReplayAction = { type: "REPLAY_OUTCOME", target: requested };
  if ((expectedEpoch !== undefined && intentEpoch !== expectedEpoch) || !plan || !session || busy || (takenOver && !session.manual_cue_visit) || !canReplayOutcome(plan, session, action)
    || session.outcome_completion?.cueId !== requested.cueId || session.outcome_completion.status !== "COMPLETE") return false;
  if (requireDiagnosis && (cueCase?.cueId !== requested.cueId || cueCase.status === "REFLECTION_PENDING" || cueCase.status === "FALLBACK"
    || !cueCase.reflection || !cueCase.hinge || !cueCase.diagnosticResult || !cueCase.verdict || !cueCase.transferRule)) return false;
  transition(action);
  return true;
}

/** Guard the existing Host transition; replay is not another diagnostic submission. */
export function requestTeachingDiagnosisReplay(
  requested: OutcomeReplayTarget,
  read: () => ReplayHostState,
  transition: (action: OutcomeReplayAction) => void,
): boolean {
  return requestCurrentOutcomeReplay(requested, read, transition, true);
}

/** Reject stale/double clicks before resets or persistence, including before React publishes its next state. */
export class HostOutcomeReplayGuard {
  private accepted = new WeakSet<CoachingSessionState>();
  begin(input: ReplayHostState & { plan: ReviewPlan; action: OutcomeReplayAction; control: { reset(): void };
    notifyTransport(): void; invalidateSeek(): void; clearTakeover(): void }): boolean {
    const { session, plan, action } = input;
    if (!session || input.busy || (input.takenOver && !session.manual_cue_visit)
      || this.accepted.has(session) || !canReplayOutcome(plan, session, action)) return false;
    this.accepted.add(session);
    if (session.manual_cue_visit) {
      input.control.reset();
      input.notifyTransport();
      input.invalidateSeek();
    } else input.clearTakeover();
    return true;
  }
}

export function outcomeReplayInteractionKey(session: CoachingSessionState, action: OutcomeReplayAction): string {
  return action.target?.visitId
    ? `manual-replay-${stableStage3IdentityToken(session.id, action.target.cueId, action.target.visitId, "REPLAY_OUTCOME")}`
    : `${session.id}:${action.type}:${session.current_cue_id ?? session.current_segment_index}`.slice(0, 160);
}

export function newManualVisitId(): string { return `manual-${crypto.randomUUID()}`; }
