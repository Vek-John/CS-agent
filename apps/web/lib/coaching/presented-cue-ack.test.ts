import { expect, it, vi } from "vitest";
import { createCoachAgentRuntime } from "@cs-coach/coach-agent";
import { CoachAgentEventSchema, type CoachAgentEvent, type CoachAgentResult } from "@cs-coach/coach-agent/client";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { startCueEvent } from "../../../../libs/coach-agent/src/test-fixtures";
import { buildInitialCoachingRouteState } from "./cs2d-route-integration";
import { buildStage3Identity, CoachAgentStage3HostAdapter, type Stage3IdentityInput } from "./coach-agent-stage3-host-adapter";
import { CoachAgentStage3Controller } from "./coach-agent-stage3-controller";

// Real Graph manual visit/resume protocol on a synthetic route; no browser or model.
async function fixture() {
  const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());
  const [first, next] = plan.cues;
  const firstIndex = plan.segments.findIndex(s => s.id === first.segment_id);
  const nextIndex = plan.segments.findIndex(s => s.id === next.segment_id);
  expect(nextIndex).toBeGreaterThan(firstIndex + 1);
  const input: Stage3IdentityInput = { plan, routeState: { ...buildInitialCoachingRouteState(plan), routeFrozen: true, routeFingerprint: "synthetic-route" },
    analysis: { demo_id: plan.demo_id, selected_steam_id: plan.player_id }, demoContentHash: "b".repeat(64),
    selectedPlayerId: plan.player_id, sessionId: "presented-session", runId: "presented-run" };
  const identity = buildStage3Identity(input), runtime = createCoachAgentRuntime();
  const observe = (index: number) => runtime.dispatch(CoachAgentEventSchema.parse({ version: "coach-agent-event.v2", type: "OBSERVE_SEGMENT",
    eventId: `segment-${index}`, identity, segmentId: plan.segments[index].id, segmentIndex: index, mode: "BRIEF", currentSessionPhase: "PLAYING" }));
  for (let index = 0; index < firstIndex; index++) await observe(index);
  const firstStart = startCueEvent({ identity, eventId: "first", cueId: first.id, segmentId: first.segment_id, routeSegmentIndex: firstIndex, capabilities: [] });
  await runtime.dispatch(firstStart);
  await runtime.dispatch(CoachAgentEventSchema.parse({ version: "coach-agent-event.v2", type: "USER_TAKEOVER", eventId: "takeover", identity, reason: "MANUAL_CUE_NAVIGATION" }));
  const { routeSegmentIndex: _index, ...manual } = startCueEvent({ identity, cueId: next.id, segmentId: next.segment_id, capabilities: [] });
  const visited = await runtime.dispatch(CoachAgentEventSchema.parse({ ...manual, version: "coach-agent-event.v2", type: "START_MANUAL_CUE_VISIT",
    eventId: "manual-next", visitId: "manual-visit", targetSegmentIndex: nextIndex }));
  expect(visited.state.presentedCueBindings).toContainEqual({ cueId: next.id, segmentId: next.segment_id, segmentIndex: nextIndex });
  const resumed = await runtime.dispatch(CoachAgentEventSchema.parse({ ...firstStart, version: "coach-agent-event.v2", eventId: "resume-default", resumeFromTakeover: true }));
  expect(resumed.state.routeCursor).toBe(firstIndex);
  const adapter = new CoachAgentStage3HostAdapter();
  adapter.markLifecycleSynced(firstIndex);
  const mirror = vi.fn(), post = vi.fn(), replies: CoachAgentResult[] = [];
  const dispatch = vi.fn(async (event: CoachAgentEvent) => { const result = await runtime.dispatch(event); replies.push(result); return result; });
  const controller = new CoachAgentStage3Controller({ adapter, dispatch, post, onAgentResult: mirror, isLive: () => true, bridgeAvailable: () => true });
  const eventId = `stage3-presented-${input.runId}-${nextIndex}-${next.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 160);
  const send = () => controller.observePresentedCue(input, next.id, next.segment_id, nextIndex);
  const settle = () => vi.waitFor(() => expect(adapter.lifecycleEventStatus(eventId)).not.toBe("PENDING"));
  const fillGap = async () => { for (let index = firstIndex + 1; index < nextIndex; index++) await observe(index); };
  return { input, runtime, adapter, controller, dispatch, replies, mirror, post, eventId, firstIndex, nextIndex, send, settle, fillGap };
}

it("does not confirm or mirror a real route-order rejection, and allows the same observation to retry after the missing segment arrives", async () => {
  const f = await fixture();
  try {
    // The manual cue is genuinely presented, but background default-route observation is behind.
    f.send(); await f.settle();
    expect(f.replies[0].status).toBe("COMPLETED");
    expect(f.replies[0].state.fallbackReasons).toContain("ROUTE_ORDER_MISMATCH");
    expect(f.replies[0].state.routeCursor).toBe(f.firstIndex);
    expect(f.adapter.lifecycleCursor).toBe(f.firstIndex);
    expect(f.adapter.lifecycleEventStatus(f.eventId)).toBe("NONE");
    expect(f.mirror).not.toHaveBeenCalled();
    await f.fillGap();
    f.send(); await f.settle();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.adapter.lifecycleCursor).toBe(f.nextIndex);
    expect(f.adapter.lifecycleEventStatus(f.eventId)).toBe("CONFIRMED");
    expect(f.mirror).toHaveBeenCalledOnce();
    expect(f.post).not.toHaveBeenCalled();
  } finally { f.controller.dispose(); }
});

it("confirms a valid manually presented cue once, without replaying its teaching tool", async () => {
  const f = await fixture();
  try {
    await f.fillGap(); f.send(); await f.settle();
    expect(f.adapter.lifecycleCursor).toBe(f.nextIndex);
    expect(f.adapter.lifecycleEventStatus(f.eventId)).toBe("CONFIRMED");
    f.send(); await f.settle();
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.mirror).toHaveBeenCalledOnce();
    expect(f.post).not.toHaveBeenCalled();
  } finally { f.controller.dispose(); }
});

it("does not acknowledge or mirror a pre-reset response", async () => {
  const f = await fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.fillGap();
    f.dispatch.mockImplementation(async event => { const result = await f.runtime.dispatch(event); await pending; f.replies.push(result); return result; });
    f.send(); await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledOnce());
    f.controller.reset(); release();
    await vi.waitFor(() => expect(f.replies).toHaveLength(1));
    await Promise.resolve(); await Promise.resolve();
    expect(f.adapter.lifecycleCursor).toBe(-1);
    expect(f.adapter.lifecycleEventStatus(f.eventId)).toBe("NONE");
    expect(f.mirror).not.toHaveBeenCalled();
  } finally { release(); f.controller.dispose(); }
});

it("accepts the receipt on retry after an ACK was lost and Graph has moved forward, without repeating the presentation", async () => {
  const f = await fixture();
  try {
    await f.fillGap();
    f.dispatch.mockImplementationOnce(async event => { await f.runtime.dispatch(event); throw new Error("lost ACK"); });
    f.send(); await f.settle();
    expect(f.adapter.lifecycleEventStatus(f.eventId)).toBe("NONE");
    const identity = buildStage3Identity(f.input), laterIndex = f.nextIndex + 1;
    const advanced = await f.runtime.dispatch(CoachAgentEventSchema.parse({ version: "coach-agent-event.v2", type: "OBSERVE_SEGMENT",
      eventId: "later-segment", identity, segmentId: f.input.plan.segments[laterIndex].id, segmentIndex: laterIndex, mode: "BRIEF", currentSessionPhase: "PLAYING" }));
    f.send(); await f.settle();
    expect(f.adapter.lifecycleEventStatus(f.eventId)).toBe("CONFIRMED");
    expect(f.replies.at(-1)?.state.routeCursor).toBe(laterIndex);
    expect(f.replies.at(-1)?.state.completedCueIds).toEqual(advanced.state.completedCueIds);
    expect(f.replies.at(-1)?.state.trace).toEqual(advanced.state.trace);
    expect(f.mirror).toHaveBeenCalledOnce(); expect(f.post).not.toHaveBeenCalled();
  } finally { f.controller.dispose(); }
});

it("keeps a new same-event request pending when the pre-reset request settles", async () => {
  const f = await fixture();
  let releaseOld!: () => void, releaseNew!: () => void;
  const oldWait = new Promise<void>(resolve => { releaseOld = resolve; });
  const newWait = new Promise<void>(resolve => { releaseNew = resolve; });
  let calls = 0;
  try {
    await f.fillGap();
    f.dispatch.mockImplementation(async event => {
      const call = ++calls, result = await f.runtime.dispatch(event);
      await (call === 1 ? oldWait : newWait); f.replies.push(result); return result;
    });
    f.send(); await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1));
    f.controller.reset(); f.send(); await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(2));
    releaseOld(); await vi.waitFor(() => expect(f.replies).toHaveLength(1));
    f.send(); await Promise.resolve(); await Promise.resolve();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    releaseNew(); await f.settle();
    expect(f.adapter.lifecycleEventStatus(f.eventId)).toBe("CONFIRMED");
    expect(f.mirror).toHaveBeenCalledOnce();
  } finally { releaseOld(); releaseNew(); f.controller.dispose(); }
});
