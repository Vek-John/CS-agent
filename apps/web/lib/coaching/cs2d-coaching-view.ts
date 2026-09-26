import { matchesDecisionState, verifiedUtilityKindText } from "./utility-kind-evidence";
import { projectDecisionUtilityCount } from "@cs-coach/coach-agent/decision-utilities";
import type {
  ActiveItem,
  CoachCue,
  Fact,
  NarrationBundle,
  OutcomeCompletionState,
  OutcomeImpact,
  TrustedDecisionSemantics,
  PlayerStateSample
} from "@cs-coach/contracts";
import { observableSituation, playerFacingLimitation, uncertaintyReviewQuestions } from "./decision-presentation";
import { canPresentOutcome } from "@cs-coach/session";

export interface CoachingCueView {
  decisionFacts: Fact[];
  outcomeFacts: Fact[];
  question: string;
  advice?: CoachCue["advice"][number];
  /** Present only after the cue's one-way outcome gate is complete. */
  narration?: NarrationBundle;
}

export type CoachingStatusKind = "location" | "health" | "armor" | "weapon" | "utility" | "money" | "objective" | "situation" | "clock";

export interface CoachingStatusChip {
  kind: CoachingStatusKind;
  text: string;
  item?: ActiveItem;
}

export interface ThreeStageCoachingView {
  currentState: {
    chips: readonly CoachingStatusChip[];
    fallbackText?: string;
    limitations: readonly string[];
  };
  problem: {
    title: string;
    confidence?: number;
    text: string;
    consequences: readonly string[];
  };
  improvement: {
    text: string;
    reviewQuestions: readonly string[];
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
  decisionTick?: number;
  decisionFacts?: readonly Fact[];
  callout?: string;
  outcomeFacts: readonly Fact[];
  outcomeImpact?: OutcomeImpact;
  semantics?: TrustedDecisionSemantics;
}): ThreeStageCoachingView {
  const chips: CoachingStatusChip[] = [];
  const rawState = input.decisionState;
  const state = rawState && matchesDecisionState(rawState, input.semantics, input.decisionTick, input.decisionFacts) ? rawState : undefined;
  const playerStateUnknown = Boolean(input.semantics?.decisionSnapshot && !state);
  if (input.callout && !playerStateUnknown) chips.push({ kind: "location", text: input.callout });
  if (state) {
    chips.push({ kind: "health", text: `${Math.max(0, state.health)} HP` });
    chips.push({
      kind: "armor",
      text: state.armor <= 0 ? "没甲" : state.has_helmet ? `${state.armor} 头甲` : `${state.armor} 甲`
    });
    const activeIsC4 = Boolean(state.active_item && (state.active_item.item_class.toUpperCase() === "BOMB" || /(?:^|_)c4$/.test(state.active_item.item_id)));
    if (state.active_item) chips.push({ kind: activeIsC4 ? "objective" : "weapon", text: activeIsC4 ? "C4" : state.active_item.item_id, item: state.active_item });
    const { utilityCount: grenades } = projectDecisionUtilityCount(state);
    const utilityText = grenades !== undefined
      ? grenades > 0 ? `${grenades} 颗道具` : "无道具"
      : verifiedUtilityKindText(state, input.semantics, input.decisionTick, input.decisionFacts);
    if (utilityText) chips.push({ kind: "utility", text: utilityText });
    if (state.carries_c4 && !activeIsC4) chips.push({ kind: "objective", text: "携带 C4", item: { item_id: "weapon_c4", item_class: "BOMB" } });
    if (state.money !== undefined) chips.push({ kind: "money", text: `$${Math.max(0, state.money).toLocaleString("en-US")}` });
  }

  const situation = observableSituation(input.semantics ?? {});
  if (situation.allies !== null && situation.enemies !== null) chips.push({ kind: "situation", text: `我方 ${situation.allies} 人 · 对方 ${situation.enemies} 人存活` });
  if (situation.remainingSeconds !== null) chips.push({ kind: "clock", text: `回合剩余 ${Math.max(0, Math.ceil(situation.remainingSeconds))} 秒` });
  const objectives = { NOT_CARRIED: "C4 未携带", CARRIED: "C4 已携带", DROPPED: "C4 已掉落", PLANTED: "C4 已安放", DEFUSED: "C4 已拆除", EXPLODED: "C4 已爆炸", UNKNOWN: "C4 状态待确认" };
  if (situation.objective) chips.push({ kind: "objective", text: objectives[situation.objective] });
  const assessment = input.semantics?.assessment;
  const titles = { DECISION_ERROR: "这次决策的问题", EXECUTION_ISSUE: "这次执行的判断", POSITIVE_PROCESS: "值得肯定的过程", FORCED_CHOICE: "当时的局面限制", INSUFFICIENT_EVIDENCE: "暂时无法确定", NO_TEACHING_VALUE: "这段处理的记录" };
  const rawAction = compactText(input.narration.playerAction.text);
  const rawIssue = compactText(input.narration.coreIssue.text);
  const issue = containsInternalTaxonomy(rawIssue)
    ? "现有证据不足以评价这个选择。"
    : rawIssue;
  const problemText = [isGenericAction(rawAction) ? "" : rawAction, issue]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" ");

  const consequences = input.outcomeFacts.slice(0, 1).map((fact) => compactText(fact.text));
  if (hasMeaningfulWinRateImpact(input.outcomeImpact)) {
    const impact = input.outcomeImpact;
    consequences.push(`这段结果前后，我方胜率从 ${Math.round(impact.beforeProbability * 100)}% 变为 ${Math.round(impact.afterProbability * 100)}%。这不单独决定你的选择是否正确。`);
  }
  if (consequences.length === 0 && !/(?:上升|下降|少了)\s*0\s*个?百分点/.test(input.narration.outcomeImpact.text)) {
    consequences.push(compactText(input.narration.outcomeImpact.text));
  }

  return {
    currentState: {
      chips,
      limitations: input.semantics ? [...new Set([...(playerStateUnknown ? ["无法确认该决策点的当前玩家状态，暂不展示生命、护甲等资源。"] : []), ...situation.limitations, ...(assessment?.limitations ?? []).map(playerFacingLimitation)])].slice(0, 3) : [],
      ...(chips.length === 0 ? { fallbackText: playerStateUnknown ? "当前玩家状态暂无法确认。" : compactText(input.narration.currentSituation.text) } : {})
    },
    problem: {
      title: assessment ? titles[assessment.kind] : "这次处理的判断",
      ...(assessment ? { confidence: assessment.confidence } : {}),
      text: problemText || "现有证据不足以评价这个选择。",
      consequences: [...new Set(consequences.filter(Boolean))]
    },
    improvement: { text: compactText(input.narration.betterPlay.text), reviewQuestions: uncertaintyReviewQuestions(input.semantics, input.decisionTick) }
  };
}

