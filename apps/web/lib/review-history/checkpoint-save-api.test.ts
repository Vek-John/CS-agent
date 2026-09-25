import { afterEach, expect, it, vi } from "vitest";
import { CHECKPOINT_REQUEST_TIMEOUT_MS as deadline, createReviewHistoryApi } from "./api";
function deferred<T>() { let resolve!:(v:T)=>void; let reject!:(e:unknown)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}; }
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
const artifact={revisionId:"revision",artifactType:"SESSION_RECOVERY",artifactKey:"boundary:checkpoint",schemaVersion:"session-recovery-record.v2",payload:{},idempotencyKey:"same-key"};
function save(api:ReturnType<typeof createReviewHistoryApi>,kind:string){return kind==="artifact"?api.appendArtifact("review",artifact):api.commitRuntimeHead("review",{checkpointId:"checkpoint"});}

it.each(["artifact","head"])("bounds %s fetch and ignores late headers without reading their body",async kind=>{
  vi.useFakeTimers();const late=deferred<Response>();let signal:AbortSignal|undefined;const json=vi.fn();
  const fetcher=vi.fn((_url,init)=>{signal=init?.signal as AbortSignal;return late.promise});
  const result=save(createReviewHistoryApi(fetcher),kind).catch(e=>e);
  await vi.advanceTimersByTimeAsync(deadline);expect(await result).toMatchObject({code:"CHECKPOINT_SAVE_TIMEOUT"});expect(signal?.aborted).toBe(true);
  late.resolve(Object.assign(new Response(),{json}));await vi.advanceTimersByTimeAsync(0);expect(json).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

it.each([true,false])("shares one deadline across checkpoint headers and body, including error JSON (ok=%s)",async ok=>{
  vi.useFakeTimers();const headers=deferred<Response>();const body=deferred<unknown>();
  const result=save(createReviewHistoryApi(()=>headers.promise),"head").catch(e=>e);
  await vi.advanceTimersByTimeAsync(deadline-1);
  headers.resolve(Object.assign(new Response(undefined,{status:ok?200:409}),{json:()=>body.promise}));
  await vi.advanceTimersByTimeAsync(1);expect(await result).toMatchObject({code:"CHECKPOINT_SAVE_TIMEOUT"});
  body.reject(new Error("late private storage failure"));await vi.advanceTimersByTimeAsync(0);expect(await result).toMatchObject({code:"CHECKPOINT_SAVE_TIMEOUT"});expect(vi.getTimerCount()).toBe(0);
});

it.each(["success","invalid-success-json","coded-error","invalid-error-json"])("preserves existing checkpoint response semantics for %s",async kind=>{
  vi.useFakeTimers();const response=kind==="success"?Response.json({saved:true}):kind==="coded-error"?Response.json({code:"REVISION_ARTIFACTS_INCOMPLETE"},{status:409}):new Response("{bad",{status:kind==="invalid-error-json"?500:200});
  const output=await save(createReviewHistoryApi(async()=>response),"artifact").catch(e=>e);
  if(kind==="coded-error")expect(output).toMatchObject({code:"REVISION_ARTIFACTS_INCOMPLETE"});
  else if(kind==="invalid-error-json")expect(output).toMatchObject({code:"REQUEST_FAILED"});else expect(output).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not apply the checkpoint deadline to heavy AnalysisBundle uploads",async()=>{
  vi.useFakeTimers();const late=deferred<Response>();const fetcher=vi.fn((_url:RequestInfo|URL,_init?:RequestInit)=>late.promise);let finished=false;
  const pending=createReviewHistoryApi(fetcher).appendArtifact("review",{...artifact,artifactType:"ANALYSIS_BUNDLE",payload:{synthetic:"x".repeat(300_000)}}).then(()=>{finished=true});
  await vi.advanceTimersByTimeAsync(deadline*2);expect(finished).toBe(false);expect(vi.getTimerCount()).toBe(0);
  expect(fetcher.mock.calls[0][1]).not.toHaveProperty("signal");late.resolve(Response.json({saved:true}));await pending;expect(finished).toBe(true);
});
