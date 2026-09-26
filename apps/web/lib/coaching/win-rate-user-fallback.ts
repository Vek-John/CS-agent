import type { AnalysisProgressEvent, PlaybackCommand } from "@cs-coach/contracts";
export interface WinRateFallbackTarget { readonly selectedPlayerId: string; readonly analysisRequestId: number; readonly requested: boolean }
/** Page-local token ownership; an old rendered callback cannot claim a replacement request. */
export class WinRateFallbackControl {
  private target?: WinRateFallbackTarget;
  private latestRequestId = 0;
  get current() { return this.target; }
  close() { this.target = undefined; }
  reset() { this.close(); this.latestRequestId = 0; }
  update(progress: AnalysisProgressEvent, selectedPlayerId: string | undefined, blocked: boolean): WinRateFallbackTarget | undefined {
    if (blocked || progress.selectedPlayerId !== selectedPlayerId) { this.close(); return; }
    const id = progress.analysisRequestId;
    if (!Number.isSafeInteger(id) || id! <= 0) { this.close(); return; }
    if (id! < this.latestRequestId) return this.target;
    if (progress.phase === "unavailable") { this.latestRequestId = id!; this.close(); return; }
    const current = this.target;
    if (current && current.analysisRequestId === id && current.selectedPlayerId === selectedPlayerId) return current;
    if (id! <= this.latestRequestId) return;
    this.latestRequestId = id!;
    return this.target = { selectedPlayerId, analysisRequestId: id!, requested: false };
  }
  claim(target: WinRateFallbackTarget): Extract<PlaybackCommand, { type: "skipWinRate" }> | undefined {
    if (target !== this.target || target.requested) return;
    this.target = { ...target, requested: true };
    return { type: "skipWinRate", selectedPlayerId: target.selectedPlayerId, analysisRequestId: target.analysisRequestId };
  }
}
