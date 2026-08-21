import type {
  Advice,
  Annotation,
  CandidateMaterial,
  CandidateSet,
  CoachCue,
  CoachingRouteState,
  DirectorCandidateSummary,
  DirectorDecision,
  DirectorDecisionSet,
  DirectorManifest,
  DirectorRequest,
  Fact,
  GenerationManifest,
  HabitCluster,
  Inference,
  MatchTimeline,
  NarrationBundle,
  OutcomeFact,
  PlayerActionFact,
  ReviewPlan,
  ReviewSegment,
  TeachingCandidate
} from "@cs-coach/contracts";
import { DIRECTOR_FOCUS_CODES_BY_SIGNAL } from "@cs-coach/contracts";
import { assertValidReviewPlan } from "./index";
import { buildDeterministicAdvice } from "./coaching-package-builder";
import { playerFacingFocusProblem } from "./coaching-language";

const DEFAULT_MAX_CUES = 8;
const DEFAULT_COMPILER_VERSION = "review-planner/compiler/1.0.0";
const DEFAULT_PROMPT_VERSION = "deterministic-template/1.0.0";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(nonEmpty))];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** Stable non-cryptographic fingerprint for deterministic local artifacts. */
export function stableFingerprint(value: unknown): string {
  const input = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface CandidateSetAssemblyInput {
  id: string;
  version: string;
  demoId: string;
  playerId: string;
  candidates: readonly TeachingCandidate[];
  materials: readonly CandidateMaterial[];
  status?: "COMPLETE" | "FAILED";
  generationManifest: CandidateSet["generationManifest"];
  failureReason?: string;
  limitations?: readonly string[];
}

export function collectCandidateSetIssues(input: CandidateSetAssemblyInput): string[] {
  const issues: string[] = [];
  if (!nonEmpty(input.id) || !nonEmpty(input.version) || !nonEmpty(input.demoId) || !nonEmpty(input.playerId)) {
    issues.push("CandidateSet identifiers must be non-empty.");
  }
  const manifest = input.generationManifest;
  if (!manifest || Object.values(manifest).some((value) => typeof value !== "string" || !value.trim())) {
    issues.push("CandidateSet generationManifest must pin timeline, sceneIndex, observation, signal, and generator versions.");
  }
  if (input.status === "FAILED" && !input.failureReason?.trim()) issues.push("FAILED CandidateSet requires failureReason.");
  const candidateIds = new Set<string>();
  for (const candidate of input.candidates) {
    if (!nonEmpty(candidate.candidateId)) issues.push("Candidate has an empty candidateId.");
    if (candidateIds.has(candidate.candidateId)) issues.push(`Duplicate candidate ${candidate.candidateId}.`);
    candidateIds.add(candidate.candidateId);
    if (!Number.isInteger(candidate.roundNumber) || candidate.roundNumber <= 0) issues.push(`Candidate ${candidate.candidateId} has an invalid roundNumber.`);
    if (candidate.preRollStart > candidate.decisionTick || candidate.decisionTick >= candidate.revealTick || candidate.revealTick > candidate.outcomeEnd) {
      issues.push(`Candidate ${candidate.candidateId} has invalid canonical timing.`);
    }
    if (!Number.isFinite(candidate.deterministicScore)) issues.push(`Candidate ${candidate.candidateId} has an invalid deterministicScore.`);
    if (!nonEmpty(candidate.source.kind) || candidate.source.refs.length === 0) issues.push(`Candidate ${candidate.candidateId} has no source signal reference.`);
  }
  const materialIds = new Set<string>();
  for (const material of input.materials) {
    if (materialIds.has(material.candidateId)) issues.push(`Duplicate candidate material ${material.candidateId}.`);
    materialIds.add(material.candidateId);
    if (!candidateIds.has(material.candidateId)) issues.push(`Material ${material.candidateId} references an unknown candidate.`);
  }
  for (const candidateId of candidateIds) {
    if (!materialIds.has(candidateId)) issues.push(`Candidate ${candidateId} has no material.`);
  }
  return unique(issues);
}

/** CandidateGenerator: normalize, sort, and fingerprint nominations only. */
export function assembleCandidateSet(input: CandidateSetAssemblyInput): CandidateSet {
  const issues = collectCandidateSetIssues(input);
  if (issues.length > 0) throw new Error(`CandidateSet validation failed: ${issues.join(" ")}`);
  const status = input.status ?? "COMPLETE";
  if (status === "FAILED" && !input.failureReason?.trim()) throw new Error("FAILED CandidateSet requires failureReason.");
  const candidates = [...input.candidates].sort((left, right) =>
    left.decisionTick - right.decisionTick || left.candidateId.localeCompare(right.candidateId)
  );
  const materials = [...input.materials].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const storedCandidates = status === "FAILED" ? [] : candidates;
  const storedMaterials = status === "FAILED" ? [] : materials;
  const limitations = unique([
    ...(input.limitations ?? []),
    ...(input.failureReason ? [`Candidate index failed: ${input.failureReason}`] : [])
  ]);
  const hash = stableFingerprint({
    id: input.id,
    version: input.version,
    demoId: input.demoId,
    playerId: input.playerId,
    status: input.status ?? "COMPLETE",
    failureReason: input.failureReason,
    generationManifest: input.generationManifest,
    candidates: storedCandidates,
    materials: storedMaterials,
    limitations
  });
  return {
    id: input.id,
    version: input.version,
    hash,
    demoId: input.demoId,
    playerId: input.playerId,
    status,
    ...(status === "FAILED" && input.failureReason ? { failureReason: input.failureReason } : {}),
    generationManifest: input.generationManifest,
    candidates: storedCandidates,
    materials: storedMaterials,
    limitations
  };
}

function candidateById(set: CandidateSet): Map<string, TeachingCandidate> {
  return new Map(set.candidates.map((candidate) => [candidate.candidateId, candidate]));
}

function materialById(set: CandidateSet): Map<string, CandidateMaterial> {
  return new Map(set.materials.map((material) => [material.candidateId, material]));
}

function allCandidateRefs(candidate: TeachingCandidate): Set<string> {
  return new Set([
    ...candidate.source.refs,
    ...candidate.factRefs,
    ...candidate.observableClaimRefs,
    ...candidate.actionRefs,
    ...candidate.outcomeRefs,
    ...candidate.evidenceRefs,
    ...candidate.winRateSignalRefs,
    ...candidate.economySignalRefs
  ]);
}

export function buildDirectorRequest(set: CandidateSet, maxSelected = DEFAULT_MAX_CUES): DirectorRequest {
  const valueOf = (candidate: TeachingCandidate): number => candidate.deterministicScore + (candidate.resultSummary.selectedPlayerDeath ? 100 : candidate.source.kind === "KILL" ? 80 : 0) + (candidate.winRateSignalRefs.length > 0 ? 80 : 0) + (candidate.actionRefs.length > 0 && candidate.factRefs.length > 0 ? 10 : 0) + Math.min(6, candidate.evidenceRefs.length);
  const byRound = new Map<number, TeachingCandidate[]>();
  for (const candidate of set.candidates) byRound.set(candidate.roundNumber, [...(byRound.get(candidate.roundNumber) ?? []), candidate]);
  const representatives = [...byRound.values()].map((group) => [...group].sort((left, right) => valueOf(right) - valueOf(left) || left.decisionTick - right.decisionTick || left.candidateId.localeCompare(right.candidateId))[0]);
  const representativeIds = new Set(representatives.map((candidate) => candidate.candidateId));
  const ranked = [...representatives, ...set.candidates.filter((candidate) => !representativeIds.has(candidate.candidateId))].sort((left, right) => valueOf(right) - valueOf(left) || left.decisionTick - right.decisionTick || left.candidateId.localeCompare(right.candidateId));
  const compacted = ranked.slice(0, 32);
  const candidates: DirectorCandidateSummary[] = compacted.map((candidate) => ({
    candidateId: candidate.candidateId,
    sourceKind: candidate.source.kind,
    deterministicScore: candidate.deterministicScore,
    missingFields: [...candidate.missingFields].slice(0, 8),
    limitations: [...candidate.limitations].slice(0, 4).map((limitation) => limitation.slice(0, 160)),
    reasonRefs: [...candidate.factRefs, ...candidate.source.refs].slice(0, 3),
    evidenceRefs: [...candidate.evidenceRefs].slice(0, 3),
    resultSummary: {
      ...candidate.resultSummary,
      missingFields: [...candidate.resultSummary.missingFields].slice(0, 8),
      limitations: [...candidate.resultSummary.limitations].slice(0, 4).map((limitation) => limitation.slice(0, 160))
    },
    allowedFocusCodes: [...DIRECTOR_FOCUS_CODES_BY_SIGNAL[candidate.source.kind]]
  }));
  return {
    candidateSetId: set.id,
    candidateSetVersion: set.version,
    candidateSetHash: set.hash,
    candidates,
    maxSelected: Math.max(0, Math.min(DEFAULT_MAX_CUES, Math.trunc(maxSelected)))
  };
}

function focusFor(candidate: TeachingCandidate): string {
  switch (candidate.source.kind) {
    case "DEATH": return "SURVIVE_THE_NEXT_CONTACT";
    case "KILL": return "CONVERT_ADVANTAGE";
    case "BOMB": return "OBJECTIVE_TIMING";
    case "UTILITY": return "UTILITY_PURPOSE_AND_TEMPO";
    case "HP_CHANGE": return "SURVIVE_CONTACT";
    case "WIN_RATE_DROP": return "WIN_PROBABILITY_SWING_RESPONSE";
  }
}

function selectionReason(candidate: TeachingCandidate): string {
  return candidate.missingFields.length > 0
    ? "按确定性候选分数选入；缺失字段保留为限制。"
    : "按确定性候选分数与完整事实窗口选入。";
}

function makeDecision(candidate: TeachingCandidate, rank: number): DirectorDecision {
  const refs = [...candidate.factRefs, ...candidate.observableClaimRefs, ...candidate.source.refs];
  return {
    candidateId: candidate.candidateId,
    priority: rank,
    primaryFocusCode: focusFor(candidate),
    selectionReason: selectionReason(candidate),
    reasonRefs: refs.slice(0, 3),
    evidenceRefs: [...candidate.evidenceRefs].slice(0, 3),
    confidence: Math.max(0, Math.min(1, candidate.deterministicScore >= 8 ? 0.88 : candidate.deterministicScore >= 5 ? 0.72 : 0.55))
  };
}

function legalCandidates(set: CandidateSet): TeachingCandidate[] {
  const materials = materialById(set);
  const canCompile = (candidate: TeachingCandidate): boolean => {
    const material = materials.get(candidate.candidateId);
    const hasDecisionFact = Boolean(material?.decisionFacts.some((fact) => candidate.factRefs.includes(fact.id) && fact.availability === "DECISION" && fact.observed_by_player));
    const hasPlayerAction = Boolean(material?.playerActionFacts.some((fact) => candidate.actionRefs.includes(fact.id) && Boolean(fact.actorPlayerId)));
    const hasOutcomeFact = Boolean(material?.outcomeFacts.some((fact) => candidate.outcomeRefs.includes(fact.id)));
    return candidate.factRefs.length > 0 && candidate.actionRefs.length > 0 && (candidate.outcomeRefs.length > 0 || candidate.winRateSignalRefs.length > 0) && hasDecisionFact && hasPlayerAction && (hasOutcomeFact || candidate.winRateSignalRefs.length > 0);
  };
  const rank = (candidate: TeachingCandidate): number => candidate.deterministicScore + (candidate.resultSummary.selectedPlayerDeath ? 100 : candidate.source.kind === "KILL" ? 80 : 0) + (candidate.winRateSignalRefs.length > 0 ? 80 : 0) + (candidate.factRefs.length > 0 && candidate.actionRefs.length > 0 ? 10 : 0) + Math.min(6, candidate.evidenceRefs.length);
  const byRound = new Map<number, TeachingCandidate[]>();
  for (const candidate of set.candidates.filter(canCompile)) byRound.set(candidate.roundNumber, [...(byRound.get(candidate.roundNumber) ?? []), candidate]);
  const accepted: TeachingCandidate[] = [];
  for (const group of byRound.values()) {
    const sorted = [...group].sort((left, right) => left.preRollStart - right.preRollStart || left.candidateId.localeCompare(right.candidateId));
    const clusters: TeachingCandidate[][] = [];
    for (const candidate of sorted) {
      const current = clusters.at(-1);
      if (!current || current.every((item) => item.outcomeEnd <= candidate.preRollStart)) clusters.push([candidate]);
      else current.push(candidate);
    }
    for (const cluster of clusters) accepted.push([...cluster].sort((left, right) => rank(right) - rank(left) || left.decisionTick - right.decisionTick || left.candidateId.localeCompare(right.candidateId))[0]);
  }
  return accepted.sort((left, right) => left.decisionTick - right.decisionTick || left.candidateId.localeCompare(right.candidateId));
}

/** Provider-free Director used when a key, timeout, or schema is unavailable. */
export function deterministicDirectorFallback(
  set: CandidateSet,
  reason = "DETERMINISTIC_FALLBACK",
  maxSelected = DEFAULT_MAX_CUES
): DirectorDecisionSet {
  const limit = Math.max(0, Math.min(DEFAULT_MAX_CUES, Math.trunc(maxSelected)));
  const accepted = legalCandidates(set);
  if (accepted.length === 0) {
    return {
      candidateSetId: set.id,
      candidateSetVersion: set.version,
      candidateSetHash: set.hash,
      selected: [],
      manifest: {
        status: "DISABLED",
        provider: "DETERMINISTIC",
        reason: set.status === "FAILED" ? "INDEX_FAILED" : "NO_CANDIDATES",
        limitations: [...set.limitations]
      }
    };
  }

  const byRound = new Map<number, TeachingCandidate[]>();
  for (const candidate of accepted) byRound.set(candidate.roundNumber, [...(byRound.get(candidate.roundNumber) ?? []), candidate]);
  const score = (candidate: TeachingCandidate) => candidate.deterministicScore;
  const representatives = [...byRound.values()]
    .map((group) => [...group].sort((left, right) => score(right) - score(left) || left.decisionTick - right.decisionTick || left.candidateId.localeCompare(right.candidateId))[0])
    .sort((left, right) => left.decisionTick - right.decisionTick || left.candidateId.localeCompare(right.candidateId));

  let chosen: TeachingCandidate[];
  if (representatives.length > limit && limit > 0) {
    const indexes = new Set<number>();
    for (let index = 0; index < limit; index += 1) indexes.add(Math.round(index * (representatives.length - 1) / Math.max(1, limit - 1)));
    chosen = [...indexes].map((index) => representatives[index]).filter((candidate): candidate is TeachingCandidate => Boolean(candidate));
  } else {
    chosen = representatives.slice(0, limit);
    const chosenIds = new Set(chosen.map((candidate) => candidate.candidateId));
    chosen.push(...accepted.filter((candidate) => !chosenIds.has(candidate.candidateId)).sort((left, right) => score(right) - score(left) || left.decisionTick - right.decisionTick || left.candidateId.localeCompare(right.candidateId)).slice(0, Math.max(0, limit - chosen.length)));
  }
  chosen.sort((left, right) => left.decisionTick - right.decisionTick || left.candidateId.localeCompare(right.candidateId));
  const limitations = [...set.limitations];
  if (accepted.length > chosen.length) limitations.push(`Teaching cues were paced to ${chosen.length}/${accepted.length} candidates (maximum ${limit}); all timeline segments remain covered.`);
  return {
    candidateSetId: set.id,
    candidateSetVersion: set.version,
    candidateSetHash: set.hash,
    selected: chosen.map((candidate, index) => makeDecision(candidate, index + 1)),
    manifest: {
      status: "FALLBACK",
      provider: "DETERMINISTIC",
      reason,
      limitations: unique(limitations)
    }
  };
}

export function collectDirectorDecisionIssues(set: CandidateSet, decisions: DirectorDecisionSet): string[] {
  const issues: string[] = [];
  if (decisions.candidateSetId !== set.id) issues.push("Director candidateSetId is unknown.");
  if (decisions.candidateSetVersion !== set.version) issues.push("Director candidateSetVersion is unknown.");
  if (decisions.candidateSetHash !== set.hash) issues.push("Director candidateSetHash does not match.");
  const candidates = candidateById(set);
  const materials = materialById(set);
  const selected = new Set<string>();
  for (const decision of decisions.selected) {
    if (!nonEmpty(decision.candidateId) || !candidates.has(decision.candidateId)) issues.push(`Director selected unknown candidate ${decision.candidateId}.`);
    if (selected.has(decision.candidateId)) issues.push(`Director selected candidate ${decision.candidateId} more than once.`);
    selected.add(decision.candidateId);
    if (!nonEmpty(decision.primaryFocusCode)) issues.push(`Director candidate ${decision.candidateId} has no unique primaryFocusCode.`);
    if (!nonEmpty(decision.selectionReason)) issues.push(`Director candidate ${decision.candidateId} has no selectionReason.`);
    if (!Number.isFinite(decision.priority) || decision.priority < 0) issues.push(`Director candidate ${decision.candidateId} has an invalid priority.`);
    if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) issues.push(`Director candidate ${decision.candidateId} has invalid confidence.`);
    const candidate = candidates.get(decision.candidateId);
    if (!candidate) continue;
    const material = materials.get(candidate.candidateId);
    const hasDecisionFact = Boolean(material?.decisionFacts.some((fact) => candidate.factRefs.includes(fact.id) && fact.availability === "DECISION" && fact.observed_by_player));
    const hasPlayerAction = Boolean(material?.playerActionFacts.some((fact) => candidate.actionRefs.includes(fact.id) && Boolean(fact.actorPlayerId)));
    const hasOutcomeFact = Boolean(material?.outcomeFacts.some((fact) => candidate.outcomeRefs.includes(fact.id)));
    if (candidate.factRefs.length === 0 || !hasDecisionFact) issues.push(`Director candidate ${decision.candidateId} has no decision fact.`);
    if (candidate.actionRefs.length === 0 || !hasPlayerAction) issues.push(`Director candidate ${decision.candidateId} has no verified player action.`);
    if ((candidate.outcomeRefs.length === 0 && candidate.winRateSignalRefs.length === 0) || (candidate.outcomeRefs.length > 0 && !hasOutcomeFact && candidate.winRateSignalRefs.length === 0)) issues.push(`Director candidate ${decision.candidateId} has no outcome or measurement ref.`);
    if (!DIRECTOR_FOCUS_CODES_BY_SIGNAL[candidate.source.kind].includes(decision.primaryFocusCode)) issues.push(`Director candidate ${decision.candidateId} uses an unallowlisted primaryFocusCode.`);
    const refs = allCandidateRefs(candidate);
    for (const ref of [...decision.reasonRefs, ...decision.evidenceRefs]) {
      if (!refs.has(ref)) issues.push(`Director candidate ${decision.candidateId} references unknown ref ${ref}.`);
    }
    if (/\b(?:tick|frame|order|segment|route)\b/i.test(decision.selectionReason)) issues.push(`Director candidate ${decision.candidateId} leaks execution fields.`);
  }
  return unique(issues);
}

