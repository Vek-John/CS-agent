export type HistoryGenerationResult<T> =
  | { readonly status: "RESTORE_ONLY" }
  | { readonly status: "GENERATED"; readonly value: T };

export const HISTORY_ANALYSIS_EVENT_TYPES = [
  "ANALYSIS_PROGRESS",
  "ANALYSIS_TELEMETRY",
  "ANALYSIS_FAILED",
  "ANALYSIS_READY",
] as const;

export type HistoryAnalysisEventType = (typeof HISTORY_ANALYSIS_EVENT_TYPES)[number];

/**
 * A RESTORE consumes the frozen SQLite control plane, not any analysis event
 * left in flight from the previous Viewer selection. This guard belongs at
 * the bridge dispatch boundary so progress/failure events cannot mutate state
 * before the ANALYSIS_READY generation gate is reached.
 */
export function ignoreHistoryAnalysisEvent(
  historyPlaybackOnly: boolean,
  eventType: string,
): boolean {
  return historyPlaybackOnly && (HISTORY_ANALYSIS_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * The Host wraps its complete ANALYSIS_READY generation branch in this second
 * gate, after the bridge-wide analysis event guard.
 * A saved-history playback can therefore consume no Director, Narrator,
 * Reflection, Adaptive, or Embedding provider even if Viewer mis-emits an
 * analysis event during deterministic media reconstruction.
 */
export async function runHistoryAnalysisGeneration<T>(
  historyPlaybackOnly: boolean,
  generate: () => T | Promise<T>,
): Promise<HistoryGenerationResult<T>> {
  if (historyPlaybackOnly) return { status: "RESTORE_ONLY" };
  return { status: "GENERATED", value: await generate() };
}
