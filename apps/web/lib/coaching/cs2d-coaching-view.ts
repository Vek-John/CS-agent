import type { CoachCue, Fact } from "@cs-coach/contracts";

export interface CoachingCueView {
  decisionFacts: Fact[];
  outcomeFacts: Fact[];
  question: string;
  advice?: CoachCue["advice"][number];
}

/** Builds the paused coaching surface without leaking outcome facts early. */
export function buildCoachingCueView(
  cue: CoachCue,
  outcomeVisible: boolean
): CoachingCueView {
  const observableIds = new Set(cue.observable_fact_refs);
  const decisionFacts = cue.facts.filter((fact) =>
    fact.availability === "DECISION" &&
    observableIds.has(fact.id) &&
    fact.available_at_tick <= cue.decision_tick
  );
  const outcomeFacts = outcomeVisible
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
    advice: cue.advice[0]
  };
}
