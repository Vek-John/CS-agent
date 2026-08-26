import type {
  CoachCue,
  CoachingRouteState,
  CoachingSessionState,
  CueReadiness,
  DefaultRouteCursor,
  QuestionAnswer,
  ReviewPlan,
  ReviewSegment,
  SessionSummary,
  SessionUserEvent
} from "@cs-coach/contracts";

export type SessionAction =
  | { type: "START" }
  | { type: "TICK"; tick: number }
  | { type: "SEEK"; tick: number }
  | { type: "RETURN_TO_NEAREST_CUE"; tick: number }
  | { type: "BEGIN_MANUAL_CUE_VISIT"; visitId: string; cueId: string }
  | { type: "CANCEL_MANUAL_CUE_VISIT" }
  | { type: "RETURN_TO_DEFAULT_ROUTE" }
  | { type: "CUE_PRESENTED"; cueId: string; visitId?: string }
  | { type: "NARRATION_READY"; cueId: string; readiness: Exclude<CueReadiness, "PENDING"> }
  | { type: "SKIP_SEGMENT" }
  | { type: "EXPAND_SKIP" }
  | { type: "REVEAL_OUTCOME" }
  | { type: "REPLAY_OUTCOME" }
  | { type: "ADVANCE_SEGMENT" }
  | { type: "QUESTION_ASKED"; question: string }
  | {
      type: "RECORD_TEACHING_CASE";
      cueCase: import("@cs-coach/contracts").CueCase;
      /** Optional latest reflection for fallback cases whose case has no reflection yet. */
      reflection?: import("@cs-coach/contracts").UserReflection;
      learningThread?: import("@cs-coach/contracts").LearningThread;
    }
  | { type: "CONFIRM_TEACHING_CASE"; cueId: string }
  | { type: "COMPLETE_SESSION" };

/** Session owns this one-way authorization; PlanCompiler only owns route/tick shape. */
export function createOutcomeCompletionGate(
  cue: Pick<CoachCue, "id" | "outcome_end_tick">
): import("@cs-coach/contracts").OutcomeCompletionState {
  return { cueId: cue.id, outcomeEndTick: cue.outcome_end_tick, status: "LOCKED" };
}

export function completeOutcomeGate(
  gate: import("@cs-coach/contracts").OutcomeCompletionState,
  confirmedTick: number
): import("@cs-coach/contracts").OutcomeCompletionState {
  if (!Number.isFinite(confirmedTick) || confirmedTick < gate.outcomeEndTick) return gate;
  return { ...gate, status: "COMPLETE", completedAtTick: confirmedTick };
}

export function canPresentOutcome(
  gate: import("@cs-coach/contracts").OutcomeCompletionState | undefined
): boolean {
  return gate?.status === "COMPLETE";
}

export {
  captureSessionRecovery,
  rehydrateSessionRecovery,
  sessionRouteFingerprint,
  SESSION_RECOVERY_SNAPSHOT_VERSION,
  type SessionRecoveryBoundary,
  type SessionRecoveryBoundaryKind,
  type SessionRecoverySnapshot,
} from "./recovery";

function event(
  state: CoachingSessionState,
  type: SessionUserEvent["type"],
  details: Partial<SessionUserEvent> = {}
): SessionUserEvent {
  return {
    id: `event-${state.user_events.length + 1}`,
    type,
    at_tick: state.current_tick,
    ...details
  };
}

export function createCoachingSession(
  plan: ReviewPlan,
  sessionId = "session-local-fixture",
  routeState?: Pick<CoachingRouteState, "routeFingerprint" | "readiness">
): CoachingSessionState {
  const state: CoachingSessionState = {
    id: sessionId,
    review_plan_id: plan.id,
    phase: "INTRO",
    current_segment_index: 0,
    current_tick: plan.segments[0]?.start_tick ?? 0,
    consumed_cue_ids: [],
    revealed_cue_ids: [],
    presented_cue_ids: [],
    default_route_cursor: {
      segment_index: 0,
      phase: "INTRO",
      current_tick: plan.segments[0]?.start_tick ?? 0,
    },
    expanded_segment_ids: [],
    ...(routeState ? {
      narration_readiness: { ...routeState.readiness },
      route_fingerprint: routeState.routeFingerprint
    } : {}),
    user_events: []
  };
  return synchronizeDefaultRouteCursor(state);
}

