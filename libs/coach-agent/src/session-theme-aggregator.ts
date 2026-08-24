import {
  PresentableCueSummarySchema,
  SessionThemeSchema,
  type PresentableCueSummary,
  type SessionTheme,
} from "./types";

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const MAX_THEME_REFS = 16;

/**
 * SessionTheme is a compact index, not the complete evidence ledger. Keep a
 * deterministic bounded summary: first preserve the representative cue (the
 * earliest cue with advice, matching wrap-up selection), then fill remaining
 * slots in completed-cue order. Full completedCueSummaries/completedCueIds
 * stay in state, so clipping here cannot discard completion history.
 */
function boundedRefs(
  allValues: readonly string[],
  representativeValues: readonly string[],
): string[] {
  return unique([...representativeValues, ...allValues]).slice(0, MAX_THEME_REFS);
}

function economyFor(summaries: readonly PresentableCueSummary[]): PresentableCueSummary["economyContext"] {
  const counts = new Map<PresentableCueSummary["economyContext"], number>();
  for (const summary of summaries) {
    counts.set(summary.economyContext, (counts.get(summary.economyContext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([leftClass, leftCount], [rightClass, rightCount]) => rightCount - leftCount || leftClass.localeCompare(rightClass))[0]?.[0] ?? "UNKNOWN";
}

export function aggregateSessionThemes(rawSummaries: readonly PresentableCueSummary[]): SessionTheme[] {
  const summaries = rawSummaries.map((summary) => PresentableCueSummarySchema.parse(summary));
  const byFocus = new Map<string, PresentableCueSummary[]>();
  for (const summary of summaries) {
    const list = byFocus.get(summary.focus) ?? [];
    list.push(summary);
    byFocus.set(summary.focus, list);
  }
  return [...byFocus.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([focus, focusSummaries]) => {
      const representative = focusSummaries.find((summary) => summary.adviceRefs.length > 0) ?? focusSummaries[0];
      return SessionThemeSchema.parse({
        focus,
        cueRefs: boundedRefs(
          focusSummaries.map((summary) => summary.cueId),
          representative ? [representative.cueId] : [],
        ),
        roundRefs: boundedRefs(
          focusSummaries.map((summary) => summary.roundId),
          representative ? [representative.roundId] : [],
        ),
        evidenceRefs: boundedRefs(
          focusSummaries.flatMap((summary) => summary.evidenceRefs),
          representative?.evidenceRefs ?? [],
        ),
        occurrence: focusSummaries.length,
        economyContext: economyFor(focusSummaries),
        repeated: focusSummaries.length > 1,
        conflictEvidence: focusSummaries.some((summary) => summary.conflictEvidence),
      });
    });
}
