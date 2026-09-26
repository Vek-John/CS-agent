import { afterEach, expect, it, vi } from "vitest";
import { SessionRecoveryRecordSchema, type SessionRecoveryRecord, type SessionRecoveryResult, type CoachAgentEvent, type CoachAgentResult } from "@cs-coach/coach-agent/client";
import { createSessionRecoveryRuntime } from "./session-recovery-runtime";
import { mirrorAgentCheckpoint, type AgentMirrorOwner } from "./agent-checkpoint-mirror";
import { HistoryPersistenceController } from "../review-history/history-persistence-controller";
import { createReviewHistoryApi } from "../review-history/api";
import { CoachAgentStage3Controller } from "../coaching/coach-agent-stage3-controller";
import { buildStage3Identity } from "../coaching/coach-agent-stage3-host-adapter";
const HASH = "a".repeat(64);
const deadline = 20_000;
function deferred<T>() { let resolve!: (v:T)=>void; let reject!: (e:unknown)=>void; const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no}); return {promise,resolve,reject}; }
afterEach(()=>{ vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
function record(id: string, updatedAt: number): SessionRecoveryRecord {
  return SessionRecoveryRecordSchema.parse({
    schemaVersion: "session-recovery-record.v2",
    status: "INCOMPLETE",
    createdAt: updatedAt,
    updatedAt,
    recoveryId: id,
    sessionId: `session-${id}`,
    runId: `run-${id}`,
    demoContentHash: HASH,
    selectedPlayerId: "player-1",
    routeId: "route-1",
    routeHash: "route-hash-1",
    versions: {
      parser: "parser.v1",
      analysisAdapter: "analysis.v1",
      candidateGenerator: "candidate.v1",
      director: "director.v1",
      planCompiler: "planner.v1",
      reviewPlanSchema: "review-plan.v1",
      sessionSchema: "session.v1",
      graph: "coach-agent-graph.v2",
      agentState: "coach-agent-state.v2",
    },
    frozenReviewPlan: {
      id: "route-1",
      demo_id: "demo-1",
      player_id: "player-1",
      status: "COMPLETE",
      match_timeline_version: "timeline.v1",
      observation_version: "observation.v1",
      signal_version: "signal.v1",
      planner_version: "planner.v1",
      estimated_duration_seconds: 120,
      available_until_round: 24,
      full_match_index_ready: true,
      global_aggregation_ready: true,
      segments: [{ id: "segment-1" }],
      cues: [{ id: "cue-1" }],
      habit_clusters: [],
      generation_manifest: { provider: "DETERMINISTIC_TEMPLATE" },
    },
    routeReadiness: { "cue-1": "READY" },
    boundary: {
      kind: "CUE_PAUSED",
      boundaryId: `boundary-${id}`,
      segmentId: "segment-1",
      segmentIndex: 0,
      cueId: "cue-1",
      sessionPhase: "PAUSED_FOR_COACHING",
      outcomeGateStatus: "COMPLETE",
    },
    cueProgress: { completedCueIds: [], consumedCueIds: [], revealedCueIds: [] },
    agentCheckpointId: `checkpoint-${id}`,
    toolLedger: [],
    narrationArtifacts: [],
  });
}

async function fixture(fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ saved: true, recoveryArtifactId: "confirmed-artifact" }))) {
  const a = record("A", 1000); const b = record("B", 1000);
  const api = createReviewHistoryApi(fetcher as unknown as typeof fetch);
  const deps = { createReview: vi.fn(), startRevision: vi.fn(), appendArtifact: api.appendArtifact, commitRuntimeHead: api.commitRuntimeHead, markFailed: vi.fn() };
  const history = new HistoryPersistenceController(deps);
  history.adopt("review-A", "revision-A", "demo-A");
  const runtime = createSessionRecoveryRuntime({ indexedDB: null, now: () => 1000 });
  await runtime.dispatch({ type: "SESSION_STARTED", eventId: "start-A", record: a });
  const identity = { plan: a.frozenReviewPlan, routeState: { routeFingerprint: a.routeHash }, analysis: { demo_id: "demo-1", selected_steam_id: a.selectedPlayerId },
    demoContentHash: a.demoContentHash, selectedPlayerId: a.selectedPlayerId, sessionId: a.sessionId, runId: a.runId } as import("../coaching/coach-agent-stage3-host-adapter").Stage3IdentityInput;
  const agentIdentity = buildStage3Identity(identity);
  const result = { identity: agentIdentity, status: "COMPLETED", checkpoint: { checkpointId: "new-checkpoint" }, state: {
    activeCueId: "cue-1", currentSessionPhase: "WRAP_UP", routeCursor: 0, sessionStatus: "COMPLETED",
  } } as CoachAgentResult;
  const event = { version: "coach-agent-event.v2", type: "COMPLETE_SESSION", eventId: "complete-A", identity: agentIdentity } as CoachAgentEvent;
  const live: AgentMirrorOwner = { generation: 1, historyEpoch: 1, sessionId: a.sessionId, identity,
    recoveryIdentity: { recoveryId: a.recoveryId, sessionId: a.sessionId, runId: a.runId }, runtime, record: a, history, takenOver: false, recovering: false };
  const checkpoint = vi.fn((meta: { checkpointId: string | null }) => { live.checkpointId = meta.checkpointId; }); const accept = vi.fn((r: SessionRecoveryResult) => { if(r.record) live.record=r.record; }); const failure = vi.fn();
  const input = { event, result, read: () => live, checkpoint, accept, failure, eventId: () => "mirror-A",
    stable: () => ({ ...a, updatedAt: 1001, agentCheckpointId: result.checkpoint.checkpointId }) };
  const switchToB = () => { live.generation++; live.historyEpoch++; live.sessionId=b.sessionId; live.record=b; live.recoveryIdentity={recoveryId:b.recoveryId,sessionId:b.sessionId,runId:b.runId}; history.adopt("review-B","revision-B","demo-B"); };
  return { input, live, a,b,history,runtime,identity,result,event,fetcher,checkpoint,accept,failure,switchToB,deps };
}

