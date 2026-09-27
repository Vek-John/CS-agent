import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
it('uses the actual desktop handler and persisted checkpoint across two clean Node processes',async()=>{
 const run=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./desktop-process-recovery.mjs',import.meta.url))],{timeout:55000,killSignal:'SIGTERM',maxBuffer:65536});
 const result=JSON.parse(run.stdout);
 expect(result.ok).toBe(true);expect(result.nodeEnvironment).toBe('production');expect(result.differentProcesses).toBe(true);
 const [seed,resume]=result.children;
 expect(seed.pid).not.toBe(resume.pid);expect(resume.seedPid).toBe(seed.pid);
 for(const child of result.children)expect(child).toMatchObject({backend:'SQLITE',recoverableAfterRefresh:true,externalCalls:0,closed:true,exitCode:0,signal:null});
 expect(resume).toMatchObject({restored:'MATCHED',consumedCues:1,narrationRequests:0,routeValidations:1,viewerCalls:0,artifactsAndHeadUnchanged:true});
 expect(resume.graphEvents[0]).toBe('RECONNECT_REPLAY');expect(resume.graphEvents.filter(event=>event==='START_CUE')).toHaveLength(1);
},60000);
