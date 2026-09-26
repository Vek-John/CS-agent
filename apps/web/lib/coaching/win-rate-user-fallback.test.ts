import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { AnalysisProgressEvent } from "@cs-coach/contracts";
import { WinRateFallbackControl } from "./win-rate-user-fallback";
import { CoachSetupFlow } from "../../components/playback/coach-setup-flow";
const progress = (id?: number): AnalysisProgressEvent => ({ type: "ANALYSIS_PROGRESS", schemaVersion: "cs2d-analysis-progress.v1", selectedPlayerId: "player", analysisRequestId: id, phase: "inference", completed: 0, total: 10, detail: "pending" });
it("claims one currently rendered request and does not let duplicate or old callbacks claim a successor", () => {
  const control = new WinRateFallbackControl();
  const first = control.update(progress(1), "player", false)!;
  expect(control.claim(first)).toEqual({ type: "skipWinRate", selectedPlayerId: "player", analysisRequestId: 1 });
  expect(control.current?.requested).toBe(true); expect(control.claim(first)).toBeUndefined();
  expect(control.update({ ...progress(1), completed: 1 }, "player", false)?.requested).toBe(true);
  const second = control.update(progress(2), "player", false)!;
  expect(control.claim(first)).toBeUndefined(); expect(control.current).toBe(second);
  expect(control.update(progress(1), "player", false)).toBe(second);
  control.close(); expect(control.claim(second)).toBeUndefined(); expect(control.update(progress(2), "player", false)).toBeUndefined();
  control.reset(); const reloaded = control.update(progress(1), "player", false)!;
  expect(control.claim(first)).toBeUndefined(); expect(control.claim(reloaded)?.analysisRequestId).toBe(1);
});
it("shows no action for old progress, mismatched player, RESTORE, unavailable or completed work", () => {
  const control = new WinRateFallbackControl();
  expect(control.update(progress(), "player", false)).toBeUndefined();
  expect(control.update(progress(1), "other", false)).toBeUndefined();
  expect(control.update(progress(1), "player", true)).toBeUndefined();
  const pending = control.update(progress(1), "player", false)!;
  expect(control.update({ ...progress(1), phase: "unavailable" }, "player", false)).toBeUndefined();
  expect(control.claim(pending)).toBeUndefined();
});
it("renders a native keyboard button and accessible acknowledgement without changing setup steps", () => {
  const onChoose = vi.fn(), props = { steps: [{ title: "分析", detail: "等待", state: "active" as const }] };
  const ready = renderToStaticMarkup(createElement(CoachSetupFlow, { ...props, winRateFallback: { requested: false, onChoose } }));
  expect(ready).toContain('type="button"'); expect(ready).toContain("先用基础路线"); expect(ready).toContain("本次不包含胜率分析");
  const pending = renderToStaticMarkup(createElement(CoachSetupFlow, { ...props, winRateFallback: { requested: true, onChoose } }));
  expect(pending).toContain('disabled=""'); expect(pending).toContain('role="status"'); expect(pending).toContain("正在切换到基础路线");
  expect(renderToStaticMarkup(createElement(CoachSetupFlow, props))).not.toContain("先用基础路线");
});
