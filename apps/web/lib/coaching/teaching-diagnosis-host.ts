import type {
  CandidateMaterial,
  CoachCue,
  CoachingSessionState,
  Fact,
  LearningThread,
  MatchTimeline,
  OutcomeFact,
  PlayerActionFact,
  PlayerStateSample,
  ReviewPlan,
  UserReflection,
  CueCase,
  TeachingDiagnosisInput,
  TeachingDiagnosisOutput,
} from "@cs-coach/contracts";
import {
  CoachAgentEventSchema,
  CueCaseSchema,
  diagnoseTeachingCue,
  parseUserReflection,
  reviseTeachingDiagnosis,
} from "@cs-coach/coach-agent/client";
import type { CoachAgentIdentity, CoachAgentEvent } from "@cs-coach/coach-agent/client";

export interface TeachingDiagnosisHostContext {
  readonly plan: ReviewPlan;
  readonly cue: CoachCue;
  readonly material?: CandidateMaterial;
  readonly timeline?: MatchTimeline;
  readonly selectedPlayerId: string;
  readonly learningThreads?: readonly LearningThread[];
}

export interface TeachingDiagnosisSubmissionOptions {
  readonly eventType: "SUBMIT_REFLECTION" | "SUBMIT_DISAGREEMENT";
  readonly eventId: string;
  readonly identity: CoachAgentIdentity;
  readonly outcomeGateStatus?: "COMPLETE";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function stateAtOrBefore(states: readonly PlayerStateSample[] | undefined, playerId: string, tick: number): PlayerStateSample | undefined {
  if (!states) return undefined;
  let selected: PlayerStateSample | undefined;
  for (const state of states) {
    if (state.player_id !== playerId || state.tick > tick) continue;
    if (!selected || state.tick >= selected.tick) selected = state;
  }
  return selected;
}

function outcomeFactsForCue(cue: CoachCue): OutcomeFact[] {
  if (cue.outcome_facts?.length) return [...cue.outcome_facts];
  return cue.facts
    .filter((fact) => fact.availability === "OUTCOME")
    .map((fact) => ({
      id: fact.id,
      text: fact.text,
      availableAtTick: fact.available_at_tick,
      source: "DEMO" as const,
      outcomeKind: /死亡|阵亡|击杀/.test(fact.text) ? (/击杀/.test(fact.text) ? "KILL" as const : "DEATH" as const) : "OTHER" as const,
      evidenceRefs: [fact.id],
      limitations: [],
    }));
}

function actionFactsForCue(cue: CoachCue, material?: CandidateMaterial): PlayerActionFact[] {
  if (cue.action_facts?.length) return [...cue.action_facts];
  if (material?.playerActionFacts?.length) return [...material.playerActionFacts];
  return [];
}

/**
 * Keep the decision packet inside the observable-state boundary.  An empty
 * cue allowlist means that this cue did not identify any player-observable
 * facts; it must not silently widen to every DECISION fact in the material.
 * The observed flag is the remaining parser-owned guard for this legacy
 * adapter.  Ticks are retained here because this function runs in the local
 * Host/deterministic executor; the submission builder below still strips the
 * rich decisionState before a remote dispatch.
 */
export function decisionFactsForCue(cue: CoachCue, material?: CandidateMaterial): Fact[] {
  const facts = material?.decisionFacts?.length ? material.decisionFacts : cue.facts;
  const observable = new Set(cue.observable_fact_refs);
  return facts.filter((fact) =>
    fact.availability === "DECISION" &&
    fact.available_at_tick <= cue.decision_tick &&
    (observable.size > 0 ? observable.has(fact.id) : fact.observed_by_player),
  );
}

export function buildTeachingDiagnosisInput(
  context: TeachingDiagnosisHostContext,
  reflection: UserReflection,
): TeachingDiagnosisInput {
  const normalized = parseUserReflection(reflection, context.cue.id);
  const decisionFacts = decisionFactsForCue(context.cue, context.material);
  const playerActionFacts = actionFactsForCue(context.cue, context.material);
  const outcomeFacts = outcomeFactsForCue(context.cue);
  const state = stateAtOrBefore(context.timeline?.player_state_tracks, context.selectedPlayerId, context.cue.decision_tick);
  const economyClass = context.material?.economy;
  const decisionResources = state ? {
    health: state.health,
    armor: state.armor,
    hasHelmet: state.has_helmet,
    ...(state.money !== undefined ? { money: state.money } : {}),
    ...(state.equipment_value !== undefined ? { equipmentValue: state.equipment_value } : {}),
    inventoryCount: state.inventory.reduce((sum, item) => sum + Math.max(0, item.count), 0),
    evidenceRefs: unique([
      ...(state.fact_refs ?? []),
      ...decisionFacts.map((fact) => fact.id),
      ...playerActionFacts.flatMap((fact) => fact.evidenceRefs),
    ]).slice(0, 32),
  } : undefined;
  // The Graph receives a compact, strict material projection.  Inferences,
  // annotations and callouts remain Host/rendering concerns and must not
  // cross the diagnosis event boundary.
  const material = context.material ? {
    candidateId: context.material.candidateId,
    decisionFacts: context.material.decisionFacts,
    playerActionFacts: context.material.playerActionFacts,
    outcomeFacts: context.material.outcomeFacts,
    advice: context.material.advice.map((advice) => ({
      id: advice.id,
      text: advice.text,
      trigger: advice.trigger,
      fact_refs: [...advice.fact_refs],
    })),
    limitations: [...context.material.limitations],
    ...(context.material.economy ? { economy: context.material.economy } : {}),
    ...(context.material.contextCode ? { contextCode: context.material.contextCode } : {}),
  } : undefined;
  return {
    cueId: context.cue.id,
    ...(context.cue.candidate_id ? { candidateId: context.cue.candidate_id } : {}),
    cue: { id: context.cue.id, primary_focus_code: context.cue.primary_focus_code, limitations: context.cue.limitations },
    ...(material ? { material } : {}),
    reflection: normalized,
    decisionFacts,
    playerActionFacts,
    outcomeFacts,
    ...(state ? { decisionState: state } : {}),
    ...(decisionResources ? { decisionResources } : {}),
    ...(context.cue.primary_focus_code ? { focusCode: context.cue.primary_focus_code } : {}),
    ...(economyClass ? { economyClass } : {}),
    ...(context.learningThreads ? { existingThreads: context.learningThreads } : {}),
    limitations: unique(context.cue.limitations),
  };
}

/**
 * Build the only event shape used by the Host for adaptive diagnosis.  The
 * reflection is a separate USER claim; the input is a bounded evidence
 * packet and intentionally drops the rich PlayerState (ticks/coordinates),
 * retaining only the identity-free DecisionResources projection before
 * crossing into the CoachAgent Graph.
 */
export function buildTeachingDiagnosisSubmissionEvent(
  context: TeachingDiagnosisHostContext,
  reflection: UserReflection,
  options: TeachingDiagnosisSubmissionOptions,
): Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" | "SUBMIT_DISAGREEMENT" }> {
  const normalized = parseUserReflection(reflection, context.cue.id);
  const fullInput = buildTeachingDiagnosisInput(context, normalized);
  // `decisionState` contains the selected player's identity, canonical tick
  // and coordinates, so it stays Host-owned.  The fact arrays below are
  // parser-owned, allowlisted evidence consumed by the deterministic
  // executor; they are not an LLM query surface or generated playback input.
  const { decisionState: _decisionState, existingThreads: _existingThreads, reflection: _reflection, ...boundedInput } = fullInput;
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: options.eventType,
    eventId: options.eventId.slice(0, 160),
    identity: options.identity,
    cueId: context.cue.id,
    outcomeGateStatus: options.outcomeGateStatus ?? "COMPLETE",
    input: boundedInput,
    reflection: normalized,
  }) as Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" | "SUBMIT_DISAGREEMENT" }>;
}