function collectSelectionWindowIssues(
  timeline: MatchTimeline,
  set: CandidateSet,
  decisions: DirectorDecisionSet
): string[] {
  const candidates = candidateById(set);
  const cursorByRound = new Map<number, number>();
  const issues: string[] = [];
  const ordered = [...decisions.selected].sort((left, right) => {
    const leftCandidate = candidates.get(left.candidateId);
    const rightCandidate = candidates.get(right.candidateId);
    return (leftCandidate?.decisionTick ?? Number.MAX_SAFE_INTEGER) - (rightCandidate?.decisionTick ?? Number.MAX_SAFE_INTEGER) || left.candidateId.localeCompare(right.candidateId);
  });
  for (const decision of ordered) {
    const candidate = candidates.get(decision.candidateId);
    if (!candidate) continue;
    const round = timeline.rounds.find((item) => item.round_number === candidate.roundNumber);
    if (!round) {
      issues.push(`Director candidate ${candidate.candidateId} references a missing round.`);
      continue;
    }
    if (candidate.preRollStart < round.freeze_end_tick || candidate.outcomeEnd > round.end_tick) issues.push(`Director candidate ${candidate.candidateId} falls outside its round window.`);
    const cursor = cursorByRound.get(candidate.roundNumber) ?? round.freeze_end_tick;
    if (candidate.preRollStart < cursor) issues.push(`Director candidate ${candidate.candidateId} overlaps another outcome window.`);
    cursorByRound.set(candidate.roundNumber, Math.max(cursor, candidate.outcomeEnd));
  }
  return unique(issues);
}

