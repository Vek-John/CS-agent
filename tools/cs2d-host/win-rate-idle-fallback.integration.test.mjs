import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {afterEach,describe,expect,it,vi} from 'vitest';
const path=resolve(process.env.CS2D_UPSTREAM_DIR||'.local-data/upstream/cs2d','apps/app/src/viewer/DemoAnalyzerView.vue');
const source=existsSync(path)?readFileSync(path,'utf8'):'';
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
function harness(){
  vi.useFakeTimers();const workers=[],events=[];
  class FakeWorker{constructor(){this.terminate=vi.fn();workers.push(this);}postMessage(request){this.request=request;}}
  const replay={players:[{steamId:'player',name:'Player',startSide:'T'}],rounds:[{frames:[{}]}]};
  const ctx={Worker:FakeWorker,URL,Error,AbortController,setTimeout,clearTimeout,performance,console:{info:()=>{}},route:{query:{},params:{}},winRateWorker:null,winRateRequestId:0,cancelWinRateRequest:null,winRateSkipRequest:null,
    CS_NET_DEFAULT_PROVIDER:'wasm-int8',CS_NET_DEFAULT_BATCH_SIZE:16,WIN_RATE_IDLE_TIMEOUT_MS:120000,
    emitPlaybackEvent:e=>events.push(e),buildCs2dAnalysisBundle:vi.fn(input=>({test:true,hasWinRate:!!input.winProbabilityTimeline})),serializeCs2dAnalysisBundle:JSON.stringify,
    parser:{cancel:vi.fn(),replay:{value:replay},demoContentHash:{value:'a'.repeat(64)},hashLatencyMs:{value:1}},
    hostMode:{value:true},hostSelectionLocked:{value:false},hostSelectedPlayerId:{value:null},hostStageReady:{value:false},managedLibraryMode:{value:true},managedSource:{value:{mode:'SELECT_PLAYER'}},
    managedLoadGeneration:0,managedReadyGeneration:0,managedLoadAbort:null,stopHostSelectionBridge:null,stopExtensionBridge:null,
    nextTick:vi.fn(async()=>{if(ctx.managedSource.value?.mode==='RESTORE')ctx.hostStageReady.value=true;})};
  const names=['cancelWinRate','inferWinRate','selectHostPlayer','beginManagedLoad','isManagedLoadCurrent'];
  const functions=names.map(name=>source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}(?=\\n)`))?.[0]??'').join('\n').replaceAll('import.meta.url',JSON.stringify('file:///viewer/DemoAnalyzerView.vue'));
  const unmount=source.match(/onUnmounted\(\(\) => \{([\s\S]*?)\n}\)/)?.[1]??'';
  runInNewContext(stripTypeScriptTypes(functions+'\nfunction dispose(){'+unmount+'\n}'),ctx);
  return {ctx,workers,events,start(){return ctx.inferWinRate(replay,'player').then(value=>({value}),error=>({code:error.code,message:error.message}));},cleanup(){ctx.cancelWinRate?.();for(const worker of workers)worker.onmessage?.({data:{type:'ready',requestId:worker.request?.requestId,timeline:{test:true}}});}};
}
const send=(worker,message)=>worker.onmessage?.({data:{requestId:worker.request.requestId,...message}});
describe.skipIf(!source)('actual win-rate idle fallback lifecycle',()=>{
  it('unblocks the actual selection path into baseline analysis after 120 seconds without progress',async()=>{
    const h=harness();try{
      let ended=false;const pending=h.ctx.selectHostPlayer('player').then(()=>{ended=true;});await vi.advanceTimersByTimeAsync(119999);
      expect(h.ctx.buildCs2dAnalysisBundle).not.toHaveBeenCalled();expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);expect(ended).toBe(true);await pending;
      expect(h.workers[0].terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
      const unavailable=h.events.filter(event=>event.phase==='unavailable');expect(unavailable).toHaveLength(1);
      expect(unavailable[0].detail).toBe('胜率计算长时间没有进展，改用基础教练路线。');
      expect(h.ctx.buildCs2dAnalysisBundle).toHaveBeenCalledOnce();expect(h.ctx.buildCs2dAnalysisBundle.mock.calls[0][0].winProbabilityTimeline).toBeUndefined();
      expect(h.events.filter(event=>event.type==='ANALYSIS_READY')).toHaveLength(1);
    }finally{h.cleanup();}
  });
  it('allows long inference while distinct positive progress keeps arriving',async()=>{
    const h=harness();try{
      let ended=false;const pending=h.start().then(value=>{ended=true;return value;});const w=h.workers[0];
      for(const [phase,completed] of [['downloading',10],['inference',1],['ready',2]]){
        await vi.advanceTimersByTimeAsync(90000);expect(ended).toBe(false);send(w,{type:'progress',phase,completed,total:100});
      }
      await vi.advanceTimersByTimeAsync(119999);expect(ended).toBe(false);
      send(w,{type:'ready',timeline:{marker:'current'}});expect(await pending).toEqual({value:{marker:'current'}});
      expect(w.terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });
  it.each(['duplicate','backwards','zero','nan','infinite','telemetry'])('does not extend idle waiting for %s messages',async kind=>{
    const h=harness();try{
      let ended=false;const pending=h.start().then(value=>{ended=true;return value;});const w=h.workers[0];
      send(w,{type:'progress',phase:'inference',completed:5,total:100});
      await vi.advanceTimersByTimeAsync(60000);
      if(kind==='telemetry')send(w,{type:'telemetry',telemetry:{stage:'still alive'}});
      else send(w,{type:'progress',phase:'ready',completed:{duplicate:5,backwards:4,zero:0,nan:NaN,infinite:Infinity}[kind],total:100});
      await vi.advanceTimersByTimeAsync(59999);expect(ended).toBe(false);await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({code:'WIN_RATE_IDLE_TIMEOUT'});expect(w.terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });
  it('retains separate phase maxima without reviving a decreasing download counter',async()=>{
    const h=harness();try{const pending=h.start(),w=h.workers[0];
      send(w,{type:'progress',phase:'downloading',completed:100,total:200});await vi.advanceTimersByTimeAsync(100000);
      send(w,{type:'progress',phase:'inference',completed:1,total:50});await vi.advanceTimersByTimeAsync(100000);
      send(w,{type:'progress',phase:'downloading',completed:99,total:200});await vi.advanceTimersByTimeAsync(20000);
      expect(await pending).toMatchObject({code:'WIN_RATE_IDLE_TIMEOUT'});expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });
  it('settles superseded inference and shields its successor from old callbacks and timeout',async()=>{
    const h=harness();try{
      const first=h.start(),old=h.workers[0],message=old.onmessage,error=old.onerror;
      await vi.advanceTimersByTimeAsync(1000);const second=h.start(),current=h.workers[1];
      expect(await first).toMatchObject({code:'WIN_RATE_CANCELLED'});const count=h.events.length;
      for(const data of [{type:'ready',timeline:{old:true}},{type:'progress',phase:'inference',completed:10,total:20},{type:'telemetry',telemetry:{old:true}}])message({data:{...data,requestId:old.request.requestId}});
      error({message:'old failure'});expect(h.events).toHaveLength(count);await vi.advanceTimersByTimeAsync(119000);
      expect(current.terminate).not.toHaveBeenCalled();expect(h.ctx.winRateWorker).toBe(current);
      send(current,{type:'ready',timeline:{current:true}});expect(await second).toEqual({value:{current:true}});expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });
  it.each(['load','unmount'])('cancels the selection without old fallback on %s',async action=>{
    const h=harness();try{const pending=h.ctx.selectHostPlayer('player');await vi.advanceTimersByTimeAsync(0);
      if(action==='load')h.ctx.beginManagedLoad();else h.ctx.dispose();await pending;await vi.advanceTimersByTimeAsync(240000);
      expect(h.workers[0].terminate).toHaveBeenCalledOnce();expect(h.ctx.buildCs2dAnalysisBundle).not.toHaveBeenCalled();
      expect(h.events.some(event=>event.phase==='unavailable'||event.type==='ANALYSIS_READY'||event.type==='ANALYSIS_FAILED')).toBe(false);expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });
  it.each(['worker-error','result-error','postMessage'])('preserves baseline fallback and cleanup after %s',async kind=>{
    const h=harness();try{
      if(kind==='postMessage')h.ctx.Worker.prototype.postMessage=function(){throw new Error('clone failed');};
      const pending=h.ctx.selectHostPlayer('player');await vi.advanceTimersByTimeAsync(0);const w=h.workers[0];
      if(kind==='worker-error')w.onerror({message:'current worker error'});
      if(kind==='result-error')send(w,{type:'error',message:'current inference error',code:'MODEL_FAILED'});
      await pending;expect(w.terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
      expect(h.events.filter(event=>event.phase==='unavailable')).toHaveLength(1);expect(h.ctx.buildCs2dAnalysisBundle).toHaveBeenCalledOnce();
      expect(h.events.filter(event=>event.type==='ANALYSIS_READY')).toHaveLength(1);
    }finally{h.cleanup();}
  });
  it('keeps successful analysis and does not invoke the model for playback RESTORE',async()=>{
    const h=harness();try{const pending=h.ctx.selectHostPlayer('player');await vi.advanceTimersByTimeAsync(0);
      const timeline={marker:'valid'};send(h.workers[0],{type:'ready',timeline});await pending;
      expect(h.ctx.buildCs2dAnalysisBundle.mock.calls[0][0].winProbabilityTimeline).toBe(timeline);expect(vi.getTimerCount()).toBe(0);
      const restore=harness();try{restore.ctx.managedSource.value.mode='RESTORE';await restore.ctx.selectHostPlayer('player');
        expect(restore.workers).toHaveLength(0);expect(restore.ctx.buildCs2dAnalysisBundle).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
      }finally{restore.cleanup();}
    }finally{h.cleanup();}
  });

  it('renews on real WASM progress after the one-time WebGPU fallback counter reset',async()=>{
    const h=harness();try{let ended=false;const pending=h.start().then(value=>{ended=true;return value;});const w=h.workers[0];
      send(w,{type:'progress',phase:'inference',completed:100,total:200});await vi.advanceTimersByTimeAsync(100000);
      send(w,{type:'telemetry',telemetry:{schemaVersion:'cs-net-webgpu-telemetry.v1',providerActual:'unavailable',fallbackReason:'WEBGPU_FAILURE:device lost'}});
      await vi.advanceTimersByTimeAsync(10000);send(w,{type:'progress',phase:'inference',completed:1,total:200});
      await vi.advanceTimersByTimeAsync(110000);expect(ended).toBe(false);send(w,{type:'progress',phase:'ready',completed:2,total:200});
      await vi.advanceTimersByTimeAsync(119999);expect(ended).toBe(false);send(w,{type:'ready',timeline:{wasm:true}});
      expect(await pending).toEqual({value:{wasm:true}});expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });
  it('does not extend waiting for fallback telemetry alone or a repeated reset',async()=>{
    for(const repeated of [false,true]){const h=harness();try{const pending=h.start(),w=h.workers[0];
      const telemetry={schemaVersion:'cs-net-webgpu-telemetry.v1',providerActual:'unavailable',fallbackReason:'WEBGPU_FAILURE:fallback'};
      send(w,{type:'progress',phase:'inference',completed:100,total:200});await vi.advanceTimersByTimeAsync(100000);
      send(w,{type:'telemetry',telemetry});
      if(repeated){send(w,{type:'progress',phase:'inference',completed:10,total:200});await vi.advanceTimersByTimeAsync(100000);send(w,{type:'telemetry',telemetry});send(w,{type:'progress',phase:'inference',completed:9,total:200});}
      await vi.advanceTimersByTimeAsync(20000);expect(await pending).toMatchObject({code:'WIN_RATE_IDLE_TIMEOUT'});expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}}
  });
  it.each(['WEBGPU_TIMEOUT:','WEBGPU_ABORTED:'])('does not reset progress maxima for %s telemetry',async reason=>{
    const h=harness();try{const pending=h.start(),w=h.workers[0];send(w,{type:'progress',phase:'inference',completed:100,total:200});
      await vi.advanceTimersByTimeAsync(100000);send(w,{type:'telemetry',telemetry:{schemaVersion:'cs-net-webgpu-telemetry.v1',providerActual:'unavailable',fallbackReason:reason+'stopped'}});
      send(w,{type:'progress',phase:'inference',completed:1,total:200});await vi.advanceTimersByTimeAsync(20000);
      expect(await pending).toMatchObject({code:'WIN_RATE_IDLE_TIMEOUT'});expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });

});
