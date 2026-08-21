import type {
  CandidateSet,
  CoachCue,
  CoachingPackage,
  MatchTimeline,
  ObservableState,
  OutcomeImpact,
  OutcomePackage,
  WinProbabilityTimelineV1
} from "@cs-coach/contracts";

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function candidateMaterialFor(cue: CoachCue, candidateSet: CandidateSet) {
  if (!cue.candidate_id) throw new Error(`Cue ${cue.id} is not bound to a candidate.`);
  const candidate = candidateSet.candidates.find((item) => item.candidateId === cue.candidate_id);
  const material = candidateSet.materials.find((item) => item.candidateId === cue.candidate_id);
  if (!candidate || !material) throw new Error(`Cue ${cue.id} references an unknown candidate material.`);
  if (material.observableStateId !== cue.observable_state_id) throw new Error(`Cue ${cue.id} is bound to the wrong ObservableState.`);
  return { candidate, material };
}

export function buildCoachingPackage(cue: CoachCue, candidateSet: CandidateSet, observationEvidence: readonly ObservableState[], additionalLimitations: readonly string[] = []): CoachingPackage {
  const { candidate, material } = candidateMaterialFor(cue, candidateSet);
  const observableState = material.observableStateId ? observationEvidence.find((state) => state.id === material.observableStateId) : undefined;
  if (material.observableStateId && !observableState) throw new Error(`Candidate ${candidate.candidateId} references missing ObservableState ${material.observableStateId}.`);
  const observableIds = new Set(cue.observable_fact_refs);
  const candidateFactIds = new Set(candidate.factRefs);
  const facts = material.decisionFacts.filter((fact) => candidateFactIds.has(fact.id) && observableIds.has(fact.id) && fact.availability === "DECISION" && fact.observed_by_player && fact.available_at_tick <= cue.decision_tick);
  const candidateClaimIds = new Set(candidate.observableClaimRefs);
  const stateClaims = observableState?.claims ?? [];
  const stateClaimIds = new Set(stateClaims.map((claim) => claim.id));
  const missingClaims = [...candidateClaimIds].filter((claimId) => !stateClaimIds.has(claimId));
  if (missingClaims.length > 0) throw new Error(`Candidate ${candidate.candidateId} references claims outside its ObservableState: ${missingClaims.join(", ")}.`);
  const claims = stateClaims.filter((claim) => candidateClaimIds.has(claim.id) && claim.available_from_tick <= cue.decision_tick && (claim.expires_at_tick === undefined || cue.decision_tick < claim.expires_at_tick));
  const playerAction = material.playerActionFacts.filter((fact) => candidate.actionRefs.includes(fact.id) && fact.availableAtTick <= cue.reveal_tick);
  const advice = [...cue.advice];
  const evidence = [...cue.evidence];
  const allowedRefs = {
    decision: unique([...facts.map((fact) => fact.id), ...claims.map((claim) => claim.id)]),
    action: unique(playerAction.map((fact) => fact.id)),
    advice: unique(advice.map((item) => item.id)),
    evidence: unique(evidence.map((item) => item.id))
  };
  assertDisjointNamespaces(allowedRefs);
  if (candidate.factRefs.length > 0 && facts.length === 0) throw new Error(`Candidate ${candidate.candidateId} is not startable: decision facts are missing or not observable at the cue tick.`);
  if (candidate.actionRefs.length > 0 && playerAction.length === 0) throw new Error(`Candidate ${candidate.candidateId} is not startable: verified player action is missing.`);
  return {
    cueId: cue.id,
    candidateId: cue.candidate_id ?? cue.id,
    decisionContext: { facts, claims },
    playerAction,
    inferences: [...cue.inferences],
    advice,
    evidence,
    primaryFocusCode: cue.primary_focus_code ?? "UNSPECIFIED_FOCUS",
    allowedRefs: {
      ...allowedRefs
    },
    limitations: unique([
      ...cue.limitations,
      ...additionalLimitations,
      ...(facts.length === 0 ? ["NARRATION_NOT_STARTABLE_MISSING_DECISION_FACTS"] : []),
      ...(playerAction.length === 0 ? ["NARRATION_NOT_STARTABLE_MISSING_ACTION_FACTS"] : [])
    ])
  };
}

