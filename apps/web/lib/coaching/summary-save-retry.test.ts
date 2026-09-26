import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { completeAndSaveSessionWrapUp, createSessionWrapUpGuard, type SessionSummarySaveRetry } from "./session-wrap-up-completion";
import { SessionWrapUpPanel } from "./session-wrap-up-presentation";
import { HistoryPersistenceController } from "../review-history/history-persistence-controller";
import * as summaries from "./deepseek-wrap-up";
import type { SessionWrapUpBuildInput, SessionWrapUpResult } from "@cs-coach/coach-agent/client";
const projection: SessionWrapUpBuildInput = { summary: { schemaVersion: "coach-agent-session-summary.v1", themes: [], completedCues: [], limitations: [] }, presentableCues: {} };
afterEach(() => vi.restoreAllMocks());
async function failedSave() {
  const append = vi.fn().mockRejectedValueOnce(new Error("connection interrupted")).mockResolvedValue(undefined);
  const persistence = new HistoryPersistenceController({ appendArtifact: append, createReview: vi.fn(), startRevision: vi.fn(), commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
  persistence.adopt("review", "revision", "demo");
  const live = { generation: 1, historyEpoch: 1, session: { id: "session", phase: "COMPLETED" as const }, runId: undefined, persistence };
  const isCurrent = createSessionWrapUpGuard({ sessionId: "session", runId: "run" }, 1, () => ({ ...live }));
  const held: { retry?: SessionSummarySaveRetry; result?: SessionWrapUpResult } = {};
  const build = vi.fn(() => projection), generate = vi.spyOn(summaries, "requestSessionWrapUp");
  await completeAndSaveSessionWrapUp({ buildInput: build, isCurrent, persistence,
    onRequest: vi.fn(), onResult: result => { held.result = result; }, onSaveError: retry => { held.retry = retry; } });
  expect(held.retry).toBeDefined();
  return { held, append, persistence, live, build, generate };
}
it("retries the exact saved payload/key after an ambiguous failure without rebuilding a summary", async () => {
  const f = await failedSave();
  const original = structuredClone(f.append.mock.calls[0]);
  f.held.result!.bundle.limitations.push("later UI mutation must not change the retained request");
  expect(await f.held.retry!.retry()).toBe(true);
  expect(f.append).toHaveBeenCalledTimes(2); expect(f.append.mock.calls[1]).toEqual(original);
  expect(f.append.mock.calls[1][1]).toMatchObject({ artifactRevision: 1, artifactKey: "session-summary", idempotencyKey: "revision:SESSION_SUMMARY:session-summary:v1" });
  expect(f.build).toHaveBeenCalledOnce(); expect(f.generate).toHaveBeenCalledOnce();
  expect(await f.held.retry!.retry()).toBe(false); expect(f.append).toHaveBeenCalledTimes(2);
});
it("coalesces repeated clicks while saving", async () => {
  const f = await failedSave(); let resolve!: () => void;
  f.append.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const a = f.held.retry!.retry(), b = f.held.retry!.retry();
  expect(a).toBe(b); await Promise.resolve(); expect(f.append).toHaveBeenCalledTimes(2);
  resolve(); expect(await a).toBe(true); expect(await b).toBe(true);
});
it.each(["different-review", "same-ids-new-owner"])("does not send the retained result after %s is adopted", async kind => {
  const f = await failedSave();
  f.persistence.adopt(kind === "different-review" ? "other" : "review", "revision", "demo");
  expect(f.held.retry!.isCurrent()).toBe(false);
  expect(await f.held.retry!.retry()).toBe(false); expect(f.append).toHaveBeenCalledOnce();
});
it("does not report success for an old owner when its write returns late", async () => {
  const f = await failedSave(); let resolve!: () => void;
  f.append.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const pending = f.held.retry!.retry(); await Promise.resolve();
  f.live.historyEpoch++; resolve(); expect(await pending).toBe(false);
  expect(await f.held.retry!.retry()).toBe(false); expect(f.append).toHaveBeenCalledTimes(2);
});
it("retains the same request after another failure for the next explicit retry", async () => {
  const f = await failedSave(); f.append.mockRejectedValueOnce(new Error("still offline"));
  await expect(f.held.retry!.retry()).rejects.toThrow("still offline");
  expect(await f.held.retry!.retry()).toBe(true);
  expect(f.append).toHaveBeenCalledTimes(3);
  expect(f.append.mock.calls[2]).toEqual(f.append.mock.calls[0]); expect(f.generate).toHaveBeenCalledOnce();
});
it("keeps the result and completion available while exposing retry, busy and saved feedback", async () => {
  const f = await failedSave(); const onRetry = vi.fn();
  const props = { status: "FALLBACK", result: f.held.result, phase: "WRAP_UP", onComplete: () => {} };
  const failed = renderToStaticMarkup(createElement(SessionWrapUpPanel, { ...props, saveRetry: { busy: false, onRetry } }));
  expect(failed).toContain("重试保存总结"); expect(failed).toContain("暂不归纳为习惯"); expect(failed).toContain("完成本次复盘");
  const busy = renderToStaticMarkup(createElement(SessionWrapUpPanel, { ...props, saveRetry: { busy: true, onRetry } }));
  expect(busy).toContain("正在保存总结"); expect(busy).toContain('disabled=""');
  const saved = renderToStaticMarkup(createElement(SessionWrapUpPanel, { ...props, saveConfirmed: true }));
  expect(saved).toContain("总结已保存"); expect(saved).not.toContain("重试保存总结");
});
