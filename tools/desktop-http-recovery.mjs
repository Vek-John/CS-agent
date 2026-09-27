#!/usr/bin/env node
// One controller owns both restricted production sidecars. No caller environment is inherited.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2);
const preparedInput=args.find(arg=>arg.startsWith('--prepared-root='))?.slice(16),output=args.find(arg=>arg.startsWith('--output='))?.slice(9);
if(!preparedInput||!isAbsolute(preparedInput))throw Error('ABSOLUTE_PREPARED_ROOT_REQUIRED');
const prepared=await realpath(preparedInput),runtimeRoot=join(prepared,'resources/runtime-root'),viewerRoot=join(prepared,'resources/viewer-root');
const binary=join(prepared,'binaries/cs-agent-runtime-aarch64-apple-darwin');
for(const path of [binary,join(runtimeRoot,'runtime.cjs'),viewerRoot])await stat(path);
const temporaryRoot=await mkdtemp(join(tmpdir(),'cs-agent-http-recovery-'));
const dataDir=join(temporaryRoot,'data'),cacheDir=join(temporaryRoot,'cache'),logDir=join(temporaryRoot,'log');
await Promise.all([dataDir,cacheDir,logDir].map(path=>mkdir(path,{mode:0o700})));
const permissions=[runtimeRoot,viewerRoot,dataDir,cacheDir,logDir].map(path=>`--allow-fs-read=${path}`).concat([dataDir,cacheDir,logDir].map(path=>`--allow-fs-write=${path}`));
if(permissions.some(value=>value.includes('*')))throw Error('WILDCARD_PERMISSION_FORBIDDEN');
const esbuild=createRequire(resolve(root,'libs/coach-agent/package.json'))('esbuild');
const nativeFetch=globalThis.fetch.bind(globalThis),requests=new Set();
let active,stopReason,stage='BUILD',outputBytes=0,externalAttempts=0;
const runs=[];
function killActive(){if(active&&!active.ended&&Number.isInteger(active.child.pid)&&active.child.pid>0){try{active.child.kill('SIGKILL')}catch{}}}
function stop(reason){stopReason=reason;esbuild.stop();for(const request of requests)request.abort();killActive()}
const onInt=()=>stop('SIGINT'),onTerm=()=>stop('SIGTERM');process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
const overall=setTimeout(()=>stop('OVERALL_DEADLINE'),120000);
globalThis.fetch=async()=>{externalAttempts++;throw Error('UNCONTROLLED_FETCH_FORBIDDEN')};
async function boundedResponse(url,init,expected){
 if(stopReason)throw Error(stopReason);
 const controller=new AbortController();requests.add(controller);
 const timer=setTimeout(()=>controller.abort(),10000);
 let reader;
 try{
  const response=await nativeFetch(url,{...init,redirect:'error',signal:controller.signal});
  reader=response.body?.getReader();const chunks=[];let size=0;
  if(reader)for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>2*1024*1024)throw Error('HTTP_RESPONSE_LIMIT');chunks.push(item.value)}
  const bytes=Buffer.concat(chunks);let payload=null;
  if(bytes.length){try{payload=JSON.parse(bytes.toString('utf8'))}catch{throw Error('HTTP_JSON_INVALID')}}
  if(expected!==undefined&&response.status!==expected){const code=typeof payload?.code==='string'?payload.code:typeof payload?.reason==='string'?payload.reason:'HTTP_STATUS';throw Error(`HTTP_${response.status}_${/^[A-Z_]+$/.test(code)?code:'REJECTED'}`)}
  return {status:response.status,payload};
 }finally{clearTimeout(timer);requests.delete(controller);try{await reader?.cancel()}catch{}try{reader?.releaseLock()}catch{}}
}
async function start(label){
 if(active||stopReason)throw Error(stopReason??'CONCURRENT_SIDECAR_FORBIDDEN');stage=`START_${label}`;
 const child=spawn(binary,['--permission',...permissions,'--jitless',join(runtimeRoot,'runtime.cjs')],{env:{},stdio:['pipe','pipe','pipe']});
 let resolveReady,rejectReady,buffer='';const ready=new Promise((yes,no)=>{resolveReady=yes;rejectReady=no});
 const run={child,ended:false,message:undefined,closed:undefined,label};
 run.closed=new Promise(yes=>child.once('close',(code,signal)=>{run.ended=true;rejectReady(Error('SIDECAR_CLOSED_BEFORE_READY'));yes({code,signal})}));active=run;
 const receive=(chunk,isStdout)=>{outputBytes+=chunk.length;if(outputBytes>65536){stop('SIDECAR_OUTPUT_LIMIT');rejectReady(Error('SIDECAR_OUTPUT_LIMIT'));return}if(isStdout&&!run.message){buffer+=chunk.toString('utf8');const end=buffer.indexOf('\n');if(end>=0){try{const message=JSON.parse(buffer.slice(0,end));if(message.schemaVersion!=='desktop-runtime-ready.v2'||message.protocolVersion!=='desktop-runtime-http.v2'||!/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(message.appOrigin)||!/^http:\/\/localhost:[1-9]\d*$/.test(message.viewerOrigin)||new URL(message.appOrigin).port===new URL(message.viewerOrigin).port||typeof message.sessionToken!=='string'||typeof message.adminToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(message.sessionToken)||!/^[A-Za-z0-9_-]{43}$/.test(message.adminToken))throw Error();run.message=message;buffer='';resolveReady()}catch{rejectReady(Error('READY_PROTOCOL_INVALID'))}}}};
 child.stdout.on('data',chunk=>receive(chunk,true));child.stderr.on('data',chunk=>receive(chunk,false));child.once('error',()=>rejectReady(Error('SIDECAR_SPAWN_FAILED')));child.stdin.on('error',()=>rejectReady(Error('SIDECAR_INIT_FAILED')));
 child.stdin.end(JSON.stringify({schemaVersion:'desktop-runtime-init.v1',appVersion:'0.1.0',buildSha:'http-recovery-synthetic',targetTriple:'aarch64-apple-darwin',dataDir,cacheDir,logDir,runtimeRoot,viewerRoot,provider:{kind:'NONE',apiKey:null,baseUrl:null,model:null}})+'\n');
 const timer=setTimeout(()=>{rejectReady(Error('STARTUP_DEADLINE'));killActive()},20000);
 try{await ready;return run}finally{clearTimeout(timer)}
}
function client(run){
 const {appOrigin,viewerOrigin,sessionToken}=run.message;
 const json=async(path,init={})=>{if(!path.startsWith('/')||path.startsWith('//'))throw Error('HTTP_PATH_REJECTED');const response=await boundedResponse(appOrigin+path,{...init,headers:{...init.headers,cookie:`cs_agent_runtime=${sessionToken}`,origin:appOrigin,'sec-fetch-site':'same-origin'}},undefined);if(response.status<200||response.status>=300){const code=response.payload?.code??response.payload?.reason;throw Error(`APP_HTTP_${response.status}_${typeof code==='string'&&/^[A-Z_]+$/.test(code)?code:'REJECTED'}`)}return response.payload};
 return {json,async importDemo(bytes){
  const requestId='http-recovery-synthetic';
  const capability=await json('/api/review-history/import-capability',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId,originalFilename:'synthetic-no-parser.dem',byteSize:bytes.length})});
  if(capability.requestId!==requestId||typeof capability.capabilityToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(capability.capabilityToken))throw Error('IMPORT_CAPABILITY_INVALID');
  const imported=(await boundedResponse(viewerOrigin+'/_desktop/library/import',{method:'POST',headers:{authorization:`Bearer ${capability.capabilityToken}`,'content-type':'application/octet-stream','x-cs-agent-import-id':requestId},body:bytes},201)).payload;
  if(typeof imported.demoId!=='string'||typeof imported.contentHash!=='string'||typeof imported.validationToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(imported.validationToken))throw Error('IMPORT_RESULT_INVALID');
  // Explicit fixture boundary: header bytes are never claimed to have been parsed.
  const finalized=(await boundedResponse(viewerOrigin+'/_desktop/library/import/finalize',{method:'POST',headers:{authorization:`Bearer ${imported.validationToken}`,'x-cs-agent-demo-id':imported.demoId,'x-cs-agent-parse-outcome':'READY'}},200)).payload;
  if(finalized.status!=='READY'||finalized.demoId!==imported.demoId)throw Error('FINALIZE_FAILED');return {demoId:imported.demoId,contentHash:imported.contentHash};
 }};
}
async function shutdown(run){
 stage=`SHUTDOWN_${run.label}`;
 await boundedResponse(run.message.appOrigin+'/_desktop/shutdown',{method:'POST',headers:{authorization:`Bearer ${run.message.adminToken}`}},202);
 const timer=setTimeout(()=>{stop('SHUTDOWN_DEADLINE')},10000);
 try{const exit=await run.closed;if(exit.code!==0||exit.signal!==null)throw Error('UNCLEAN_SHUTDOWN');runs.push({phase:run.label,pid:run.child.pid,exitCode:exit.code,signal:exit.signal});active=undefined}finally{clearTimeout(timer)}
}
try{
 const executable=join(temporaryRoot,'client.cjs');await esbuild.build({entryPoints:[resolve(root,'tools/desktop-http-recovery-client.ts')],outfile:executable,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'});esbuild.stop();
 if(args.includes('--check-only'))console.log(JSON.stringify({ok:true,built:true,startedSidecars:0}));
 else{
  const fixture=createRequire(import.meta.url)(executable),first=await start('seed');stage='AUTH_PROBE';
  const unauthorized=await nativeFetch(first.message.appOrigin+'/api/coaching/agent',{method:'POST',headers:{'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(unauthorized.status!==401&&unauthorized.status!==403)throw Error('UNAUTHENTICATED_NOT_REJECTED');await unauthorized.body?.cancel();
  stage=args.includes('--probe-only')?'AGENT_PROBE':'SEED_HTTP';
  const seed=args.includes('--probe-only')?{summary:await fixture.probe(client(first))}:await fixture.seed(client(first));
  await shutdown(first);let resumed;
  if(!args.includes('--probe-only')){const second=await start('resume');if(second.child.pid===first.child.pid)throw Error('PID_NOT_DISTINCT');stage='STALE_COOKIE_PROBE';const stale=await nativeFetch(second.message.appOrigin+'/api/coaching/agent',{method:'POST',headers:{cookie:`cs_agent_runtime=${first.message.sessionToken}`,origin:second.message.appOrigin,'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(10000)});if(stale.status!==401&&stale.status!==403)throw Error('STALE_COOKIE_NOT_REJECTED');await stale.body?.cancel();stage='RESUME_HTTP';resumed=await fixture.resume(client(second),seed.reviewId);resumed.staleCookieRejected=true;await shutdown(second)}
  const result={ok:true,probeOnly:args.includes('--probe-only'),runs,seed:seed.summary,...(resumed?{resume:resumed}:{}),unauthenticatedRejected:true,uncontrolledClientFetches:externalAttempts,limitations:['Prepared production sidecar/Next HTTP; no Tauri GUI.','Synthetic Replay and header-only import finalized as synthetic-no-parser, never parsed Demo evidence.','Provider NONE; default runtime Memory feature remains consent-gated.','Client fixture advances synthetic Session ticks; no Viewer rendering.']};
  if(output)await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
 }
}catch(error){console.log(JSON.stringify({ok:false,stage,code:stopReason??(/^[A-Z0-9_:]+$/.test(error.message)?error.message:'VALIDATION_FAILED'),runs}));process.exitCode=1}
finally{clearTimeout(overall);esbuild.stop();for(const request of requests)request.abort();killActive();if(active)await active.closed;process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);globalThis.fetch=nativeFetch;await rm(temporaryRoot,{recursive:true,force:true})}
