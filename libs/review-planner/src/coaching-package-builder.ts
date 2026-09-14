import type { AdviceOption, CandidateMaterial, DirectorDecision, Fact, TeachingCandidate, WinProbabilityEconomyClass } from "@cs-coach/contracts";
import { assessCandidateTeaching, buildGatedAdviceOptions } from "./teaching-gates";
import { UNCERTAIN_ADVICE_TEXT } from "./coaching-language";

export const COACHING_RULE_VERSION = "review-planner/coaching-rules/2.0.0";
export interface DeterministicCoachMaterial {
  title: string; explanation: string; advice: string; trigger: string; ruleId: string; taxonomy: string;
}

/** Legacy callers receive uncertainty; resource labels alone never establish a tactical option. */
export function buildDeterministicCoachMaterial(input: {
  contextCode?: string; callout?: string; economy?: WinProbabilityEconomyClass; repeated: boolean; primaryFocusCode: string;
}): DeterministicCoachMaterial {
  return { title: "回看当时的选择", explanation: "当前证据不足以判断这次选择是否有问题；结果本身不能说明决策对错。", advice: UNCERTAIN_ADVICE_TEXT,
    trigger: "需要核实行动条件时", ruleId: `${COACHING_RULE_VERSION}/uncertainty`, taxonomy: input.primaryFocusCode };
}

export function buildDeterministicAdvice(candidate: TeachingCandidate, decision: DirectorDecision, material: CandidateMaterial, _decisionFacts: readonly Fact[], _repeated: boolean): { copy: DeterministicCoachMaterial; advice: AdviceOption[] } {
  const assessment = assessCandidateTeaching(candidate, material);
  const advice = buildGatedAdviceOptions(candidate, material).filter((option) => option.applicability?.allowedIntoNarrator);
  const title = assessment.kind === "DECISION_ERROR" ? "有依据的决策改进" : assessment.kind === "POSITIVE_PROCESS" ? "值得保留的处理" : assessment.kind === "EXECUTION_ISSUE" ? "区分选择与执行" : assessment.kind === "FORCED_CHOICE" ? "理解当时的选择限制" : "回看当时的选择，暂不判错";
  return { copy: { title, explanation: assessment.explanation, advice: advice[0]?.text ?? UNCERTAIN_ADVICE_TEXT, trigger: advice[0]?.trigger ?? "需要核实行动条件时", ruleId: advice[0]?.rule_id ?? `${COACHING_RULE_VERSION}/uncertainty`, taxonomy: decision.primaryFocusCode }, advice };
}