it("retries only the original head after timeout, without rerunning recovery or rewriting artifacts", async () => {
  vi.useFakeTimers();
  const late = deferred<Response>(); let heads = 0;
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("/runtime-head") && ++heads === 1
    ? late.promise : Response.json({ recoveryArtifactId: "confirmed-artifact" }));
  const f = await fixture(fetcher); const dispatch = vi.spyOn(f.runtime, "dispatch");
  const pending = mirrorAgentCheckpoint(f.input);
  await vi.advanceTimersByTimeAsync(deadline); await pending;
  const retry = f.failure.mock.calls[0][0] as import("../review-history/history-persistence-controller").RuntimeHeadRetry;
  expect(retry?.isCurrent()).toBe(true); expect(f.accept).not.toHaveBeenCalled();
  const one = retry.retry(); const two = retry.retry();
  expect(one).toBe(two); expect(await one).toBe(true);
  expect(f.accept).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual(["artifacts", "runtime-head", "runtime-head"]);
  expect(fetcher.mock.calls[2][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
  late.resolve(Response.json({ recoveryArtifactId: "confirmed-artifact" })); await vi.advanceTimersByTimeAsync(0);
  expect(f.accept).toHaveBeenCalledOnce(); expect(await retry.retry()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["owner", "transport", "checkpoint", "artifact"])("does not resend a head after %s invalidates the retained mirror", async change => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/runtime-head")) throw new TypeError("network failed");
    return Response.json({ saved: true });
  });
  const f = await fixture(fetcher); await mirrorAgentCheckpoint(f.input);
  const retry = f.failure.mock.calls[0][0] as import("../review-history/history-persistence-controller").RuntimeHeadRetry;
  expect(retry?.isCurrent()).toBe(true);
  if (change === "owner") f.switchToB();
  if (change === "transport") f.live.transportEpoch = 2;
  if (change === "checkpoint") f.live.checkpointId = "newer";
  if (change === "artifact") await f.history.artifact("CUE_CASE", "new", {}, "fixture");
  const requests = fetcher.mock.calls.length;
  expect(retry.isCurrent()).toBe(false); expect(await retry.retry()).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(requests); expect(f.accept).not.toHaveBeenCalled();
});

