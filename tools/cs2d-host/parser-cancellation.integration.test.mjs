import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const upstream=resolve(process.env.CS2D_UPSTREAM_DIR||'.local-data/upstream/cs2d');
const parserPath=resolve(upstream,'apps/app/src/viewer/ingest/useDemoParser.ts'),viewerPath=resolve(upstream,'apps/app/src/viewer/DemoAnalyzerView.vue');
const source=existsSync(parserPath)?readFileSync(parserPath,'utf8'):'';
const viewer=existsSync(viewerPath)?readFileSync(viewerPath,'utf8'):'';
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
const result=()=>({type:'result',ok:true,replay:{rounds:[]},voice:{tracks:[]},demoContentHash:'a'.repeat(64),hashLatencyMs:1});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function harness(autoDecompress=true,parserStartFailures=0){
  const workers=[],unmount=[];
  class FakeWorker{
    constructor(url){this.parser=url.pathname.endsWith('/demoParser.worker.ts');if(this.parser&&parserStartFailures>0){parserStartFailures--;throw new Error('Worker startup denied');}this.terminate=vi.fn();workers.push(this);}
    postMessage(message){this.message=message;if(!this.parser&&autoDecompress)queueMicrotask(()=>this.onmessage?.({data:{ok:true,buffer:message.buffer,rawSize:9}}));}
  }
  const ref=value=>({value});
  const make=new Function('ref','shallowRef','onUnmounted','Worker',stripTypeScriptTypes(source.replace(/^import .*$/gm,'')).replaceAll('import.meta.url',JSON.stringify('file:///viewer/ingest/useDemoParser.ts')).replaceAll('export ','')+'\nreturn useDemoParser();');
  const parser=make(ref,ref,fn=>unmount.push(fn),FakeWorker);
  const ctx={parser,AbortController,managedLoadGeneration:0,managedReadyGeneration:-1,managedLoadAbort:null,managedParseTail:Promise.resolve(),managedSource:{value:null},winRateWorker:null,hostSelectedPlayerId:{value:null},hostStageReady:{value:false}};
  const names=['beginManagedLoad','isManagedLoadCurrent','assertManagedLoadCurrent','parseManagedFile'];
  const fns=names.map(name=>viewer.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}(?=\\n)`))?.[0]).join('\n');
  runInNewContext(stripTypeScriptTypes(fns),ctx);
  const file={name:'small.dem',size:9,arrayBuffer:async()=>new Uint8Array(9).buffer};
  return {parser,ctx,file,workers,unmount,async cleanup(){parser.cancel?.();for(let i=0;i<4;i++){for(const w of workers)w.onmessage?.({data:w.parser?result():{ok:true,buffer:new ArrayBuffer(9),rawSize:9}});await flush();}}};
}
describe.skipIf(!source||!viewer)('actual Parser cancellation',()=>{
it('releases the actual managed parse tail when another file starts',async()=>{
  const h=harness();let oldSettled=false;const source={contentHash:'a'.repeat(64)};
  try{
    const first=h.ctx.beginManagedLoad();const a=h.ctx.parseManagedFile(h.file,source,first.generation).then(()=>{oldSettled=true;},()=>{oldSettled=true;});
    await flush();expect(h.workers.filter(w=>w.parser)).toHaveLength(1);
    const old=h.workers.find(w=>w.parser);
    const second=h.ctx.beginManagedLoad();const b=h.ctx.parseManagedFile(h.file,source,second.generation).catch(()=>{});
    await flush();
    expect(oldSettled).toBe(true);expect(old.terminate).toHaveBeenCalledOnce();expect(h.workers.filter(w=>w.parser)).toHaveLength(2);
    h.workers.filter(w=>w.parser)[1].onmessage({data:result()});await Promise.all([a,b]);
  }finally{await h.cleanup();}
});

it.each(['read','decompress','parser'])('settles cancellation during %s and ignores all late work',async phase=>{
  const h=harness(phase!=='decompress'),read=deferred();
  try{
    const pending=h.parser.parse(phase==='read'?{...h.file,arrayBuffer:()=>read.promise}:h.file);await flush();
    const old=h.workers.at(-1),message=old?.onmessage,error=old?.onerror;
    h.parser.cancel();expect(await pending).toBe(false);
    if(old)expect(old.terminate).toHaveBeenCalledOnce();
    const next=h.parser.parse(h.file);await flush();
    if(phase==='decompress'){h.workers.at(-1).onmessage({data:{ok:true,buffer:new ArrayBuffer(9),rawSize:9}});await flush();}
    const current=h.workers.at(-1);expect(current.parser).toBe(true);
    read.resolve(new ArrayBuffer(9));message?.({data:{type:'progress',phase:'parsing',tick:99,totalTicks:100}});
    message?.({data:phase==='decompress'?{ok:true,buffer:new ArrayBuffer(9),rawSize:99}:result()});error?.({message:'late error'});await flush();
    expect(h.parser.status.value).toBe('parsing');expect(h.parser.replay.value).toBeNull();expect(h.parser.error.value).toBeNull();
    expect(current.terminate).not.toHaveBeenCalled();current.onmessage({data:result()});await next;
    expect(h.parser.status.value).toBe('done');
  }finally{await h.cleanup();}
});
it('ignores a rejected old File read after a newer parse completes',async()=>{
  const h=harness(),read=deferred();
  try{const old=h.parser.parse({...h.file,arrayBuffer:()=>read.promise});await flush();
    const next=h.parser.parse(h.file);await flush();expect(await old).toBe(false);
    h.workers.at(-1).onmessage({data:result()});await next;read.reject(new Error('late read denied'));await flush();
    expect(h.parser.status.value).toBe('done');expect(h.parser.error.value).toBeNull();
  }finally{await h.cleanup();}
});
it.each(['reset','hydrate','unmount'])('settles a pending parser on %s without late state writes',async action=>{
  const h=harness();
  try{const pending=h.parser.parse(h.file);await flush();const w=h.workers.at(-1),late=w.onmessage;
    const hydrated={rounds:[{restored:true}]};
    if(action==='hydrate')h.parser.hydrate({replay:hydrated,voice:null,fileName:'saved.cs2dv'});
    else if(action==='reset')h.parser.reset();else h.unmount.forEach(fn=>fn());
    expect(await pending).toBe(false);expect(w.terminate).toHaveBeenCalledOnce();late({data:result()});
    expect(h.parser.replay.value).toBe(action==='hydrate'?hydrated:null);
    expect(h.parser.status.value).toBe(action==='hydrate'?'done':'idle');
  }finally{await h.cleanup();}
});
it('does not save or navigate an old nonmanaged handleFile after hydrate cancels it',async()=>{
  const h=harness();
  try{const fn=viewer.match(/async function handleFile\([\s\S]*?\n}(?=\n)/)[0];
    const recent={save:vi.fn(async()=>'wrong')},router={push:vi.fn()};
    Object.assign(h.ctx,{managedLibraryMode:{value:false},hostMode:{value:false},recent,router,currentId:{value:null}});
    runInNewContext(stripTypeScriptTypes(fn),h.ctx);
    const pending=h.ctx.handleFile(h.file);await flush();
    h.parser.hydrate({replay:{rounds:[]},voice:null,fileName:'other.cs2dv'});await pending;
    expect(recent.save).not.toHaveBeenCalled();expect(router.push).not.toHaveBeenCalled();
  }finally{await h.cleanup();}
});
it('leaves completed Replay, voice and hash available when a managed load cancels pending work',async()=>{
  const h=harness();
  try{const pending=h.parser.parse(h.file);await flush();const value=result();h.workers.at(-1).onmessage({data:value});await pending;
    h.ctx.beginManagedLoad();expect(h.parser.status.value).toBe('done');expect(h.parser.replay.value).toBe(value.replay);
    expect(h.parser.voice.value).toBe(value.voice);expect(h.parser.demoContentHash.value).toBe(value.demoContentHash);
  }finally{await h.cleanup();}
});
it('does not begin File IO after cancellation in the same call stack',async()=>{
  const h=harness(),arrayBuffer=vi.fn(async()=>new ArrayBuffer(9));
  try{const pending=h.parser.parse({...h.file,arrayBuffer});h.parser.cancel();expect(await pending).toBe(false);await flush();
    expect(arrayBuffer).not.toHaveBeenCalled();expect(h.workers).toHaveLength(0);
  }finally{await h.cleanup();}
});

it('settles Parser Worker startup failure as retryable error and releases its operation',async()=>{
  const h=harness(true,1);
  try{
    await expect(h.parser.parse(h.file)).resolves.toBeUndefined();
    expect(h.parser.status.value).toBe('error');expect(h.parser.error.value).toBe('无法启动 Demo 解析，请重新选择文件后重试。');
    expect(h.parser.replay.value).toBeNull();expect(h.parser.demoContentHash.value).toBeNull();
    expect(h.workers).toHaveLength(1);expect(h.workers[0].terminate).toHaveBeenCalledOnce();
    h.parser.cancel();expect(h.parser.status.value).toBe('error');
    const next=h.parser.parse(h.file);await flush();h.workers.at(-1).onmessage({data:result()});await next;
    expect(h.parser.status.value).toBe('done');expect(h.parser.error.value).toBeNull();
  }finally{await h.cleanup();}
});
it('fails the managed load without blocking its next parse after startup failure',async()=>{
  const h=harness(true,1),source={contentHash:'a'.repeat(64)};
  try{
    const first=h.ctx.beginManagedLoad();
    await expect(h.ctx.parseManagedFile(h.file,source,first.generation)).rejects.toThrow('MANAGED_DEMO_PARSE_FAILED');
    const second=h.ctx.beginManagedLoad();const next=h.ctx.parseManagedFile(h.file,source,second.generation);await flush();
    h.workers.at(-1).onmessage({data:result()});await next;expect(h.parser.status.value).toBe('done');
  }finally{await h.cleanup();}
});

});