export function runTeachingDiagnosis(
  context: TeachingDiagnosisHostContext,
  reflection: UserReflection,
): TeachingDiagnosisOutput {
  return diagnoseTeachingCue(buildTeachingDiagnosisInput(context, reflection));
}

export function runTeachingDiagnosisDisagreement(
  context: TeachingDiagnosisHostContext,
  previous: { cueCase: CueCase; learningThread: LearningThread },
  disagreement: UserReflection,
): TeachingDiagnosisOutput {
  const normalized = parseUserReflection(disagreement, context.cue.id);
  return reviseTeachingDiagnosis({
    previous,
    input: buildTeachingDiagnosisInput(context, previous.cueCase.reflection ?? reflectionForSkip(context.cue.id)),
    disagreement: normalized,
  });
}

export function baselineCueCase(cue: CoachCue, reason: string): CueCase {
  return CueCaseSchema.parse({
    schemaVersion: "cue-case.v1",
    caseId: `case-${cue.id}-baseline`.slice(0, 160),
    cueId: cue.id,
    ...(cue.candidate_id ? { candidateId: cue.candidate_id } : {}),
    pedagogyMode: "DEFER",
    status: "FALLBACK",
    claims: [],
    capabilities: [],
    baselineNarrationAvailable: true,
    attemptBudget: { reflection: 0, diagnostic: 0, disagreement: 0, alternateDiagnostic: 0 },
    limitations: [reason.slice(0, 200)],
  });
}

export function reflectionForGoal(cueId: string, selectedGoal: UserReflection["selectedGoal"]): UserReflection {
  return parseUserReflection({ cueId, selectedGoal, response: "ANSWERED", source: "USER", limitations: [] });
}

export function reflectionForSkip(cueId: string): UserReflection {
  return parseUserReflection({ cueId, selectedGoal: "UNKNOWN", response: "SKIPPED", source: "USER", limitations: ["用户选择跳过 Reflection Gate。"] });
}

export function reflectionForDisagreement(cueId: string, rawText: string, selectedGoal?: UserReflection["selectedGoal"]): UserReflection {
  return parseUserReflection({ cueId, rawText: rawText.trim() || undefined, selectedGoal, response: "ANSWERED", source: "USER", limitations: ["用户补充内容属于 USER claim，不能直接升级为 Demo 事实。"] });
}

export function sessionThreads(state: CoachingSessionState | undefined): readonly LearningThread[] {
  return state?.learning_threads ?? [];
}
