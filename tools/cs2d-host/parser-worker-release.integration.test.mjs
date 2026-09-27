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
function harness(options = {}) {
  const workers = []; const unmount = []; let started = deferred();
  class FakeWorker {
    constructor(url) { this.parser = url.pathname.endsWith('/demoParser.worker.ts'); this.terminate = vi.fn(); workers.push(this); }
    postMessage(message) {
      if (this.parser) { started.resolve(this); if (options.parserPostError) throw new Error('private transfer detail'); }
      else queueMicrotask(() => this.onmessage({ data: options.decompressError === undefined ? { ok: true, buffer: message.buffer, rawSize: message.buffer.byteLength } : { ok: false, error: options.decompressError } }));
    }
  }
  const ref = value => ({ value });
  const make = new Function('ref','shallowRef','onUnmounted','Worker',stripTypeScriptTypes(source.replace(/^import .*$/gm,'')).replaceAll('import.meta.url',JSON.stringify('file:///viewer/ingest/useDemoParser.ts')).replaceAll('export ','')+'\nreturn useDemoParser();');
  const parser = make(ref,ref,fn=>unmount.push(fn),FakeWorker);
  const file = { name:'fixture.dem',size:9,arrayBuffer:async()=>new Uint8Array(9).buffer };
  return { parser,workers,unmount,file,async start() { started=deferred(); const completion=parser.parse(file); const worker=await started.promise; return {worker,completion}; } };
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


describe.skipIf(!source)('actual Parser file-error feedback',()=>{
 it.each([
  ['Supports only Source 2 replays','这份文件未通过 CS2 Demo 格式检查。请选择完整的 CS2 .dem 文件；如果下载尚未完成，请完成下载后再试。'],
  ['Wrong CDemoFileInfo offset','比赛文件内容暂时无法完整读取。请确认下载完整；若仍失败，可尝试其他 CS2 Demo。'],
  ['Supports only Source 2 replays: extra','这份比赛暂时无法解析，可能与文件完整性或当前解析器兼容性有关。请确认下载完整，或尝试其他 CS2 Demo。'],
  ['private internal error','这份比赛暂时无法解析，可能与文件完整性或当前解析器兼容性有关。请确认下载完整，或尝试其他 CS2 Demo。'],
 ])('projects exact Parser error without claiming corruption: %s',async(message,expected)=>{
  const h=harness(),first=await h.start(),late=first.worker.onmessage;
  late({data:{ok:false,error:message}});await first.completion;
  expect(h.parser.error.value).toBe(expected);expect(h.parser.error.value).not.toContain('损坏');expect(first.worker.terminate).toHaveBeenCalledOnce();
  const next=await h.start();expect(h.parser.error.value).toBeNull();late({data:{ok:false,error:message}});expect(h.parser.error.value).toBeNull();
  next.worker.onmessage({data:result()});await next.completion;expect(h.parser.status.value).toBe('done');
 });
 it.each([
  ['O arquivo .zip está vazio.','压缩包中没有可读取的文件。请重新选择压缩包，或先解压为 .dem 文件。'],
  ['Demos .bz2 ainda não são suportadas. Descomprima para .dem antes de enviar.','暂不支持直接读取 .bz2 压缩包，请先解压为 .dem 文件。'],
  ['unknown decompression error','文件解压或预处理未完成。如果选择的是压缩包，请先解压为 .dem 文件后重新选择；否则可重新选择或刷新后重试。'],
 ])('keeps known container feedback and an unknown decompression fallback: %s',async(message,expected)=>{
  const h=harness({decompressError:message});await h.parser.parse(h.file);expect(h.parser.error.value).toBe(expected);expect(h.workers).toHaveLength(1);expect(h.workers[0].terminate).toHaveBeenCalledOnce();
 });
 it('distinguishes a Parser Worker crash from an invalid file',async()=>{
  const h=harness(),first=await h.start();first.worker.onerror({message:'private crash detail'});await first.completion;
  expect(h.parser.error.value).toBe('解析进程意外停止，暂时无法确认是否是文件问题。请重新选择文件后重试；若仍失败，可尝试其他 Demo。');
  expect(first.worker.terminate).toHaveBeenCalledOnce();const next=await h.start();next.worker.onmessage({data:result()});await next.completion;expect(h.parser.status.value).toBe('done');
 });
});

describe.skipIf(!source)('actual Parser transfer failure feedback',()=>{
 it('settles a failed transfer without claiming bad bytes and allows the same file again',async()=>{
  const options={parserPostError:true},h=harness(options),first=await h.start();await first.completion;
  expect(h.parser.error.value).toBe('文件未能交给解析进程，请重新选择文件后重试。');expect(first.worker.terminate).toHaveBeenCalledOnce();
  options.parserPostError=false;const next=await h.start();expect(h.parser.error.value).toBeNull();next.worker.onmessage({data:result()});await next.completion;expect(h.parser.status.value).toBe('done');
 });
});
