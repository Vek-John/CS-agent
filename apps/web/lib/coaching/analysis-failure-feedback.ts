// Exact messages emitted by the current Adapter's intact capacity gates.
// A changed or unknown error falls back safely; arbitrary transport text is never displayed.
const CAPACITY_ERRORS = new Set([
  "AnalysisBundle exceeds 16 MiB.",
  "Analysis candidate windows exceed 512; analysis stopped without truncating timeline coverage.",
  "Analysis candidate windows exceed 512.",
]);

export function analysisFailureFeedback(message: unknown, hasHistory = false): string {
  return typeof message === "string" && CAPACITY_ERRORS.has(message)
    ? `这场复盘超过当前版本的处理容量，无法准备完整教学复盘。原样重试不会改变结果；请选择其他比赛${hasHistory ? "，或打开已有复盘" : ""}。`
    : `比赛分析暂时未能完成。请点击“重新选择 Demo”重新导入比赛后再选择玩家。${hasHistory ? "已有复盘也可从历史菜单选择“重新分析”。" : ""}`;
}