export function buildOutcomePackage(cue: CoachCue, candidateSet: CandidateSet, outcomeImpact?: OutcomeImpact): OutcomePackage {
  const { candidate, material } = candidateMaterialFor(cue, candidateSet);
  if (outcomeImpact && outcomeImpact.cueId !== cue.id) throw new Error(`OutcomeImpact is bound to ${outcomeImpact.cueId}, not ${cue.id}.`);
  const outcomeFacts = material.outcomeFacts.filter((fact) => candidate.outcomeRefs.includes(fact.id));
  if (candidate.outcomeRefs.length > 0 && outcomeFacts.length === 0) throw new Error(`Candidate ${candidate.candidateId} is not startable: outcome facts are missing.`);
  if (candidate.outcomeRefs.length === 0 && !outcomeImpact) throw new Error(`Candidate ${candidate.candidateId} is not startable: outcome or measurement evidence is missing.`);
  const measurementRefs = outcomeImpact ? [`measurement-${cue.id}`] : [];
  return {
    cueId: cue.id,
    candidateId: cue.candidate_id ?? cue.id,
    outcomeFacts,
    deathKillHpRefs: outcomeFacts.filter((fact) => ["DEATH", "KILL", "HP_CHANGE"].includes(fact.outcomeKind)).map((fact) => fact.id),
    ...(outcomeImpact ? { winProbabilityImpact: outcomeImpact } : {}),
    measurementRefs,
    confounders: outcomeImpact?.confidence === "LOW" ? ["多个结果事件或模型信号同时发生，不能归因给单一动作。"] : [],
    limitations: [...cue.limitations, ...(outcomeImpact?.limitations ?? [])]
  };
}

function assertDisjointNamespaces(namespaces: Record<string, readonly string[]>): void {
  const seen = new Set<string>();
  for (const [namespace, refs] of Object.entries(namespaces)) {
    for (const ref of refs) {
      if (seen.has(ref)) throw new Error(`Narration namespace ref ${ref} overlaps at ${namespace}.`);
      seen.add(ref);
    }
  }
}

export function assertPackageNamespaces(coaching: CoachingPackage, outcome: OutcomePackage): void {
  assertDisjointNamespaces(coaching.allowedRefs);
  assertDisjointNamespaces({ outcome: outcome.outcomeFacts.map((fact) => fact.id), measurement: outcome.measurementRefs });
  const decisionRefs = new Set(Object.values(coaching.allowedRefs).flat());
  if ([...outcome.outcomeFacts.map((fact) => fact.id), ...outcome.measurementRefs].some((ref) => decisionRefs.has(ref))) throw new Error("Outcome namespace overlaps decision-side refs.");
  if (coaching.cueId !== outcome.cueId || coaching.candidateId !== outcome.candidateId) throw new Error("CoachingPackage and OutcomePackage identity mismatch.");
}

function selectedSideAtTick(timeline: MatchTimeline, playerId: string, tick: number): "T" | "CT" {
  let side: "T" | "CT" | undefined;
  for (const sample of timeline.player_state_tracks ?? []) if (sample.player_id === playerId && sample.tick <= tick) side = sample.side;
  return side ?? timeline.players.find((player) => player.player_id === playerId)?.side ?? "T";
}

function selectedProbability(side: "T" | "CT", probability: number): number {
  return side === "T" ? 1 - probability : probability;
}

