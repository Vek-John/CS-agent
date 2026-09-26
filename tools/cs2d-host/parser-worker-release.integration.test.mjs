import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const path = resolve(process.env.CS2D_UPSTREAM_DIR || '.local-data/upstream/cs2d', 'apps/app/src/viewer/ingest/useDemoParser.ts');
const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
function deferred() {
  let resolve; const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function harness() {
  const workers = []; const unmount = []; let started = deferred();
  class FakeWorker {
    constructor(url) { this.parser = url.pathname.endsWith('/demoParser.worker.ts'); this.terminate = vi.fn(); workers.push(this); }
    postMessage(message) {
      if (this.parser) started.resolve(this);
      else queueMicrotask(() => this.onmessage({ data: { ok: true, buffer: message.buffer, rawSize: message.buffer.byteLength } }));
    }
  }
  const ref = value => ({ value });
  const make = new Function('ref','shallowRef','onUnmounted','Worker',stripTypeScriptTypes(source.replace(/^import .*$/gm,'')).replaceAll('import.meta.url',JSON.stringify('file:///viewer/ingest/useDemoParser.ts')).replaceAll('export ','')+'\nreturn useDemoParser();');
  const parser = make(ref,ref,fn=>unmount.push(fn),FakeWorker);
  const file = { name:'fixture.dem',size:9,arrayBuffer:async()=>new Uint8Array(9).buffer };
  return { parser,workers,unmount,async start() { started=deferred(); const completion=parser.parse(file); const worker=await started.promise; return {worker,completion}; } };
}
const result = () => ({ ok:true,replay:{rounds:[]},voice:{tracks:[{packets:[{data:new Uint8Array([1,2])}]}]},demoContentHash:'a'.repeat(64),hashLatencyMs:3 });

describe.skipIf(!source)('actual useDemoParser terminal worker lifetime',()=>{
  it('retains page data but releases the worker after a successful result',async()=>{
    const h=harness();const {worker,completion}=await h.start();const data=result();
    worker.onmessage({data});await completion;
    expect(worker.terminate).toHaveBeenCalledOnce();expect(worker.onmessage).toBeNull();expect(worker.onerror).toBeNull();
    expect(h.parser.replay.value).toBe(data.replay);expect(h.parser.voice.value).toBe(data.voice);
    expect(h.parser.voice.value.tracks[0].packets[0].data.byteLength).toBe(2);
    expect(h.parser.demoContentHash.value).toBe(data.demoContentHash);expect(h.parser.hashLatencyMs.value).toBe(3);expect(h.parser.status.value).toBe('done');
    h.unmount.forEach(fn=>fn());expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('keeps progress alive until a terminal message',async()=>{
    const h=harness();const {worker,completion}=await h.start();let settled=false;void completion.then(()=>{settled=true;});
    worker.onmessage({data:{type:'progress',phase:'parsing',tick:2,totalTicks:10}});await Promise.resolve();
    expect(worker.terminate).not.toHaveBeenCalled();expect(settled).toBe(false);expect(h.parser.parseTick.value).toBe(2);
    worker.onmessage({data:result()});await completion;expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it.each(['result-error','worker-error'])('releases on %s and allows a fresh next parse',async reason=>{
    const h=harness();const first=await h.start();const oldError=first.worker.onerror;const oldMessage=first.worker.onmessage;
    if(reason==='result-error')oldMessage({data:{ok:false,error:'bad demo'}});else oldError({message:'worker crash'});
    await first.completion;expect(first.worker.terminate).toHaveBeenCalledOnce();expect(h.parser.status.value).toBe('error');
    const second=await h.start();expect(second.worker).not.toBe(first.worker);
    oldError({message:'late crash'});oldMessage({data:result()});
    expect(second.worker.terminate).not.toHaveBeenCalled();expect(h.parser.status.value).toBe('parsing');expect(h.parser.error.value).toBeNull();
    second.worker.onmessage({data:result()});await second.completion;expect(second.worker.terminate).toHaveBeenCalledOnce();
  });
  it('does not let old success or progress overwrite a subsequent parse',async()=>{
    const h=harness();const first=await h.start();const stale=first.worker.onmessage;
    stale({data:result()});await first.completion;
    const second=await h.start();expect(second.worker).not.toBe(first.worker);
    stale({data:{type:'progress',phase:'parsing',tick:99,totalTicks:100}});stale({data:result()});
    expect(h.parser.status.value).toBe('parsing');expect(h.parser.replay.value).toBeNull();expect(h.parser.parseTick.value).toBe(0);
    second.worker.onmessage({data:result()});await second.completion;
    expect(h.workers.filter(w=>w.parser)).toHaveLength(2);
  });
  it.each([new Error('permission lost'), 'unavailable', undefined])('settles unreadable files as retryable error (%s)',async reason=>{
    const h=harness();
    await expect(h.parser.parse({name:'unreadable.dem',size:9,arrayBuffer:async()=>{throw reason;}})).resolves.toBeUndefined();
    expect(h.parser.status.value).toBe('error');
    expect(h.parser.error.value).toBe('无法读取 Demo 文件，请重新选择后重试。');
    expect(h.parser.replay.value).toBeNull();expect(h.parser.demoContentHash.value).toBeNull();
    expect(h.workers).toHaveLength(0);
    const next=await h.start();next.worker.onmessage({data:result()});await next.completion;
    expect(h.parser.status.value).toBe('done');expect(h.parser.error.value).toBeNull();
    expect(next.worker.terminate).toHaveBeenCalledOnce();
  });

});