function legacyOutcomeText(kind?: string): string {
  if (kind === "DEATH") return "这段结果记录了你的阵亡。";
  if (kind === "KILL") return "这段结果记录了你的击杀。";
  if (kind === "HP_CHANGE") return "这段结果记录了你的血量变化。";
  return "这段结果已记录，无法仅凭结果确定决策对错。";
}

/** Saved v1 sessions stay navigable; unverified old prose is never reused. */
export function presentableCoachingNarration(cue: CoachCue, narration: NarrationBundle): NarrationBundle {
  if (cue.assessment && cue.observableContext) return narration;
  const facts = cue.facts.filter((fact) => fact.availability === "DECISION" && fact.observed_by_player && fact.available_at_tick <= cue.decision_tick && cue.observable_fact_refs.includes(fact.id));
  const decisionRefs = facts.slice(0, 1).map((fact) => fact.id);
  const outcomes = (cue.outcome_facts ?? []).filter((fact) => fact.availableAtTick >= cue.reveal_tick && fact.availableAtTick <= cue.outcome_end_tick);
  return {
    ...narration,
    currentSituation: { text: facts[0]?.text ?? "这段历史记录缺少当时的完整局面。", refs: decisionRefs },
    playerAction: { text: "当前记录不足以确认具体行动意图。", refs: [] },
    coreIssue: { text: "这段历史记录尚未验证决策条件，不能据此认定你的选择有问题。", refs: decisionRefs },
    betterPlay: { text: "目前还不能确认哪种替代处理在当时可行。", refs: decisionRefs },
    outcomeImpact: { text: outcomes.map((fact) => legacyOutcomeText(fact.outcomeKind)).join(" ") || "这段结果不用于反推当时的决策好坏。", refs: outcomes.map((fact) => fact.id) },
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
  return preparedNarration ? presentableCoachingNarration(cue, preparedNarration) : undefined;
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
    outcomeFacts: cue.assessment && cue.observableContext ? outcomeFacts : outcomeFacts.map((fact) => ({ ...fact, text: legacyOutcomeText(cue.outcome_facts?.find((item) => item.id === fact.id)?.outcomeKind) })),
    question: cue.assessment ? cue.question : "你当时最想完成什么？",
    advice: cue.assessment && cue.observableContext ? cue.advice[0] : undefined,
    ...(isOutcomeVisible && preparedNarration ? { narration: presentableCoachingNarration(cue, preparedNarration) } : {})
  };
}