it("retires a retry on CAS conflict and leaves the confirmed record untouched", async () => {
  let heads = 0;
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (!url.endsWith("/runtime-head")) return Response.json({ saved: true });
    if (++heads === 1) throw new TypeError("network failed");
    return Response.json({ code: "RUNTIME_HEAD_CONFLICT" }, { status: 409 });
  });
  const f = await fixture(fetcher); await mirrorAgentCheckpoint(f.input);
  const retry = f.failure.mock.calls[0][0] as import("../review-history/history-persistence-controller").RuntimeHeadRetry;
  await expect(retry.retry()).rejects.toMatchObject({ code: "RUNTIME_HEAD_CONFLICT" });
  expect(retry.isCurrent()).toBe(false); expect(f.failure).toHaveBeenLastCalledWith();
  expect(f.accept).not.toHaveBeenCalled(); expect(f.live.record).toBe(f.a);
  expect(await retry.retry()).toBe(false); expect(heads).toBe(2);
});

it.each(["owner", "artifact"])("ignores retry acknowledgement after %s changes while the request is in flight", async change => {
  const ack = deferred<Response>(); let heads = 0;
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (!url.endsWith("/runtime-head")) return Response.json({ saved: true });
    if (++heads === 1) throw new TypeError("network failed");
    return ack.promise;
  });
  const f = await fixture(fetcher); await mirrorAgentCheckpoint(f.input);
  const retry = f.failure.mock.calls[0][0] as import("../review-history/history-persistence-controller").RuntimeHeadRetry;
  const pending = retry.retry().catch(() => false);
  await Promise.resolve(); expect(heads).toBe(2);
  if (change === "owner") f.switchToB();
  else await f.history.artifact("USER_INTERACTION", "new-reflection", {}, "fixture");
  const expectedRecord = f.live.record;
  ack.resolve(Response.json({ recoveryArtifactId: "confirmed-artifact" }));
  expect(await pending).toBe(false); expect(f.accept).not.toHaveBeenCalled();
  expect(f.live.record).toBe(expectedRecord); expect(f.failure).toHaveBeenCalledOnce();
});

it("allows another explicit attempt after a transient retry failure", async () => {
  let heads = 0;
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/runtime-head") && ++heads < 3) throw new TypeError("network failed");
    return Response.json({ recoveryArtifactId: "confirmed-artifact" });
  });
  const f = await fixture(fetcher); await mirrorAgentCheckpoint(f.input);
  const retry = f.failure.mock.calls[0][0] as import("../review-history/history-persistence-controller").RuntimeHeadRetry;
  await expect(retry.retry()).rejects.toThrow("network failed");
  expect(heads).toBe(2); expect(retry.isCurrent()).toBe(true);
  expect(await retry.retry()).toBe(true); expect(heads).toBe(3); expect(f.accept).toHaveBeenCalledOnce();
});

it("discards a stable save response after review A switched to B, before any new UI or library write", async()=>{
  const f=await fixture(); const gate=deferred<SessionRecoveryResult>();
  f.live.runtime={ dispatch:()=>gate.promise };
  const pending=mirrorAgentCheckpoint(f.input);
  const saved=await f.runtime.dispatch({ type:"STABLE_BOUNDARY_REACHED",eventId:"saved",recoveryId:f.a.recoveryId,boundary:f.a.boundary,cueProgress:f.a.cueProgress,routeReadiness:f.a.routeReadiness,narrationArtifacts:[],agentCheckpointId:"new-checkpoint",updatedAt:1001 });
  f.switchToB(); gate.resolve(saved); await pending;
  expect(f.accept).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled(); expect(f.live.record).toBe(f.b);
});

it("does not seed a new session's latest checkpoint with an old result",async()=>{
  const f=await fixture(); f.switchToB(); await mirrorAgentCheckpoint(f.input);
  expect(f.checkpoint).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});

