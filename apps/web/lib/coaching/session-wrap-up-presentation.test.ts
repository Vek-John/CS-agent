import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoachAgentResult, SessionWrapUpResult } from "@cs-coach/coach-agent/client";
import type { ReviewPlan } from "@cs-coach/contracts";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { canPublishSessionWrapUp, sessionWrapUpPresentation, SessionWrapUpNotice, SessionWrapUpPanel } from "./session-wrap-up-presentation";

const local: SessionWrapUpResult = { status: "DISABLED", bundle: { schemaVersion: "coach-agent-session-wrap-up.v1", themes: [], limitations: [] }, manifest: { status: "DISABLED", provider: "DETERMINISTIC", reason: "CLOSED_SESSION_PROJECTION", limitations: [] } };

it("explains saved revised-cue exclusions even when no repeated theme remains", async () => {
  const { REVISED_DIAGNOSIS_SUMMARY_LIMITATION } = await import("@cs-coach/coach-agent/client");
  const restored = JSON.parse(JSON.stringify({ ...local, bundle: { ...local.bundle, limitations: [REVISED_DIAGNOSIS_SUMMARY_LIMITATION] } }));
  const html = renderRepresentative(restored);
  expect(html).toContain(REVISED_DIAGNOSIS_SUMMARY_LIMITATION);
  expect(html).not.toContain("训练建议");
  expect(renderRepresentative(local)).not.toContain(REVISED_DIAGNOSIS_SUMMARY_LIMITATION);
});

function representativeFixture() {
  const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());
  plan.cues.forEach(cue => { cue.primary_focus_code = "verified"; });
  const cue = plan.cues[0];
  const result: SessionWrapUpResult = { ...local, bundle: { ...local.bundle, themes: [{ focus: "verified",
    summary: { text: "已有问题", refs: [cue.id] }, trainingAdvice: { text: "已有建议", refs: [] } }] } };
  return { plan, cue, result, segment: plan.segments.find(segment => segment.id === cue.segment_id)! };
}
function renderRepresentative(result: SessionWrapUpResult, plan?: ReviewPlan) {
  return renderToStaticMarkup(createElement(SessionWrapUpPanel, { status: "READY", result, plan, phase: "COMPLETED", onComplete() {} }));
}

it("shows only saved representative cases, ignoring other theme occurrences and transient requests", () => {
  const { plan, cue, result, segment } = representativeFixture();
  plan.cues[1].primary_focus_code = "other";
  result.bundle.themes[0].summary.refs = [cue.id, cue.facts[0].id, cue.id, "old-cue", plan.cues[1].id];
  const html = renderRepresentative(result, plan);
  expect(html).toContain(`代表案例：第 ${segment.round_number} 回合`);
  expect(html.match(/第 \d+ 回合/g)).toHaveLength(1);
  const request = { themes: [{ focus: "verified", cueRefs: plan.cues.map(c => c.id) }] } as import("@cs-coach/coach-agent/client").SessionWrapUpRequest;
  expect(renderToStaticMarkup(createElement(SessionWrapUpPanel, { status: "READY", result, plan, request, phase: "COMPLETED", onComplete() {} }))).toBe(html);
});

it("deduplicates rounds from multiple legitimate representative cue refs", () => {
  const { plan, cue, result, segment } = representativeFixture();
  plan.cues.push({ ...cue, id: "same-round" });
  segment.cue_ids.push("same-round");
  result.bundle.themes[0].summary.refs.push("same-round", plan.cues[1].id);
  expect(renderRepresentative(result, plan).match(/第 \d+ 回合/g)).toEqual([`第 ${segment.round_number} 回合`, `第 ${plan.segments.find(s => s.id === plan.cues[1].segment_id)!.round_number} 回合`]);
});

