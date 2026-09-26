import { describe, expect, it, vi } from "vitest";
import type { CueCase } from "@cs-coach/contracts";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createCoachingSession, reduceCoachingSession, getCurrentCue } from "@cs-coach/session";
import { createCoachAgentRuntime } from "@cs-coach/coach-agent";
import { baselineCueCase, reflectionForSkip, buildTeachingDiagnosisSubmissionEvent } from "./teaching-diagnosis-host";
import { skipReflectionToBaseline } from "./skip-reflection-flow";
import { HistoryPersistenceController } from "../review-history/history-persistence-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  const timeline = createSyntheticMirageTimeline(), plan = createFixtureReviewPlan(timeline);
  let session = createCoachingSession(plan, "skip-session");
  session = reduceCoachingSession(plan, session, { type: "START" });
  session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" });
  session = reduceCoachingSession(plan, session, { type: "TICK", tick: 2350 });
  session = reduceCoachingSession(plan, session, { type: "TICK", tick: getCurrentCue(plan, session)!.outcome_end_tick });
  expect(session.phase).toBe("PAUSED_FOR_COACHING");
  const cue = getCurrentCue(plan, session)!;
  const reflection = reflectionForSkip(cue.id);
  const baseline: CueCase = { ...baselineCueCase(cue, "本地跳过反思，基础讲解可用。"), reflection,
    attemptBudget: { reflection: 1, diagnostic: 0, disagreement: 0, alternateDiagnostic: 0 } };
  let current = true, owns = true;
  const order: string[] = [];
  const mirror = vi.fn(async () => { order.push("head"); });
  const input = {
    baseline,
    isCurrent: () => current && session.current_cue_id === cue.id && session.phase === "PAUSED_FOR_COACHING",
    ownsHistory: () => owns,
    publishLocal: vi.fn((cueCase: CueCase) => { order.push("local"); session = reduceCoachingSession(plan, session, { type: "RECORD_TEACHING_CASE", cueCase, reflection }); }),
    // Production reconciliation must replace the case without recording another user event.
    reconcile: vi.fn((cueCase: CueCase) => { order.push("reconcile"); session = { ...session, cue_cases: { ...session.cue_cases, [cue.id]: cueCase } }; }),
    persistInteraction: vi.fn(async () => { order.push("interaction"); return true; }),
    synchronize: vi.fn(async (): Promise<{ cueCase: CueCase; mirror: () => Promise<void> } | undefined> => { order.push("graph"); return { cueCase: { ...baseline, caseId: "graph-case" }, mirror }; }),
    persistCase: vi.fn(async (_cueCase: CueCase) => { order.push("case"); return true; }),
  };
  return { input, mirror, order, plan, cue, timeline, reflection, baseline,
    session: () => session, invalidate: () => { current = false; }, relinquishHistory: () => { owns = false; },
    advance: () => { session = reduceCoachingSession(plan, session, { type: "ADVANCE_SEGMENT" }); },
  };
}

