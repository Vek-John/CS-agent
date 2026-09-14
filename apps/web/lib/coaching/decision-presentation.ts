import type { TrustedDecisionSemantics } from "@cs-coach/contracts";

/** Presentation only: it never approves advice or infers a missing fact. */
export function playerFacingLimitation(value: string): string {
  if (!/(?:Observation|Observable)State|WinProbabilityTimeline|DecisionSnapshot|CoachingPackage|OutcomePackage|分析包|逐玩家|字段|renderer|Worker|Director|PlanCompiler|Viewer|\bticks?\b|lossless|\bTRADE\b|ref[ _-]?id|schema|pipeline|fallback|candidate|focus|\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b|USER claim|Learning Thread/i.test(value) && !/^[A-Za-z][A-Za-z0-9_./ :;-]*$/.test(value)) return value;
  if (/winprobability|win.?rate/i.test(value)) return "这段回放暂时没有可用的胜率估计。";
  if (/sound|audio|声音|听觉/i.test(value)) return "无法确认你当时实际听到了什么。";
  if (/visibility|sight|视线|observation|observable/i.test(value)) return "无法完整确认你当时看到了哪些敌人信息。";
  if (/trade|support|teammate|队友/i.test(value)) return "还缺少队友能否及时参与同一次交火的信息。";
  if (/time|tick|clock/i.test(value)) return "这段记录的时机信息还不完整。";
  return "这段回放的证据还不完整，暂时不能据此下确定结论。";
}

export interface ObservableSituation {
  allies: number | null; enemies: number | null; health: number | null; armor: number | null; money: number | null;
  phase: "FREEZE" | "LIVE" | "POST_ROUND" | "UNKNOWN" | null;
  remainingSeconds: number | null;
  objective: "NOT_CARRIED" | "CARRIED" | "DROPPED" | "PLANTED" | "DEFUSED" | "EXPLODED" | "UNKNOWN" | null;
  confidence: number; limitations: string[];
}

/** Field by field boundary projection. Full-world player summaries never enter this object. */
export function observableSituation(semantics: TrustedDecisionSemantics): ObservableSituation {
  const snapshot = semantics.decisionSnapshot;
  const counts = snapshot?.aliveCounts.boundary === "OBSERVABLE" ? snapshot.aliveCounts.value : null;
  const player = snapshot?.selectedPlayer.boundary === "OBSERVABLE" ? snapshot.selectedPlayer.value : null;
  const clock = snapshot?.clock.boundary === "OBSERVABLE" ? snapshot.clock.value : null;
  const bomb = snapshot?.bomb.boundary === "OBSERVABLE" ? snapshot.bomb.value : null;
  return {
    allies: counts?.allies ?? null, enemies: counts?.enemies ?? null,
    health: player?.health ?? null, armor: player?.armor ?? null, money: player?.money ?? null,
    phase: clock?.phase ?? null, remainingSeconds: clock?.remainingSeconds ?? null,
    objective: bomb?.state ?? null, confidence: semantics.observableContext?.confidence ?? 0,
    limitations: [...new Set((semantics.observableContext?.limitations ?? ["当时的可见信息尚不完整。"]).map(playerFacingLimitation))].slice(0, 24),
  };
}
