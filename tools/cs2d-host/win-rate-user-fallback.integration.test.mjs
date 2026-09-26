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
  const names=['skipWinRate','cancelWinRate','inferWinRate','selectHostPlayer','beginManagedLoad','isManagedLoadCurrent'];
  const functions=names.map(name=>source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}(?=\\n)`))?.[0]??'').join('\n').replaceAll('import.meta.url',JSON.stringify('file:///viewer/DemoAnalyzerView.vue'));
  const unmount=source.match(/onUnmounted\(\(\) => \{([\s\S]*?)\n}\)/)?.[1]??'';
  runInNewContext(stripTypeScriptTypes(functions+'\nfunction dispose(){'+unmount+'\n}'),ctx);
  return {ctx,workers,events,start(){return ctx.inferWinRate(replay,'player').then(value=>({value}),error=>({code:error.code,message:error.message}));},cleanup(){ctx.cancelWinRate?.();for(const worker of workers)worker.onmessage?.({data:{type:'ready',requestId:worker.request?.requestId,timeline:{test:true}}});}};
}
const send=(worker,message)=>worker.onmessage?.({data:{requestId:worker.request.requestId,...message}});
describe.skipIf(!source)('actual user win-rate fallback',()=>{
  it('accepts one identity-bound skip during pending selection and produces a single baseline bundle',async()=>{
    const h=harness();try{const pending=h.ctx.selectHostPlayer('player');await vi.advanceTimersByTimeAsync(0);
      const w=h.workers[0],message=w.onmessage,error=w.onerror;
      const command={selectedPlayerId:'player',analysisRequestId:w.request.requestId};
      h.ctx.skipWinRate?.(command);await vi.advanceTimersByTimeAsync(0);
      expect(h.ctx.buildCs2dAnalysisBundle).toHaveBeenCalledOnce();await pending;
      h.ctx.skipWinRate(command);message({data:{type:'ready',requestId:command.analysisRequestId,timeline:{old:true}}});error({message:'late'});
      expect(w.terminate).toHaveBeenCalledOnce();expect(h.events.filter(e=>e.type==='ANALYSIS_READY')).toHaveLength(1);
      expect(h.events.filter(e=>e.phase==='unavailable')).toHaveLength(1);expect(h.ctx.buildCs2dAnalysisBundle.mock.calls[0][0].winProbabilityTimeline).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });
  it.each(['wrong-player','wrong-request','after-ready'])('ignores %s skip without changing a live or settled request',async kind=>{
    const h=harness();try{const pending=h.start(),w=h.workers[0],id=w.request.requestId;
      expect(h.events[0]).toMatchObject({type:'ANALYSIS_PROGRESS',selectedPlayerId:'player',analysisRequestId:id});
      if(kind==='after-ready')send(w,{type:'ready',timeline:{ok:true}});
      h.ctx.skipWinRate({selectedPlayerId:kind==='wrong-player'?'other':'player',analysisRequestId:kind==='wrong-request'?id+1:id});
      if(kind!=='after-ready'){expect(w.terminate).not.toHaveBeenCalled();send(w,{type:'ready',timeline:{ok:true}});}
      expect(await pending).toEqual({value:{ok:true}});expect(w.terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });
  it('does not let a same-player old request skip its successor',async()=>{
    const h=harness();try{const a=h.start(),oldId=h.workers[0].request.requestId;const b=h.start(),w=h.workers[1];
      expect(await a).toMatchObject({code:'WIN_RATE_CANCELLED'});h.ctx.skipWinRate({selectedPlayerId:'player',analysisRequestId:oldId});
      expect(w.terminate).not.toHaveBeenCalled();h.ctx.skipWinRate({selectedPlayerId:'player',analysisRequestId:w.request.requestId});
      expect(await b).toMatchObject({code:'WIN_RATE_SKIPPED'});expect(w.terminate).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });
  it.each(['load','unmount','RESTORE'])('leaves %s cancellation separate from a user skip',async mode=>{
    const h=harness();try{
      if(mode==='RESTORE'){h.ctx.managedSource.value.mode='RESTORE';await h.ctx.selectHostPlayer('player');h.ctx.skipWinRate({selectedPlayerId:'player',analysisRequestId:1});expect(h.workers).toHaveLength(0);}
      else{const pending=h.ctx.selectHostPlayer('player');await vi.advanceTimersByTimeAsync(0);const id=h.workers[0].request.requestId;
        if(mode==='load')h.ctx.beginManagedLoad();else h.ctx.dispose();h.ctx.skipWinRate({selectedPlayerId:'player',analysisRequestId:id});await pending;}
      expect(h.ctx.buildCs2dAnalysisBundle).not.toHaveBeenCalled();expect(h.events.some(e=>e.phase==='unavailable'||e.type==='ANALYSIS_READY')).toBe(false);expect(vi.getTimerCount()).toBe(0);
    }finally{h.cleanup();}
  });
  it('strictly validates the actual Viewer command and keeps source/origin and optional Stage handler gates',()=>{
    const bridgePath=resolve(path,'../player/hostBridge.ts');
    const bridge=readFileSync(bridgePath,'utf8');const listeners=[];const parent={};
    const window={parent,location:{href:'http://127.0.0.1:5174/?managedLibrary=1&parentOrigin=http://127.0.0.1:3000'},addEventListener:(_type,fn)=>listeners.push(fn),removeEventListener:vi.fn()};
    const ctx={window,document:{referrer:''},URL};runInNewContext(stripTypeScriptTypes(bridge).replaceAll('export ',''),ctx);
    const skip=vi.fn();const remove=ctx.listenForPlaybackCommands({skipWinRate:skip});const removeStage=ctx.listenForPlaybackCommands({});
    const payload={type:'skipWinRate',selectedPlayerId:'player',analysisRequestId:1};
    const envelope=value=>({channel:'cs2d-playback-bridge.v1',direction:'command',payload:value});
    expect(ctx.isCommandEnvelope(envelope(payload))).toBe(true);
    for(const bad of [{...payload,analysisRequestId:0},{...payload,analysisRequestId:1.5},{...payload,analysisRequestId:Infinity},{...payload,extra:true},{...payload,selectedPlayerId:''}])expect(ctx.isCommandEnvelope(envelope(bad))).toBe(false);
    try{for(const fn of listeners){fn({source:{},origin:'http://127.0.0.1:3000',data:envelope(payload)});fn({source:parent,origin:'http://other',data:envelope(payload)});}expect(skip).not.toHaveBeenCalled();
      for(const fn of listeners)fn({source:parent,origin:'http://127.0.0.1:3000',data:envelope(payload)});expect(skip).toHaveBeenCalledExactlyOnceWith(payload);
    }finally{remove();removeStage();}
  });

});