function defaultCursorFor(state: CoachingSessionState): DefaultRouteCursor {
  return {
    segment_index: state.current_segment_index,
    ...(state.current_cue_id ? { cue_id: state.current_cue_id } : {}),
    phase: state.phase,
    current_tick: state.current_tick,
    ...(state.outcome_completion ? { outcome_completion: state.outcome_completion } : {}),
    ...(state.buffered_from_phase ? { buffered_from_phase: state.buffered_from_phase } : {}),
  };
}

function sameDefaultCursor(left: DefaultRouteCursor, right: DefaultRouteCursor): boolean {
  return left.segment_index === right.segment_index &&
    left.cue_id === right.cue_id &&
    left.phase === right.phase &&
    left.current_tick === right.current_tick &&
    left.buffered_from_phase === right.buffered_from_phase &&
    left.outcome_completion?.cueId === right.outcome_completion?.cueId &&
    left.outcome_completion?.status === right.outcome_completion?.status &&
    left.outcome_completion?.completedAtTick === right.outcome_completion?.completedAtTick;
}

/** Keeps the default cursor reducer-owned while preserving it during a manual visit. */
export function synchronizeDefaultRouteCursor(state: CoachingSessionState): CoachingSessionState {
  if (state.manual_cue_visit) return state;
  const cursor = defaultCursorFor(state);
  return state.default_route_cursor && sameDefaultCursor(state.default_route_cursor, cursor)
    ? state
    : { ...state, default_route_cursor: cursor };
}

function restoreDefaultRouteCursor(state: CoachingSessionState): CoachingSessionState {
  const cursor = state.default_route_cursor;
  return {
    ...state,
    phase: cursor.phase,
    current_segment_index: cursor.segment_index,
    ...(cursor.cue_id ? { current_cue_id: cursor.cue_id } : { current_cue_id: undefined }),
    current_tick: cursor.current_tick,
    ...(cursor.outcome_completion ? { outcome_completion: cursor.outcome_completion } : { outcome_completion: undefined }),
    ...(cursor.buffered_from_phase ? { buffered_from_phase: cursor.buffered_from_phase } : { buffered_from_phase: undefined }),
    manual_cue_visit: undefined,
  };
}

export function getCurrentSegment(
  plan: ReviewPlan,
  state: CoachingSessionState
): ReviewSegment | undefined {
  return plan.segments[state.current_segment_index];
}

export function getCurrentCue(
  plan: ReviewPlan,
  state: CoachingSessionState
): CoachCue | undefined {
  if (!state.current_cue_id) return undefined;
  return plan.cues.find((cue) => cue.id === state.current_cue_id);
}

function isAutomaticFreezeSkip(segment: ReviewSegment): boolean {
  return segment.mode === "SKIP" && segment.reason_code === "FREEZE_TIME";
}

function narrationReadiness(state: CoachingSessionState, cueId: string): CueReadiness {
  return state.narration_readiness?.[cueId] ?? "READY";
}

function isPendingNarration(state: CoachingSessionState, cueId: string | undefined): cueId is string {
  return Boolean(cueId && narrationReadiness(state, cueId) === "PENDING");
}

function bufferedSegmentState(
  state: CoachingSessionState,
  segment: ReviewSegment,
  cueId: string
): CoachingSessionState {
  const buffered = {
    ...state,
    phase: "BUFFERING" as const,
    current_cue_id: cueId,
    current_segment_index: state.current_segment_index,
    current_tick: segment.start_tick,
    buffered_from_phase: state.phase === "SKIPPING" ? "SKIPPING" as const : "PLAYING" as const
  };
  return {
    ...buffered,
    user_events: [
      ...state.user_events,
      event(buffered, "NARRATION_BUFFERED", {
        segment_id: segment.id,
        cue_id: cueId,
        detail: "NARRATION_PENDING"
      })
    ]
  };
}

