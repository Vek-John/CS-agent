import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const path=resolve(process.env.CS2D_UPSTREAM_DIR||'.local-data/upstream/cs2d','apps/app/src/viewer/DemoAnalyzerView.vue');
const source=existsSync(path)?readFileSync(path,'utf8'):'';
function harness(){
  const workers=[],events=[];
  class FakeWorker{constructor(){this.terminate=vi.fn();workers.push(this);}postMessage(value){this.request=value;}}
  const ctx={Worker:FakeWorker,URL,Error,route:{query:{}},winRateWorker:null,winRateRequestId:0,CS_NET_DEFAULT_PROVIDER:'wasm-int8',CS_NET_DEFAULT_BATCH_SIZE:16,emitPlaybackEvent:e=>events.push(e),console:{info:()=>{}}};
  const fn=source.match(/function inferWinRate\([\s\S]*?\n}(?=\n)/)[0].replaceAll('import.meta.url',JSON.stringify('file:///viewer/DemoAnalyzerView.vue'));
  runInNewContext(stripTypeScriptTypes(fn),ctx);
  return {ctx,workers,events,start(){return ctx.inferWinRate({rounds:[]},'player').then(value=>({value}),error=>({error:error.message}));},cleanup(){for(const w of workers){w.onmessage=null;w.onerror=null;w.terminate();}}};
}
function ready(worker){worker.onmessage({data:{type:'ready',requestId:worker.request.requestId,timeline:{marker:'current'}}});}
describe.skipIf(!source)('actual win-rate Worker error ownership',()=>{
  it.each([false,true])('ignores an old error after a successor starts (previous completed: %s)',async completed=>{
    const h=harness();
    try{
      const first=h.start(),old=h.workers[0],oldError=old.onerror;
      if(completed){ready(old);await first;}
      const second=h.start(),current=h.workers[1];
      oldError({message:'old error'});
      expect(h.ctx.winRateWorker).toBe(current);expect(current.terminate).not.toHaveBeenCalled();
      ready(current);expect(await second).toEqual({value:{marker:'current'}});expect(h.ctx.winRateWorker).toBeNull();
    }finally{h.cleanup();}
  });
  it('keeps the current failure actionable and permits the next inference',async()=>{
    const h=harness();
    try{
      const failed=h.start(),worker=h.workers[0];worker.onerror({message:'current failure'});
      expect(await failed).toEqual({error:'current failure'});expect(worker.terminate).toHaveBeenCalledOnce();expect(h.ctx.winRateWorker).toBeNull();
      const next=h.start();ready(h.workers[1]);expect(await next).toEqual({value:{marker:'current'}});
    }finally{h.cleanup();}
  });
  it('keeps current progress and ignores old request messages',async()=>{
    const h=harness();
    try{
      h.start();const old=h.workers[0],oldMessage=old.onmessage;const pending=h.start(),current=h.workers[1];
      oldMessage({data:{type:'progress',requestId:old.request.requestId,phase:'inference',completed:1,total:2}});
      current.onmessage({data:{type:'progress',requestId:current.request.requestId,phase:'inference',completed:1,total:2}});
      expect(h.events).toHaveLength(1);expect(h.events[0].type).toBe('ANALYSIS_PROGRESS');
      ready(current);await pending;
    }finally{h.cleanup();}
  });
});
