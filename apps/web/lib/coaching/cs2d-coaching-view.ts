import type {
  ActiveItem,
  CoachCue,
  Fact,
  NarrationBundle,
  OutcomeCompletionState,
  OutcomeImpact,
  PlayerStateSample
} from "@cs-coach/contracts";
import { playerFacingFocusProblem } from "@cs-coach/review-planner";
import { canPresentOutcome } from "@cs-coach/session";

export interface CoachingCueView {
  decisionFacts: Fact[];
  outcomeFacts: Fact[];
  question: string;
  advice?: CoachCue["advice"][number];
  /** Present only after the cue's one-way outcome gate is complete. */
  narration?: NarrationBundle;
}

export type CoachingStatusKind = "location" | "health" | "armor" | "weapon" | "utility" | "money" | "objective";

export interface CoachingStatusChip {
  kind: CoachingStatusKind;
  text: string;
  item?: ActiveItem;
}

export interface ThreeStageCoachingView {
  currentState: {
    chips: readonly CoachingStatusChip[];
    fallbackText?: string;
  };
  problem: {
    text: string;
    consequences: readonly string[];
  };
  improvement: {
    text: string;
  };
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isGenericAction(value: string): boolean {
  return /这段窗口内(?:继续处理当前接触|完成了一次主动接触|执行了目标点相关操作)/.test(value);
}

function containsInternalTaxonomy(value: string): boolean {
  return /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/.test(value) || /回到决策时的事实和动作/.test(value);
}

function utilityCount(state: PlayerStateSample): number | undefined {
  if (state.missing_fields.includes("inventory")) return undefined;
  return state.inventory.reduce((total, item) => total + Math.max(0, item.count), 0);
}

/** Finds the last real state at the decision boundary without interpolating facts. */
export function playerStateAtOrBefore(
  states: readonly PlayerStateSample[],
  playerId: string,
  tick: number
): PlayerStateSample | undefined {
  let selected: PlayerStateSample | undefined;
  for (const state of states) {
    if (state.player_id !== playerId || state.tick > tick) continue;
    if (!selected || state.tick >= selected.tick) selected = state;
  }
  return selected;
}

export function hasMeaningfulWinRateImpact(impact: OutcomeImpact | undefined): impact is OutcomeImpact {
  return Boolean(impact && Number.isFinite(impact.percentagePoints) && Math.abs(impact.percentagePoints) >= 1);
}

/** Five evidence fields stay intact; this is the only player-facing three-stage projection. */
export function buildThreeStageCoachingView(input: {
  narration: NarrationBundle;
  decisionState?: PlayerStateSample;
  callout?: string;
  outcomeFacts: readonly Fact[];
  outcomeImpact?: OutcomeImpact;
}): ThreeStageCoachingView {
  const chips: CoachingStatusChip[] = [];
  const state = input.decisionState;
  if (input.callout) chips.push({ kind: "location", text: input.callout });
  if (state) {
    chips.push({ kind: "health", text: `${Math.max(0, state.health)} HP` });
    chips.push({
      kind: "armor",
      text: state.armor <= 0 ? "没甲" : state.has_helmet ? `${state.armor} 头甲` : `${state.armor} 甲`
    });
    const activeIsC4 = Boolean(state.active_item && (state.active_item.item_class.toUpperCase() === "BOMB" || /(?:^|_)c4$/.test(state.active_item.item_id)));
    if (state.active_item) chips.push({ kind: activeIsC4 ? "objective" : "weapon", text: activeIsC4 ? "C4" : state.active_item.item_id, item: state.active_item });
    const grenades = utilityCount(state);
    if (grenades !== undefined) chips.push({ kind: "utility", text: grenades > 0 ? `${grenades} 颗道具` : "无道具" });
    if (state.carries_c4 && !activeIsC4) chips.push({ kind: "objective", text: "携带 C4", item: { item_id: "weapon_c4", item_class: "BOMB" } });
    if (state.money !== undefined) chips.push({ kind: "money", text: `$${Math.max(0, state.money).toLocaleString("en-US")}` });
  }

  const rawAction = compactText(input.narration.playerAction.text);
  const rawIssue = compactText(input.narration.coreIssue.text);
  const issue = containsInternalTaxonomy(rawIssue)
    ? playerFacingFocusProblem(input.narration.primaryFocusCode)
    : rawIssue;
  const problemText = [isGenericAction(rawAction) ? "" : rawAction, issue]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" ");

  const consequences = input.outcomeFacts.slice(0, 1).map((fact) => compactText(fact.text));
  if (hasMeaningfulWinRateImpact(input.outcomeImpact)) consequences.push(compactText(input.outcomeImpact.text));
  if (consequences.length === 0 && !/(?:上升|下降|少了)\s*0\s*个?百分点/.test(input.narration.outcomeImpact.text)) {
    consequences.push(compactText(input.narration.outcomeImpact.text));
  }

  return {
    currentState: {
      chips,
      ...(chips.length === 0 ? { fallbackText: compactText(input.narration.currentSituation.text) } : {})
    },
    problem: {
      text: problemText || playerFacingFocusProblem(input.narration.primaryFocusCode),
      consequences: [...new Set(consequences.filter(Boolean))]
    },
    improvement: { text: compactText(input.narration.betterPlay.text) }
  };
}

function gateIsComplete(cue: CoachCue, gate: OutcomeCompletionState | undefined): boolean {
  return Boolean(gate && gate.cueId === cue.id && canPresentOutcome(gate));
}

/** Pure selector: replay phase hides the body while preserving a completed gate. */
export function selectPresentableNarration(
  cue: CoachCue,
  phase: "PAUSED_FOR_COACHING" | "REPLAYING" | "REVEALING" | undefined,
  gate: OutcomeCompletionState | undefined,
  preparedNarration?: NarrationBundle
): NarrationBundle | undefined {
  if (phase !== "PAUSED_FOR_COACHING" || !gateIsComplete(cue, gate)) return undefined;
  return preparedNarration;
}

/** Builds the paused coaching surface without leaking outcome facts early. */
export function buildCoachingCueView(
  cue: CoachCue,
  outcomeVisible: boolean | OutcomeCompletionState,
  preparedNarration?: NarrationBundle
): CoachingCueView {
  const gate = typeof outcomeVisible === "boolean" ? undefined : outcomeVisible;
  const isOutcomeVisible = typeof outcomeVisible === "boolean" ? outcomeVisible : gateIsComplete(cue, gate);
  const observableIds = new Set(cue.observable_fact_refs);
  const decisionFacts = cue.facts.filter((fact) =>
    fact.availability === "DECISION" &&
    observableIds.has(fact.id) &&
    fact.available_at_tick <= cue.decision_tick
  );
  const outcomeFacts = isOutcomeVisible
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
    advice: cue.advice[0],
    ...(isOutcomeVisible && preparedNarration ? { narration: preparedNarration } : {})
  };
}