it("releases actual Controller completion when its checkpoint artifact fetch hangs",async()=>{
  vi.useFakeTimers(); const fetcher=vi.fn(()=>new Promise<Response>(()=>{})); const f=await fixture(fetcher);
  const dispatch=vi.fn(async()=>f.result);
  const controller=new CoachAgentStage3Controller({ dispatch, post:vi.fn(),bridgeAvailable:()=>true,isLive:()=>true,
    onAgentResult:(event,result)=>mirrorAgentCheckpoint({...f.input,event,result}) });
  let finished=false; const pending=controller.completeSession(f.identity).then(value=>{finished=true;return value});
  const tail=controller.reconnect({version:"coach-agent-event.v2",type:"RECONNECT_REPLAY",eventId:"next",identity:f.event.identity} as never);
  await vi.advanceTimersByTimeAsync(deadline);
  expect(finished).toBe(true); expect(await pending).toMatchObject({status:"SUCCEEDED"}); await tail;
  expect(dispatch).toHaveBeenCalledTimes(2); expect(fetcher).toHaveBeenCalledOnce(); expect(f.failure).toHaveBeenCalledOnce(); controller.dispose();
});

it("preserves a legal first checkpoint before the recovery record exists",async()=>{
  const f=await fixture(); f.live.record=undefined; await mirrorAgentCheckpoint(f.input);
  expect(f.checkpoint).toHaveBeenCalledOnce(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled();
});

it("persists a matching DEGRADED memory record through the library in artifact-before-head-before-accept order",async()=>{
  const f=await fixture(); await mirrorAgentCheckpoint(f.input);
  expect(f.fetcher.mock.calls.map(call=>call[0])).toEqual(["/api/review-history/review-A/artifacts","/api/review-history/review-A/runtime-head"]);
  const artifact=JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)); const head=JSON.parse(String(f.fetcher.mock.calls[1][1]?.body));
  expect(artifact.payload.agentCheckpointId).toBe("new-checkpoint"); expect(head.checkpointId).toBe("new-checkpoint");
  expect(head.demoId).toBe("demo-A"); expect(head.reviewRevisionId).toBe("revision-A");
  expect(f.accept).toHaveBeenCalledWith(expect.objectContaining({status:"DEGRADED",record:expect.objectContaining({agentCheckpointId:"new-checkpoint"})}));
  expect(f.failure).not.toHaveBeenCalled();
  process.stdout.write("checkpoint fixture UTF-8 bytes " + JSON.stringify({artifact:Buffer.byteLength(JSON.stringify(artifact)),head:Buffer.byteLength(JSON.stringify(head))}) + "\n");
});

it("allows a pending initial revision to finish in the captured ownership generation",async()=>{
  vi.useFakeTimers(); const f=await fixture(); const revision=deferred<{revisionId:string}>();
  f.history.adopt("review-A",undefined,"demo-A"); f.deps.startRevision.mockImplementation(()=>revision.promise);
  const creating=f.history.beginRevision({routeId:"route-1",routeHash:"route-hash-1",analysisVersion:"test",graphVersion:"test",promptVersion:"test",modelMetadata:{}});
  const pending=mirrorAgentCheckpoint(f.input); await vi.advanceTimersByTimeAsync(0);
  expect(f.fetcher).not.toHaveBeenCalled(); revision.resolve({revisionId:"revision-A"}); await creating; await pending;
  expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.accept).toHaveBeenCalledOnce(); expect(f.failure).not.toHaveBeenCalled();
});

