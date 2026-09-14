/** One controller owns production localhost servers, browser, and cleanup. No raw Replay leaves its page. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createViewerHandler } from '../apps/desktop-runtime/src/viewer.ts';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const playwrightPath=process.env.PLAYWRIGHT_MODULE;
const {chromium}=playwrightPath ? require(playwrightPath) : require('playwright');
const root=process.cwd(), out=resolve(root,'.local-data/acceptance-trusted-decisions');
const result={status:'RUNNING',stages:[],errors:[],requests:{},cues:[],cueVisits:[],cleanup:false};
let browser; let activePage; let viewerServer; const services=[]; let deadlineTimer;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(port){await new Promise((ok,bad)=>{const s=createServer();s.once('error',bad);s.listen(port,'127.0.0.1',()=>s.close(ok));});}
function start(cmd,args,cwd){const child=spawn(cmd,args,{cwd,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DEEPSEEK_API_KEY:'',MEMORY_ENABLED:'false',DEPLOY_TARGET:'localhost',CS2D_BASE_PATH:'/cs2d/'}});let logs='';for(const stream of [child.stdout,child.stderr]) stream.on('data',v=>logs=(logs+v).slice(-4000));services.push({child,logs:()=>logs});return child;}
async function http(url){const until=Date.now()+45000;while(Date.now()<until){try{if((await fetch(url,{signal:AbortSignal.timeout(1500)})).ok)return;}catch{}await delay(500);}throw Error(`HTTP_NOT_READY ${url}`);}
async function snapshot(page,name){await page.screenshot({path:resolve(out,`${name}.png`),fullPage:false});}
async function main(){
 await mkdir(out,{recursive:true}); await freePort(3000);await freePort(5174);
 start(process.execPath,[resolve(root,'apps/web/node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3000'],resolve(root,'apps/web'));
 viewerServer=createHttpServer(await createViewerHandler(resolve(root,'.local-data/upstream/cs2d/apps/app/dist'),()=> 'http://localhost:3000',()=> 'localhost:5174'));
 await new Promise((ok,bad)=>{viewerServer.once('error',bad);viewerServer.listen(5174,'127.0.0.1',ok);});
 await Promise.all([http('http://127.0.0.1:3000/'),http('http://localhost:5174/')]);result.stages.push('production_servers_ready');
 for(const asset of ['/maps/de_mirage_radar.png','/models/cs-net/win-rate.fp16.onnx','/ort-wasm-simd-threaded.asyncify.wasm']) {
  const response=await fetch(`http://localhost:5174${asset}`,{method:'HEAD'});assert.equal(response.status,200,asset);assert(!response.headers.get('content-type')?.includes('text/html'),asset);
 }
 result.stages.push('production_viewer_asset_smoke');
 if(process.argv.includes('--smoke')){result.status='PASS';return;}
 browser=await chromium.launch({executablePath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:true,timeout:20000});
 const page=await browser.newPage({viewport:{width:1512,height:982},reducedMotion:'reduce'});
 activePage=page;
 page.on('response',response=>{if(response.status()>=400){result.httpErrors??=[];result.httpErrors.push({url:response.url(),status:response.status()});}});
 page.on('console',msg=>{if(msg.type()==='error') result.errors.push(msg.text().slice(0,300));});
 page.on('pageerror',e=>result.errors.push(String(e).slice(0,300)));
 page.on('response',async response=>{if(new URL(response.url()).pathname==='/api/coaching/agent'){try{const body=await response.json();const r=body.result??body;const request=response.request().postDataJSON();result.agentResponses??=[];result.agentResponses.push({http:response.status(),event:request?.event?.type,status:r.status,restored:r.restored,reason:r.reason,checkpoint:r.checkpoint,state:r.state?{activeCueId:r.state.activeCueId,currentSessionPhase:r.state.currentSessionPhase,runStatus:r.state.runStatus,routeCursor:r.state.routeCursor,fallbackReasons:r.state.fallbackReasons,caseIds:Object.keys(r.state.cueCases??{})}:null});}catch{}}});
 page.on('request',req=>{const p=new URL(req.url()).pathname;if(p.startsWith('/api/'))result.requests[p]=(result.requests[p]??0)+1;});
 await page.addInitScript(()=>{
  window.__trust={analysis:null,ready:null,playback:null,telemetry:[],seenOutcome:{},gateObservations:[]};
  addEventListener('message',e=>{const p=e.data?.payload;if(!p)return;if(p.type==='REPLAY_READY')window.__trust.ready=p;if(p.type==='PLAYBACK_STATE'){window.__trust.playback=p;for(const cue of window.__trust.analysis?.cues??[]){if(p.playing&&p.canonicalTick>=cue.outcomeEnd&&p.canonicalTick<=cue.outcomeEnd+128)window.__trust.seenOutcome[cue.id]=true;}}if(p.type==='ANALYSIS_TELEMETRY')window.__trust.telemetry.push(p.telemetry);if(p.type==='ANALYSIS_READY'){const b=JSON.parse(p.bundleJson);window.__trust.analysis={player:b.selected_steam_id,rounds:b.match_timeline.rounds.length,cues:b.review_plan.cues.map(c=>({id:c.id,decision:c.decision_tick,outcomeEnd:c.outcome_end_tick,assessment:c.assessment,advice:c.advice})),candidateCount:b.candidate_set.candidates.length,bundleBytes:new TextEncoder().encode(p.bundleJson).length,impacts:b.outcome_impacts,winrate:b.win_probability_timeline.status,unavailableReason:b.win_probability_timeline.unavailableReason};}});
 });
 await page.goto('http://localhost:3000/?teachingDiagnostics=1',{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForSelector('iframe',{timeout:30000});
 const frame=await page.locator('iframe').contentFrame();
 result.frameUrl=await page.locator('iframe').getAttribute('src');await snapshot(page,'initial');
 await frame.locator('input[type=file]').setInputFiles(resolve(root,'demoTests/test_demo.dem'));
 await frame.getByRole('button',{name:'povergo',exact:true}).waitFor({timeout:120000});
 result.stages.push('real_demo_parsed_ten_players'); await snapshot(page,'players');
 await frame.getByRole('button',{name:'povergo',exact:true}).click();
 await page.waitForFunction(()=>Boolean(window.__trust.analysis),undefined,{timeout:240000});
 result.analysis=await page.evaluate(()=>window.__trust.analysis);result.telemetry=await page.evaluate(()=>window.__trust.telemetry);result.isolation=await page.evaluate(()=>crossOriginIsolated);assert.equal(result.analysis.rounds,9);assert.equal(result.analysis.winrate,'AVAILABLE','real local model must finish');result.stages.push('full_analysis_ready');
 await snapshot(page,'route');
 result.hostText=(await page.locator('body').innerText()).slice(0,10000);
 await writeFile(resolve(out,'browser-stage.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({stage:'analysis_ready',analysis:result.analysis,hostText:result.hostText}));
 // Continue through real cue UI; selectors use visible product labels only.
 const until=Date.now()+240000;
 while(Date.now()<until){
  const text=await page.locator('body').innerText();
  if(/本场复盘完成|复盘已完成|全场总结/.test(text)){result.stages.push('wrap_up');break;}
  const choices=page.getByRole('button',{name:'给队友补枪',exact:true});
  if(await choices.isVisible().catch(()=>false)){
   const atTarget=await page.evaluate(()=>Math.abs((window.__trust.playback?.canonicalTick??0)-8969)<16);
   if(atTarget&&!result.stages.includes('reflection_answered')){await choices.click();result.stages.push('reflection_answered');}
   else {const skip=page.getByRole('button',{name:'跳过，直接看分析',exact:true});if(await skip.isEnabled()){await skip.click();result.stages.push('reflection_skipped');}}
   await delay(500);
  }
  const submit=page.getByRole('button',{name:/提交反思|提交回答|确认回答|检查这个条件/});
  if(await submit.first().isVisible().catch(()=>false)&&await submit.first().isEnabled()){await submit.first().click();await delay(500);}
  const next=page.getByRole('button',{name:/下一段|下一个讲解|继续复盘|开始复盘|开始带看|懂了，继续/});
  if(await next.first().isVisible().catch(()=>false)&&await next.first().isEnabled()){
   const card=await page.locator('body').innerText();const progress=card.match(/讲解\s*(\d+)\/(\d+)/);if(progress&&!result.cueVisits.includes(Number(progress[1])))result.cueVisits.push(Number(progress[1]));if(card.includes('四名队友都已阵亡'))result.reflectionProof=card;
   if(!result.cues.includes(card)){result.cues.push(card.slice(0,6000));await snapshot(page,`cue-${result.cues.length}`);}
   if(process.argv.includes('--recovery')&&card.includes('四名队友都已阵亡')) {
    const readBoundary=()=>page.evaluate(async()=>{
     const db=await new Promise((ok,bad)=>{const request=indexedDB.open('cs-coach-host-recovery');request.onsuccess=()=>ok(request.result);request.onerror=()=>bad(request.error);});
     try{return await new Promise((ok,bad)=>{const request=db.transaction('session-recovery-records','readonly').objectStore('session-recovery-records').getAll();request.onsuccess=()=>{const row=request.result.find(r=>r.boundary?.kind==='CUE_PAUSED');ok(row?{kind:row.boundary.kind,cueId:row.boundary.cueId,routeHash:row.routeHash,agentCheckpointId:row.agentCheckpointId,updatedAt:row.updatedAt}:null);};request.onerror=()=>bad(request.error);});}finally{db.close();}
    });
    let boundary;const checkpointDeadline=Date.now()+15000;
    while(Date.now()<checkpointDeadline){boundary=await readBoundary();if(boundary?.agentCheckpointId)break;await delay(100);}
    assert(boundary?.agentCheckpointId,'matching stable cue checkpoint required before refresh');result.recovery={before:boundary};
    const beforeDirect=result.requests['/api/coaching/direct']??0;const beforeNarration=result.requests['/api/coaching/narrate']??0;
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('[data-recovery-state="DORMANT"]').waitFor({timeout:15000});await snapshot(page,'recovery-dormant');
    assert.equal(result.requests['/api/coaching/direct']??0,beforeDirect);assert.equal(result.requests['/api/coaching/narrate']??0,beforeNarration);
    await page.getByRole('button',{name:'到回放区选择 Demo',exact:true}).click();
    await page.locator('iframe').contentFrame().locator('input[type=file]').setInputFiles(resolve(root,'demoTests/test_demo.dem'));
    await page.getByText('这次怎么判 · 目前无法确定',{exact:true}).waitFor({timeout:60000});
    assert(result.agentResponses.some(response=>response.event==='RECONNECT_REPLAY'&&response.restored==='MATCHED'),'same checkpoint must reconnect successfully');
    const restoredText=await page.locator('body').innerText();
    const restored=await page.evaluate(()=>window.__trust.playback);
    assert(restoredText.includes('四名队友都已阵亡'),'restore must retain the verified reflection result');assert(!restoredText.includes('先说说你的思路'),'completed reflection must not reopen');
    assert(restoredText.includes('povergo'));assert(Math.abs(restored.canonicalTick-8969)<16,'restore must land on the same real decision');assert.equal(result.requests['/api/coaching/direct']??0,beforeDirect,'restore must not rerun Director');
    result.recovery.after=await readBoundary();assert.equal(result.recovery.after.routeHash,boundary.routeHash);result.recovery.playback=restored;result.recovery.narratorCalls=(result.requests['/api/coaching/narrate']??0)-beforeNarration;result.recovery.text=restoredText;
    await snapshot(page,'recovery-restored');result.stages.push('same_cue_recovered');result.status='PASS';return;
   }
   await next.first().click();
  }
  await delay(500);
 }
 result.finalText=(await page.locator('body').innerText()).slice(0,14000);result.playbackEvidence=await page.evaluate(()=>({state:window.__trust.playback,seenOutcome:window.__trust.seenOutcome}));
 await snapshot(page,'final');assert(result.stages.includes('wrap_up'),'full route must reach wrap up');assert.equal(result.cueVisits.length,result.analysis.cues.length,'every cue must be visited');assert(result.reflectionProof?.includes('四名队友都已阵亡'),'known zero teammates must be explained in reflection');for(const impact of result.analysis.impacts){if(impact.delta>0){assert(result.analysis.cues.find(c=>c.id===impact.cueId)?.assessment.counterEvidenceRefs.length>0,'positive outcome must enter counterevidence before Director');}}assert(result.stages.includes('reflection_answered'),'reflection submit required');assert(result.stages.includes('reflection_skipped'),'reflection skip required');assert(!/ObservationState|ObservableState|renderer|\btick\b|lossless|refId|schema|\bTRADE\b|\bpipeline\b|\bfallback\b|\bcandidate\b/i.test(result.cues.join(' ')),'internal terminology leaked');assert(!(result.httpErrors??[]).some(x=>!/favicon|manifest\.webmanifest|\/sw\.js/.test(x.url)),'unexpected HTTP error');result.status='PASS';
}
try{await Promise.race([main(),new Promise((_,reject)=>{deadlineTimer=setTimeout(()=>reject(Error('CONTROLLER_TIMEOUT')),540000);})]);}
catch(error){if(activePage){result.failureText=await activePage.locator('body').innerText().catch(()=>'<unavailable>');result.frameUrls=activePage.frames().map(f=>f.url());await snapshot(activePage,'failure').catch(()=>{});}result.status='FAIL';result.failure=String(error);result.serviceLogs=services.map(s=>s.logs());console.error(String(error));}
finally{clearTimeout(deadlineTimer);await browser?.close().catch(()=>{});for(const {child}of services){try{process.kill(-child.pid,'SIGTERM');}catch{}}await delay(800);for(const{child}of services){try{process.kill(-child.pid,'SIGKILL');}catch{}}if(viewerServer){viewerServer.closeAllConnections();await new Promise(ok=>viewerServer.close(ok));}result.cleanup=true;await writeFile(resolve(out,process.argv.includes('--smoke')?'browser-infrastructure-smoke.json':process.argv.includes('--recovery')?'browser-recovery.json':'browser.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify({status:result.status,stages:result.stages,cleanup:result.cleanup,errors:result.errors}));if(result.status!=='PASS')process.exitCode=1;
