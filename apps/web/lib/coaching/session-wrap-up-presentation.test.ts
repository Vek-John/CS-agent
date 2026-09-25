import { createElement } from "react";
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoachAgentResult, SessionWrapUpResult } from "@cs-coach/coach-agent/client";
import { canPublishSessionWrapUp, sessionWrapUpPresentation, SessionWrapUpNotice } from "./session-wrap-up-presentation";

const local: SessionWrapUpResult = { status: "DISABLED", bundle: { schemaVersion: "coach-agent-session-wrap-up.v1", themes: [], limitations: [] }, manifest: { status: "DISABLED", provider: "DETERMINISTIC", reason: "CLOSED_SESSION_PROJECTION", limitations: [] } };
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
  const error = sessionWrapUpFailureMessage(failed);
  const props = { status: "FALLBACK", plan, phase: session.phase, error, onComplete: () => {} };
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
