import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { diagnoseTeachingCue, DiagnosticResultSchema } from "@cs-coach/coach-agent/client";
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

function completeResourceDiagnosis() {
  return diagnoseTeachingCue({
    cueId: "cue-resources",
    reflection: { cueId: "cue-resources", selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] },
    decisionFacts: [], playerActionFacts: [], outcomeFacts: [],
    decisionResources: { health: 100, armor: 100, hasHelmet: true, money: 800, equipmentValue: 4100, utilityCount: 0,
      weaponAmmo: { weapon: "M4A4", clip: 0, evidenceRefs: ["prior-ammo"] }, evidenceRefs: ["resources"] },
  }).cueCase;
}

function renderResourcePanel(cueCase = completeResourceDiagnosis(), trusted = true) {
  return renderToStaticMarkup(createElement(TeachingDiagnosisPanel, {
    cue: { id: cueCase.cueId, title: "处理复盘", question: "你的目标是什么？" }, decisionFacts: [], cueCase,
    hasTrustedDecisionContext: trusted, onSubmit() {}, onSkip() {}, onConfirm() {}, onDisagree() {}, onReplay() {},
  }));
}

it("renders all six real resource measurements in order, including zero utility and prior ammo", () => {
  const cueCase = completeResourceDiagnosis();
  const measurements = cueCase.diagnosticResult!.measurements;
  expect(measurements).toHaveLength(6);
  const html = renderResourcePanel(cueCase);
  // Check the numeric rows, not the explanation which already mentioned the omitted facts.
  const rows = [...html.matchAll(/<li[^>]*><b>(.*?)<\/b><span>(.*?)<\/span><\/li>/g)].map(match => [match[1], match[2]]);
  expect(rows).toEqual(measurements.map(item => [item.label, `${item.value}${item.unit ?? ""}`]));
  expect(rows.slice(-2)).toEqual([["决策时道具数量", "0颗"], ["M4A4 决策前最近记录弹匣", "0发"]]);
  expect(html).toContain("不能当作决策瞬间精确余量");
});

it("renders the validated 16-measurement limit without truncating labels, values or units", () => {
  const cueCase = completeResourceDiagnosis();
  cueCase.diagnosticResult = DiagnosticResultSchema.parse({ ...cueCase.diagnosticResult, measurements: Array.from({ length: 16 }, (_, index) => ({
    id: `measurement-${index}`, label: `${index} 较长的已保存数值证据标签 LongUnbrokenWeaponLabel`, value: index, unit: "单位", evidenceRefs: [],
  })) });
  const html = renderResourcePanel(cueCase);
  expect([...html.matchAll(/<li[^>]*><b>/g)]).toHaveLength(16);
  expect(html).toContain("15 较长的已保存数值证据标签 LongUnbrokenWeaponLabel</b><span>15单位");
  expect(html).toContain('role="list" aria-label="诊断数值证据"');
  expect(renderResourcePanel(cueCase, false)).not.toContain("LongUnbrokenWeaponLabel");
});

it("omits an empty measurement list while retaining diagnosis actions", () => {
  const cueCase = completeResourceDiagnosis();
  cueCase.diagnosticResult = { ...cueCase.diagnosticResult!, measurements: [] };
  const html = renderResourcePanel(cueCase);
  expect(html).not.toContain('aria-label="诊断数值证据"');
  for (const label of ["懂了，继续", "再看一遍", "我不同意这个结论"]) expect(html).toContain(label);
});
