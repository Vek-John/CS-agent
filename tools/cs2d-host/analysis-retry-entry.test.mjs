import { existsSync, readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle } from '../../libs/cs2d-analysis-adapter/src/index.ts';
import { fireReplay, self } from '../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures.ts';
const upstream = resolve('.local-data/upstream/cs2d');
const path = resolve(upstream, 'apps/app/src/viewer/DemoAnalyzerView.vue');
const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
const functions = names => names.map(name => source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}(?=\\n)`))?.[0] ?? '').join('\n');
function selectionHarness() {
 const events=[];
 const ctx={Error,AbortController,performance,hostMode:{value:true},hostSelectedPlayerId:{value:null},managedLoadGeneration:0,managedReadyGeneration:0,managedLoadAbort:null,managedLibraryMode:{value:false},managedSource:{value:null},hostStageReady:{value:false},
  input:{value:{click:vi.fn()}}, pendingManagedImport:{value:null}, crypto:{randomUUID:()=> 'synthetic-import'}, currentId:{value:null}, hostRouteQuery:{value:{}}, recent:{save:vi.fn(async()=> 'synthetic-saved')}, router:{push:vi.fn()}, replayReadyMessage:value=>({type:'REPLAY_READY',value}),
  parser:{status:{value:'done'},fileName:{value:'fixture.dem'},fileSize:{value:72},voice:{value:null},reset:vi.fn(),replay:{value:{players:[{steamId:'self',name:'Self',startSide:'T'},{steamId:'other',name:'Other',startSide:'CT'}],rounds:[]}},demoContentHash:{value:undefined},hashLatencyMs:{value:undefined},cancel:vi.fn()},
  nextTick:async()=>{ctx.hostStageReady.value=true},route:{params:{}},inferWinRate:vi.fn(async()=>undefined),cancelWinRate:vi.fn(),buildCs2dAnalysisBundle:vi.fn(()=>{throw Error('synthetic ordinary failure')}),serializeCs2dAnalysisBundle:JSON.stringify,emitPlaybackEvent:e=>events.push(e),computed:fn=>({get value(){return fn()}})};
 const computed=source.match(/const hostSelectionLocked = computed\([^\n]+/)[0];
 runInNewContext(stripTypeScriptTypes(computed+'\n'+functions(['selectHostPlayer','beginManagedLoad','isManagedLoadCurrent','assertManagedLoadCurrent','managedReplayReady','pick','onFiles','onInput','handleFile'])),ctx);
 let onReplay;
 ctx.watch=(_getter,callback)=>{onReplay=callback};
 const watcher=source.match(/watch\(\n  \(\) => parser.replay.value,[\s\S]*?\n\)/)[0];
 runInNewContext(stripTypeScriptTypes(watcher),ctx);
 ctx.parser.parse=vi.fn(async()=>{const previous=ctx.parser.replay.value;ctx.parser.replay.value={...previous};onReplay(ctx.parser.replay.value,previous)});
 return {ctx,events};
}
async function templateHtml(status) {
 const done=status==='done';
 const require=createRequire(resolve(upstream,'apps/app/package.json'));
 const Vue=require('vue'), vueRequire=createRequire(require.resolve('vue'));
 const {compile}=vueRequire('@vue/compiler-dom'), {renderToString}=vueRequire('@vue/server-renderer');
 const template=source.slice(source.indexOf('<template>')+10,source.lastIndexOf('</template>'));
 const compiled=compile(template,{mode:'function',prefixIdentifiers:true,expressionPlugins:['typescript']}).code;
 const render=new Function('Vue',stripTypeScriptTypes('function createRender(Vue){'+compiled+'}\n')+'return createRender(Vue)')(Vue);
 const context={parser:{status:{value:status},replay:{value:done?{players:[],rounds:[]}:null},voice:{value:null},fileName:{value:'fixture.dem'},fileSize:{value:0}},hostMode:true,hostSelectionLocked:done,activeTab:'viewer',currentId:null,skipFreeze:false,autoplay:false,
  extDownload:null,routeLoading:false,importing:false,showPreview:false,dragging:false,heatmapSource:null,hostSelectedPlayerId:'self',input:null,importInput:null,t:x=>x,fmtSize:()=>'',onFiles(){},onDrop(){},onInput(){},pick(){},onHostStageReady(){},goTab(){},onGrenadeJump(){},goHeatmapSource(){}};
 const app=Vue.createSSRApp({render,setup:()=>context,components:{ViewerStage:{render:()=>Vue.h('div',{'data-stub-stage':''})}}});
 app.config.warnHandler=()=>{};
 return renderToString(app);
}
describe.skipIf(!source)('actual failed analysis recovery entry',()=>{
 it('keeps current-subject lock after ordinary failure, so repeating select is not retry',async()=>{
  const h=selectionHarness();await h.ctx.selectHostPlayer('self');
  expect(h.events.filter(e=>e.type==='ANALYSIS_FAILED')).toHaveLength(1);
  await h.ctx.selectHostPlayer('self');await h.ctx.selectHostPlayer('other');
  expect(h.ctx.buildCs2dAnalysisBundle).toHaveBeenCalledOnce();expect(h.ctx.hostSelectedPlayerId.value).toBe('self');
 });
 it('keeps the actual template file-picker input reachable after parser is done',async()=>{
  expect((await templateHtml('idle')).match(/type="file"/g)).toHaveLength(1);
  expect((await templateHtml('done')).match(/type="file"/g)??[]).toHaveLength(1);
  expect((await templateHtml('reading')).match(/type="file"/g)??[]).toHaveLength(1);
 });
});

describe.skipIf(!source)('explicit fresh-file recovery without unlocking current subject',()=>{
 it('opening then cancelling the picker preserves failure data and does not analyze',async()=>{
  const h=selectionHarness();await h.ctx.selectHostPlayer('self');const current=h.ctx.parser.replay.value,count=h.events.length;
  h.ctx.pick();expect(h.ctx.input.value.click).toHaveBeenCalledOnce();
  await h.ctx.onFiles(undefined);await h.ctx.onFiles([]);
  expect(h.ctx.parser.replay.value).toBe(current);expect(h.ctx.hostSelectedPlayerId.value).toBe('self');
  expect(h.events).toHaveLength(count);expect(h.ctx.buildCs2dAnalysisBundle).toHaveBeenCalledOnce();expect(h.ctx.parser.parse).not.toHaveBeenCalled();
 });
 it('accepts explicit same-file choices, resets input value, and succeeds after the new replay watcher unlocks selection',async()=>{
  const h=selectionHarness();h.ctx.parser.replay.value=fireReplay('DEATH',[]);await h.ctx.selectHostPlayer(self);
  const actual=h.ctx.onFiles;let pending;h.ctx.onFiles=files=>{pending=actual(files);return pending};
  const file={name:'fixture.dem',size:72};const input={files:[file],value:'fixture.dem'};
  h.ctx.onInput({target:input});expect(input.value).toBe('');await pending;
  expect(h.ctx.hostSelectedPlayerId.value).toBe(null);expect(h.ctx.parser.parse).toHaveBeenCalledOnce();
  h.ctx.buildCs2dAnalysisBundle.mockImplementation(buildCs2dAnalysisBundle);h.ctx.serializeCs2dAnalysisBundle=serializeCs2dAnalysisBundle;await h.ctx.selectHostPlayer(self);
  expect(h.events.filter(e=>e.type==='ANALYSIS_FAILED')).toHaveLength(1);expect(h.events.filter(e=>e.type==='ANALYSIS_READY')).toHaveLength(1);
  const ready=h.events.find(e=>e.type==='ANALYSIS_READY');const restored=deserializeCs2dAnalysisBundle(ready.bundleJson);
  expect(ready.selectedPlayerId).toBe(self);expect(restored.selected_steam_id).toBe(self);expect(restored.review_plan.cues.length).toBeGreaterThan(0);
  input.value='fixture.dem';h.ctx.onInput({target:input});expect(input.value).toBe('');await pending;
  expect(h.ctx.parser.parse).toHaveBeenCalledTimes(2);
 });
 it('resets a managed failure only on new file choice and preserves RESTORE zero generation',async()=>{
  const h=selectionHarness();h.ctx.managedLibraryMode.value=true;await h.ctx.selectHostPlayer('self');
  await h.ctx.onFiles([{name:'fixture.dem',size:72}]);
  expect(h.ctx.hostSelectedPlayerId.value).toBe(null);expect(h.events.at(-1).type).toBe('DEMO_IMPORT_REQUESTED');
  expect(h.ctx.parser.parse).not.toHaveBeenCalled();expect(h.ctx.buildCs2dAnalysisBundle).toHaveBeenCalledOnce();
  const hash='a'.repeat(64);h.ctx.parser.demoContentHash.value=hash;
  h.ctx.managedReplayReady({mode:'RESTORE',contentHash:hash},h.ctx.managedLoadGeneration);
  const inferred=h.ctx.inferWinRate.mock.calls.length;await h.ctx.selectHostPlayer('self');
  expect(h.ctx.inferWinRate).toHaveBeenCalledTimes(inferred);expect(h.ctx.buildCs2dAnalysisBundle).toHaveBeenCalledOnce();
 });
 it('ignores the old inference result after an explicit managed file change',async()=>{
  const h=selectionHarness();h.ctx.managedLibraryMode.value=true;let resolve;
  h.ctx.inferWinRate.mockImplementation(()=>new Promise(r=>{resolve=r}));
  const old=h.ctx.selectHostPlayer('self');await vi.waitFor(()=>expect(h.ctx.inferWinRate).toHaveBeenCalledOnce());
  await h.ctx.onFiles([{name:'other.dem',size:72}]);resolve(undefined);await old;
  expect(h.ctx.buildCs2dAnalysisBundle).not.toHaveBeenCalled();
  expect(h.events.some(e=>e.type==='ANALYSIS_FAILED'||e.type==='ANALYSIS_READY')).toBe(false);
 });
});

it('wires the visible Host failure button to the existing picker command without clearing failure state',()=>{
 const host=readFileSync(resolve('apps/web/components/playback/cs2d-playback-host.tsx'),'utf8');
 const start=host.indexOf('{analysisError ? (');
 const card=host.slice(start,host.indexOf('{session && userTookOver ? (',start));
 const button=card.match(/<button type="button"[\s\S]*?onClick=\{(\(\) => send\([\s\S]*?\))\}>重新选择 Demo<\/button>/)?.[1];
 expect(button).toBeDefined();const send=vi.fn();
 const action=runInNewContext(stripTypeScriptTypes('const click = '+button+';\nclick'),{send});action();
 expect(send).toHaveBeenCalledOnce();expect(send).toHaveBeenCalledWith({type:'requestDemoPicker'});
 expect(source).toContain('requestDemoPicker: pick');
});
