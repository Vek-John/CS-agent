import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import type { CoachAgentResult, SessionWrapUpResult } from "@cs-coach/coach-agent/client";
import { CoachAgentStage3Controller } from "./coach-agent-stage3-controller";
import { CoachAgentStage3HostAdapter, type Stage3IdentityInput } from "./coach-agent-stage3-host-adapter";
import { completeStage3SessionWrapUp } from "./session-wrap-up-completion";
import { SessionWrapUpPanel, sessionWrapUpPresentation, isSessionWrapUpIdentityCurrent } from "./session-wrap-up-presentation";
import { HistoryPersistenceController } from "../review-history/history-persistence-controller";

function fixture(dispatch: ConstructorParameters<typeof CoachAgentStage3Controller>[0]["dispatch"]) {
  const timeline = createSyntheticMirageTimeline(); const base = createFixtureReviewPlan(timeline);
  const plan = { ...base, status: "COMPLETE" as const, cues: base.cues.map(cue => ({ ...cue, primary_focus_code: cue.primary_focus_code ?? "SURVIVE_THE_NEXT_CONTACT" })) };
  const identity = { plan, routeState: { routeFingerprint: "route-hash" },
    analysis: { demo_id: plan.demo_id, selected_steam_id: plan.player_id },
    demoContentHash: "a".repeat(64), selectedPlayerId: plan.player_id, sessionId: "session", runId: "run" } as Stage3IdentityInput;
  const adapter = new CoachAgentStage3HostAdapter(); const onAgentResult = vi.fn();
  const controller = new CoachAgentStage3Controller({ adapter, dispatch, post: vi.fn(), bridgeAvailable: () => true, isLive: () => true, onAgentResult });
  const appendArtifact = vi.fn().mockResolvedValue(undefined);
  const persistence = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(), appendArtifact, commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
  persistence.adopt("review", "revision", "demo");
  let result: SessionWrapUpResult | undefined; let claimed = false; let status = "IDLE";
  const live = { generation: 1, runId: "run" as string | undefined, session: { id: "session", phase: "WRAP_UP" as "WRAP_UP" | "COMPLETED" }, epoch: 1, takeover: false };
  const input = { controller, identity, persistence, isCurrent: () => live.generation === 1 && !live.takeover && live.epoch === 1
      && isSessionWrapUpIdentityCurrent({ identity }, live.session, live.runId)
      && persistence.reviewId === "review" && persistence.revisionId === "revision",
    claim: vi.fn(() => claimed ? false : (claimed = true)), onStart: vi.fn(() => { status = "LOADING"; }), onRequest: vi.fn(), onSaveError: vi.fn(),
    buildInput: vi.fn((agent: CoachAgentResult) => agent.state.sessionSummaryInput ? { summary: agent.state.sessionSummaryInput, presentableCues: {} } : null),
    onResult: vi.fn((value: SessionWrapUpResult) => { result = value; status = sessionWrapUpPresentation(value).status; }),
  };
  const render = () => renderToStaticMarkup(createElement(SessionWrapUpPanel, { plan, result, phase: "WRAP_UP", status, error: result ? sessionWrapUpPresentation(result).error : undefined, onComplete: () => {} }));
  return { input, controller, adapter, plan, timeline, live, onAgentResult, appendArtifact, render, result: () => result };
}

it("publishes and saves an explicit failure from the production Controller through the actual Host completion entry", async () => {
  const dispatch = vi.fn().mockRejectedValue(new Error("private transport failure"));
  const f = fixture(dispatch);
  await completeStage3SessionWrapUp(f.input);
  expect(f.render()).toContain("未生成全场总结");
  expect(f.render()).toContain("完成本次复盘");
  expect(f.render()).not.toContain("没有足够重复");
  expect(f.result()?.manifest.reason).toBe("MISSING_SESSION_SUMMARY");
  expect(f.appendArtifact).toHaveBeenCalledOnce();
  expect(f.onAgentResult).not.toHaveBeenCalled();
  expect(f.input.buildInput).not.toHaveBeenCalled();
  expect(JSON.stringify(f.appendArtifact.mock.calls)).not.toContain("private transport failure");
  await completeStage3SessionWrapUp(f.input);
  expect(dispatch).toHaveBeenCalledOnce(); expect(f.appendArtifact).toHaveBeenCalledOnce();
});