function enterSegment(
  plan: ReviewPlan,
  state: CoachingSessionState,
  segmentIndex: number
): CoachingSessionState {
  let nextState = state;
  let nextIndex = segmentIndex;

  // Freeze time stays in ReviewPlan coverage and the session event log, but
  // it is not a user decision. Consume consecutive freeze segments in one
  // deterministic transition so the coach never asks the user to skip them.
  while (nextIndex < plan.segments.length) {
    const segment = plan.segments[nextIndex];
    if (isAutomaticFreezeSkip(segment)) {
      const completedFreeze = {
        ...nextState,
        current_segment_index: nextIndex,
        current_cue_id: undefined,
        current_tick: segment.end_tick
      };
      nextState = {
        ...completedFreeze,
        user_events: [
          ...completedFreeze.user_events,
          event(completedFreeze, "SEGMENT_SKIPPED", {
            segment_id: segment.id,
            at_tick: segment.end_tick,
            detail: "AUTO_FREEZE_TIME"
          })
        ]
      };
      nextIndex += 1;
      continue;
    }

    const wasExpanded = nextState.expanded_segment_ids.includes(segment.id);
    const cueId = segment.cue_ids[0];
    if (isPendingNarration(nextState, cueId)) {
      return bufferedSegmentState({
        ...nextState,
        current_segment_index: nextIndex
      }, segment, cueId);
    }
    return {
      ...nextState,
      phase: segment.mode === "SKIP" && !wasExpanded ? "SKIPPING" : "PLAYING",
      current_segment_index: nextIndex,
      current_cue_id: cueId,
      current_tick: segment.start_tick,
      buffered_from_phase: undefined,
      outcome_completion: undefined
    };
  }

  return {
    ...nextState,
    phase: "WRAP_UP",
    current_segment_index: plan.segments.length,
    current_cue_id: undefined,
    current_tick: plan.segments.at(-1)?.end_tick ?? nextState.current_tick,
    buffered_from_phase: undefined,
    outcome_completion: undefined
  };
}

function consumeCurrentCue(
  state: CoachingSessionState,
  cue: CoachCue | undefined
): CoachingSessionState {
  if (!cue || state.consumed_cue_ids.includes(cue.id)) return state;
  return { ...state, consumed_cue_ids: [...state.consumed_cue_ids, cue.id] };
}

function finishOutcome(
  state: CoachingSessionState,
  segment: ReviewSegment,
  cue: CoachCue
): CoachingSessionState {
  const isFirstReveal =
    state.phase !== "REPLAYING" && !state.revealed_cue_ids.includes(cue.id);
  return {
    ...state,
    phase: "PAUSED_FOR_COACHING",
    // Keep the map at the problem state while the coach explains the result.
    current_tick: cue.decision_tick,
    outcome_completion: completeOutcomeGate(createOutcomeCompletionGate(cue), cue.outcome_end_tick),
    revealed_cue_ids:
      !state.manual_cue_visit && isFirstReveal && !state.revealed_cue_ids.includes(cue.id)
        ? [...state.revealed_cue_ids, cue.id]
        : state.revealed_cue_ids,
    user_events: [
      ...state.user_events,
      event(state, !state.manual_cue_visit && isFirstReveal ? "OUTCOME_REVEALED" : "OUTCOME_REPLAYED", {
        segment_id: segment.id,
        cue_id: cue.id,
        at_tick: cue.outcome_end_tick
      })
    ]
  };
}

function nearestCueRoute(
  plan: ReviewPlan,
  tick: number
): { cue: CoachCue; segmentIndex: number } | undefined {
  const candidates = plan.cues.flatMap((cue, cueIndex) => {
    const segmentIndex = plan.segments.findIndex((segment) =>
      segment.id === cue.segment_id && segment.cue_ids.includes(cue.id)
    );
    return segmentIndex < 0 ? [] : [{ cue, cueIndex, segmentIndex }];
  });

  candidates.sort((left, right) => {
    const distance = Math.abs(left.cue.decision_tick - tick) - Math.abs(right.cue.decision_tick - tick);
    if (distance !== 0) return distance;
    const leftIsAhead = left.cue.decision_tick >= tick;
    const rightIsAhead = right.cue.decision_tick >= tick;
    if (leftIsAhead !== rightIsAhead) return leftIsAhead ? -1 : 1;
    return left.cue.decision_tick - right.cue.decision_tick || left.cueIndex - right.cueIndex;
  });

  const nearest = candidates[0];
  return nearest ? { cue: nearest.cue, segmentIndex: nearest.segmentIndex } : undefined;
}

