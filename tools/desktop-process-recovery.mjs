#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory=await mkdtemp(join(tmpdir(),'cs-agent-process-recovery-'));
const args=process.argv.slice(2), output=args.find(arg=>arg.startsWith('--output='))?.slice(9);
const results=[]; let active, interrupted;
const esbuild=createRequire(resolve(root,'libs/coach-agent/package.json'))('esbuild');
const executable=join(directory,'child.cjs');
function killOwned(){if(!active?.ended&&Number.isInteger(active?.pid)&&active.pid>0){try{process.kill(-active.pid,'SIGKILL')}catch{ /* exited or failed spawn */ }}}
function signalStop(signal){interrupted=signal;killOwned();esbuild.stop()}
const onInt=()=>signalStop('SIGINT'),onTerm=()=>signalStop('SIGTERM');process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
async function child(phase){
 if(interrupted)throw Error('PARENT_INTERRUPTED');
 const env={PATH:process.env.PATH??'',TMPDIR:tmpdir(),NODE_ENV:'production',DEPLOY_TARGET:'desktop',MEMORY_ENABLED:'false',CS_AGENT_DESKTOP_DB_PATH:join(directory,'history.sqlite3')};
 const worker=spawn(process.execPath,['--max-old-space-size=512',executable,phase,directory],{cwd:root,env,stdio:['ignore','pipe','pipe'],detached:true});
 let stdout='',stderr='',bytes=0,reason;
 const closed=new Promise(resolve=>worker.once('close',(code,signal)=>{if(active?.pid===worker.pid)active.ended=true;resolve({code,signal})}));
 active={pid:worker.pid,closed,ended:false};
 const deadline=setTimeout(()=>{reason='CHILD_DEADLINE';killOwned()},45000);
 worker.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){reason='CHILD_OUTPUT_LIMIT';killOwned()}else stdout+=chunk.toString('utf8')});
 worker.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8').slice(0,Math.max(0,2048-stderr.length));bytes+=chunk.length;if(bytes>65536){reason='CHILD_OUTPUT_LIMIT';killOwned()}});
 worker.once('error',()=>{reason='CHILD_SPAWN_FAILED';killOwned()});
 try{
  const {code,signal}=await closed;
  if(interrupted||reason)throw Error(interrupted?'PARENT_INTERRUPTED':reason);
  let value;try{value=JSON.parse(stdout.trim())}catch{throw Error(`CHILD_LOAD_FAILED:${phase}:${stderr.match(/^\w*Error(?:\s*\[[^\]]+\])?:[^\n]*/m)?.[0]?.slice(0,400)??'NO_SUMMARY'}`)}
  const summary={...value,exitCode:code,signal};
  if(code!==0||!value.ok){results.push(summary);throw Error(`CHILD_FAILED:${phase}:${value.stage??'UNKNOWN'}:${value.code??'UNKNOWN'}`)}
  return summary;
 }finally{clearTimeout(deadline);if(active?.pid===worker.pid){killOwned();await closed;active=undefined}}
}
try{
 const buildDeadline=setTimeout(()=>esbuild.stop(),45000);
 try { await esbuild.build({entryPoints:[resolve(root,'tools/desktop-process-recovery-child.ts')],outfile:executable,bundle:true,platform:'node',format:'cjs',target:'node22',conditions:['react-server'],logLevel:'silent',alias:{'server-only':resolve(root,'apps/web/node_modules/next/dist/compiled/server-only/empty.js')}}); } finally {clearTimeout(buildDeadline);esbuild.stop()}

 for(const phase of args.includes('--probe')?['probe']:['seed','resume']) results.push(await child(phase));
 if(results.length===2&&results[0].pid===results[1].pid)throw Error('PID_NOT_DISTINCT');
 const result={ok:true,handler:'apps/web/app/api/coaching/agent/route.ts POST',nodeEnvironment:'production',differentProcesses:results.length===2,children:results,limitations:['Direct production handler functions in separate Node processes; no Tauri/sidecar HTTP server.','esbuild resolves server-only to the installed Next server marker; no business/backend substitution.','Synthetic Replay/header bytes; no Parser, real Demo or model.']};
 if(output)await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(result));
}catch(error){console.log(JSON.stringify({ok:false,code:error.message,children:results}));process.exitCode=1}
finally{esbuild.stop();killOwned();if(active)await active.closed;process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);await rm(directory,{recursive:true,force:true})}
