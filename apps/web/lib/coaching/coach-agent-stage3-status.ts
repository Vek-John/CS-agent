import type { Stage3CompletionNotice, Stage3ControllerState } from "./coach-agent-stage3-controller";
import { stage3ToolStatusLabel } from "./coach-agent-stage3-host-adapter";

type CurrentPresentation = Pick<Stage3CompletionNotice, "sessionId" | "runId" | "cueId" | "generation" | "visitId">;

const completedLabels = {
  REPLAY_CUE_SLOW: "关键动作回放已完成",
  FOCUS_MAP_EVIDENCE: "关键站位已标出",
  SHOW_GRENADE_TRACE: "道具轨迹已展示",
  SHOW_WIN_RATE_IMPACT: "胜率变化已展示",
  SHOW_ECONOMY_CONTEXT: "经济情况已展示",
} as const;

/** The Host renders this projection; missing recovery evidence stays neutral. */
export function stage3StatusView(state: Stage3ControllerState, current: CurrentPresentation | undefined) {
  const neutral = { title: "本段讲解已就绪", detail: "你可以继续下一段。", showPresentation: false };
  if (!current || state.cueId !== current.cueId) {
    return { title: "正在准备讲解", detail: "这里仅展示已经确认的证据。", showPresentation: false };
  }
  if (state.status === "COMPLETED") {
    const notice = state.completionNotice;
    if (!notice || notice.sessionId !== current.sessionId || notice.runId !== current.runId ||
      notice.cueId !== current.cueId || notice.generation !== current.generation || notice.visitId !== current.visitId) return neutral;
    if (notice.outcome === "NO_DEMONSTRATION") {
      return { title: "无需额外演示", detail: "本段讲解已就绪，你可以继续下一段。", showPresentation: false };
    }
    if (notice.outcome === "SUCCEEDED" && notice.tool && notice.callId) {
      return { title: completedLabels[notice.tool], detail: "你可以结合当前讲解继续复盘，或进入下一段。", showPresentation: true };
    }
    return { title: "额外演示未完成", detail: "你仍可以阅读当前讲解，或继续下一段。", showPresentation: false };
  }
  const unavailable = state.status === "FAILED" || state.status === "CANCELLED" || state.status === "RECOVERY_REQUIRED";
  return {
    title: state.status === "RECOVERY_REQUIRED" ? "需要恢复工具状态"
      : unavailable ? "教学工具暂不可用"
        : state.playback?.paused ? "演示已暂停"
          : state.status === "FOCUSING" && state.tool ? stage3ToolStatusLabel(state.tool)
            : state.status === "RESUMING" ? "正在准备下一段" : "准备下一段",
    detail: unavailable || state.error ? "这段证据暂时无法展示，你仍可以继续回放。" : "这里仅展示已经确认的证据。",
    showPresentation: !unavailable && !state.error && (state.status === "FOCUSING" || state.status === "RESUMING"),
  };
}