export function reduceCoachingSession(
  plan: ReviewPlan,
  state: CoachingSessionState,
  action: SessionAction
): CoachingSessionState {
  const normalized = synchronizeDefaultRouteCursor(state);
  const reduced = reduceCoachingSessionInner(plan, normalized, action);
  return synchronizeDefaultRouteCursor(reduced);
}

function reduceCoachingSessionInner(
  plan: ReviewPlan,
  state: CoachingSessionState,
  action: SessionAction
): CoachingSessionState {
  if (state.review_plan_id !== plan.id) {
    throw new Error("Session and ReviewPlan do not match.");
  }

  const segment = getCurrentSegment(plan, state);
  const cue = getCurrentCue(plan, state);

  switch (action.type) {
    case "START": {
      if (state.phase !== "INTRO") return state;
      const started = {
        ...state,
        user_events: [...state.user_events, event(state, "STARTED")]
      };
      return enterSegment(plan, started, 0);
    }

    case "EXPAND_SKIP": {
      if (state.phase !== "SKIPPING" || !segment?.expandable) return state;
      return {
        ...state,
        phase: "PLAYING",
        expanded_segment_ids: [...state.expanded_segment_ids, segment.id],
        user_events: [
          ...state.user_events,
          event(state, "SKIP_EXPANDED", { segment_id: segment.id })
        ]
      };
    }

    case "NARRATION_READY": {
      const nextReadiness = {
        ...(state.narration_readiness ?? {}),
        [action.cueId]: action.readiness
      };
      if (state.phase !== "BUFFERING" || state.current_cue_id !== action.cueId) {
        return { ...state, narration_readiness: nextReadiness };
      }
      const resumed = {
        ...state,
        phase: "PLAYING" as const,
        narration_readiness: nextReadiness,
        buffered_from_phase: undefined
      };
      return {
        ...resumed,
        user_events: [
          ...state.user_events,
          event(resumed, "NARRATION_READY", {
            segment_id: segment?.id,
            cue_id: action.cueId,
            detail: action.readiness
          })
        ]
      };
    }

    case "BEGIN_MANUAL_CUE_VISIT": {
      if (!action.visitId.trim() || !action.cueId.trim() || ["INTRO", "WRAP_UP", "COMPLETED"].includes(state.phase)) return state;
      const targetCue = plan.cues.find((candidate) => candidate.id === action.cueId);
      const targetSegmentIndex = targetCue
        ? plan.segments.findIndex((candidate) => candidate.id === targetCue.segment_id && candidate.cue_ids.includes(targetCue.id))
        : -1;
      if (!targetCue || targetSegmentIndex < 0 || isPendingNarration(state, targetCue.id)) return state;
      const targetSegment = plan.segments[targetSegmentIndex];
      return {
        ...state,
        phase: "PLAYING",
        current_segment_index: targetSegmentIndex,
        current_cue_id: targetCue.id,
        current_tick: targetSegment.start_tick,
        outcome_completion: undefined,
        buffered_from_phase: undefined,
        manual_cue_visit: { visit_id: action.visitId, cue_id: targetCue.id },
      };
    }

    case "CANCEL_MANUAL_CUE_VISIT":
    case "RETURN_TO_DEFAULT_ROUTE": {
      return state.manual_cue_visit ? restoreDefaultRouteCursor(state) : state;
    }

    case "CUE_PRESENTED": {
      const visit = state.manual_cue_visit;
      const belongsToVisit = visit
        ? visit.cue_id === action.cueId && action.visitId === visit.visit_id
        : action.visitId === undefined;
      if (!belongsToVisit || !cue || cue.id !== action.cueId || state.phase !== "PAUSED_FOR_COACHING" ||
        !canPresentOutcome(state.outcome_completion) || narrationReadiness(state, cue.id) === "PENDING") return state;
      if (state.presented_cue_ids.includes(cue.id)) return state;
      const presented = { ...state, presented_cue_ids: [...state.presented_cue_ids, cue.id] };
      return {
        ...presented,
        user_events: [...state.user_events, event(presented, "CUE_PRESENTED", { segment_id: cue.segment_id, cue_id: cue.id })],
      };
    }

    case "SKIP_SEGMENT": {
      if (state.phase !== "SKIPPING" || !segment) return state;
      const skipped = {
        ...state,
        current_tick: segment.end_tick,
        user_events: [
          ...state.user_events,
          event(state, "SEGMENT_SKIPPED", { segment_id: segment.id, at_tick: segment.end_tick })
        ]
      };
      return enterSegment(plan, skipped, state.current_segment_index + 1);
    }

    case "TICK": {
      if (!segment || !["PLAYING", "REVEALING", "REPLAYING"].includes(state.phase)) {
        return state;
      }

      if ((state.phase === "REVEALING" || state.phase === "REPLAYING") && cue) {
        if (action.tick < cue.outcome_end_tick) {
          return {
            ...state,
            current_tick: Math.max(cue.outcome_start_tick, action.tick)
          };
        }
        return finishOutcome(state, segment, cue);
      }

      if (state.phase === "PLAYING") {
        const hasAlreadyBeenPresented = Boolean(!state.manual_cue_visit && cue && state.presented_cue_ids.includes(cue.id));
        if (hasAlreadyBeenPresented) {
          if (action.tick >= segment.end_tick) {
            return enterSegment(plan, consumeCurrentCue(state, cue), state.current_segment_index + 1);
          }
          return { ...state, current_tick: Math.max(segment.start_tick, action.tick) };
        }
        const cueNeedsReveal = cue && !state.revealed_cue_ids.includes(cue.id);
        if (cueNeedsReveal && action.tick >= cue.decision_tick) {
          if (action.tick >= cue.outcome_end_tick) {
            return finishOutcome(state, segment, cue);
          }
          return {
            ...state,
            // The decision boundary changes the playback treatment, not the
            // user's viewing position. Continue through the real outcome.
            phase: "REVEALING",
            current_tick: Math.max(cue.outcome_start_tick, action.tick),
            outcome_completion: createOutcomeCompletionGate(cue)
          };
        }
        if (action.tick >= segment.end_tick) {
          return enterSegment(plan, state, state.current_segment_index + 1);
        }
        return {
          ...state,
          current_tick: Math.max(segment.start_tick, action.tick)
        };
      }
      return state;
    }

    case "SEEK": {
      if (!segment || ["INTRO", "WRAP_UP", "COMPLETED"].includes(state.phase)) return state;
      const upperBound =
        cue && !state.revealed_cue_ids.includes(cue.id)
          ? Math.min(segment.end_tick - 1, cue.decision_tick)
          : segment.end_tick - 1;
      return {
        ...state,
        current_tick: Math.max(segment.start_tick, Math.min(action.tick, upperBound))
      };
    }

    case "RETURN_TO_NEAREST_CUE": {
      const route = nearestCueRoute(plan, action.tick);
      if (!route) return state;
      const targetSegment = plan.segments[route.segmentIndex];
      const pending = isPendingNarration(state, route.cue.id);
      const consumedCueIds = new Set(state.consumed_cue_ids);
      return {
        ...state,
        phase: pending ? "BUFFERING" : "PLAYING",
        current_segment_index: route.segmentIndex,
        current_cue_id: route.cue.id,
        current_tick: targetSegment.start_tick,
        consumed_cue_ids: state.consumed_cue_ids.filter((cueId) => cueId !== route.cue.id),
        // A revealed cue is only safe to keep revealed after its teaching
        // boundary was consumed.  Takeover can happen during a later cue's
        // outcome/replay, so leave no unreconciled reveal that TICK could
        // mistake for completed teaching on the next walk.
        revealed_cue_ids: state.revealed_cue_ids.filter(
          (cueId) => cueId !== route.cue.id && consumedCueIds.has(cueId)
        ),
        outcome_completion: undefined,
        ...(pending ? { buffered_from_phase: "PLAYING" as const } : { buffered_from_phase: undefined })
      };
    }

    case "REVEAL_OUTCOME": {
      if (
        state.phase !== "PAUSED_FOR_COACHING" ||
        !cue ||
        state.revealed_cue_ids.includes(cue.id)
      ) {
        return state;
      }
      return { ...state, phase: "REVEALING", current_tick: cue.outcome_start_tick, outcome_completion: createOutcomeCompletionGate(cue) };
    }

    case "REPLAY_OUTCOME": {
      if (
        state.phase !== "PAUSED_FOR_COACHING" ||
        !cue ||
        !state.revealed_cue_ids.includes(cue.id)
      ) {
        return state;
      }
      return {
        ...state,
        phase: "REPLAYING",
        current_tick: cue.outcome_start_tick,
        // OutcomeCompletionGate is one-way. Replay hides the presentable
        // surface through the phase selector, but never revokes completion.
        outcome_completion: state.outcome_completion ?? completeOutcomeGate(createOutcomeCompletionGate(cue), cue.outcome_end_tick)
      };
    }

    case "ADVANCE_SEGMENT": {
      if (!segment || !["PLAYING", "PAUSED_FOR_COACHING"].includes(state.phase)) return state;
      if (state.manual_cue_visit) return state;
      if (cue && !state.revealed_cue_ids.includes(cue.id)) return state;
      const consumed = consumeCurrentCue(state, cue);
      return enterSegment(plan, consumed, state.current_segment_index + 1);
    }

    case "QUESTION_ASKED": {
      if (state.phase !== "PAUSED_FOR_COACHING" || !cue || !action.question.trim()) return state;
      return {
        ...state,
        user_events: [
          ...state.user_events,
          event(state, "QUESTION_ASKED", {
            segment_id: segment?.id,
            cue_id: cue.id,
            detail: action.question.trim()
          })
        ]
      };
    }

    case "RECORD_TEACHING_CASE": {
      if (!action.cueCase.cueId) return state;
      const reflection = action.reflection ?? action.cueCase.reflection;
      const cueCase = reflection && !action.cueCase.reflection
        ? { ...action.cueCase, reflection }
        : action.cueCase;
      const cueCases = { ...(state.cue_cases ?? {}), [cueCase.cueId]: cueCase };
      const priorThreads = state.learning_threads ?? [];
      const learning_threads = action.learningThread
        ? [...priorThreads.filter((thread) => thread.threadId !== action.learningThread!.threadId), action.learningThread].slice(-16)
        : priorThreads;
      const reflectionEventType = reflection?.response === "SKIPPED"
        ? "REFLECTION_SKIPPED" as const
        : reflection
          ? "REFLECTION_SUBMITTED" as const
          : undefined;
      const priorEvents = state.user_events ?? [];
      const appendedEvents: SessionUserEvent[] = [];
      const appendEvent = (type: SessionUserEvent["type"], details: Partial<SessionUserEvent> = {}) => {
        appendedEvents.push(event({ ...state, user_events: [...priorEvents, ...appendedEvents] }, type, details));
      };
      if (reflectionEventType) {
        appendEvent(reflectionEventType, {
          cue_id: cueCase.cueId,
          detail: reflection?.rawText?.slice(0, 240),
        });
      }
      if (cueCase.status === "DISAGREED") {
        appendEvent("USER_DISAGREED", {
          cue_id: cueCase.cueId,
          detail: reflection?.rawText?.slice(0, 240),
        });
      }
      if (cueCase.diagnosticResult || cueCase.verdict) {
        appendEvent("DIAGNOSTIC_COMPLETED", {
          cue_id: cueCase.cueId,
          detail: cueCase.verdict?.type ?? cueCase.status,
        });
      }
      const recorded = {
        ...state,
        cue_cases: cueCases,
        ...(action.learningThread || state.learning_threads !== undefined ? { learning_threads } : {}),
        user_events: [
          ...priorEvents,
          ...appendedEvents,
        ],
      };
      return recorded;
    }

    case "CONFIRM_TEACHING_CASE": {
      const currentCase = state.cue_cases?.[action.cueId];
      if (!currentCase) return state;
      const cue_cases = {
        ...(state.cue_cases ?? {}),
        [action.cueId]: { ...currentCase, status: "COMPLETED" as const },
      };
      return {
        ...state,
        cue_cases,
        user_events: [...state.user_events, event(state, "VERDICT_CONFIRMED", { cue_id: action.cueId })],
      };
    }

    case "COMPLETE_SESSION": {
      if (state.phase !== "WRAP_UP" || plan.status !== "COMPLETE") return state;
      const completed = { ...state, phase: "COMPLETED" as const };
      return {
        ...completed,
        user_events: [
          ...state.user_events,
          event(completed, "SESSION_COMPLETED", { at_tick: completed.current_tick })
        ]
      };
    }
  }
}

