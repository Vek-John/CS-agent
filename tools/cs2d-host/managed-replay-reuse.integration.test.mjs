import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// Executes the patched Viewer functions. Requires the normal cs2d setup checkout;
// no browser, user Demo, real parser Worker or disk library is used.
const path = resolve(process.env.CS2D_UPSTREAM_DIR || '.local-data/upstream/cs2d', 'apps/app/src/viewer/DemoAnalyzerView.vue');
const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
const names = ['beginManagedLoad', 'isManagedLoadCurrent', 'assertManagedLoadCurrent', 'parseManagedFile', 'managedReplayReady', 'persistSelectedDemo', 'loadManagedDemo'];
const functions = names.map(name => source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}(?=\\n)`))?.[0]).filter(Boolean).join('\n');
const bytes = new Uint8Array([80, 66, 68, 69, 77, 83, 50, 0, 1]);
const digest = async body => Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', await body.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
async function harness() {
  const body = new Blob([bytes]); const hash = await digest(body);
  const replay = { players: [{ steamId: 'player' }], rounds: [] };
  const parser = { status: { value: 'idle' }, replay: { value: null }, demoContentHash: { value: null }, hashLatencyMs: { value: 1 }, fileName: { value: 'match.dem' }, parse: vi.fn(async file => { parser.status.value='done'; parser.replay.value=replay; parser.demoContentHash.value=await digest(file); }) };
  const result = { demoId: 'demo', contentHash: hash, originalFilename: 'match.dem', byteSize: body.size, deduplicated: true };
  const command = { ...result, requestId: 'restore', capabilityToken: 'fresh-read', mode: 'RESTORE' };
  const events=[]; const stages=[];
  const ctx = { managedLibraryMode:{value:true}, managedSource:{value:null}, pendingManagedImport:{value:null}, managedLoadGeneration:0, managedReadyGeneration:-1, managedLoadAbort:null, managedParseTail:Promise.resolve(), winRateWorker:null, hostSelectedPlayerId:{value:null}, hostStageReady:{value:false}, routeLoading:{value:false}, parser, File, performance, crypto:webcrypto, AbortController,
    uploadManagedDemo:vi.fn(async()=>result), finalizeManagedDemo:vi.fn(async()=>{}), emitPlaybackEvent:e=>events.push(e), replayReadyMessage:r=>({type:'REPLAY_READY',source:r.managedSource}),
    fetch:vi.fn(async()=>new Response(body,{headers:{'content-type':'application/octet-stream','content-length':String(body.size)}})),
    nextTick:vi.fn(async()=>{stages.push(ctx.hostSelectedPlayerId.value);}) };
  runInNewContext(stripTypeScriptTypes(functions),ctx);
  const initial=ctx.beginManagedLoad();
  ctx.pendingManagedImport.value={requestId:'import',file:new File([body],'match.dem'),generation:initial.generation,signal:initial.signal};
  await ctx.persistSelectedDemo({requestId:'import',capabilityToken:'write'});
  expect(parser.parse).toHaveBeenCalledOnce(); expect(events.at(-1).type).toBe('REPLAY_READY');
  return {ctx,parser,replay,body,hash,command,events,stages};
}

describe.skipIf(!source)('actual Viewer warm managed RESTORE',()=>{
  it('keeps fresh authenticated READ but parses once across import and restore',async()=>{
    const h=await harness();h.ctx.hostSelectedPlayerId.value='player';
    await h.ctx.loadManagedDemo(h.command);
    expect(h.ctx.fetch).toHaveBeenCalledOnce();
    expect(h.ctx.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fresh-read');
    expect(h.parser.parse).toHaveBeenCalledOnce(); expect(h.parser.replay.value).toBe(h.replay);
    expect(h.stages).toEqual([null]); expect(h.events.at(-1).source.requestId).toBe('restore');
    expect(h.events.at(-1).source.mode).toBe('RESTORE'); expect(h.ctx.managedReadyGeneration).toBe(2);
    expect(h.ctx.routeLoading.value).toBe(false);
  });
  it.each(['REANALYZE','SELECT_PLAYER','different-id','not-ready','unknown-hash'])('retains cold parse for %s',async reason=>{
    const h=await harness();
    if(['REANALYZE','SELECT_PLAYER'].includes(reason))h.command.mode=reason;
    if(reason==='different-id')h.command.demoId='other';
    if(reason==='not-ready')h.ctx.managedReadyGeneration=-1;
    if(reason==='unknown-hash')h.parser.demoContentHash.value=null;
    await h.ctx.loadManagedDemo(h.command);
    expect(h.parser.parse).toHaveBeenCalledTimes(2);expect(h.events.at(-1).type).toBe('REPLAY_READY');
  });
  it.each(['unauthorized','changed-bytes','wrong-length'])('never serves cached Replay after %s',async reason=>{
    const h=await harness();
    h.ctx.fetch.mockImplementation(async()=>new Response(new Blob([new Uint8Array(bytes.length)]),{status:reason==='unauthorized'?403:200,headers:{'content-type':'application/octet-stream','content-length':String(reason==='wrong-length'?99:bytes.length)}}));
    await h.ctx.loadManagedDemo(h.command);
    expect(h.events.at(-1).type).toBe('DEMO_IMPORT_FAILED');expect(h.ctx.managedReadyGeneration).toBe(-1);
  });
  it('does not publish or clear the successor loading state after an old body resolves',async()=>{
    const h=await harness();let resolveBody;let started;const bodyStarted=new Promise(resolve=>{started=resolve;});
    h.ctx.fetch.mockImplementation(async()=>({ok:true,headers:new Headers({'content-type':'application/octet-stream','content-length':String(bytes.length)}),blob:()=>new Promise(resolve=>{resolveBody=resolve;started();})}));
    const pending=h.ctx.loadManagedDemo(h.command);await bodyStarted;
    h.ctx.beginManagedLoad();h.ctx.routeLoading.value=true;const before=h.events.length;
    resolveBody(h.body);await pending;
    expect(h.events.length).toBe(before);expect(h.ctx.routeLoading.value).toBe(true);expect(h.parser.parse).toHaveBeenCalledOnce();
  });
  it('rejects an old hash completion after another load begins',async()=>{
    const h=await harness();let finishHash;let started;const hashing=new Promise(resolve=>{started=resolve;});
    h.ctx.crypto={subtle:{digest:()=>new Promise(resolve=>{finishHash=resolve;started();})}};
    const pending=h.ctx.loadManagedDemo(h.command);await hashing;
    h.ctx.beginManagedLoad();const before=h.events.length;
    finishHash(await webcrypto.subtle.digest('SHA-256',bytes));await pending;
    expect(h.events.length).toBe(before);expect(h.parser.parse).toHaveBeenCalledOnce();
    expect(h.ctx.managedReadyGeneration).toBe(-1);
  });
  it('does not emit ready if the load changes while the old stage unmounts',async()=>{
    const h=await harness();h.ctx.nextTick.mockImplementation(async()=>{h.ctx.beginManagedLoad();});
    const before=h.events.length;await h.ctx.loadManagedDemo(h.command);
    expect(h.events.length).toBe(before);expect(h.ctx.managedReadyGeneration).toBe(-1);
  });

});
