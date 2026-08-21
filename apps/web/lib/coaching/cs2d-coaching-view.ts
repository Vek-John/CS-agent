import type { CoachCue, Fact, NarrationBundle, OutcomeCompletionState } from "@cs-coach/contracts";
import { canPresentOutcome } from "@cs-coach/session";

export interface CoachingCueView {
  decisionFacts: Fact[];
  outcomeFacts: Fact[];
  question: string;
  advice?: CoachCue["advice"][number];
  /** Present only after the cue's one-way outcome gate is complete. */
  narration?: NarrationBundle;
}

function gateIsComplete(cue: CoachCue, gate: OutcomeCompletionState | undefined): boolean {
  return Boolean(gate && gate.cueId === cue.id && canPresentOutcome(gate));
}

/** Pure selector: replay phase hides the body while preserving a completed gate. */
export function selectPresentableNarration(
  cue: CoachCue,
  phase: "PAUSED_FOR_COACHING" | "REPLAYING" | "REVEALING" | undefined,
  gate: OutcomeCompletionState | undefined,
  preparedNarration?: NarrationBundle
): NarrationBundle | undefined {
  if (phase !== "PAUSED_FOR_COACHING" || !gateIsComplete(cue, gate)) return undefined;
  return preparedNarration;
}

/** Builds the paused coaching surface without leaking outcome facts early. */
export function buildCoachingCueView(
  cue: CoachCue,
  outcomeVisible: boolean | OutcomeCompletionState,
  preparedNarration?: NarrationBundle
): CoachingCueView {
  const gate = typeof outcomeVisible === "boolean" ? undefined : outcomeVisible;
  const isOutcomeVisible = typeof outcomeVisible === "boolean" ? outcomeVisible : gateIsComplete(cue, gate);
  const observableIds = new Set(cue.observable_fact_refs);
  const decisionFacts = cue.facts.filter((fact) =>
    fact.availability === "DECISION" &&
    observableIds.has(fact.id) &&
    fact.available_at_tick <= cue.decision_tick
  );
  const outcomeFacts = isOutcomeVisible
    ? cue.facts.filter((fact) =>
        fact.availability === "OUTCOME" &&
        fact.available_at_tick >= cue.reveal_tick &&
        fact.available_at_tick <= cue.outcome_end_tick
      )
    : [];

  return {
    decisionFacts,
    outcomeFacts,
    question: cue.question,
    advice: cue.advice[0],
    ...(isOutcomeVisible && preparedNarration ? { narration: preparedNarration } : {})
  };
}
