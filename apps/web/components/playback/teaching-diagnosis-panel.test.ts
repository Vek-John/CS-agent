import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { TeachingDiagnosisPanel } from "./teaching-diagnosis-panel";

function renderTradePanel(aliveTeammates?: number, legacy = false) {
  const result = diagnoseTeachingCue({
    cueId: "cue-test",
    reflection: { cueId: "cue-test", selectedGoal: "TRADE", response: "ANSWERED", source: "USER", limitations: [] },
    decisionFacts: [], playerActionFacts: [], outcomeFacts: [],
    decisionResources: { health: 2, armor: 0, hasHelmet: false, ...(aliveTeammates === undefined ? {} : { aliveTeammates }), evidenceRefs: ["public-roster"] },
    limitations: ["WinProbabilityTimeline unavailable.", "ObservableState missing", "当前分析包没有逐玩家视线。"],
  });
  if (legacy && result.cueCase.transferRule) result.cueCase.transferRule.do = "让高血量队友先接触，你跟着补枪。";
  return renderToStaticMarkup(createElement(TeachingDiagnosisPanel, {
    cue: { id: "cue-test", title: "处理复盘", question: "你当时想完成什么？" },
    decisionFacts: [], cueCase: result.cueCase, learningThread: result.learningThread, hasTrustedDecisionContext: !legacy,
    onSubmit() {}, onSkip() {}, onConfirm() {}, onDisagree() {},
  }));
}

describe("rendered reflection feedback", () => {
  it("renders a selected trade goal in natural language without internal enums or implementation labels", () => {
    const html = renderTradePanel();
    expect(html).toContain("给队友补枪");
    expect(html).toContain("这是你对当时思路的补充");
    expect(html).not.toMatch(/TRADE|USER claim|WinProbabilityTimeline|ObservableState|ObservationState|renderer|分析包|逐玩家/);
    expect(html).toContain("暂时没有可用的胜率估计");
    expect(html).toContain("懂了，继续");
  });

  it("states the known absent teammate condition rather than asking if teammates were alive", () => {
    const html = renderTradePanel(0);
    expect(html).toContain("四名队友都已阵亡");
    expect(html).not.toContain("还缺少队友是否存活");
    expect(html).not.toContain("让高血量队友");
    expect(html).toContain("目前无法确定");
  });
});

it("does not render legacy saved diagnosis tactics and preserves a continue control", () => {
  const html = renderTradePanel(undefined, true);
  expect(html).toContain("已恢复你的思路记录");
  expect(html).toContain("看完了，继续下一段");
  expect(html).not.toContain("让高血量队友");
  expect(html).not.toContain("USER claim");
});

it.each([0, 2, undefined])("renders a known utility count or explicit unknown without inventing zero: %s", (utilityCount) => {
  const output = diagnoseTeachingCue({ cueId: "cue-utility", reflection: { cueId: "cue-utility", selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] }, decisionFacts: [], playerActionFacts: [], outcomeFacts: [], decisionResources: { health: 100, armor: 100, hasHelmet: true, ...(utilityCount === undefined ? { inventoryCount: 1 } : { utilityCount }), evidenceRefs: [] } });
  const html = renderToStaticMarkup(createElement(TeachingDiagnosisPanel, { cue: { id: "cue-utility", title: "处理复盘", question: "你的目标是什么？" }, decisionFacts: [], cueCase: output.cueCase, hasTrustedDecisionContext: true, onSubmit() {}, onSkip() {}, onConfirm() {}, onDisagree() {} }));
  if (utilityCount === undefined) {
    expect(html).toContain("道具数量未知");
    expect(html).not.toContain("决策时道具数量</b>");
  } else {
    expect(html).toContain(`决策时道具数量</b><span>${utilityCount}颗`);
  }
  expect(html).toContain("懂了，继续");
});


it("keeps known living teammates distinct from unknown contact conditions", () => {
  const html = renderTradePanel(4);
  expect(html).toContain("当时还有4名存活队友");
  expect(html).not.toContain("还缺少队友是否存活");
  expect(html).toContain("双方能否看到同一个对手");
  expect(html).toContain("懂了，继续");
});