function outcomeAsFact(fact: OutcomeFact): Fact {
  return {
    id: fact.id,
    text: fact.text,
    availability: "OUTCOME",
    available_at_tick: fact.availableAtTick,
    source: "DEMO",
    observed_by_player: false
  };
}

function buildCue(
  candidate: TeachingCandidate,
  decision: DirectorDecision,
  material: CandidateMaterial,
  segmentId: string,
  cueNumber: number,
  repeated: boolean
): CoachCue {
  const decisionFacts = [...material.decisionFacts];
  const outcomeFacts = [...material.outcomeFacts];
  const observableFactRefs = decisionFacts.filter((fact) => fact.availability === "DECISION" && fact.available_at_tick <= candidate.decisionTick && fact.observed_by_player).map((fact) => fact.id);
  const actionFacts = [...material.playerActionFacts];
  const actionRefs = actionFacts.map((fact) => fact.id);
  const outcomeRefs = outcomeFacts.map((fact) => fact.id);
  const { copy, advice } = buildDeterministicAdvice(candidate, decision, material, decisionFacts, repeated);
  const inference: Inference = {
    id: `i${cueNumber}`,
    text: copy.explanation,
    confidence: observableFactRefs.length > 0 ? 0.72 : 0.45,
    fact_refs: [...observableFactRefs]
  };
  const evidence: import("@cs-coach/contracts").Evidence = {
    id: `e${cueNumber}`,
    source: "RULE",
    label: "选手决策时的可执行检查规则",
    sample_count: observableFactRefs.length > 0 ? 1 : undefined,
    fact_refs: [...observableFactRefs]
  };
  const cue: CoachCue = {
    id: `c${cueNumber}`,
    segment_id: segmentId,
    cue_type: repeated ? "HABIT_RECHECK" : "DECISION",
    candidate_id: candidate.candidateId,
    primary_focus_code: decision.primaryFocusCode,
    title: copy.title,
    question: `教练直接说：${copy.explanation}`,
    decision_tick: candidate.decisionTick,
    reveal_tick: candidate.revealTick,
    outcome_start_tick: candidate.decisionTick,
    outcome_end_tick: candidate.outcomeEnd,
    facts: [...decisionFacts, ...outcomeFacts.map(outcomeAsFact)],
    inferences: [inference],
    advice: [advice],
    evidence: [evidence, ...material.evidence],
    observable_fact_refs: [...observableFactRefs],
    ...(actionFacts.length > 0 ? { action_facts: actionFacts, action_fact_refs: actionRefs } : {}),
    ...(outcomeFacts.length > 0 ? { outcome_facts: outcomeFacts, outcome_fact_refs: outcomeRefs } : {}),
    ...(material.observableStateId ? { observable_state_id: material.observableStateId } : {}),
    annotations: [...(material.annotations ?? [])],
    confidence: observableFactRefs.length > 0 ? 0.72 : 0.45,
    limitations: unique([...candidate.limitations, ...material.limitations])
  };
  return cue;
}

