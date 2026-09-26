import { describe, expect, it, vi } from "vitest";
import type { CoachCue, CoachingRouteState, CueCase } from "@cs-coach/contracts";
import type { CoachAgentEvent } from "@cs-coach/coach-agent/client";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { createCoachAgentRuntime } from "@cs-coach/coach-agent";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { CoachAgentStage3Controller } from "./coach-agent-stage3-controller";
import { CoachAgentStage3HostAdapter, type Stage3HostAdapterInput } from "./coach-agent-stage3-host-adapter";
import { baselineCueCase, reflectionForSkip, buildTeachingDiagnosisSubmissionEvent } from "./teaching-diagnosis-host";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  // Synthetic frames and two different signal kinds survive the real Director's
  // uncertainty deduplication. Do not rewrite Compiler focus or route windows.
  const source = fireReplay("DEATH"), secondSource = fireReplay("HP_CHANGE").rounds[0];
  const round2 = { ...secondSource, number: 2, freezeStartTick: secondSource.freezeStartTick + 2000,
    startTick: secondSource.startTick + 2000, decidedTick: secondSource.decidedTick + 2000,
    endTick: secondSource.endTick + 2000, postEndTick: secondSource.postEndTick! + 2000,
    frames: secondSource.frames.map(frame => ({ ...frame, tick: frame.tick + 2000 })),
    events: secondSource.events.map(event => ({ ...event, tick: event.tick + 2000 })) };
  const bundle = buildCs2dAnalysisBundle({ replay: { ...source, rounds: [source.rounds[0], round2] }, selectedSteamId: self, demoId: "synthetic-continuity" });
  const plan = bundle.review_plan;
  expect(plan.cues).toHaveLength(2);
  const routeState: CoachingRouteState = {
    routeFrozen: true, routeFingerprint: "synthetic-route", candidateSetId: bundle.candidate_set.id, candidateSetHash: bundle.candidate_set.hash,
    selectedCueCount: 2, readiness: Object.fromEntries(plan.cues.map(cue => [cue.id, "READY" as const])), cueOrder: plan.cues.map(cue => cue.id),
    cueBindings: Object.fromEntries(plan.cues.map(cue => [cue.id, { candidateId: cue.candidate_id!, primaryFocusCode: cue.primary_focus_code! }])),
    startable: true, consumedCueIds: [], frozenCueIds: plan.cues.map(cue => cue.id),
  };
  const input = (cue: CoachCue): Stage3HostAdapterInput => {
    const outcomeImpact = bundle.outcome_impacts.find(impact => impact.cueId === cue.id);
    return { plan, routeState, cue, narration: deterministicNarrationBundle(buildCoachingPackage(cue, bundle.candidate_set, bundle.observation_evidence), buildOutcomePackage(cue, bundle.candidate_set, outcomeImpact)),
      analysis: bundle, demoContentHash: "b".repeat(64), selectedPlayerId: self, sessionId: "session-continuity", runId: "run-continuity", generation: 1, tickRate: 64,
      outcomeGate: { cueId: cue.id, outcomeEndTick: cue.outcome_end_tick, status: "COMPLETE", completedAtTick: cue.outcome_end_tick }, currentSessionPhase: "PAUSED_FOR_COACHING",
      evidence: { candidate: bundle.candidate_set.candidates.find(candidate => candidate.candidateId === cue.candidate_id), material: bundle.candidate_set.materials.find(material => material.candidateId === cue.candidate_id), outcomeImpact } };
  };
  const first = input(plan.cues[0]), second = input(plan.cues[1]);
  const skipped: CueCase = { ...baselineCueCase(first.cue, "已显示基础讲解"), reflection: reflectionForSkip(first.cue.id), attemptBudget: { reflection: 1, diagnostic: 0, disagreement: 0, alternateDiagnostic: 0 } };
  const runtime = createCoachAgentRuntime(), adapter = new CoachAgentStage3HostAdapter();
  let liveCueId = first.cue.id;
  const dispatch = vi.fn((event: CoachAgentEvent) => runtime.dispatch(event));
  const post = vi.fn(), mirror = vi.fn();
  const controller = new CoachAgentStage3Controller({ adapter, dispatch: event => dispatch(event), post, bridgeAvailable: () => true,
    isLive: candidate => candidate.cue.id === liveCueId, onAgentResult: mirror });
  return { first, second, skipped, runtime, adapter, dispatch, post, mirror, controller,
    showSecond: () => { liveCueId = second.cue.id; }, firstIndex: plan.segments.findIndex(segment => segment.id === first.cue.segment_id),
    secondIndex: plan.segments.findIndex(segment => segment.id === second.cue.segment_id) };
}