it.each(["generation","openEpoch","recovery","runtime","history-instance","same-ids-adopt","reset"])("drops a delayed runtime result after %s ownership changes",async change=>{
  const f=await fixture(); const gate=deferred<SessionRecoveryResult>(); const source={dispatch:()=>gate.promise}; f.live.runtime=source;
  const pending=mirrorAgentCheckpoint(f.input);
  if(change==="generation")f.live.generation++;
  if(change==="openEpoch")f.live.historyEpoch++;
  if(change==="recovery")f.live.recoveryIdentity={...f.live.recoveryIdentity!,recoveryId:"another"};
  if(change==="runtime")f.live.runtime=f.runtime;
  if(change==="history-instance")f.live.history=new HistoryPersistenceController(f.deps);
  if(change==="same-ids-adopt")f.history.adopt("review-A","revision-A","demo-A");
  if(change==="reset")f.history.reset();
  gate.resolve({schemaVersion:"session-recovery-runtime.v1",status:"READY",recoveryId:f.a.recoveryId,record:{...f.a,agentCheckpointId:"new-checkpoint"},effects:[],reason:null});
  await pending;expect(f.accept).not.toHaveBeenCalled();expect(f.fetcher).not.toHaveBeenCalled();expect(f.failure).not.toHaveBeenCalled();
});

it.each(["artifact","head"])("does not publish A's late %s acknowledgement or error into an adopted B",async stage=>{
  vi.useFakeTimers();const gate=deferred<Response>();
  const fetcher=vi.fn(async(url:string)=>url.endsWith(stage==="artifact"?"/artifacts":"/runtime-head")?gate.promise:Response.json({saved:true}));
  const f=await fixture(fetcher);const pending=mirrorAgentCheckpoint(f.input);await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(stage==="artifact"?1:2);
  // No Host generation bump: the controller's own adoption token must still protect B.
  f.history.adopt("review-B","revision-B","demo-B");f.live.record=f.b;
  gate.resolve(Response.json({saved:true}));await pending;
  expect(fetcher.mock.calls.every(([url])=>url.includes("review-A"))).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(stage==="artifact"?1:2);
  expect(f.accept).not.toHaveBeenCalled();expect(f.failure).not.toHaveBeenCalled();expect(f.live.record).toBe(f.b);
});

it.each(["artifact","head"])("keeps the previously confirmed Host record when %s body times out and ignores a late acknowledgement",async stage=>{
  vi.useFakeTimers();const body=deferred<unknown>();let signal:AbortSignal|undefined;
  const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
    if(url.endsWith(stage==="artifact"?"/artifacts":"/runtime-head")){signal=init?.signal as AbortSignal;return Object.assign(new Response(),{json:()=>body.promise});}
    return Response.json({saved:true});
  });
  const f=await fixture(fetcher);const pending=mirrorAgentCheckpoint(f.input);await vi.advanceTimersByTimeAsync(deadline);await pending;
  expect(f.failure).toHaveBeenCalledOnce();expect(f.accept).not.toHaveBeenCalled();expect(f.live.record).toBe(f.a);
  expect(fetcher).toHaveBeenCalledTimes(stage==="artifact"?1:2);expect(signal?.aborted).toBe(true);
  body.resolve({saved:true});await vi.advanceTimersByTimeAsync(0);expect(f.accept).not.toHaveBeenCalled();expect(f.failure).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["REJECTED","missing","wrong-checkpoint","wrong-run"])("never promotes a draft after runtime returns %s",async kind=>{
  const f=await fixture(); const saved={...f.a,agentCheckpointId:kind==="wrong-checkpoint"?"old":"new-checkpoint",...(kind==="wrong-run"?{runId:"wrong"}:{})};
  f.live.runtime={dispatch:async()=>({schemaVersion:"session-recovery-runtime.v1",status:kind==="REJECTED"?"REJECTED":"DEGRADED",recoveryId:f.a.recoveryId,record:kind==="missing"?null:saved,effects:[],reason:null})};
  await mirrorAgentCheckpoint(f.input);expect(f.failure).toHaveBeenCalledOnce();expect(f.fetcher).not.toHaveBeenCalled();expect(f.accept).not.toHaveBeenCalled();
});

