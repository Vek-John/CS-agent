import type {
  CandidateGeneratorInput,
  CandidateMaterial,
  CandidateResultSummary,
  CandidateSet,
  CanonicalAnalysisFact,
  CanonicalPlayerContext,
  CanonicalSignal,
  Evidence,
  Fact,
  Inference,
  OutcomeFact,
  PlayerActionFact,
  TeachingCandidate,
  WinProbabilityEconomyClass,
  WinProbabilitySwing,
  WinProbabilityTimelineV1
} from "@cs-coach/contracts";
import { assembleCandidateSet } from "./teaching-pipeline";

export const CANDIDATE_GENERATOR_VERSION = "review-planner/candidate-generator/1.1.0";
const OUTCOME_WINDOW_SECONDS = 4;
const PRE_ROLL_SECONDS = 1;
const WIN_RATE_DROP_THRESHOLD = 0.12;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundedProbability(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sideAtTick(input: CandidateGeneratorInput, tick: number): "T" | "CT" {
  const samples = input.timeline.player_state_tracks ?? [];
  let side: "T" | "CT" | undefined;
  for (const sample of samples) {
    if (sample.player_id !== input.playerId || sample.tick > tick) continue;
    side = sample.side;
  }
  return side ?? input.timeline.players.find((player) => player.player_id === input.playerId)?.side ?? "T";
}

function selectedProbability(swing: WinProbabilitySwing, side: "T" | "CT"): { before: number; after: number; delta: number } {
  const before = side === "T" ? 1 - swing.before : swing.before;
  const after = side === "T" ? 1 - swing.after : swing.after;
  return { before, after, delta: after - before };
}

function economyForRound(timeline: WinProbabilityTimelineV1 | undefined, roundNumber: number, side: "T" | "CT"): WinProbabilityEconomyClass {
  const economy = timeline?.rounds.find((round) => round.roundNumber === roundNumber)?.economy;
  return economy ? side === "T" ? economy.t : economy.ct : "UNKNOWN";
}

function swingForSignal(input: CandidateGeneratorInput, signal: CanonicalSignal): { swing?: WinProbabilitySwing; probability?: { before: number; after: number; delta: number }; economy: WinProbabilityEconomyClass } {
  const timeline = input.winProbabilityTimeline;
  const timelineRound = timeline?.rounds.find((round) => round.roundNumber === signal.roundNumber);
  const economy = timelineRound ? economyForRound(timeline, signal.roundNumber, signal.playerSide) : signal.playerContext?.economyClass ?? "UNKNOWN";
  if (!timeline || timeline.status !== "AVAILABLE") return { economy };
  const candidates = timeline.swings
    .filter((swing) => Math.abs(swing.tick - signal.revealTick) <= Math.max(1, Math.round(input.timeline.tick_rate / 2)))
    .map((swing) => ({ swing, probability: selectedProbability(swing, signal.playerSide) }))
    .filter((item) => item.probability.delta < 0)
    .sort((left, right) => Math.abs(right.probability.delta) - Math.abs(left.probability.delta) || left.swing.tick - right.swing.tick);
  const exact = signal.sourceRefs.map((ref) => timeline.swings.find((swing) => ref.includes(swing.id))).find(Boolean);
  if (exact) {
    const exactProbability = selectedProbability(exact, signal.playerSide);
    if (exactProbability.delta < 0) return { swing: exact, probability: exactProbability, economy };
  }
  const nearest = candidates[0];
  return nearest ? { swing: nearest.swing, probability: nearest.probability, economy } : { economy };
}

function factsFor(signal: CanonicalSignal, facts: Map<string, CanonicalAnalysisFact>, kind: CanonicalAnalysisFact["kind"]): CanonicalAnalysisFact[] {
  return unique(signal.factRefs).map((id) => facts.get(id)).filter((fact): fact is CanonicalAnalysisFact => Boolean(fact && fact.kind === kind));
}

function actionFactsFor(signal: CanonicalSignal, facts: Map<string, CanonicalAnalysisFact>): CanonicalAnalysisFact[] {
  return unique(signal.actionRefs).map((id) => facts.get(id)).filter((fact): fact is CanonicalAnalysisFact => Boolean(fact && fact.kind === "PLAYER_ACTION"));
}

function outcomeFactsFor(signal: CanonicalSignal, facts: Map<string, CanonicalAnalysisFact>): CanonicalAnalysisFact[] {
  return unique(signal.outcomeRefs).map((id) => facts.get(id)).filter((fact): fact is CanonicalAnalysisFact => Boolean(fact && fact.kind === "OUTCOME"));
}

function contextCodeFor(signal: CanonicalSignal): string {
  if (signal.kind === "WIN_RATE_DROP") return "win-rate-review";
  const context = signal.playerContext;
  if (!context) return "contact-preparation";
  if (context.activeItemClass === "BOMB") return "bomb-carrier-safety";
  if (context.activeItemClass === "UTILITY") return "utility-readiness";
  if (context.health !== undefined && context.health <= 45) return "low-health-survival";
  if (context.activeItemClass === "KNIFE") return "rotation-safety";
  if (context.armor !== undefined && (context.armor <= 0 || context.helmet === false)) return "unarmored-contact";
  return "contact-preparation";
}

function resultSummary(input: CandidateGeneratorInput, signal: CanonicalSignal, economy: WinProbabilityEconomyClass, swing?: WinProbabilitySwing): CandidateResultSummary {
  const probability = swing ? selectedProbability(swing, signal.playerSide) : undefined;
  return {
    ...(probability ? { winProbabilityBefore: roundedProbability(probability.before), winProbabilityAfter: roundedProbability(probability.after), winProbabilityDelta: roundedProbability(probability.delta), winProbabilityPercentagePoints: Math.round(probability.delta * 100) } : {}),
    selectedPlayerDeath: signal.selectedPlayerDeath === true || signal.kind === "DEATH" || swing?.selectedPlayerDeath === true,
    economyClass: economy,
    concurrentEvents: signal.limitations.some((limitation) => /concurrent|并发|同时/.test(limitation)),
    missingFields: [...signal.missingFields],
    limitations: [...signal.limitations, ...(input.winProbabilityTimeline?.status === "AVAILABLE" ? [] : ["WinProbabilityTimeline unavailable."])]
  };
}

function candidateId(signal: CanonicalSignal): string {
  return `candidate-r${signal.roundNumber}-${signal.kind.toLowerCase()}-${signal.signalId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function createIndependentSwingSignals(input: CandidateGeneratorInput): CanonicalSignal[] {
  const timeline = input.winProbabilityTimeline;
  if (!timeline || timeline.status !== "AVAILABLE") return [];
  const existing = input.signals;
  const generated: CanonicalSignal[] = [];
  for (const swing of timeline.swings) {
    const side = sideAtTick(input, swing.tick);
    const probability = selectedProbability(swing, side);
    if (probability.delta > -WIN_RATE_DROP_THRESHOLD) continue;
    const round = input.timeline.rounds.find((item) => swing.tick >= item.start_tick && swing.tick <= item.end_tick);
    if (!round) continue;
    const closeExisting = existing.find((signal) => Math.abs(signal.revealTick - swing.tick) <= Math.max(1, Math.round(input.timeline.tick_rate / 2)) && signal.roundNumber === round.round_number);
    if (closeExisting) continue;
    const decisionFact = [...input.facts].filter((fact) => fact.kind === "DECISION_CONTEXT" && fact.roundNumber === round.round_number && fact.tick <= swing.tick).sort((left, right) => right.tick - left.tick)[0];
    const nearbyAction = [...input.facts].filter((fact) => fact.kind === "PLAYER_ACTION" && fact.roundNumber === round.round_number && Math.abs(fact.tick - swing.tick) <= Math.max(1, input.timeline.tick_rate)).sort((left, right) => Math.abs(left.tick - swing.tick) - Math.abs(right.tick - swing.tick))[0];
    generated.push({
      signalId: `winrate-swing-${swing.id}`,
      kind: "WIN_RATE_DROP",
      roundNumber: round.round_number,
      sourceTick: swing.tick,
      decisionTick: decisionFact?.tick ?? Math.max(round.freeze_end_tick, swing.tick - 1),
      revealTick: swing.tick,
      sourceRefs: [`winrate-swing-${swing.id}`],
      factRefs: decisionFact ? [decisionFact.id] : [],
      actionRefs: nearbyAction ? [nearbyAction.id] : [],
      outcomeRefs: [],
      observableClaimRefs: [],
      evidenceRefs: [swing.id],
      playerSide: side,
      playerContext: { playerSide: side, economyClass: economyForRound(timeline, round.round_number, side) },
      selectedPlayerDeath: false,
      missingFields: [],
      limitations: ["该候选来自胜率模型显著下滑，尚未证明单一玩家动作因果。"]
    });
  }
  return generated;
}

function mergeSignals(input: CandidateGeneratorInput): CanonicalSignal[] {
  const all = [...input.signals, ...createIndependentSwingSignals(input)];
  const merged: CanonicalSignal[] = [];
  const timeline = input.winProbabilityTimeline;
  for (const signal of all) {
    const existing = merged.find((candidate) => candidate.roundNumber === signal.roundNumber && Math.abs(candidate.revealTick - signal.revealTick) <= Math.max(1, Math.round(input.timeline.tick_rate / 2)) && ((candidate.kind === "DEATH" && signal.kind === "WIN_RATE_DROP") || (candidate.kind === "WIN_RATE_DROP" && signal.kind === "DEATH")));
    if (!existing) {
      merged.push({ ...signal });
      continue;
    }
    const winRef = signal.kind === "WIN_RATE_DROP" ? signal.sourceRefs : existing.sourceRefs;
    const signalData = timeline?.swings.find((swing) => winRef.some((ref) => ref.includes(swing.id)));
    const index = merged.indexOf(existing);
    merged[index] = {
      ...existing,
      sourceRefs: unique([...existing.sourceRefs, ...signal.sourceRefs]),
      evidenceRefs: unique([...existing.evidenceRefs, ...signal.evidenceRefs]),
      limitations: unique([...existing.limitations, ...signal.limitations, ...(signalData?.selectedPlayerDeath ? [] : [])]),
      selectedPlayerDeath: existing.selectedPlayerDeath === true || signal.selectedPlayerDeath === true || signal.kind === "DEATH"
    };
  }
  return merged;
}

function materializeSignal(input: CandidateGeneratorInput, signal: CanonicalSignal, facts: Map<string, CanonicalAnalysisFact>, economy: WinProbabilityEconomyClass, swing?: WinProbabilitySwing): { candidate: TeachingCandidate; material: CandidateMaterial } | undefined {
  const round = input.timeline.rounds.find((item) => item.round_number === signal.roundNumber);
  if (!round || signal.revealTick <= signal.decisionTick) return undefined;
  const preRollStart = Math.max(round.freeze_end_tick, signal.decisionTick - Math.max(1, Math.round(input.timeline.tick_rate * PRE_ROLL_SECONDS)));
  const outcomeEnd = Math.min(round.end_tick, Math.max(signal.revealTick + 1, signal.revealTick + Math.round(input.timeline.tick_rate * OUTCOME_WINDOW_SECONDS)));
  if (outcomeEnd <= signal.revealTick) return undefined;
  const id = candidateId(signal);
  const decisionSourceFacts = factsFor(signal, facts, "DECISION_CONTEXT").filter((fact) => fact.tick <= signal.decisionTick);
  const actionSourceFacts = actionFactsFor(signal, facts).filter((fact) => fact.tick <= signal.revealTick);
  const outcomeSourceFacts = outcomeFactsFor(signal, facts).filter((fact) => fact.tick >= signal.revealTick && fact.tick <= outcomeEnd);
  const decisionFacts: Fact[] = decisionSourceFacts.map((fact) => ({ id: fact.id, text: fact.text, availability: "DECISION", available_at_tick: fact.tick, source: "DEMO", observed_by_player: fact.observedByPlayer }));
  const actionFacts: PlayerActionFact[] = actionSourceFacts.map((fact) => ({ id: fact.id, text: fact.text, actorPlayerId: input.playerId, availableAtTick: fact.tick, source: "DEMO", evidenceRefs: [...fact.sourceRefs], limitations: [...fact.limitations, ...fact.missingFields] }));
  const outcomeFacts: OutcomeFact[] = outcomeSourceFacts.map((fact) => ({ id: fact.id, text: fact.text, availableAtTick: fact.tick, source: "DEMO", outcomeKind: fact.outcomeKind ?? "OTHER", evidenceRefs: [...fact.sourceRefs], limitations: [...fact.limitations, ...fact.missingFields] }));
  const evidence: Evidence[] = [{ id: `evidence-${id}`, source: "DEMO", label: `结构化 ${signal.kind} 信号`, fact_refs: decisionFacts.map((fact) => fact.id) }];
  const result = resultSummary(input, signal, economy, swing);
  const scoreBase: Record<CanonicalSignal["kind"], number> = { DEATH: 5, HP_CHANGE: 4, KILL: 3, BOMB: 2, UTILITY: 1, WIN_RATE_DROP: 4 };
  const dropBonus = result.winProbabilityDelta !== undefined ? Math.min(6, Math.round(Math.abs(result.winProbabilityDelta) * 10)) : 0;
  const candidate: TeachingCandidate = {
    candidateId: id,
    roundNumber: signal.roundNumber,
    source: { kind: signal.kind, refs: [...signal.sourceRefs] },
    preRollStart,
    decisionTick: signal.decisionTick,
    revealTick: signal.revealTick,
    outcomeEnd,
    factRefs: decisionFacts.map((fact) => fact.id),
    observableClaimRefs: [...signal.observableClaimRefs],
    actionRefs: actionFacts.map((fact) => fact.id),
    outcomeRefs: outcomeFacts.map((fact) => fact.id),
    evidenceRefs: evidence.map((item) => item.id),
    winRateSignalRefs: swing ? [`winrate-swing-${swing.id}`] : [],
    economySignalRefs: economy !== "UNKNOWN" ? [`economy-r${signal.roundNumber}-${economy}`] : [],
    missingFields: unique([...signal.missingFields, ...decisionSourceFacts.flatMap((fact) => fact.missingFields)]),
    limitations: unique([...signal.limitations, ...decisionSourceFacts.flatMap((fact) => fact.limitations)]),
    deterministicScore: scoreBase[signal.kind] + dropBonus,
    resultSummary: result
  };
  const material: CandidateMaterial = {
    candidateId: id,
    decisionFacts,
    playerActionFacts: actionFacts,
    outcomeFacts,
    inferences: [] as Inference[],
    advice: [],
    evidence,
    contextCode: contextCodeFor(signal),
    ...(signal.playerContext?.callout ? { callout: signal.playerContext.callout } : {}),
    ...(signal.playerContext?.economyClass ? { economy: signal.playerContext.economyClass } : {}),
    ...(signal.annotations ? { annotations: [...signal.annotations] } : {}),
    ...(signal.observableClaimRefs.length > 0 ? { observableStateId: input.observableStates?.find((state) => signal.observableClaimRefs.some((ref) => state.claims.some((claim) => claim.id === ref)))?.id } : {}),
    limitations: unique([...signal.limitations, ...result.limitations])
  };
  return { candidate, material };
}

/**
 * Parser-neutral CandidateGenerator. It nominates from canonical facts/signals,
 * derives legal windows, adds model-only drop candidates, and materializes
 * context/rule-evidence refs without creating Advice, CoachCue, or a teaching route.
 */
export function generateCandidateSet(input: CandidateGeneratorInput): CandidateSet {
  const facts = new Map(input.facts.map((fact) => [fact.id, fact]));
  const generatedSignals = mergeSignals(input);
  const generated = generatedSignals
    .map((signal) => {
      const win = swingForSignal(input, signal);
      return materializeSignal(input, signal, facts, win.economy, win.swing);
    })
    .filter((value): value is { candidate: TeachingCandidate; material: CandidateMaterial } => Boolean(value));
  return assembleCandidateSet({
    id: `candidate-set-${input.demoId}-${input.playerId}`,
    version: input.generationManifest.signalVersion,
    demoId: input.demoId,
    playerId: input.playerId,
    candidates: generated.map((item) => item.candidate),
    materials: generated.map((item) => item.material),
    generationManifest: input.generationManifest,
    limitations: input.limitations
  });
}
