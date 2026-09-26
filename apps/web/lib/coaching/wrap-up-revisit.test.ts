import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import type { PlaybackCommand } from "@cs-coach/contracts";
import type { SessionWrapUpResult } from "@cs-coach/coach-agent/client";
import { completedReviewTargets, SessionWrapUpPanel } from "./session-wrap-up-presentation";
import { HostPlaybackControl, issueHostUserCommand } from "../playback/cs2d-playback-host";

const empty: SessionWrapUpResult = { status: "DISABLED", bundle: { schemaVersion: "coach-agent-session-wrap-up.v1", themes: [], limitations: [] },
  manifest: { status: "DISABLED", provider: "DETERMINISTIC", reason: "NO_REPEATED_THEME", limitations: [] } };
function completed() {
  // Synthetic timeline coordinates exercise Session behavior, not parsed Demo ticks.
  const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  for (let step = 0; step < plan.segments.length * 6 && session.phase !== "WRAP_UP"; step++) {
    const segment = plan.segments[session.current_segment_index];
    if (session.phase === "PAUSED_FOR_COACHING") {
      session = reduceCoachingSession(plan, session, { type: "CUE_PRESENTED", cueId: session.current_cue_id! });
      session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
    } else session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" } : { type: "TICK", tick: segment.end_tick });
  }
  expect(session.phase).toBe("WRAP_UP");
  return { plan, session };
}
function clickFirstRevisit(node: ReactNode): boolean {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void; disabled?: boolean }>(child)) continue;
    if (child.type === "button" && Children.toArray(child.props.children).includes("回看第 ")) {
      expect(child.props.disabled).toBe(false); child.props.onClick!(); return true;
    }
    if (clickFirstRevisit(child.props.children)) return true;
  }
  return false;
}
it.each(["WRAP_UP", "COMPLETED"] as const)("revisits an actually presented cue from %s without changing its finished progress", phase => {
  const { plan, session: finished } = completed();
  const session = phase === "COMPLETED" ? reduceCoachingSession(plan, finished, { type: "COMPLETE_SESSION" }) : finished;
  const targets = completedReviewTargets(plan, session);
  expect(targets.length).toBeGreaterThan(0);
  const snapshot = JSON.stringify(session), commands: PlaybackCommand[] = [];
  const takeover = vi.fn(), complete = vi.fn();
  const onReviewCue = vi.fn((cueId: string) => {
    const target = completedReviewTargets(plan, session).find(item => item.cueId === cueId)!;
    issueHostUserCommand({ type: "seekCanonicalTick", canonicalTick: target.tick }, {
      session, userTookOver: false, control: new HostPlaybackControl(), takeover, send: command => commands.push(command),
    });
  });
  const props = { status: "FALLBACK", result: empty, plan, session, phase, onComplete: complete, onReviewCue, playbackAvailable: true };
  const html = renderToStaticMarkup(createElement(SessionWrapUpPanel, props));
  expect(html).toContain("暂不归纳为习惯"); expect(html).toContain("按播放继续观看");
  expect(html).not.toContain("训练建议");
  expect(clickFirstRevisit(SessionWrapUpPanel(props))).toBe(true);
  expect(onReviewCue).toHaveBeenCalledOnce(); expect(takeover).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
  expect(commands).toEqual([{ type: "pause" }, { type: "seekCanonicalTick", canonicalTick: targets[0].tick }]);
  expect(JSON.stringify(session)).toBe(snapshot);
  expect(renderToStaticMarkup(createElement(SessionWrapUpPanel, { ...props, session: JSON.parse(snapshot) }))).toContain("回看已完成片段");
});
it("only offers the intersection of presented and consumed cues in the same terminal plan", () => {
  const { plan, session } = completed();
  const cue = completedReviewTargets(plan, session)[0];
  expect(completedReviewTargets(plan, { ...session, review_plan_id: "other" })).toEqual([]);
  expect(completedReviewTargets(plan, { ...session, phase: "PLAYING" })).toEqual([]);
  expect(completedReviewTargets(plan, { ...session, presented_cue_ids: [] })).toEqual([]);
  expect(completedReviewTargets(plan, { ...session, consumed_cue_ids: [] })).toEqual([]);
  const subset = { ...session, consumed_cue_ids: [cue.cueId, "unknown"], presented_cue_ids: [cue.cueId, "unknown"] };
  expect(completedReviewTargets(plan, subset)).toEqual([cue]);
  expect(completedReviewTargets({ ...plan, segments: [] }, subset)).toEqual([]);
});
it("keeps saved summary visible while playback is unavailable and exposes disabled native controls", () => {
  const { plan, session } = completed();
  const html = renderToStaticMarkup(createElement(SessionWrapUpPanel, { status: "FALLBACK", result: empty, plan, session,
    phase: session.phase, onComplete: () => {}, onReviewCue: () => {}, playbackAvailable: false }));
  expect(html).toContain("已保存的总结不受影响"); expect(html).toContain('disabled=""');
  expect(html).toContain("完成本次复盘");
});

it("does not interrupt an in-flight summary with a new revisit", () => {
  const { plan, session } = completed();
  for (const status of ["IDLE", "LOADING"]) {
    const html = renderToStaticMarkup(createElement(SessionWrapUpPanel, { status, result: empty, plan, session,
      phase: session.phase, onComplete: () => {}, onReviewCue: () => {}, playbackAvailable: true }));
    expect(html).toContain("正在整理总结，完成后可选择片段回看");
    expect(html.match(/disabled=""/g)).toHaveLength(completedReviewTargets(plan, session).length);
  }
});
