import type { DecisionSnapshot, Fact, TeachingDiagnosisInput } from "@cs-coach/contracts";

/** Consume only the already freshness/identity-checked snapshot and allowlisted decision facts. */
export function projectDiagnosisClock(snapshot: DecisionSnapshot | undefined, decisionFacts: readonly Fact[]): TeachingDiagnosisInput["decisionClock"] {
  const clock = snapshot?.clock;
  const clockRefs = clock?.evidenceRefs.filter(ref => decisionFacts.some(fact => fact.id === ref && fact.source === "DEMO" && fact.observed_by_player)) ?? [];
  return clock?.boundary === "OBSERVABLE" && clock.value?.phase === "LIVE" &&
    typeof clock.value.remainingSeconds === "number" && Number.isFinite(clock.value.remainingSeconds) && clock.value.remainingSeconds > 0 &&
    clockRefs.length > 0 && clockRefs.length === clock.evidenceRefs.length
    ? { remainingSeconds: clock.value.remainingSeconds, evidenceRefs: [...new Set(clockRefs.filter(value => typeof value === "string" && value.trim()))].slice(0, 8) } : undefined;
}
