import type { CoachingSessionPhase } from "@cs-coach/contracts";

export function canShowGroundTruthForPhase(
  phase: CoachingSessionPhase,
  hasCue: boolean,
  revealed: boolean
): boolean {
  return !hasCue || revealed || phase === "REVEALING" || phase === "REPLAYING";
}
