import type {
  Advice,
  CandidateMaterial,
  DirectorDecision,
  Fact,
  TeachingCandidate,
  WinProbabilityEconomyClass
} from "@cs-coach/contracts";

export const COACHING_RULE_VERSION = "review-planner/coaching-rules/1.0.0";

export interface DeterministicCoachMaterial {
  title: string;
  explanation: string;
  advice: string;
  trigger: string;
  ruleId: string;
  taxonomy: string;
}

export function buildDeterministicCoachMaterial(input: {
  contextCode?: string;
  callout?: string;
  economy?: WinProbabilityEconomyClass;
  repeated: boolean;
  primaryFocusCode: string;
}): DeterministicCoachMaterial {
  const where = input.callout ? `你现在在${input.callout}` : "当前报点未知";
  const economyLead = input.economy === "ECO" ? "这把是 eco，" : input.economy === "FORCE" ? "这把是强起，" : input.economy === "FULL" ? "这是长枪局，" : input.economy === "PISTOL" ? "这是手枪局，" : "";
  const context = input.contextCode ?? "contact-preparation";
  const base = context === "utility-readiness"
    ? { title: "道具先封枪线，队友跟上再拉出去", explanation: `${where}，手里有道具。先用这颗道具封住要过的枪线，再让队友一起拉出去；不然道具落地也没人补枪。`, advice: "先报清这颗道具封哪里；队友能跟上再出手，没铺好枪线就先别硬磕。", trigger: "手持道具并准备拉出当前掩体时", ruleId: `${COACHING_RULE_VERSION}/utility-window` }
    : context === "low-health-survival"
      ? { title: "低血量别第一个拉，站第二身位补枪", explanation: `${where}，血量已经偏低。现在别第一个拉出去，先让高血量队友架枪，你跟第二身位补枪，打完还能马上换位。`, advice: "让高血量队友打首接触；你跟着补枪，独自拿信息时只露一个能立刻收回的身位。", trigger: "低血量准备进入下一条枪线时", ruleId: `${COACHING_RULE_VERSION}/low-health-second-contact` }
      : context === "rotation-safety"
        ? { title: "切刀转点前换回枪，预瞄再走", explanation: `${where}，切刀只适合已经确认安全的路。前面还有未知角就先换回枪预瞄，别空手拉出去。`, advice: "安全直路可以切刀提速；接近未知角前换回枪，先架住首接触位再走。", trigger: "刀在手且准备走进未确认枪线时", ruleId: `${COACHING_RULE_VERSION}/rotation-weapon-ready` }
        : context === "bomb-carrier-safety"
          ? { title: "带包别单拉，先让队友架枪", explanation: `${where}，你带着 C4。先让队友架住并能补枪再往前拉；一个人冲进未知区，掉包后全队连转点都难。`, advice: "队友没跟上就别深拉；需要先探时交包，或者先让队友架住能回收的位置。", trigger: "携带 C4 且准备离开队友补枪范围时", ruleId: `${COACHING_RULE_VERSION}/bomb-recoverability` }
          : context === "unarmored-contact"
            ? { title: `${input.economy === "ECO" ? "eco 局没头甲" : input.economy === "FORCE" ? "强起局头甲不够" : input.economy === "FULL" ? "长枪局头甲不够" : "头甲不够"}别硬磕，预瞄一个角就换位`, explanation: `${where}，${economyLead}头甲不够，别直接拉出去和对面磕枪。先预瞄一个角，只拉一个身位，第一枪打完就回掩体换位。`, advice: "只拉一个能马上收回的身位；打完就换位，没有队友补枪就先架住，别连续找第二个角。", trigger: "头甲不足且准备拉出掩体时", ruleId: `${COACHING_RULE_VERSION}/unarmored-contact` }
            : context === "win-rate-review"
              ? { title: "先拆开胜率下滑对应的处理", explanation: `${where}，${economyLead}这段模型胜率明显下滑。先只根据决策时已有事实拆开是哪一个可控处理影响了风险，不把模型变化直接当成单一动作的因果证明。`, advice: "先回到这段处理的决策事实，确认造成下滑的可控动作，再保留一条可撤退路线。", trigger: "胜率在结果窗口内显著下降时", ruleId: `${COACHING_RULE_VERSION}/win-rate-review` }
              : { title: `${input.economy === "ECO" ? "eco 局" : input.economy === "FORCE" ? "强起局" : input.economy === "FULL" ? "长枪局" : input.economy === "PISTOL" ? "手枪局" : "首接触前"}先架枪，预瞄好再拉出去`, explanation: `${where}。${economyLead}先把准星预瞄到首接触位，队友能补枪再拉出去；没人补就架住或换位，别一个人硬磕枪。`, advice: "先预瞄、停半拍；队友没补枪就留在掩体后架枪，或者换位再打。", trigger: "准备进入下一条未知枪线时", ruleId: `${COACHING_RULE_VERSION}/contact-preparation` };
  return {
    ...base,
    title: `${input.repeated ? "又一次：" : ""}${input.callout ? `${input.callout}：` : ""}${base.title}`,
    taxonomy: input.primaryFocusCode
  };
}

export function buildDeterministicAdvice(
  candidate: TeachingCandidate,
  decision: DirectorDecision,
  material: CandidateMaterial,
  decisionFacts: readonly Fact[],
  repeated: boolean
): { copy: DeterministicCoachMaterial; advice: Advice } {
  const copy = buildDeterministicCoachMaterial({
    contextCode: material.contextCode,
    callout: material.callout,
    economy: material.economy,
    repeated,
    primaryFocusCode: decision.primaryFocusCode
  });
  return {
    copy,
    advice: {
      id: `advice-${candidate.candidateId}`,
      text: copy.advice,
      trigger: copy.trigger,
      fact_refs: decisionFacts.map((fact) => fact.id),
      rule_id: copy.ruleId
    }
  };
}
