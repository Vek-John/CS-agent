import { afterEach, expect, it, vi } from "vitest";
import { dispatchCoachAgentEvent, AGENT_REQUEST_TIMEOUT_MS } from "./coach-agent-host-adapter";
import { CoachAgentStage3Controller } from "./coach-agent-stage3-controller";
import type { Stage3IdentityInput } from "./coach-agent-stage3-host-adapter";
import { createSyntheticMirageTimeline } from "@cs-coach/demo-domain";
import { createFixtureReviewPlan } from "@cs-coach/review-planner";
import { createCoachAgentRuntime, parseRemoteCoachAgentDispatchEnvelope } from "@cs-coach/coach-agent";
import { startCueEvent } from "../../../../libs/coach-agent/src/test-fixtures";

const deadline = AGENT_REQUEST_TIMEOUT_MS;
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
function identity(runId = "run"): Stage3IdentityInput {
  const plan = createFixtureReviewPlan(createSyntheticMirageTimeline());
  return { plan, routeState: { routeFingerprint: "route-hash" }, analysis: { demo_id: plan.demo_id, selected_steam_id: plan.player_id },
    demoContentHash: "a".repeat(64), selectedPlayerId: plan.player_id, sessionId: "session", runId } as Stage3IdentityInput;
}

it.each(["fetch", "body"] as const)("bounds the production dispatch when %s never settles", async stage => {
  vi.useFakeTimers(); const late = deferred<unknown>(); let signal: AbortSignal | undefined;
  const json = vi.fn(() => late.promise);
  const fetcher = vi.fn((_url, init) => { signal = init?.signal as AbortSignal;
    return stage === "fetch" ? late.promise as Promise<Response> : Promise.resolve(Object.assign(new Response(), { json })); });
  let settled = false;
  const observed = dispatchCoachAgentEvent(startCueEvent(), fetcher).catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(deadline);
  expect(settled).toBe(true);
  expect(await observed).toMatchObject({ name: "AgentRequestTimeout" });
  expect(signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  if (stage === "fetch") { late.resolve({ ok: true, status: 200, json }); await vi.advanceTimersByTimeAsync(0); expect(json).not.toHaveBeenCalled(); }
  else { late.reject(new Error("late private JSON rejection")); await vi.advanceTimersByTimeAsync(0); expect(await observed).toMatchObject({ name: "AgentRequestTimeout" }); }
});

it.each(["fetch", "body"] as const)("releases the actual Stage3 serial tail after a stuck Agent %s", async stage => {
  vi.useFakeTimers(); const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
  const late = deferred<unknown>();
  const fetcher = vi.fn(async (_url, init) => {
    if (fetcher.mock.calls.length === 1) return stage === "fetch" ? late.promise as Promise<Response> : Object.assign(new Response(), { json: () => late.promise });
    const envelope = parseRemoteCoachAgentDispatchEnvelope(JSON.parse(String(init?.body)));
    return Response.json(await runtime.dispatch(envelope.event));
  });
  const controller = new CoachAgentStage3Controller({ dispatch: event => dispatchCoachAgentEvent(event, fetcher), post: vi.fn(), bridgeAvailable: () => true, isLive: () => true });
  let firstSettled = false;
  const first = controller.completeSession(identity()).then(value => { firstSettled = true; return value; });
  const second = controller.completeSession(identity("next-run"));
  await vi.advanceTimersByTimeAsync(deadline);
  expect(firstSettled).toBe(true);
  expect(await first).toEqual({ status: "FAILED" });
  await second; expect(fetcher).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0); controller.dispose();
});