describe("skip reflection local presentation and bounded background persistence", () => {
  it("keeps the local skip when Graph rejects it after an earlier answer consumed the attempt", async () => {
    const f = fixture(), runtime = createCoachAgentRuntime();
    const context = { plan: f.plan, cue: f.cue, timeline: f.timeline, selectedPlayerId: f.plan.player_id };
    const identity = { runId: "skip-race", sessionId: "skip-session", demoId: f.plan.demo_id, demoContentHash: "b".repeat(64),
      selectedPlayerId: f.plan.player_id, routeId: f.plan.id, routeHash: "synthetic-route" };
    await runtime.dispatch(buildTeachingDiagnosisSubmissionEvent(context, { ...f.reflection, response: "ANSWERED", selectedGoal: "OTHER" },
      { eventType: "SUBMIT_REFLECTION", eventId: "answer-first", identity }));
    f.input.synchronize.mockImplementation(async () => {
      const result = await runtime.dispatch(buildTeachingDiagnosisSubmissionEvent(context, f.reflection,
        { eventType: "SUBMIT_REFLECTION", eventId: "skip-after-answer", identity }));
      expect(result.state.fallbackReasons).toContain("DIAGNOSIS_ATTEMPT_EXHAUSTED");
      expect(result.state.cueCases[f.cue.id].reflection?.response).toBe("ANSWERED");
      return { cueCase: result.state.cueCases[f.cue.id], mirror: f.mirror };
    });
    expect(await skipReflectionToBaseline(f.input)).toBe("NO_AGENT_CHECKPOINT");
    expect(f.input.reconcile).not.toHaveBeenCalled();
    expect(f.input.persistCase).toHaveBeenCalledWith(f.baseline);
    expect(f.session().cue_cases?.[f.cue.id]?.reflection?.response).toBe("SKIPPED");
    expect(f.mirror).not.toHaveBeenCalled();
  });

  it("publishes and records SKIPPED synchronously before an interaction save settles, allowing immediate continuation", async () => {
    const f = fixture(), pending = deferred<boolean>();
    f.input.persistInteraction.mockImplementation(() => pending.promise);
    const work = skipReflectionToBaseline(f.input);
    expect(f.input.publishLocal).toHaveBeenCalledOnce();
    expect(f.session().cue_cases?.[f.cue.id]).toMatchObject({ status: "FALLBACK", attemptBudget: { reflection: 1 } });
    expect(f.session().user_events.filter(event => event.type === "REFLECTION_SKIPPED")).toHaveLength(1);
    expect(f.input.synchronize).not.toHaveBeenCalled();
    f.advance(); expect(f.session().current_segment_index).toBeGreaterThan(1);
    pending.resolve(true);
    expect(await work).toBe("NO_AGENT_CHECKPOINT");
    expect(f.input.synchronize).not.toHaveBeenCalled();
    expect(f.input.persistCase).toHaveBeenCalledWith(f.baseline);
    expect(f.mirror).not.toHaveBeenCalled();
  });

  it("keeps the local choice when Graph is pending and discards a late previous-cue result", async () => {
    const f = fixture(), pending = deferred<{ cueCase: CueCase; mirror: () => Promise<void> }>();
    f.input.synchronize.mockImplementation(() => pending.promise);
    const work = skipReflectionToBaseline(f.input);
    await Promise.resolve();
    expect(f.input.synchronize).toHaveBeenCalledOnce();
    expect(f.session().cue_cases?.[f.cue.id]?.status).toBe("FALLBACK");
    f.advance(); const nextIndex = f.session().current_segment_index;
    pending.resolve({ cueCase: { ...f.baseline, caseId: "late-graph-case" }, mirror: f.mirror });
    expect(await work).toBe("NO_AGENT_CHECKPOINT");
    expect(f.input.reconcile).not.toHaveBeenCalled();
    expect(f.session().current_segment_index).toBe(nextIndex);
    expect(f.input.persistCase).toHaveBeenCalledWith(f.baseline);
    expect(f.mirror).not.toHaveBeenCalled();
  });

  it("does not mirror an accepted Graph result after the cue changes during case persistence", async () => {
    const f = fixture(), pending = deferred<boolean>();
    f.input.persistCase.mockImplementation(() => pending.promise);
    const work = skipReflectionToBaseline(f.input);
    await vi.waitFor(() => expect(f.input.persistCase).toHaveBeenCalledOnce());
    expect(f.input.reconcile).toHaveBeenCalledOnce();
    expect(f.session().user_events.filter(event => event.type === "REFLECTION_SKIPPED")).toHaveLength(1);
    f.advance(); pending.resolve(true);
    expect(await work).toBe("MIRROR_FAILED");
    expect(f.mirror).not.toHaveBeenCalled();
  });

  it("does not write a case into a newly adopted history owner", async () => {
    const f = fixture(), pending = deferred<boolean>(), appendArtifact = vi.fn(async () => {});
    const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(), appendArtifact, commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
    history.adopt("old-review", "old-revision", "old-demo");
    const owner = history.ownershipGeneration;
    f.input.ownsHistory = () => history.ownershipGeneration === owner;
    f.input.persistInteraction.mockImplementation(() => pending.promise);
    f.input.persistCase.mockImplementation(async cueCase => { await history.artifact("CUE_CASE", cueCase.cueId, cueCase, "cue-case.v1"); return true; });
    const work = skipReflectionToBaseline(f.input);
    history.adopt("new-review", "new-revision", "new-demo"); f.invalidate(); pending.resolve(true);
    expect(await work).toBe("ARTIFACTS_INCOMPLETE");
    expect(f.input.persistCase).not.toHaveBeenCalled();
    expect(appendArtifact).not.toHaveBeenCalled();
    expect(f.mirror).not.toHaveBeenCalled();
  });

  it.each(["interaction", "case"] as const)("keeps local analysis but cannot promote a head after %s persistence returns false", async failed => {
    const f = fixture();
    if (failed === "interaction") f.input.persistInteraction.mockResolvedValue(false);
    else f.input.persistCase.mockResolvedValue(false);
    expect(await skipReflectionToBaseline(f.input)).toBe("ARTIFACTS_INCOMPLETE");
    expect(f.input.publishLocal).toHaveBeenCalledOnce();
    expect(f.input.persistCase).toHaveBeenCalledOnce();
    expect(f.mirror).not.toHaveBeenCalled();
  });

  it("does nothing for a stale initial request", async () => {
    const f = fixture(); f.invalidate();
    expect(await skipReflectionToBaseline(f.input)).toBe("NO_AGENT_CHECKPOINT");
    expect(f.input.publishLocal).not.toHaveBeenCalled();
    expect(f.input.persistInteraction).not.toHaveBeenCalled();
    expect(f.input.synchronize).not.toHaveBeenCalled();
  });

  it("accepts a real Graph SKIPPED result without another Session user event and saves the case before its head", async () => {
    const f = fixture(), runtime = createCoachAgentRuntime();
    const appendArtifact = vi.fn(async () => {});
    const history = new HistoryPersistenceController({ createReview: vi.fn(), startRevision: vi.fn(), appendArtifact, commitRuntimeHead: vi.fn(), markFailed: vi.fn() });
    history.adopt("review", "revision", "demo");
    f.input.persistCase.mockImplementation(async cueCase => {
      f.order.push("case");
      await history.artifact("CUE_CASE", cueCase.cueId, cueCase, "cue-case.v1", 1);
      return true;
    });
    const event = buildTeachingDiagnosisSubmissionEvent({ plan: f.plan, cue: f.cue, timeline: f.timeline, selectedPlayerId: f.plan.player_id }, f.reflection,
      { eventType: "SUBMIT_REFLECTION", eventId: "skip-real-graph", identity: { runId: "skip-run", sessionId: "skip-session", demoId: f.plan.demo_id,
        demoContentHash: "b".repeat(64), selectedPlayerId: f.plan.player_id, routeId: f.plan.id, routeHash: "synthetic-route" } });
    f.input.synchronize.mockImplementation(async () => {
      f.order.push("graph");
      const result = await runtime.dispatch(event);
      expect(result.state.learningThreads).toEqual([]);
      const cueCase = result.state.cueCases[f.cue.id];
      expect(cueCase).toMatchObject({ status: "FALLBACK", reflection: { response: "SKIPPED" }, attemptBudget: { reflection: 1, diagnostic: 0 } });
      return { cueCase, mirror: f.mirror };
    });
    expect(await skipReflectionToBaseline(f.input)).toBe("COMMITTED");
    expect(f.order).toEqual(["local", "interaction", "graph", "reconcile", "case", "head"]);
    expect(appendArtifact).toHaveBeenCalledExactlyOnceWith("review", expect.objectContaining({
      artifactType: "CUE_CASE", artifactKey: f.cue.id, artifactRevision: 1,
      idempotencyKey: `revision:CUE_CASE:${f.cue.id}:v1`,
      payload: expect.objectContaining({ reflection: expect.objectContaining({ response: "SKIPPED" }) }),
    }));
    expect(f.mirror).toHaveBeenCalledOnce();
    expect(f.session().user_events.filter(item => item.type === "REFLECTION_SKIPPED")).toHaveLength(1);
    expect(f.session().user_events.some(item => item.type === "DIAGNOSTIC_COMPLETED")).toBe(false);
    f.advance(); expect(f.session().phase).not.toBe("PAUSED_FOR_COACHING");
  });
});