it("releases the default notify=true serial tail only after the actual START_CUE mirror times out",async()=>{
  vi.useFakeTimers();
  const {createSyntheticMirageTimeline}=await import("@cs-coach/demo-domain");
  const {createFixtureReviewPlan}=await import("@cs-coach/review-planner");
  const {createCoachAgentRuntime}=await import("@cs-coach/coach-agent");
  const {CoachAgentStage3HostAdapter}=await import("../coaching/coach-agent-stage3-host-adapter");
  const {buildInitialCoachingRouteState}=await import("../coaching/cs2d-route-integration");
  const {checkpointForRecoveryBoundary}=await import("./cs2d-session-recovery");
  const fetcher=vi.fn((_url:string,_init?:RequestInit)=>new Promise<Response>(()=>{}));const f=await fixture(fetcher);
  const base=createFixtureReviewPlan(createSyntheticMirageTimeline());
  const cue={...base.cues[0],primary_focus_code:"SURVIVE_THE_NEXT_CONTACT",annotations:[],action_fact_refs:[]};
  const plan={...base,id:f.a.routeId,demo_id:"demo-1",player_id:f.a.selectedPlayerId,status:"COMPLETE" as const,cues:base.cues.map(c=>c.id===cue.id?cue:c)};
  const index=plan.segments.findIndex(s=>s.id===cue.segment_id);
  const routeState={...buildInitialCoachingRouteState(plan),routeFrozen:true,routeFingerprint:f.a.routeHash,readiness:Object.fromEntries(plan.cues.map(c=>[c.id,"READY" as const])),cueOrder:plan.cues.map(c=>c.id)};
  const input={...f.identity,plan,routeState,cue,narration:{cueId:cue.id,candidateId:cue.candidate_id??"candidate",primaryFocusCode:cue.primary_focus_code,
    currentSituation:{text:"情况",refs:[]},playerAction:{text:"动作",refs:[]},coreIssue:{text:"问题",refs:[]},betterPlay:{text:"建议",refs:[]},outcomeImpact:{text:"结果",refs:[]}},
    generation:1,tickRate:64,evidence:{},currentSessionPhase:"PAUSED_FOR_COACHING" as const,outcomeGate:{cueId:cue.id,outcomeEndTick:cue.outcome_end_tick,status:"COMPLETE" as const,completedAtTick:cue.outcome_end_tick}};
  const current=SessionRecoveryRecordSchema.parse({...f.a,frozenReviewPlan:plan,boundary:{...f.a.boundary,segmentId:cue.segment_id,segmentIndex:index,cueId:cue.id}});
  f.live.identity=input;f.live.record=current;await f.runtime.dispatch({type:"SESSION_STARTED",eventId:"replace-fixture",record:current});
  const adapter=new CoachAgentStage3HostAdapter(); const graph=createCoachAgentRuntime({checkpoint:"memory"});
  for(let i=0;i<index;i++){
    const segment=plan.segments[i];const mode=segment.mode==="SKIP"?segment.reason_code==="FREEZE_TIME"?"FREEZE":"SKIP":segment.mode==="BRIEF"?"BRIEF":"OBSERVE";
    await graph.dispatch(adapter.createObserveSegmentEvent(input,segment.id,i,mode,mode==="SKIP"||mode==="FREEZE"?"SKIPPING":"PLAYING",`seed-${i}`));
  }
  adapter.markLifecycleSynced(index-1);
  const dispatch=vi.fn((event:CoachAgentEvent)=>graph.dispatch(event));
  const controller=new CoachAgentStage3Controller({adapter,dispatch,post:vi.fn(),bridgeAvailable:()=>true,isLive:()=>true,onAgentResult:(event,result)=>mirrorAgentCheckpoint({...f.input,event,result,
    stable:meta=>{const checkpointId=checkpointForRecoveryBoundary(meta,current.boundary);return checkpointId?{...current,agentCheckpointId:checkpointId}:undefined;}})});
  controller.start(input);await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledOnce(); // Real Graph result matched the actual CUE_PAUSED boundary.
  f.live.takenOver=true;
  const second=controller.takeoverIdentity(input);
  await vi.advanceTimersByTimeAsync(deadline-1);expect(dispatch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);expect(await second).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(2);expect(f.failure).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledOnce();
  expect(f.accept).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);controller.dispose();
});