export function answerCurrentCueQuestion(
  plan: ReviewPlan,
  state: CoachingSessionState,
  question: string
): QuestionAnswer {
  const cue = getCurrentCue(plan, state);
  if (!cue || state.phase !== "PAUSED_FOR_COACHING") {
    throw new Error("Questions are scoped to an active paused coaching cue.");
  }

  const normalized = question.trim().toLowerCase();
  const observableFacts = cue.facts.filter((fact) => cue.observable_fact_refs.includes(fact.id));
  const citations = observableFacts.map((fact) => fact.id);

  if (normalized.includes("职业") || normalized.includes("pro")) {
    const proEvidence = cue.evidence.find((item) => item.source === "PRO_SCENE");
    if (!proEvidence) {
      return {
        text: "当前讲解点没有达到可展示门槛的职业样本，所以我不会声称职业选手通常怎么做。这里先只使用可验证局面和教练规则。",
        citation_refs: citations,
        limitation: "无已验证职业样本"
      };
    }
  }

  if (normalized.includes("语音") || normalized.includes("队友报") || normalized.includes("叫我")) {
    return {
      text: `如果队友当时明确给了同步指令，选择可以条件化调整；但当前夹具只能确认：${observableFacts
        .map((fact) => fact.text)
        .join("；")}。`,
      citation_refs: citations,
      limitation: cue.limitations[0]
    };
  }

  const advice = cue.advice[0];
  return {
    text: `${observableFacts.map((fact) => fact.text).join("；")} 因此当前更稳妥的执行是：${advice.text}`,
    citation_refs: [...new Set([...citations, advice.id])],
    limitation: cue.limitations[0]
  };
}

