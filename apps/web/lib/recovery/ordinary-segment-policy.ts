import type { ReviewPlan, CoachingSessionState } from "@cs-coach/contracts";

/** A successful ordinary save consumes one round slot; failed/pending saves do not. */
export class OrdinarySegmentRecoveryPolicy {
  private recoveryId?: string;
  private rounds = new Set<number>();

  eligible(plan: ReviewPlan, session: CoachingSessionState, recoveryId: string): boolean {
    const segment = plan.segments[session.current_segment_index];
    return session.phase === "PLAYING" && !session.manual_cue_visit
      && !session.current_cue_id && !!segment && Number.isInteger(segment.round_number) && segment.round_number > 0
      && (segment.mode === "BRIEF" || segment.mode === "OBSERVE") && segment.cue_ids.length === 0
      && session.current_tick >= segment.start_tick && session.current_tick < segment.end_tick
      && (this.recoveryId !== recoveryId || !this.rounds.has(segment.round_number));
  }

  confirm(plan: ReviewPlan, segmentIndex: number, recoveryId: string): void {
    const segment = plan.segments[segmentIndex];
    if (!segment || !Number.isInteger(segment.round_number) || segment.round_number <= 0) return;
    if (this.recoveryId !== recoveryId) { this.recoveryId = recoveryId; this.rounds.clear(); }
    this.rounds.add(segment.round_number);
  }
}