it("uses one deadline for headers plus body and cleans its parent listener", async () => {
  vi.useFakeTimers(); const headers = deferred<Response>(); const body = deferred<unknown>();
  const parent = new AbortController(); const add = vi.spyOn(parent.signal, "addEventListener"); const remove = vi.spyOn(parent.signal, "removeEventListener");
  let child: AbortSignal | undefined;
  const observed = dispatchCoachAgentEvent(startCueEvent(), (_url, init) => { child = init?.signal as AbortSignal; return headers.promise; }, parent.signal).catch(e => e);
  await vi.advanceTimersByTimeAsync(deadline - 1);
  headers.resolve(Object.assign(new Response(), { json: () => body.promise }));
  await vi.advanceTimersByTimeAsync(1);
  expect(await observed).toMatchObject({ name: "AgentRequestTimeout", code: "AGENT_REQUEST_TIMEOUT" });
  expect(child?.aborted).toBe(true); expect(parent.signal.aborted).toBe(false);
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]); expect(vi.getTimerCount()).toBe(0);
  body.resolve({ late: true }); await vi.advanceTimersByTimeAsync(0);
  expect(await observed).toMatchObject({ name: "AgentRequestTimeout" });
});

it.each(["fetch", "body"] as const)("cancels non-cooperative %s without replacing cancellation with late rejection", async stage => {
  vi.useFakeTimers(); const parent = new AbortController(); const late = deferred<unknown>();
  const remove = vi.spyOn(parent.signal, "removeEventListener"); let child: AbortSignal | undefined;
  const observed = dispatchCoachAgentEvent(startCueEvent(), (_url, init) => {
    child = init?.signal as AbortSignal;
    return stage === "fetch" ? late.promise as Promise<Response> : Promise.resolve(Object.assign(new Response(), { json: () => late.promise }));
  }, parent.signal).catch(e => e);
  await vi.advanceTimersByTimeAsync(0); parent.abort();
  expect(await observed).toMatchObject({ name: "AbortError" }); expect(child?.aborted).toBe(true);
  expect(remove).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  late.reject(new Error("late rejection")); await vi.advanceTimersByTimeAsync(0);
  expect(await observed).toMatchObject({ name: "AbortError" });
});