function lowValueSegment(id: string, roundNumber: number, startTick: number, endTick: number, reasonCode: string, displayReason: string): ReviewSegment {
  return {
    id,
    round_number: roundNumber,
    start_tick: startTick,
    end_tick: endTick,
    mode: "SKIP",
    reason_code: reasonCode,
    display_reason: displayReason,
    playback_speed: 8,
    cue_ids: [],
    expandable: true
  };
}

function ordinaryBriefSegment(id: string, roundNumber: number, startTick: number, endTick: number, reasonCode: string, displayReason: string): ReviewSegment {
  return {
    id,
    round_number: roundNumber,
    start_tick: startTick,
    end_tick: endTick,
    mode: "BRIEF",
    reason_code: reasonCode,
    display_reason: displayReason,
    playback_speed: 4,
    cue_ids: [],
    expandable: true
  };
}

export interface PlanCompilerInput {
  timeline: MatchTimeline;
  candidateSet: CandidateSet;
  directorDecisionSet: DirectorDecisionSet;
  planId: string;
  observationVersion: string;
  signalVersion: string;
  plannerVersion?: string;
  parserVersion?: string;
  promptVersion?: string;
  maxCues?: number;
  limitations?: readonly string[];
}

export interface PlanCompilerResult {
  plan: ReviewPlan;
  directorDecisionSet: DirectorDecisionSet;
  issues: readonly string[];
}