function completed(identity: CoachAgentResult["identity"]): CoachAgentResult {
  return { identity, status: "COMPLETED", state: { sessionStatus: "COMPLETED", sessionSummaryInput: {
    schemaVersion: "coach-agent-session-summary.v1", themes: [], completedCues: [], limitations: [],
  } }, effects: [] } as unknown as CoachAgentResult;
}
function deferred() {
  let resolve!: (value: CoachAgentResult) => void; let reject!: (error: Error) => void;
  const promise = new Promise<CoachAgentResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("keeps pending completion quiet and handles its eventual failure only once", async () => {
  const pending = deferred(); const dispatch = vi.fn(() => pending.promise); const f = fixture(dispatch);
  const first = completeStage3SessionWrapUp(f.input);
  await completeStage3SessionWrapUp(f.input);
  expect(f.input.onResult).not.toHaveBeenCalled(); expect(f.appendArtifact).not.toHaveBeenCalled();
  expect(f.render()).not.toContain("未生成");
  expect(f.render()).toContain("正在整理"); expect(f.render()).toContain("完成本次复盘");
  expect(f.input.onStart).toHaveBeenCalledOnce();
  pending.reject(new Error("offline")); await first;
  await completeStage3SessionWrapUp(f.input);
  expect(dispatch).toHaveBeenCalledOnce(); expect(f.input.onResult).toHaveBeenCalledOnce(); expect(f.appendArtifact).toHaveBeenCalledOnce();
});

it("does not overwrite a successful result or issue another request after CONFIRMED", async () => {
  const dispatch = vi.fn(async event => completed(event.identity)); const f = fixture(dispatch);
  await completeStage3SessionWrapUp(f.input);
  const saved = f.result();
  expect(saved?.manifest.reason).not.toBe("MISSING_SESSION_SUMMARY");
  expect(f.adapter.lifecycleEventStatus("stage3-complete-run")).toBe("CONFIRMED");
  await completeStage3SessionWrapUp(f.input);
  expect(f.result()).toBe(saved); expect(dispatch).toHaveBeenCalledOnce(); expect(f.appendArtifact).toHaveBeenCalledOnce();
  expect(f.onAgentResult).toHaveBeenCalledOnce(); expect(f.input.buildInput).toHaveBeenCalledOnce();
  const already = fixture(dispatch);
  already.adapter.beginLifecycleEvent("stage3-complete-run"); already.adapter.confirmLifecycleEvent("stage3-complete-run");
  await completeStage3SessionWrapUp(already.input);
  expect(already.input.onResult).not.toHaveBeenCalled(); expect(already.input.onStart).not.toHaveBeenCalled(); expect(dispatch).toHaveBeenCalledOnce();
});

it.each(["DORMANT", "WAITING_TOOL", "USER_TAKEOVER", "CUE_COMPLETED", "ACTIVE_SESSION", "NO_RESPONSE"])("reports current uncompleted response %s without inventing Graph completion", async status => {
  const f = fixture(async event => status === "NO_RESPONSE" ? undefined as unknown as CoachAgentResult : {
    ...completed(event.identity), ...(status === "ACTIVE_SESSION" ? { state: { ...completed(event.identity).state, sessionStatus: "ACTIVE" as const } } : { status: status as CoachAgentResult["status"] }),
  });
  await completeStage3SessionWrapUp(f.input);
  expect(f.render()).toContain("未生成全场总结"); expect(f.input.buildInput).not.toHaveBeenCalled();
  expect(f.onAgentResult).not.toHaveBeenCalled();
  expect(f.adapter.lifecycleEventStatus("stage3-complete-run")).toBe("NONE");
});

it.each(["sessionId", "runId", "routeId", "routeHash", "selectedPlayerId", "demoContentHash"] as const)("rejects current mismatched %s as a bounded failure without publishing that payload", async key => {
  const f = fixture(async event => completed({ ...event.identity, [key]: "wrong" }));
  await completeStage3SessionWrapUp(f.input);
  expect(f.render()).toContain("未生成全场总结");
  expect(f.render()).not.toContain("正在整理");
  expect(f.result()?.manifest.reason).toBe("MISSING_SESSION_SUMMARY");
  expect(f.appendArtifact).toHaveBeenCalledOnce(); expect(f.onAgentResult).not.toHaveBeenCalled();
  expect(f.input.buildInput).not.toHaveBeenCalled(); expect(JSON.stringify(f.appendArtifact.mock.calls)).not.toContain("wrong");
});

it.each(["generation", "session", "run", "review", "revision", "history-epoch", "takeover", "reset", "dispose"])("discards pending failure after %s changes", async kind => {
  const pending = deferred(); const f = fixture(() => pending.promise);
  const first = completeStage3SessionWrapUp(f.input);
  await Promise.resolve();
  if (kind === "generation") f.live.generation++;
  if (kind === "session") f.live.session.id = "other";
  if (kind === "run") f.live.runId = "other";
  if (kind === "review") f.input.persistence.adopt("other", "revision", "demo");
  if (kind === "revision") f.input.persistence.adopt("review", "other", "demo");
  if (kind === "history-epoch") f.live.epoch++;
  if (kind === "takeover") f.live.takeover = true;
  if (kind === "reset") f.controller.reset();
  if (kind === "dispose") f.controller.dispose();
  pending.reject(new Error("late private failure")); await first;
  expect(f.input.onResult).not.toHaveBeenCalled(); expect(f.appendArtifact).not.toHaveBeenCalled(); expect(f.input.onSaveError).not.toHaveBeenCalled();
});

it("can finish normally before a pending failure arrives, even when persistence is unavailable", async () => {
  const pending = deferred(); const f = fixture(() => pending.promise);
  const first = completeStage3SessionWrapUp({ ...f.input, persistence: undefined });
  f.live.session.phase = "COMPLETED"; f.live.runId = undefined;
  pending.reject(new Error("offline")); await first;
  expect(f.render()).toContain("未生成全场总结"); expect(f.appendArtifact).not.toHaveBeenCalled();
});

it.each(["ANSWERED", "SKIPPED"] as const)("finishes default diagnostics using the local fallback after Agent synchronization fails (%s)", async response => {
  const { createCoachingSession, reduceCoachingSession } = await import("@cs-coach/session");
  const { runTeachingDiagnosis, reflectionForSkip } = await import("./teaching-diagnosis-host");
  const { buildInitialCoachingRouteState } = await import("./cs2d-route-integration");
  const dispatch = vi.fn().mockRejectedValue(new Error("Agent unavailable")); const f = fixture(dispatch);
  const routeState = { ...buildInitialCoachingRouteState(f.plan), routeFrozen: true, routeFingerprint: "route-hash", readiness: Object.fromEntries(f.plan.cues.map(cue => [cue.id, "READY" as const])), cueOrder: f.plan.cues.map(cue => cue.id) };
  let session = reduceCoachingSession(f.plan, createCoachingSession(f.plan, "session"), { type: "START" });
  let fallbackCount = 0;
  for (let step = 0; step < f.plan.segments.length * 6 && session.phase !== "WRAP_UP"; step++) {
    const segment = f.plan.segments[session.current_segment_index];
    const cue = f.plan.cues.find(c => segment.cue_ids.includes(c.id));
    if (session.phase === "PAUSED_FOR_COACHING" && cue) {
      const sync = await f.controller.synchronizeDiagnosis({ ...f.input.identity, routeState, cue,
        narration: { cueId: cue.id, candidateId: cue.candidate_id ?? "candidate", primaryFocusCode: cue.primary_focus_code ?? "SURVIVE_THE_NEXT_CONTACT",
          currentSituation: { text: "情况", refs: [] }, playerAction: { text: "动作", refs: [] }, coreIssue: { text: "问题", refs: [] }, betterPlay: { text: "建议", refs: [] }, outcomeImpact: { text: "结果", refs: [] } },
        evidence: {}, generation: 1, tickRate: 64, currentSessionPhase: "PAUSED_FOR_COACHING", outcomeGate: session.outcome_completion!,
      }).catch(error => { expect(error.message).toBe("Agent unavailable"); return undefined; });
      expect(sync).toBeUndefined();
      const reflection = response === "SKIPPED" ? reflectionForSkip(cue.id) : { cueId: cue.id, selectedGoal: "OTHER" as const, response, source: "USER" as const, limitations: [] };
      const local = runTeachingDiagnosis({ plan: f.plan, cue, timeline: f.timeline, selectedPlayerId: f.plan.player_id }, reflection);
      fallbackCount++;
      session = reduceCoachingSession(f.plan, session, { type: "RECORD_TEACHING_CASE", cueCase: local.cueCase, learningThread: local.learningThread, reflection });
      session = reduceCoachingSession(f.plan, session, { type: "ADVANCE_SEGMENT" });
    } else session = reduceCoachingSession(f.plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" } : { type: "TICK", tick: segment.end_tick });
  }
  expect(fallbackCount).toBe(f.plan.cues.length); expect(session.phase).toBe("WRAP_UP");
  expect(session.user_events.some(event => event.type === (response === "SKIPPED" ? "REFLECTION_SKIPPED" : "REFLECTION_SUBMITTED"))).toBe(true);
  expect(dispatch.mock.calls.some(([event]) => event.type === "START_CUE" || event.type === "OBSERVE_SEGMENT")).toBe(true);
  await completeStage3SessionWrapUp(f.input);
  expect(f.render()).toContain("未生成全场总结"); expect(f.render()).toContain("完成本次复盘");
  session = reduceCoachingSession(f.plan, session, { type: "COMPLETE_SESSION" });
  expect(session.phase).toBe("COMPLETED");
  const { HostPlaybackControl, issueHostUserCommand } = await import("../playback/cs2d-playback-host");
  const send = vi.fn();
  issueHostUserCommand({ type: "seekCanonicalTick", canonicalTick: f.plan.cues[0].decision_tick }, { session, userTookOver: false, control: new HostPlaybackControl(), takeover: vi.fn(), send });
  expect(send).toHaveBeenCalledWith({ type: "seekCanonicalTick", canonicalTick: f.plan.cues[0].decision_tick });
  expect(dispatch.mock.calls.filter(([event]) => event.type === "COMPLETE_SESSION")).toHaveLength(1);
});

it("releases a cancelled owner for explicit same-run return without letting its late cleanup erase the new pending request", async () => {
  const old = deferred(); const next = deferred(); let completions = 0;
  const f = fixture(event => event.type === "USER_TAKEOVER"
    ? Promise.resolve({ ...completed(event.identity), status: "USER_TAKEOVER" })
    : (++completions === 1 ? old.promise : next.promise));
  const first = completeStage3SessionWrapUp(f.input); await Promise.resolve();
  f.live.takeover = true;
  const takeover = f.controller.takeoverIdentity(f.input.identity);
  // The new owner can be reserved before the old network call finishes.
  f.live.takeover = false;
  const second = completeStage3SessionWrapUp(f.input);
  old.reject(new Error("cancelled old transport")); await first;
  expect(f.adapter.lifecycleEventStatus("stage3-complete-run")).toBe("PENDING");
  expect(f.render()).toContain("正在整理");
  expect(f.input.onResult).not.toHaveBeenCalled();
  expect(await takeover).toBe(true);
  next.reject(new Error("current transport failed")); await second;
  expect(f.render()).toContain("未生成全场总结"); expect(f.appendArtifact).toHaveBeenCalledOnce();
  await completeStage3SessionWrapUp(f.input); // settled failure cannot auto-retry
  expect(completions).toBe(2);
});

it("can explicitly return to the same run after takeover cancels completion", async () => {
  const old = deferred(); let completions = 0;
  const f = fixture(event => event.type === "USER_TAKEOVER" ? Promise.resolve({ ...completed(event.identity), status: "USER_TAKEOVER" })
    : ++completions === 1 ? old.promise : Promise.reject(new Error("current failure")));
  const first = completeStage3SessionWrapUp(f.input); await Promise.resolve();
  f.live.takeover = true;
  const takeover = f.controller.takeoverIdentity(f.input.identity);
  old.reject(new Error("cancelled")); await first; expect(await takeover).toBe(true);
  const resumed = await f.controller.resumeAfterTakeover({ ...f.input.identity, cue: f.plan.cues[0] } as import("./coach-agent-stage3-host-adapter").Stage3HostAdapterInput);
  expect(resumed).toBe(true);
  f.live.takeover = false;
  await completeStage3SessionWrapUp(f.input);
  expect(f.render()).toContain("未生成全场总结"); expect(f.appendArtifact).toHaveBeenCalledOnce();
  expect(completions).toBe(2);
});