it.each([
  "missing plan", "building plan", "unknown ref", "evidence ref", "missing focus", "different focus", "missing segment", "duplicate cue", "duplicate segment", "missing membership", "zero round", "negative round", "fractional round", "invalid round", "ambiguous evidence id",
])("downgrades unverifiable saved source: %s", reason => {
  const { plan, cue, result, segment } = representativeFixture();
  switch (reason) {
    case "building plan": plan.status = "BUILDING"; break;
    case "unknown ref": result.bundle.themes[0].summary.refs = ["old-cue"]; break;
    case "evidence ref": result.bundle.themes[0].summary.refs = [cue.facts[0].id]; break;
    case "missing focus": delete cue.primary_focus_code; break;
    case "different focus": cue.primary_focus_code = "other"; break;
    case "missing segment": cue.segment_id = "absent"; break;
    case "duplicate cue": plan.cues.push({ ...cue }); break;
    case "duplicate segment": plan.segments.push({ ...segment }); break;
    case "missing membership": segment.cue_ids = []; break;
    case "zero round": segment.round_number = 0; break;
    case "negative round": segment.round_number = -1; break;
    case "fractional round": segment.round_number = 1.5; break;
    case "invalid round": segment.round_number = NaN; break;
    case "ambiguous evidence id": cue.evidence[0].id = cue.id; break;
  }
  const html = renderRepresentative(result, reason === "missing plan" ? undefined : plan);
  expect(html).toContain("已完成讲解点");
  expect(html).not.toMatch(/代表案例|准备阶段|第 .* 回合/);
});

it("retains three-theme display limit and qualifications", () => {
  const { plan, result } = representativeFixture();
  result.bundle.themes = Array.from({ length: 4 }, () => result.bundle.themes[0]);
  result.bundle.limitations = ["来源限定"];
  const html = renderRepresentative(result, plan);
  expect(html.match(/<article/g)).toHaveLength(3);
  expect(html).toContain("来源限定");
});
it("renders no failure warning for normal deterministic completion", () => {
  const presentation = sessionWrapUpPresentation(local);
  expect(presentation.status).toBe("READY");
  expect(renderToStaticMarkup(createElement(SessionWrapUpNotice, { error: presentation.error }))).toBe("");
  const fallback = sessionWrapUpPresentation({ ...local, status: "FALLBACK", manifest: { ...local.manifest, status: "FALLBACK", reason: "UPSTREAM_HTTP" } });
  expect(renderToStaticMarkup(createElement(SessionWrapUpNotice, { error: fallback.error }))).toContain("智能总结暂不可用");
});
it("only publishes a completed Graph result for the captured current generation and run", () => {
  const result = { status: "COMPLETED", identity: { runId: "run" }, state: { sessionStatus: "COMPLETED" } } as CoachAgentResult;
  expect(canPublishSessionWrapUp(result, 1, 1, "run", false)).toBe(true);
  expect(canPublishSessionWrapUp(result, 1, 2, "run", false)).toBe(false);
  expect(canPublishSessionWrapUp(result, 1, 1, "other", false)).toBe(false);
  expect(canPublishSessionWrapUp(result, 1, 1, "run", true)).toBe(false);
  expect(canPublishSessionWrapUp({ ...result, status: "RUNNING" }, 1, 1, "run", false)).toBe(false);
  expect(canPublishSessionWrapUp({ ...result, state: { ...result.state, sessionStatus: "ACTIVE" } }, 1, 1, "run", false)).toBe(false);
});

