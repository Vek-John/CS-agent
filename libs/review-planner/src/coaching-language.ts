const FOCUS_PROBLEM_COPY: Readonly<Record<string, string>> = {
  SURVIVE_THE_NEXT_CONTACT: "你没给下一次交火留退路和补枪空间，很容易打完第一枪就被换掉。",
  SURVIVE_CONTACT: "你没给这次交火留退路和补枪空间，很容易被对面换掉。",
  CONVERT_ADVANTAGE: "有优势还继续单独找人，会把人数和位置优势白白送回去。",
  OBJECTIVE_TIMING: "队友没到位就单独处理 C4，没人架枪也没人补枪，很容易被抓死。",
  UTILITY_PURPOSE_AND_TEMPO: "道具没有接上队友的进点时机，既没逼退对手，也没帮队友过点。",
  WIN_PROBABILITY_SWING_RESPONSE: "这次处理把局面的主动权交了出去，后面会更难打。"
};

/** Internal taxonomy stays machine-readable; players only see concrete CS language. */
export function playerFacingFocusProblem(primaryFocusCode: string): string {
  return FOCUS_PROBLEM_COPY[primaryFocusCode]
    ?? "这次处理没有留好退路和队友补枪条件，风险太高。";
}
