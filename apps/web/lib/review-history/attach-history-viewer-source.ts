import { HistoryRestoreError, type HistoryRestoreController, type ManagedDemoSource, type RestoredHistoryControlPlane } from "./history-restore-controller";
import { ReviewHistoryApiError } from "./api";

export interface ViewerSourceFeedback {
  preparation: { phase: "READY" | "ERROR"; detail: string };
  message: string;
}

/** The production Host's second stage, after its saved control plane is restored. */
export async function attachHistoryViewerSource(input: {
  controller: HistoryRestoreController;
  restored: RestoredHistoryControlPlane;
  mode: "RESTORE" | "REANALYZE" | "SELECT_PLAYER";
  isCurrent(): boolean;
  expectSource(source: ManagedDemoSource): void;
  feedback(value: ViewerSourceFeedback): void;
}): Promise<void> {
  try {
    const withViewer = await input.controller.attachViewerSource(input.restored, input.mode);
    if (!input.isCurrent()) throw new HistoryRestoreError("STALE_REQUEST", "已切换到另一条复盘。");
    if (!withViewer.managedSource) throw new Error("Managed Viewer source is unavailable.");
    input.expectSource(withViewer.managedSource);
    input.controller.activate(withViewer, input.mode);
  } catch (error) {
    // Host ownership may change before Controller.open creates its next generation.
    // Check it before either error UI write, including ordinary AbortError/rejections.
    if (!input.isCurrent() || (error instanceof HistoryRestoreError && error.code === "STALE_REQUEST")) return;
    const reason = error instanceof ReviewHistoryApiError && error.code === "VIEWER_SOURCE_TIMEOUT"
      ? "获取回放入口超时" : "回放入口暂时不可用";
    if (input.mode === "RESTORE") {
      input.feedback({
        preparation: { phase: "READY", detail: `已恢复讲解与进度，${reason}。` },
        message: `${reason}；已恢复的讲解与进度仍保留，可以重试或在设置中检查资料库。`,
      });
    } else {
      const operation = input.mode === "REANALYZE" ? "重新分析" : "重新选人";
      input.feedback({
        preparation: { phase: "ERROR", detail: `${reason}，尚未开始${operation}。` },
        message: `${reason}；本次${operation}未启动，原有复盘未改变。可以重试或在设置中检查资料库。`,
      });
    }
  }
}