it("does no fetch for an already-cancelled signal", async () => {
  const parent = new AbortController(); parent.abort(); const fetcher = vi.fn();
  await expect(dispatchCoachAgentEvent(startCueEvent(), fetcher, parent.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps timeout as the result when abort-aware transport rejects immediately", async () => {
  vi.useFakeTimers();
  const observed = dispatchCoachAgentEvent(startCueEvent(), (_url, init) => new Promise((_yes, no) => {
    init?.signal?.addEventListener("abort", () => no(new DOMException("aborted", "AbortError")), { once: true });
  })).catch(e => e);
  await vi.advanceTimersByTimeAsync(deadline);
  expect(await observed).toMatchObject({ name: "AgentRequestTimeout" }); expect(vi.getTimerCount()).toBe(0);
});

it.each(["success", "http", "json", "schema", "network"] as const)("preserves %s behavior and clears all owned deadline resources", async mode => {
  vi.useFakeTimers(); const parent = new AbortController(); const remove = vi.spyOn(parent.signal, "removeEventListener");
  const event = startCueEvent(); const result = await createCoachAgentRuntime({ checkpoint: "memory" }).dispatch(event);
  const response = mode === "http" ? new Response("unread", { status: 503 }) : mode === "json" ? new Response("{bad") : Response.json(mode === "schema" ? { unsupported: true } : result);
  const json = vi.spyOn(response, "json"); const network = new Error("network failed");
  const fetcher = vi.fn(async (_url, init) => {
    const envelope = parseRemoteCoachAgentDispatchEnvelope(JSON.parse(String(init?.body)));
    expect(envelope.event).toEqual(event); // No new eventId, retry marker, or protocol mutation.
    if (mode === "network") throw network;
    return response;
  });
  const observed = await dispatchCoachAgentEvent(event, fetcher, parent.signal).catch(e => e);
  if (mode === "success") expect(observed).toEqual(result);
  if (mode === "http") { expect(observed.message).toBe("agent dispatch HTTP 503"); expect(json).not.toHaveBeenCalled(); }
  if (mode === "json") expect(observed.message).toBe("agent dispatch returned invalid JSON");
  if (mode === "schema") expect(observed.name).toBe("ZodError");
  if (mode === "network") expect(observed).toBe(network);
  expect(fetcher).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("feeds the real completion Host entry and panel through the existing timeout failure artifact", async () => {
  vi.useFakeTimers();
  const { completeStage3SessionWrapUp } = await import("./session-wrap-up-completion");
  const { SessionWrapUpPanel, sessionWrapUpPresentation } = await import("./session-wrap-up-presentation");
  const { createElement } = await import("react"); const { renderToStaticMarkup } = await import("react-dom/server");
  let saved: import("@cs-coach/coach-agent/client").SessionWrapUpResult | undefined; let status = "IDLE"; let claimed = false;
  const artifact = vi.fn().mockResolvedValue(undefined); const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  const onAgentResult = vi.fn(); const post = vi.fn();
  const controller = new CoachAgentStage3Controller({ dispatch: e => dispatchCoachAgentEvent(e, fetcher), post, bridgeAvailable: () => true, isLive: () => true, onAgentResult });
  const input = { controller, identity: identity(), isCurrent: () => true, persistence: { artifact },
    claim: () => claimed ? false : (claimed = true), onStart: () => { status = "LOADING"; }, buildInput: vi.fn(() => null), onRequest: vi.fn(), onSaveError: vi.fn(),
    onResult: (result: typeof saved) => { saved = result; status = sessionWrapUpPresentation(result).status; } };
  const pending = completeStage3SessionWrapUp(input); await vi.advanceTimersByTimeAsync(0); expect(status).toBe("LOADING");
  await vi.advanceTimersByTimeAsync(deadline); await pending;
  expect(saved?.manifest.reason).toBe("MISSING_SESSION_SUMMARY"); expect(artifact).toHaveBeenCalledOnce();
  expect(renderToStaticMarkup(createElement(SessionWrapUpPanel, { status, result: saved, error: sessionWrapUpPresentation(saved).error, phase: "WRAP_UP", onComplete: () => {} }))).toContain("未生成全场总结");
  expect(input.buildInput).not.toHaveBeenCalled(); expect(onAgentResult).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  await completeStage3SessionWrapUp(input); expect(fetcher).toHaveBeenCalledOnce(); expect(artifact).toHaveBeenCalledOnce(); controller.dispose();
});

async function diagnosisFixture() {
  const { buildInitialCoachingRouteState } = await import("./cs2d-route-integration");
  const base = identity(); const source = base.plan.cues[0];
  const cue = { ...source, primary_focus_code: "SURVIVE_THE_NEXT_CONTACT", observable_fact_refs: ["decision-ref"],
    facts: [{ id: "decision-ref", text: "已知位置", availability: "DECISION" as const, available_at_tick: source.decision_tick, source: "DEMO" as const, observed_by_player: true }],
    annotations: [{ id: "map-point", type: "POINT" as const, coordinate_space: "WORLD" as const, point: { x: 120, y: -80, z: 0 }, label: "关键站位" }] };
  const plan = { ...base.plan, status: "COMPLETE" as const, cues: base.plan.cues.map(c => c.id === cue.id ? cue : c) };
  const routeState = { ...buildInitialCoachingRouteState(plan), routeFrozen: true, routeFingerprint: "route-hash", readiness: Object.fromEntries(plan.cues.map(c => [c.id, "READY" as const])), cueOrder: plan.cues.map(c => c.id) };
  return { ...base, plan, routeState, cue,
    narration: { cueId: cue.id, candidateId: cue.candidate_id ?? "candidate", primaryFocusCode: cue.primary_focus_code,
      currentSituation: { text: "情况", refs: ["decision-ref"] }, playerAction: { text: "动作", refs: [] }, coreIssue: { text: "问题", refs: ["decision-ref"] }, betterPlay: { text: "建议", refs: [] }, outcomeImpact: { text: "结果", refs: [] } },
    evidence: {}, generation: 1, tickRate: 64, currentSessionPhase: "PAUSED_FOR_COACHING" as const,
    outcomeGate: { cueId: cue.id, outcomeEndTick: cue.outcome_end_tick, status: "COMPLETE" as const, completedAtTick: cue.outcome_end_tick },
  };
}

it("lets default diagnosis use its real local fallback after a transport timeout", async () => {
  vi.useFakeTimers(); const input = await diagnosisFixture();
  const { runTeachingDiagnosis } = await import("./teaching-diagnosis-host");
  const fetcher = vi.fn(() => new Promise<Response>(() => {})); const post = vi.fn();
  const controller = new CoachAgentStage3Controller({ dispatch: e => dispatchCoachAgentEvent(e, fetcher), post, bridgeAvailable: () => true, isLive: () => true });
  const pending = controller.synchronizeDiagnosis(input).catch(() => undefined);
  await vi.advanceTimersByTimeAsync(deadline); expect(await pending).toBeUndefined();
  expect(fetcher).toHaveBeenCalledOnce();
  const local = runTeachingDiagnosis({ plan: input.plan, cue: input.cue, selectedPlayerId: input.selectedPlayerId },
    { cueId: input.cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] });
  expect(local.cueCase.cueId).toBe(input.cue.id); expect(local.cueCase.diagnosticResult).toBeDefined();
  expect(post).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); controller.dispose();
});

it("never opens a tool or mirrors a late valid WAITING_TOOL body after switching away", async () => {
  vi.useFakeTimers(); const input = await diagnosisFixture();
  const { CoachAgentStage3HostAdapter } = await import("./coach-agent-stage3-host-adapter");
  const adapter = new CoachAgentStage3HostAdapter();
  adapter.markLifecycleSynced(input.plan.segments.findIndex(s => s.id === input.cue.segment_id) - 1);
  const runtime = createCoachAgentRuntime({ checkpoint: "memory" }); const body = deferred<unknown>();
  for (let index = 0; index < input.plan.segments.findIndex(s => s.id === input.cue.segment_id); index++) {
    const segment = input.plan.segments[index];
    const mode = segment.mode === "SKIP" ? segment.reason_code === "FREEZE_TIME" ? "FREEZE" : "SKIP" : segment.mode === "BRIEF" ? "BRIEF" : "OBSERVE";
    await runtime.dispatch(adapter.createObserveSegmentEvent(input, segment.id, index, mode, mode === "SKIP" || mode === "FREEZE" ? "SKIPPING" : "PLAYING", `seed-observer-${index}`));
  }
  let lateResult: unknown; const post = vi.fn(); const onAgentResult = vi.fn(); const onState = vi.fn(); let live = true;
  const fetcher = vi.fn(async (_url, init) => {
    const envelope = parseRemoteCoachAgentDispatchEnvelope(JSON.parse(String(init?.body)));
    lateResult = await runtime.dispatch(envelope.event);
    return Object.assign(new Response(), { json: () => body.promise });
  });
  const controller = new CoachAgentStage3Controller({ adapter, dispatch: e => dispatchCoachAgentEvent(e, fetcher), post, bridgeAvailable: () => true, isLive: () => live, onAgentResult, onState });
  controller.start(input); await vi.advanceTimersByTimeAsync(0);
  expect(lateResult).toMatchObject({ status: "WAITING_TOOL" });
  live = false; controller.dispose(); const statesBeforeLate = onState.mock.calls.length;
  await vi.advanceTimersByTimeAsync(deadline);
  body.resolve(lateResult); await vi.advanceTimersByTimeAsync(0);
  expect(post).not.toHaveBeenCalled(); expect(onAgentResult).not.toHaveBeenCalled(); expect(onState).toHaveBeenCalledTimes(statesBeforeLate);
  expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
