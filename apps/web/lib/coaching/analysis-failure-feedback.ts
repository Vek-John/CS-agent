// Exact messages emitted by the current Adapter's intact capacity gates.
// A changed or unknown error falls back safely; arbitrary transport text is never displayed.
const CAPACITY_ERRORS = new Set([
  "AnalysisBundle exceeds 16 MiB.",
  "Analysis candidate windows exceed 512; analysis stopped without truncating timeline coverage.",
  "Analysis candidate windows exceed 512.",
]);

export function analysisFailureFeedback(message: unknown): string {
  return typeof message === "string" && CAPACITY_ERRORS.has(message)
    ? "这场复盘超过当前版本的处理容量，无法准备完整教学复盘。原样重试不会改变结果；请选择其他比赛，或打开已有复盘。"
    : "比赛分析暂时未能完成，请重新选择比赛或玩家。";
}
