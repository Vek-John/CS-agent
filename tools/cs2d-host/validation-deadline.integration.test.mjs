import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
const path=resolve(process.env.CS2D_UPSTREAM_DIR || '.local-data/upstream/cs2d','apps/app/src/viewer/DemoAnalyzerView.vue');
const source=existsSync(path)?readFileSync(path,'utf8'):'';
const functions=['finalizeManagedDemo','persistSelectedDemo'].map(name=>source.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n}(?=\\n)`))?.[0]).filter(Boolean).join('\n');
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
const response=(status='READY')=>({ok:true,json:vi.fn(async()=>({schemaVersion:'desktop-library-validation.v1',demoId:'demo',status}))});
function harness(){
  vi.useFakeTimers();
  const result={demoId:'demo',contentHash:'a'.repeat(64),byteSize:9,originalFilename:'test.dem',validationToken:'once'};
  const events=[];
  const ctx={Error,AbortController,setTimeout,clearTimeout,managedLibraryMode:{value:true},pendingManagedImport:{value:{requestId:'request',file:{size:9},generation:1}},managedReadyGeneration:1,managedSource:{value:null},
    uploadManagedDemo:vi.fn(async()=>result),parseManagedFile:vi.fn(async()=>{}),assertManagedLoadCurrent:()=>{},isManagedLoadCurrent:()=>true,
    managedReplayReady:()=>({type:'REPLAY_READY'}),emitPlaybackEvent:e=>events.push(e),fetch:vi.fn(async()=>response())};
  runInNewContext(stripTypeScriptTypes(functions),ctx);
  return {ctx,result,events,start:()=>ctx.persistSelectedDemo({requestId:'request',capabilityToken:'import'})};
}
afterEach(()=>{vi.useRealTimers();});
describe.skipIf(!source)('actual Viewer VALIDATE request deadline',()=>{
  it.each(['fetch','body'])('ends hung %s once without READY or a second token submission',async phase=>{
    const h=harness();const late=deferred();const res=response();
    if(phase==='fetch')h.ctx.fetch.mockReturnValue(late.promise);else{res.json.mockReturnValue(late.promise);h.ctx.fetch.mockResolvedValue(res);}
    let ended=false;const pending=h.start().then(()=>{ended=true;});
    await vi.advanceTimersByTimeAsync(19_999);expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);expect(ended).toBe(true);await pending;
    expect(h.ctx.fetch).toHaveBeenCalledOnce();expect(h.ctx.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(h.events.filter(e=>e.type==='DEMO_IMPORT_FAILED').map(e=>e.code)).toEqual(['DEMO_VALIDATION_TIMEOUT']);
    expect(h.events.some(e=>e.type==='REPLAY_READY'||e.type==='DEMO_IMPORT_SUCCEEDED')).toBe(false);
    const count=h.events.length;late.resolve(phase==='fetch'?res:{schemaVersion:'desktop-library-validation.v1',demoId:'demo',status:'READY'});
    await vi.advanceTimersByTimeAsync(0);expect(h.events.length).toBe(count);
    if(phase==='fetch')expect(res.json).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps validated success and skips duplicate use of the same result token',async()=>{
    const h=harness();await h.start();expect(h.events.at(-1).type).toBe('REPLAY_READY');
    await h.ctx.finalizeManagedDemo(h.result,'CORRUPT');expect(h.ctx.fetch).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('does not resubmit a rejected confirmation',async()=>{
    const h=harness();h.ctx.fetch.mockResolvedValue(response('IMPORTING'));await h.start();
    expect(h.ctx.fetch).toHaveBeenCalledOnce();expect(h.events.at(-1).code).toBe('DEMO_VALIDATION_REJECTED');expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false,true])('makes a single bounded CORRUPT attempt after actual parse failure (hung: %s)',async hung=>{
    const h=harness();h.ctx.parseManagedFile.mockRejectedValue(new Error('MANAGED_DEMO_PARSE_FAILED'));
    h.ctx.fetch.mockImplementation(()=>hung?new Promise(()=>{}):Promise.resolve(response('CORRUPT')));
    let ended=false;const pending=h.start().then(()=>{ended=true;});await vi.advanceTimersByTimeAsync(20_000);
    expect(ended).toBe(true);await pending;expect(h.ctx.fetch).toHaveBeenCalledOnce();
    expect(h.ctx.fetch.mock.calls[0][1].headers['X-CS-Agent-Parse-Outcome']).toBe('CORRUPT');
    expect(h.events.at(-1).code).toBe('MANAGED_DEMO_PARSE_FAILED');expect(vi.getTimerCount()).toBe(0);
  });
  it('does not abort a later independent validation when the older one expires',async()=>{
    const h=harness();const a=deferred();const b=deferred();h.ctx.fetch.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first=h.ctx.finalizeManagedDemo({...h.result},'READY').catch(e=>e.message);
    await vi.advanceTimersByTimeAsync(1_000);let secondDone=false;
    const second=h.ctx.finalizeManagedDemo({...h.result,validationToken:'other'},'READY').then(()=>{secondDone=true;});
    await vi.advanceTimersByTimeAsync(19_000);expect(await first).toBe('DEMO_VALIDATION_TIMEOUT');expect(secondDone).toBe(false);
    expect(h.ctx.fetch.mock.calls[1][1].signal.aborted).toBe(false);b.resolve(response());await second;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not confirm an already validated deduplicated Demo without a token',async()=>{
    const h=harness();delete h.result.validationToken;await h.start();
    expect(h.ctx.fetch).not.toHaveBeenCalled();expect(h.events.at(-1).type).toBe('REPLAY_READY');expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['http','schema','demo','json'])('preserves %s response rejection',async kind=>{
    const h=harness();const res=response();
    if(kind==='http')res.ok=false;
    if(kind==='schema')res.json.mockResolvedValue({schemaVersion:'other',demoId:'demo',status:'READY'});
    if(kind==='demo')res.json.mockResolvedValue({schemaVersion:'desktop-library-validation.v1',demoId:'other',status:'READY'});
    if(kind==='json')res.json.mockRejectedValue(new Error('invalid json'));
    h.ctx.fetch.mockResolvedValue(res);await h.start();
    expect(h.ctx.fetch).toHaveBeenCalledOnce();expect(h.events.at(-1).code).toBe('DEMO_VALIDATION_REJECTED');expect(vi.getTimerCount()).toBe(0);
  });
  it('suppresses old timeout feedback after the load is replaced',async()=>{
    const h=harness();h.ctx.fetch.mockReturnValue(new Promise(()=>{}));
    const pending=h.start();await vi.advanceTimersByTimeAsync(0);h.ctx.isManagedLoadCurrent=()=>false;
    await vi.advanceTimersByTimeAsync(20_000);await pending;
    expect(h.events.some(e=>e.type==='DEMO_IMPORT_FAILED'||e.type==='REPLAY_READY'||e.type==='DEMO_IMPORT_SUCCEEDED')).toBe(false);
    expect(h.ctx.fetch).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });

});