export function buildSessionSummary(
  plan: ReviewPlan,
  state: CoachingSessionState
): SessionSummary {
  if (!["WRAP_UP", "COMPLETED"].includes(state.phase) || plan.status !== "COMPLETE") {
    throw new Error("Summary stays locked until the full review path is complete.");
  }

  const consumed = new Set(state.consumed_cue_ids);
  const rankedHabits = plan.habit_clusters
    .map((candidate) => ({
      habit: candidate,
      consumedCueIds: candidate.cue_ids.filter((cueId) => consumed.has(cueId))
    }))
    .filter((candidate) => candidate.consumedCueIds.length > 0)
    .sort((left, right) =>
      right.consumedCueIds.length - left.consumedCueIds.length ||
      left.habit.id.localeCompare(right.habit.id)
    );
  const selectedHabit = rankedHabits[0];
  const habit = selectedHabit?.habit;
  if (!habit) {
    throw new Error("No consumed coaching evidence is available for the summary.");
  }

  const habitCueIds = new Set(selectedHabit.consumedCueIds);
  const habitCues = plan.cues.filter((cue) => habitCueIds.has(cue.id));
  const representativeRounds = habitCues
    .map((cue) => plan.segments.find((segment) => segment.id === cue.segment_id)?.round_number)
    .filter((round): round is number => round !== undefined)
    .filter((round, index, rounds) => rounds.indexOf(round) === index);

  const advice = habitCues
    .flatMap((cue) => cue.advice)
    .at(-1);
  if (!advice) {
    throw new Error("No consumed coaching advice is available for the summary.");
  }

  const checkpoints = habitCues
    .flatMap((cue) => cue.advice.map((item) => item.trigger.trim()))
    .filter(Boolean)
    .filter((trigger, index, triggers) => triggers.indexOf(trigger) === index)
    .slice(0, 2);

  return {
    positive: `你完成了整场复盘，并逐一看完了 ${state.consumed_cue_ids.length} 个关键讲解点的真实结果。`,
    habit_title: habit.title,
    habit_occurrences: selectedHabit.consumedCueIds.length,
    representative_rounds: representativeRounds,
    next_match_goal: advice.text,
    checkpoints: checkpoints.length > 0 ? checkpoints : [habitCues.at(-1)?.question ?? habit.title]
  };
}