it("keeps completion and review available when the actual summary panel reports an unrepresentable result", async () => {
  const { createFixtureReviewPlan } = await import("@cs-coach/review-planner");
  const { createSyntheticMirageTimeline } = await import("@cs-coach/demo-domain");
  const { createCoachingSession, reduceCoachingSession } = await import("@cs-coach/session");
  const { SessionWrapUpPanel, sessionWrapUpFailureMessage } = await import("./session-wrap-up-presentation");
  const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  for (let step = 0; step < plan.segments.length * 4 && session.phase !== "WRAP_UP"; step++) {
    const segment = plan.segments[session.current_segment_index];
    session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" } : session.phase === "PAUSED_FOR_COACHING" ? { type: "ADVANCE_SEGMENT" } : { type: "TICK", tick: segment.end_tick });
  }
  expect(session.phase).toBe("WRAP_UP");
  const snapshot = JSON.stringify(session);
  const { requestSessionWrapUp } = await import("./deepseek-wrap-up");
  const cueId = plan.cues[0].id;
  const failed = await requestSessionWrapUp({ summary: {
    schemaVersion: "coach-agent-session-summary.v1", limitations: Array.from({ length: 8 }, (_, i) => `已有限定${i}`),
    themes: [{ focus: "verified", cueRefs: [cueId, plan.cues[1].id], roundRefs: ["round-2", "round-3"], evidenceRefs: ["fact"], occurrence: 2, economyContext: "FULL", repeated: true, conflictEvidence: false, adviceRefs: ["advice"], limitations: [] }],
    completedCues: [{ cueId, focus: "verified", roundId: "round-2", evidenceRefs: ["fact"], adviceRefs: ["advice"] }],
  }, presentableCues: { [cueId]: { cueId, focus: "verified", coreIssue: { text: "已验证问题", refs: ["fact"], limitations: ["第九条必要限定"] }, betterPlay: { text: "已有建议", refs: ["advice"], limitations: [] }, advice: [{ id: "advice", text: "已有建议", refs: ["fact"] }] } } }).catch(error => error);
  expect(failed).toMatchObject({ name: "SessionWrapUpValidationError", message: "SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT" });
  const { completeAndSaveSessionWrapUp } = await import("./session-wrap-up-completion");
  let result: SessionWrapUpResult | undefined;
  const onSaveError = vi.fn();
  await completeAndSaveSessionWrapUp({ buildInput: () => { throw failed; }, isCurrent: () => true,
    persistence: { artifact: async () => { throw new Error("storage unavailable"); } },
    onRequest: () => {}, onResult: value => { result = value; }, onSaveError });
  expect(onSaveError).toHaveBeenCalledOnce();
  const error = sessionWrapUpPresentation(result).error;
  expect(error).toBe(sessionWrapUpFailureMessage(failed));
  const props = { status: "FALLBACK", result, plan, phase: session.phase, error, onComplete: () => {} };
  const html = renderToStaticMarkup(createElement(SessionWrapUpPanel, props));
  expect(html).toContain("未生成总结");
  expect(html).toContain("完成本次复盘");
  expect(html).not.toContain("没有足够重复");
  expect(JSON.stringify(session)).toBe(snapshot);
  session = reduceCoachingSession(plan, session, { type: "COMPLETE_SESSION" });
  expect(session.phase).toBe("COMPLETED");
  expect(renderToStaticMarkup(createElement(SessionWrapUpPanel, { ...props, phase: session.phase }))).toContain("已完成的复盘和回看不受影响");
  const { HostPlaybackControl, issueHostUserCommand } = await import("../playback/cs2d-playback-host");
  const commands: import("@cs-coach/contracts").PlaybackCommand[] = [];
  let takeover = false;
  issueHostUserCommand({ type: "seekCanonicalTick", canonicalTick: plan.cues[0].decision_tick }, { session, userTookOver: false, control: new HostPlaybackControl(), takeover: () => { takeover = true; }, send: command => commands.push(command) });
  expect(takeover).toBe(true);
  expect(commands).toEqual([{ type: "pause" }, { type: "seekCanonicalTick", canonicalTick: plan.cues[0].decision_tick }]);
  expect(session.phase).toBe("COMPLETED");
});

it("renders retained source qualifications with the completed summary", async () => {
  const { SessionWrapUpPanel } = await import("./session-wrap-up-presentation");
  const result: SessionWrapUpResult = { ...local, bundle: { ...local.bundle, themes: [{ focus: "verified", summary: { text: "已有问题", refs: ["cue"] }, trainingAdvice: { text: "已有建议", refs: ["advice"] } }], limitations: ["只在当时已确认的行动条件下适用。"] } };
  const html = renderToStaticMarkup(createElement(SessionWrapUpPanel, { status: "READY", result, phase: "COMPLETED", onComplete: () => {} }));
  expect(html).toContain("只在当时已确认的行动条件下适用。");
  expect(html).not.toContain("智能总结暂不可用");
});

it("restores an absent summary as unknown instead of no repeated theme", () => {
  expect(sessionWrapUpPresentation(null)).toMatchObject({ status: "FALLBACK", error: expect.stringContaining("未保存") });
});

it("retains the exact bounded source-limit failure when presenting saved results", () => {
  const result: SessionWrapUpResult = { ...local, status: "FALLBACK", manifest: { ...local.manifest, status: "FALLBACK", reason: "SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT" } };
  expect(sessionWrapUpPresentation(result).error).toContain("限定超过当前上限");
});
