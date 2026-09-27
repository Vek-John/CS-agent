import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
// SSR cannot click open the disclosure. Only initialize its boolean open state;
// the actual Panel and native busy button are rendered without copying markup.
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => actual.useState(initial === false ? true : initial) };
});
import { TeachingDiagnosisPanel } from "./teaching-diagnosis-panel";
it.each([false, true])("renders the actual disagreement button's pending feedback (busy=%s)", busy => {
  const { cueCase, learningThread } = diagnoseTeachingCue({ cueId: "cue", reflection: { cueId: "cue", selectedGoal: "GET_INFO", source: "USER", response: "ANSWERED", limitations: [] },
    decisionFacts: [], playerActionFacts: [], outcomeFacts: [], decisionResources: { evidenceRefs: [] } });
  const html = renderToStaticMarkup(createElement(TeachingDiagnosisPanel, { cue: { id: "cue", title: "处理复盘", question: "当时想做什么？" }, cueCase, learningThread,
    decisionFacts: [], hasTrustedDecisionContext: true, busy, onSubmit() {}, onSkip() {}, onDisagree() {}, onConfirm() {} }));
  expect(html).toContain(busy ? "正在重新检查…" : "用这条信息再检查一次");
  if (busy) {
    expect(html).toMatch(/disabled=""[^>]*>正在重新检查…/);
    const box = html.slice(html.indexOf("补充一条信息（只会再检查一次）"));
    expect(box).toMatch(/<textarea[^>]*disabled=""/);
    const buttons = [...box.matchAll(/<button\b[^>]*>/g)];
    expect(buttons.length).toBeGreaterThanOrEqual(7);
    expect(buttons.every(item => item[0].includes('disabled=""'))).toBe(true);
  }
});

it("keeps the actual Reflection Gate skip control available while submission is pending", () => {
  const html = renderToStaticMarkup(createElement(TeachingDiagnosisPanel, { cue: { id: "cue", title: "处理复盘", question: "当时想做什么？" },
    decisionFacts: [], hasTrustedDecisionContext: true, busy: true, onSubmit() {}, onSkip() {}, onDisagree() {}, onConfirm() {} }));
  const skip = html.match(/<button\b[^>]*>跳过，直接看分析<\/button>/)?.[0];
  expect(skip).toBeDefined(); expect(skip).not.toContain("disabled");
  expect(html).toContain("正在检查…");
});
