/** A focus label identifies a review question; it never establishes a mistake. */
export function playerFacingFocusProblem(_primaryFocusCode: string): string {
  return "当前证据不足以判断这次选择是否有问题；结果本身不能说明决策对错。";
}

export const UNCERTAIN_ADVICE_TEXT = "目前无法确认更好的可执行方案，需要先核实当时的可用信息和行动条件。";

/** Display boundary only. Tactical validity belongs to the typed applicability gate. */
export function playerFacingLimitation(_limitation?: string): string {
  return "部分现场信息无法确认，因此暂不作确定判断。";
}
