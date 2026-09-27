import { ReviewHistoryDetailReadError } from "./api";
import { HistoryRestoreError } from "./history-restore-controller";

/** Host applies its current-open ownership gate before publishing this feedback. */
export function historyOpenFailureFeedback(error: unknown): {
  preparation: { phase: "ERROR"; detail: string };
  message: string;
} {
  if (error instanceof HistoryRestoreError && error.code === "INVALID_DETAIL") {
    return {
      preparation: { phase: "ERROR", detail: "读取到的历史详情格式无效。" },
      message: "请重新打开这条复盘；尚未验证其中的保存产物。",
    };
  }
  if (error instanceof ReviewHistoryDetailReadError) {
    return {
      preparation: { phase: "ERROR", detail: error.code === "HISTORY_DETAIL_TIMEOUT" ? "读取已保存的复盘超时。" : "暂时无法读取已保存的复盘。" },
      message: "请再次点击这条复盘重试读取；已保存的内容未改变。",
    };
  }
  return {
    preparation: { phase: "ERROR", detail: "保存的产物未通过身份或版本校验。" },
    message: "无法安全恢复这条复盘；请明确选择“重新分析”，原始记录未改变。",
  };
}