/** Final-plan outcome builder: candidate identity is the only binding key. */
export function buildOutcomeImpactForCue(cue: CoachCue, candidateSet: CandidateSet, timeline: WinProbabilityTimelineV1, matchTimeline: MatchTimeline, selectedPlayerId: string): OutcomeImpact | undefined {
  const candidate = candidateSet.candidates.find((item) => item.candidateId === cue.candidate_id);
  if (!candidate || timeline.status !== "AVAILABLE") return undefined;
  const side = selectedSideAtTick(matchTimeline, selectedPlayerId, cue.decision_tick);
  const round = timeline.rounds.find((item) => item.roundNumber === candidate.roundNumber);
  const swings = timeline.swings
    .filter((swing) => swing.tick >= cue.reveal_tick && swing.tick <= cue.outcome_end_tick + timeline.tickRate)
    .map((swing) => ({ swing, before: selectedProbability(side, swing.before), after: selectedProbability(side, swing.after) }))
    .sort((left, right) => Math.abs(right.after - right.before) - Math.abs(left.after - left.before) || left.swing.tick - right.swing.tick);
  const meaningful = swings.find((item) => item.swing.selectedPlayerDeath) ?? swings[0];
  const samples = [...(round?.samples ?? [])].filter((sample) => sample.tick <= cue.outcome_end_tick);
  const beforeSample = samples.filter((sample) => sample.tick <= cue.decision_tick).at(-1);
  const afterSample = samples.at(-1);
  const summary = candidate.resultSummary;
  const before = summary.winProbabilityBefore ?? meaningful?.before ?? (beforeSample ? selectedProbability(side, beforeSample.probability) : 0.5);
  const after = summary.winProbabilityAfter ?? meaningful?.after ?? (afterSample ? selectedProbability(side, afterSample.probability) : before);
  const events = (matchTimeline.match_events ?? []).filter((event) => event.tick >= cue.reveal_tick && event.tick <= cue.outcome_end_tick);
  const deaths = events.filter((event) => event.event_type === "PLAYER_DEATH");
  const bombs = events.filter((event) => ["BOMB_PLANT", "BOMB_DEFUSE"].includes(event.event_type));
  const concurrent = summary.concurrentEvents || deaths.length > 1 || deaths.some((death) => bombs.some((bomb) => Math.abs(death.tick - bomb.tick) <= timeline.tickRate));
  const selectedDeath = summary.selectedPlayerDeath || Boolean(meaningful?.swing.selectedPlayerDeath) || deaths.some((event) => event.target_player_id === selectedPlayerId);
  const attribution: OutcomeImpact["attribution"] = concurrent ? "CONCURRENT_EVENTS" : selectedDeath ? "SELECTED_PLAYER_DEATH" : meaningful ? "MODEL_SWING" : "ROUND_CONTEXT";
  const confidence: OutcomeImpact["confidence"] = concurrent ? "LOW" : selectedDeath ? "HIGH" : meaningful ? "MEDIUM" : "LOW";
  const delta = Math.round((after - before) * 1_000_000) / 1_000_000;
  const points = Math.round(Math.abs(delta) * 100);
  const text = selectedDeath && delta < 0
    ? `你这次处理后，我方胜率从 ${Math.round(before * 100)}% 掉到 ${Math.round(after * 100)}%，少了 ${points} 个百分点。`
    : delta < 0
      ? `这段结果窗口后，我方胜率从 ${Math.round(before * 100)}% 到 ${Math.round(after * 100)}%，下降 ${points} 个百分点。`
      : delta > 0
        ? `这段结果窗口后，我方胜率从 ${Math.round(before * 100)}% 到 ${Math.round(after * 100)}%，上升 ${points} 个百分点。`
        : `这段结果窗口前后，我方胜率都在 ${Math.round(before * 100)}% 左右。`;
  return {
    cueId: cue.id,
    beforeProbability: before,
    afterProbability: after,
    delta,
    percentagePoints: Math.round(delta * 100),
    relativeChange: Math.abs(before) > 1e-6 ? delta / before : null,
    attribution,
    confidence,
    text,
    limitations: [...summary.limitations, ...(concurrent ? ["多个结果事件同时发生，不能把变化归因给单一动作。"] : ["胜率曲线是结果窗口分析信号，不等同于玩家当时可见信息。"])]
  };
}