describe("skipped baseline lifecycle continuity through real Controller and Graph", () => {
  it("remains conservatively degraded when the preceding cue has no presentation credential", async () => {
    const f = fixture();
    try {
      f.showSecond();
      expect(await f.controller.synchronizeDiagnosis(f.second)).toBeUndefined();
      expect(await f.controller.synchronizeDiagnosis(f.second)).toBeUndefined();
      expect(f.adapter.lifecycleDegraded).toBe(true);
      expect(f.dispatch.mock.calls.some(([event]) => event.type === "START_CUE")).toBe(false);
      expect(f.post).not.toHaveBeenCalled();
    } finally { f.controller.dispose(); }
  });

  it("backfills an actually presented skip after UI advances, with no tool, old-head mirror or duplicate count", async () => {
    const f = fixture();
    try {
      expect(f.controller.recordPresentedBaseline(f.first, f.skipped)).toBe(true);
      expect(f.controller.recordPresentedBaseline(f.first, f.skipped)).toBe(true);
      expect(f.dispatch).not.toHaveBeenCalled();
      f.showSecond();
      const result = await f.controller.synchronizeDiagnosis(f.second);
      expect(result?.state.activeCueId).toBe(f.second.cue.id);
      expect(result?.state.routeCursor).toBe(f.secondIndex);
      expect(result?.effects).toEqual([]); expect(result?.state.pendingToolCall).toBeNull();
      expect(result?.state.completedCueIds.filter(id => id === f.first.cue.id)).toHaveLength(1);
      expect(result?.state.presentedCueBindings.filter(item => item.cueId === f.first.cue.id)).toHaveLength(1);
      const starts = f.dispatch.mock.calls.map(([event]) => event).filter(event => event.type === "START_CUE");
      expect(starts.map(event => event.routeSegmentIndex)).toEqual([f.firstIndex, f.secondIndex]);
      expect(starts.every(event => event.capabilities.length === 0)).toBe(true);
      expect(f.mirror.mock.calls.some(([event]) => event.type === "START_CUE" && event.cueId === f.first.cue.id)).toBe(false);
      expect(f.post).not.toHaveBeenCalled();
      const duplicate = await f.runtime.dispatch(starts[0]);
      expect(duplicate.state.routeCursor).toBe(f.secondIndex);
      expect(duplicate.state.completedCueIds).toEqual(result!.state.completedCueIds);
      const repeated = await f.controller.synchronizeDiagnosis(f.second);
      expect(repeated?.state.completedCueIds).toEqual(result!.state.completedCueIds);
      expect(f.dispatch.mock.calls.filter(([event]) => event.type === "START_CUE" && event.cueId === f.first.cue.id)).toHaveLength(1);
      const diagnosis = await f.runtime.dispatch(buildTeachingDiagnosisSubmissionEvent({
        plan: f.second.plan, cue: f.second.cue, material: f.second.evidence.material, selectedPlayerId: self,
      }, { cueId: f.second.cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] }, {
        eventType: "SUBMIT_REFLECTION", eventId: "second-cue-reflection", identity: result!.identity,
      }));
      expect(diagnosis.state.cueCases[f.second.cue.id]).toMatchObject({ reflection: { response: "ANSWERED" },
        attemptBudget: { reflection: 1, diagnostic: 1 } });
      expect(diagnosis.state.cueCases[f.second.cue.id].diagnosticResult).toBeDefined();
    } finally { f.controller.dispose(); }
  });

  it.each(["not-live", "incomplete-gate", "wrong-candidate", "not-skipped"] as const)("refuses an unproven baseline registration: %s", mode => {
    const f = fixture();
    try {
      if (mode === "not-live") f.showSecond();
      const input = mode === "incomplete-gate" ? { ...f.first, outcomeGate: { ...f.first.outcomeGate, completedAtTick: f.first.cue.outcome_end_tick - 1 } } : f.first;
      const skipped = mode === "wrong-candidate" ? { ...f.skipped, candidateId: "other" }
        : mode === "not-skipped" ? { ...f.skipped, reflection: { ...f.skipped.reflection!, response: "ANSWERED" as const } } : f.skipped;
      expect(f.controller.recordPresentedBaseline(input, skipped)).toBe(false);
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally { f.controller.dispose(); }
  });

  it.each(["run", "session", "route"] as const)("cannot consume a credential under another %s identity", async kind => {
    const f = fixture();
    try {
      expect(f.controller.recordPresentedBaseline(f.first, f.skipped)).toBe(true); f.showSecond();
      const input = kind === "run" ? { ...f.second, runId: "other-run" } : kind === "session" ? { ...f.second, sessionId: "other-session" }
        : { ...f.second, routeState: { ...f.second.routeState, routeFingerprint: "other-route" } };
      expect(await f.controller.synchronizeDiagnosis(input)).toBeUndefined();
      expect(f.adapter.lifecycleDegraded).toBe(true);
      expect(f.dispatch.mock.calls.some(([event]) => event.type === "START_CUE")).toBe(false);
    } finally { f.controller.dispose(); }
  });

  it("clears registered baselines on reset", async () => {
    const f = fixture();
    try {
      expect(f.controller.recordPresentedBaseline(f.first, f.skipped)).toBe(true);
      f.controller.reset(); f.showSecond();
      expect(await f.controller.synchronizeDiagnosis(f.second)).toBeUndefined();
      expect(f.adapter.lifecycleDegraded).toBe(true);
      expect(f.dispatch.mock.calls.some(([event]) => event.type === "START_CUE")).toBe(false);
    } finally { f.controller.dispose(); }
  });

  it("does not mark a baseline synchronized when Graph acknowledges the wrong cursor", async () => {
    const f = fixture();
    try {
      f.dispatch.mockImplementation(async event => {
        const result = await f.runtime.dispatch(event);
        return event.type === "START_CUE" && event.cueId === f.first.cue.id
          ? { ...result, state: { ...result.state, routeCursor: f.secondIndex } } : result;
      });
      expect(f.controller.recordPresentedBaseline(f.first, f.skipped)).toBe(true); f.showSecond();
      expect(await f.controller.synchronizeDiagnosis(f.second)).toBeUndefined();
      expect(f.adapter.lifecycleCursor).toBeLessThan(f.firstIndex);
      expect(f.adapter.lifecycleDegraded).toBe(true);
      expect(f.dispatch.mock.calls.some(([event]) => event.type === "START_CUE" && event.cueId === f.second.cue.id)).toBe(false);
      expect(f.post).not.toHaveBeenCalled();
    } finally { f.controller.dispose(); }
  });

  it("serializes a pending segment observation before the next cue and its baseline backfill", async () => {
    const f = fixture(), gate = deferred();
    try {
      f.dispatch.mockImplementation(async event => { if (event.type === "OBSERVE_SEGMENT" && event.segmentIndex === 0) await gate.promise; return f.runtime.dispatch(event); });
      expect(f.controller.recordPresentedBaseline(f.first, f.skipped)).toBe(true);
      const nextSegment = f.first.plan.segments[f.firstIndex + 1];
      f.controller.observeSegment(f.first, nextSegment.id, f.firstIndex + 1, "BRIEF", "PLAYING");
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledOnce());
      f.showSecond(); const pending = f.controller.synchronizeDiagnosis(f.second);
      await Promise.resolve(); expect(f.dispatch).toHaveBeenCalledOnce();
      gate.resolve();
      const result = await pending;
      expect(result?.state.activeCueId).toBe(f.second.cue.id);
      expect(f.adapter.lifecycleDegraded).toBe(false);
      const indices = f.dispatch.mock.calls.map(([event]) => event.type === "START_CUE" ? event.routeSegmentIndex : event.type === "OBSERVE_SEGMENT" ? event.segmentIndex : undefined);
      expect(indices).toEqual(Array.from({ length: f.secondIndex + 1 }, (_, index) => index));
      expect(f.post).not.toHaveBeenCalled();
    } finally { gate.resolve(); f.controller.dispose(); }
  });

  it("flushes every presented skip including the final cue before completing the session", async () => {
    const f = fixture();
    try {
      expect(f.controller.recordPresentedBaseline(f.first, f.skipped)).toBe(true);
      f.showSecond();
      const secondSkipped: CueCase = { ...baselineCueCase(f.second.cue, "第二段已显示基础讲解"), reflection: reflectionForSkip(f.second.cue.id),
        attemptBudget: { reflection: 1, diagnostic: 0, disagreement: 0, alternateDiagnostic: 0 } };
      expect(f.controller.recordPresentedBaseline(f.second, secondSkipped)).toBe(true);
      expect(f.dispatch).not.toHaveBeenCalled();
      const completion = await f.controller.completeSession(f.second);
      expect(completion?.status).toBe("SUCCEEDED");
      if (completion?.status !== "SUCCEEDED") throw new Error("Session completion failed");
      expect(completion.result.state.sessionStatus).toBe("COMPLETED");
      expect(completion.result.state.routeCursor).toBe(f.second.plan.segments.length - 1);
      expect(completion.result.state.completedCueIds).toEqual([f.first.cue.id, f.second.cue.id]);
      expect(completion.result.state.completedCueSummaries).toHaveLength(2);
      expect(f.dispatch.mock.calls.at(-1)?.[0].type).toBe("COMPLETE_SESSION");
      const starts = f.dispatch.mock.calls.map(([event]) => event).filter(event => event.type === "START_CUE");
      expect(starts.map(event => event.cueId)).toEqual([f.first.cue.id, f.second.cue.id]);
      expect(starts.every(event => event.capabilities.length === 0)).toBe(true);
      expect(f.mirror.mock.calls.some(([event]) => event.type === "START_CUE")).toBe(false);
      expect(f.post).not.toHaveBeenCalled();
      expect(await f.controller.completeSession(f.second)).toBeUndefined();
      expect(f.dispatch.mock.calls.filter(([event]) => event.type === "COMPLETE_SESSION")).toHaveLength(1);
    } finally { f.controller.dispose(); }
  });

  it("does not dispatch a registered baseline after reset while its preceding observer is in flight", async () => {
    const f = fixture(), gate = deferred();
    try {
      f.dispatch.mockImplementation(async event => { if (event.type === "OBSERVE_SEGMENT" && event.segmentIndex === 0) await gate.promise; return f.runtime.dispatch(event); });
      expect(f.controller.recordPresentedBaseline(f.first, f.skipped)).toBe(true); f.showSecond();
      const work = f.controller.synchronizeDiagnosis(f.second);
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledOnce());
      f.controller.reset(); gate.resolve();
      expect(await work).toBeUndefined();
      expect(f.dispatch.mock.calls.some(([event]) => event.type === "START_CUE")).toBe(false);
      expect(f.post).not.toHaveBeenCalled();
    } finally { gate.resolve(); f.controller.dispose(); }
  });
});