function compileSegments(timeline: MatchTimeline, selected: readonly { candidate: TeachingCandidate; decision: DirectorDecision; material: CandidateMaterial }[]): { segments: ReviewSegment[]; cues: CoachCue[]; habits: HabitCluster[] } {
  const segments: ReviewSegment[] = [];
  const cues: CoachCue[] = [];
  const materialByCandidate = new Map(selected.map((item) => [item.candidate.candidateId, item]));
  const occurrenceByFocus = new Map<string, number>();
  const selectedByRound = new Map<number, typeof selected[number][]>();
  for (const item of selected) selectedByRound.set(item.candidate.roundNumber, [...(selectedByRound.get(item.candidate.roundNumber) ?? []), item]);

  for (const round of timeline.rounds) {
    let cursor = round.start_tick;
    if (round.freeze_end_tick > cursor) {
      segments.push(lowValueSegment(`seg-r${round.round_number}-freeze`, round.round_number, cursor, round.freeze_end_tick, "FREEZE_TIME", "冻结时间由 Session 自动消费；保留为完整比赛覆盖。"));
      cursor = round.freeze_end_tick;
    }
    const roundCandidates = (selectedByRound.get(round.round_number) ?? []).sort((left, right) => left.candidate.decisionTick - right.candidate.decisionTick || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
    for (const item of roundCandidates) {
      const candidate = item.candidate;
      if (candidate.preRollStart < cursor || candidate.outcomeEnd <= candidate.decisionTick || candidate.outcomeEnd > round.end_tick) continue;
      if (cursor < candidate.preRollStart) segments.push(ordinaryBriefSegment(`seg-r${round.round_number}-brief-${cursor}-${candidate.preRollStart}`, round.round_number, cursor, candidate.preRollStart, "CONTEXT_ONLY", "普通回合先用一句话带过；没有候选不等于没有事实。"));
      const occurrence = (occurrenceByFocus.get(item.decision.primaryFocusCode) ?? 0) + 1;
      occurrenceByFocus.set(item.decision.primaryFocusCode, occurrence);
      const segmentId = `seg-r${round.round_number}-cue-${candidate.candidateId}`;
      const cue = buildCue(candidate, item.decision, materialByCandidate.get(candidate.candidateId)!.material, segmentId, cues.length + 1, occurrence > 1);
      cues.push(cue);
      segments.push({
        id: segmentId,
        round_number: round.round_number,
        start_tick: candidate.preRollStart,
        end_tick: candidate.outcomeEnd,
        mode: occurrence > 1 ? "HABIT_CHECK" : "DEEP_DIVE",
        reason_code: occurrence > 1 ? "REPEATED_DECISION_PATTERN" : "COACH_DECISION_POINT",
        display_reason: occurrence > 1 ? "同样的处理又出现：先把完整过程看完，再回头说怎么改。" : "从拉出去前一秒看完整处理，结束后回头讲清怎么改。",
        playback_speed: 1,
        cue_ids: [cue.id],
        expandable: true
      });
      cursor = candidate.outcomeEnd;
    }
    const decidedTick = round.decided_tick ?? round.end_tick;
    if (cursor < decidedTick) segments.push(ordinaryBriefSegment(`seg-r${round.round_number}-brief-${cursor}-${decidedTick}`, round.round_number, cursor, decidedTick, "CONTEXT_ONLY", "普通回合用一句话带过；没有候选不等于没有事实。"));
    const postRoundStart = Math.max(cursor, decidedTick);
    if (postRoundStart < round.end_tick) segments.push(lowValueSegment(`seg-r${round.round_number}-post-${postRoundStart}-${round.end_tick}`, round.round_number, postRoundStart, round.end_tick, "POST_ROUND", "回合胜负判定后的反应与过渡时间显式跳过。"));
  }
  for (let index = 1; index < timeline.rounds.length; index += 1) {
    const previous = timeline.rounds[index - 1];
    const current = timeline.rounds[index];
    if (previous.end_tick < current.start_tick) segments.push(lowValueSegment(`seg-gap-${previous.round_number}-${current.round_number}`, 0, previous.end_tick, current.start_tick, "INTER_ROUND_GAP", "回合之间的非比赛区间显式跳过。"));
  }
  segments.sort((left, right) => left.start_tick - right.start_tick || left.end_tick - right.end_tick || left.id.localeCompare(right.id));
  const habits = [...occurrenceByFocus.entries()].map(([focus, occurrenceCount], index) => {
    const cueIds = cues.filter((cue) => cue.primary_focus_code === focus).map((cue) => cue.id);
    return {
      id: `habit-${index + 1}`,
      title: cues.find((cue) => cue.primary_focus_code === focus)?.title ?? focus,
      taxonomy_id: focus,
      cue_ids: cueIds,
      occurrence_count: occurrenceCount,
      opportunity_count: occurrenceCount
    } satisfies HabitCluster;
  });
  return { segments, cues, habits };
}

function routeFingerprint(planLike: Pick<ReviewPlan, "segments" | "cues">): string {
  return stableFingerprint({
    segments: planLike.segments.map((segment) => ({ id: segment.id, start_tick: segment.start_tick, end_tick: segment.end_tick, mode: segment.mode, cue_ids: segment.cue_ids })),
    cues: planLike.cues.map((cue) => ({ id: cue.id, candidate_id: cue.candidate_id, primary_focus_code: cue.primary_focus_code, decision_tick: cue.decision_tick, reveal_tick: cue.reveal_tick, outcome_end_tick: cue.outcome_end_tick }))
  });
}

export function compileReviewPlan(input: PlanCompilerInput): PlanCompilerResult {
  if (input.candidateSet.status === "FAILED") {
    throw new Error("PlanCompiler refuses to compile a failed CandidateSet.");
  }
  const issues = unique([
    ...collectDirectorDecisionIssues(input.candidateSet, input.directorDecisionSet),
    ...collectSelectionWindowIssues(input.timeline, input.candidateSet, input.directorDecisionSet)
  ]);
  const fallbackNeeded = issues.length > 0 || input.directorDecisionSet.selected.length > (input.maxCues ?? DEFAULT_MAX_CUES);
  const effectiveDirector = fallbackNeeded
    ? deterministicDirectorFallback(input.candidateSet, issues.length > 0 ? `INVALID_DIRECTOR_OUTPUT:${issues.join("|")}` : "DIRECTOR_BUDGET")
    : input.directorDecisionSet;
  const candidateMap = candidateById(input.candidateSet);
  const materials = materialById(input.candidateSet);
  const selected = effectiveDirector.selected
    .map((decision) => {
      const candidate = candidateMap.get(decision.candidateId);
      const material = materials.get(decision.candidateId);
      return candidate && material ? { candidate, decision, material } : undefined;
    })
    .filter((value): value is { candidate: TeachingCandidate; decision: DirectorDecision; material: CandidateMaterial } => Boolean(value));
  const compiled = compileSegments(input.timeline, selected);
  const baseManifest: GenerationManifest = {
    parser_version: input.parserVersion ?? "unknown-parser",
    observation_version: input.observationVersion,
    signal_version: input.signalVersion,
    planner_version: input.plannerVersion ?? DEFAULT_COMPILER_VERSION,
    provider: effectiveDirector.manifest.provider === "DEEPSEEK" ? "DEEPSEEK" : "DETERMINISTIC_TEMPLATE",
    prompt_version: input.promptVersion ?? DEFAULT_PROMPT_VERSION,
    status: effectiveDirector.manifest.status,
    narration_deterministic: true,
    analysis_subject_selection: "EXPLICIT_PLAYER",
    analysis_subject_player_id: input.timeline.selected_player_id,
    limitations: unique([
      ...(input.limitations ?? []),
      ...input.candidateSet.limitations,
      ...effectiveDirector.manifest.limitations,
      ...(fallbackNeeded ? [`Director output was rejected and deterministic fallback was compiled: ${effectiveDirector.manifest.reason ?? "invalid output"}.`] : [])
    ])
  };
  const provisional: ReviewPlan = {
    id: input.planId,
    demo_id: input.timeline.demo_id,
    player_id: input.timeline.selected_player_id,
    status: input.timeline.rounds.length > 0 ? "COMPLETE" : "FAILED",
    match_timeline_version: input.timeline.timeline_version,
    observation_version: input.observationVersion,
    signal_version: input.signalVersion,
    planner_version: input.plannerVersion ?? DEFAULT_COMPILER_VERSION,
    estimated_duration_seconds: input.timeline.tick_rate > 0 ? (input.timeline.end_tick - input.timeline.start_tick) / input.timeline.tick_rate : 0,
    available_until_round: input.timeline.rounds.at(-1)?.round_number ?? 0,
    full_match_index_ready: true,
    global_aggregation_ready: true,
    segments: compiled.segments,
    cues: compiled.cues,
    habit_clusters: compiled.habits,
    generation_manifest: baseManifest,
    candidate_set_id: input.candidateSet.id,
    candidate_set_version: input.candidateSet.version,
    candidate_set_hash: input.candidateSet.hash,
    candidate_set_generation_manifest: input.candidateSet.generationManifest,
    director_decision_set: effectiveDirector,
    compiler_provenance: {
      version: input.plannerVersion ?? DEFAULT_COMPILER_VERSION,
      route_fingerprint: "pending",
      status: fallbackNeeded || effectiveDirector.manifest.status !== "SUCCEEDED" ? "FALLBACK" : "SUCCEEDED",
      ...(fallbackNeeded ? { reason: effectiveDirector.manifest.reason ?? "DIRECTOR_FALLBACK" } : {})
    }
  };
  const finalPlan: ReviewPlan = {
    ...provisional,
    compiler_provenance: {
      ...provisional.compiler_provenance!,
      route_fingerprint: routeFingerprint(provisional)
    }
  };
  assertValidReviewPlan(input.timeline, finalPlan);
  return {
    plan: finalPlan,
    directorDecisionSet: effectiveDirector,
    issues
  };
}

export function buildCoachingRouteState(
  plan: ReviewPlan,
  candidateIndexStatus: "BUILDING" | "COMPLETE",
  readiness: Readonly<Record<string, "PENDING" | "READY" | "FALLBACK">> = {},
  consumedCueIds: readonly string[] = [],
  frozenCueIds: readonly string[] = []
): CoachingRouteState {
  const routeFrozen = candidateIndexStatus === "COMPLETE" && Boolean(plan.compiler_provenance?.route_fingerprint);
  const cueReadiness: Record<string, "PENDING" | "READY" | "FALLBACK"> = {};
  for (const cue of plan.cues) cueReadiness[cue.id] = readiness[cue.id] ?? "PENDING";
  const cueOrder = plan.cues.map((cue) => cue.id);
  const cueBindings: Record<string, { candidateId: string; primaryFocusCode: string }> = {};
  for (const cue of plan.cues) {
    if (cue.candidate_id && cue.primary_focus_code) cueBindings[cue.id] = { candidateId: cue.candidate_id, primaryFocusCode: cue.primary_focus_code };
  }
  const firstWindow = cueOrder.slice(0, Math.min(2, cueOrder.length));
  const startable = routeFrozen && (firstWindow.length === 0 || firstWindow.every((cueId) => cueReadiness[cueId] === "READY" || cueReadiness[cueId] === "FALLBACK"));
  return {
    routeFrozen,
    routeFingerprint: plan.compiler_provenance?.route_fingerprint ?? "",
    candidateSetId: plan.candidate_set_id ?? "",
    candidateSetHash: plan.candidate_set_hash ?? "",
    selectedCueCount: plan.cues.length,
    readiness: cueReadiness,
    cueOrder,
    cueBindings,
    startable,
    consumedCueIds: [...consumedCueIds],
    frozenCueIds: [...frozenCueIds]
  };
}

export interface NarrationMergeUpdate {
  cueId: string;
  candidateId: string;
  primaryFocusCode: string;
  routeFingerprint: string;
  readiness: "READY" | "FALLBACK";
  narration: NarrationBundle;
}

export function mergeNarration(
  state: CoachingRouteState,
  update: NarrationMergeUpdate
): { accepted: true; reason?: string; state: CoachingRouteState } | { accepted: false; reason: string; state: CoachingRouteState } {
  if (!state.routeFrozen) return { accepted: false, reason: "ROUTE_NOT_FROZEN", state };
  if (state.routeFingerprint !== update.routeFingerprint) return { accepted: false, reason: "ROUTE_FINGERPRINT_CHANGED", state };
  if (state.consumedCueIds.includes(update.cueId) || state.frozenCueIds.includes(update.cueId)) return { accepted: false, reason: "CUE_ALREADY_CONSUMED_OR_FROZEN", state };
  const binding = state.cueBindings[update.cueId];
  if (!binding) return { accepted: false, reason: "UNKNOWN_CUE", state };
  if (binding.candidateId !== update.candidateId || binding.primaryFocusCode !== update.primaryFocusCode) return { accepted: false, reason: "FROZEN_PLAN_BINDING_CHANGED", state };
  if (update.narration.cueId !== update.cueId || update.narration.candidateId !== binding.candidateId || update.narration.primaryFocusCode !== binding.primaryFocusCode) return { accepted: false, reason: "NARRATION_IDENTITY_CHANGED", state };
  const nextReadiness = { ...state.readiness, [update.cueId]: update.readiness };
  const firstCueIds = state.cueOrder.slice(0, Math.min(2, state.selectedCueCount));
  return {
    accepted: true,
    state: {
      ...state,
      readiness: nextReadiness,
      startable: firstCueIds.length === 0 || firstCueIds.every((cueId) => nextReadiness[cueId] === "READY" || nextReadiness[cueId] === "FALLBACK")
    }
  };
}

export function deterministicNarrationBundle(
  packageInput: import("@cs-coach/contracts").CoachingPackage,
  outcome: import("@cs-coach/contracts").OutcomePackage
): NarrationBundle {
  const decisionNamespace = new Set(packageInput.allowedRefs.decision);
  const actionNamespace = new Set(packageInput.allowedRefs.action);
  const adviceNamespace = new Set(packageInput.allowedRefs.advice);
  const evidenceNamespace = new Set(packageInput.allowedRefs.evidence);
  const decisionRefs = unique([
    ...packageInput.decisionContext.facts.map((fact) => fact.id),
    ...packageInput.decisionContext.claims.map((claim) => claim.id)
  ]).filter((ref) => decisionNamespace.has(ref));
  const actionRefs = packageInput.playerAction.map((fact) => fact.id).filter((ref) => actionNamespace.has(ref));
  const adviceRefs = packageInput.advice.map((advice) => advice.id).filter((ref) => adviceNamespace.has(ref));
  const evidenceRefs = packageInput.evidence.map((evidence) => evidence.id).filter((ref) => evidenceNamespace.has(ref));
  const outcomeRefs = unique([...outcome.outcomeFacts.map((fact) => fact.id), ...outcome.deathKillHpRefs, ...outcome.measurementRefs]);
  const first = packageInput.decisionContext.facts[0]?.text ?? "当前可用决策事实有限";
  const action = packageInput.playerAction[0]?.text ?? "记录到的玩家动作信息有限";
  const advice = packageInput.advice[0]?.text ?? "先保留可撤退路线，再根据新信息处理";
  const outcomeText = [outcome.outcomeFacts[0]?.text, outcome.winProbabilityImpact?.text].filter((text): text is string => Boolean(text)).join(" ") || "结果事实将在结果窗口完成后展示";
  return {
    cueId: packageInput.cueId,
    candidateId: packageInput.candidateId,
    primaryFocusCode: packageInput.primaryFocusCode,
    currentSituation: { text: first, refs: decisionRefs, limitations: [...packageInput.limitations] },
    playerAction: { text: action, refs: actionRefs, limitations: [...packageInput.limitations] },
    coreIssue: { text: playerFacingFocusProblem(packageInput.primaryFocusCode), refs: unique([...decisionRefs, ...actionRefs]), limitations: [...packageInput.limitations] },
    betterPlay: { text: advice, refs: unique([...adviceRefs, ...evidenceRefs, ...decisionRefs]), limitations: [...packageInput.limitations] },
    outcomeImpact: { text: outcomeText, refs: outcomeRefs, limitations: [...outcome.limitations] }
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function fieldRefs(value: unknown): value is { text: string; refs: readonly string[]; confidence?: number; limitations?: readonly string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["text", "refs", ...(record.confidence === undefined ? [] : ["confidence"]), ...(record.limitations === undefined ? [] : ["limitations"])])) return false;
  return typeof record.text === "string" && record.text.trim().length > 0 && Array.isArray(record.refs) && record.refs.every((ref) => typeof ref === "string" && ref.trim().length > 0) && (record.confidence === undefined || (typeof record.confidence === "number" && record.confidence >= 0 && record.confidence <= 1)) && (record.limitations === undefined || (Array.isArray(record.limitations) && record.limitations.every((item) => typeof item === "string")));
}

export function collectNarrationBundleIssues(
  bundle: unknown,
  coaching: import("@cs-coach/contracts").CoachingPackage,
  outcome: import("@cs-coach/contracts").OutcomePackage
): string[] {
  const issues: string[] = [];
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return ["NarrationBundle must be an object."];
  const value = bundle as Record<string, unknown>;
  if (!exactKeys(value, ["cueId", "candidateId", "primaryFocusCode", "currentSituation", "playerAction", "coreIssue", "betterPlay", "outcomeImpact"])) issues.push("NarrationBundle contains forbidden or missing route/timing fields.");
  if (value.cueId !== coaching.cueId || value.candidateId !== coaching.candidateId || value.primaryFocusCode !== coaching.primaryFocusCode) issues.push("NarrationBundle identity or primaryFocusCode changed.");
  const fields = ["currentSituation", "playerAction", "coreIssue", "betterPlay", "outcomeImpact"] as const;
  for (const field of fields) if (!fieldRefs(value[field])) issues.push(`Narration field ${field} has an invalid shape.`);
  if (issues.length > 0) return unique(issues);
  const currentRefs = new Set(coaching.allowedRefs.decision);
  const actionRefs = new Set(coaching.allowedRefs.action);
  const adviceRefs = new Set(coaching.allowedRefs.advice);
  const evidenceRefs = new Set(coaching.allowedRefs.evidence);
  const outcomeRefs = new Set([
    ...outcome.outcomeFacts.map((fact) => fact.id),
    ...outcome.deathKillHpRefs,
    ...outcome.measurementRefs
  ]);
  const refsOf = (field: keyof typeof value): string[] => [...((value[field] as { refs: readonly string[] }).refs)];
  if (refsOf("currentSituation").length === 0 || refsOf("currentSituation").some((ref) => !currentRefs.has(ref))) issues.push("currentSituation must cite at least one decision fact/claim only.");
  if (refsOf("playerAction").length === 0 || refsOf("playerAction").some((ref) => !actionRefs.has(ref))) issues.push("playerAction must cite at least one action ref only.");
  if (refsOf("coreIssue").length === 0 || refsOf("coreIssue").some((ref) => !currentRefs.has(ref) && !actionRefs.has(ref))) issues.push("coreIssue must cite at least one decision/action ref.");
  if (refsOf("betterPlay").some((ref) => !currentRefs.has(ref) && !actionRefs.has(ref) && !adviceRefs.has(ref) && !evidenceRefs.has(ref))) issues.push("betterPlay cites an unknown or forbidden ref.");
  if (!refsOf("betterPlay").some((ref) => adviceRefs.has(ref))) issues.push("betterPlay must cite at least one advice ref.");
  if (refsOf("outcomeImpact").length === 0 || refsOf("outcomeImpact").some((ref) => !outcomeRefs.has(ref))) issues.push("outcomeImpact must cite outcome/measurement refs only.");
  if (refsOf("currentSituation").some((ref) => outcomeRefs.has(ref)) || refsOf("playerAction").some((ref) => outcomeRefs.has(ref)) || refsOf("betterPlay").some((ref) => outcomeRefs.has(ref))) issues.push("Outcome refs crossed into decision-side narration fields.");
  return unique(issues);
}

export function assertValidNarrationBundle(
  bundle: unknown,
  coaching: import("@cs-coach/contracts").CoachingPackage,
  outcome: import("@cs-coach/contracts").OutcomePackage
): asserts bundle is NarrationBundle {
  const issues = collectNarrationBundleIssues(bundle, coaching, outcome);
  if (issues.length > 0) throw new Error(`NarrationBundle validation failed: ${issues.join(" ")}`);
}
