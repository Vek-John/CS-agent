#!/usr/bin/env node
// Isolated, synthetic ViewerStage acceptance page. No Parser, model, or user Demo.
import { createRequire } from 'node:module'
import { dirname, resolve, extname, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const upstream = resolve(process.env.CS2D_UPSTREAM_DIR || resolve(root, '.local-data/upstream/cs2d'))
const app = resolve(upstream, 'apps/app')
const output = resolve(root, '.local-data/basic-route-viewer-action')
const generated = resolve(output, 'src')
const dist = resolve(output, 'dist')
const dependency = createRequire(resolve(app, 'package.json'))
const args = process.argv.slice(2)
const serve = args.includes('--serve') || args.includes('--serve-only')
const port = Number(args.find(value => value.startsWith('--port='))?.slice(7) ?? 4321)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid localhost port')

if (!args.includes('--serve-only')) {
  await mkdir(generated, { recursive: true })
  await writeFile(resolve(generated, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic Viewer action smoke</title><style>body{margin:16px;background:#10141d;color:#eee;font:16px system-ui}button{font:inherit;padding:10px 16px}button:disabled{opacity:.5}iframe{width:100%;height:640px;border:1px solid #657084;margin-top:14px}pre{white-space:pre-wrap}p{max-width:80ch}</style><h1>Synthetic Viewer action smoke</h1><p>合成场景，不是真实 Demo tick。实际 ViewerStage / useReplay / iframe bridge；不运行 Parser 或模型。</p><button id="run" disabled>运行动作回放</button> <button id="interrupt" disabled>验证暂停与恢复</button><p id="status" role="status">等待真实 ViewerStage 挂载</p><pre id="summary"></pre><iframe id="viewer" title="Synthetic CS2 Viewer"></iframe><script type="module" src="/parent.ts"></script></html>`)
  await writeFile(resolve(generated, 'child.html'), '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic ViewerStage</title><div id="app"></div><script type="module" src="/child.ts"></script></html>')
  await writeFile(resolve(generated, 'parent.ts'), `import { isPlaybackCommandEnvelope, isPlaybackEventEnvelope, PLAYBACK_BRIDGE_CHANNEL } from ${JSON.stringify(resolve(root, 'libs/contracts/src/playback-bridge.ts'))};
const frame = document.querySelector<HTMLIFrameElement>('#viewer')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
const interruptButton = document.querySelector<HTMLButtonElement>('#interrupt')!;
const summary = document.querySelector('#summary')!;
const status = document.querySelector('#status')!;
const state = { ready:false, posted:0, ackCount:0, ackStatus:'', ackCode:'', completed:false, lastTick:0, minPlayingTick:null as number|null, maxPlayingTick:null as number|null, playing:false, speed:0, returnedToDecisionAndPaused:false, mode:'continuous', pauseCommands:0, resumeCommands:0, pauseTick:null as number|null, checkedPauseTick:null as number|null, heldMs:0, firstResumedTick:null as number|null, movedAfterResume:false, interruptionPassed:false, errors:[] as string[] };
const command = { channel:PLAYBACK_BRIDGE_CHANNEL, direction:'command', payload:{type:'teachingTool',schemaVersion:'cs2d-teaching-tool-command.v2',tool:'REPLAY_CUE_SLOW',callId:'synthetic-action-1',runId:'synthetic-run',generation:1,cueId:'synthetic-cue',args:{tool:'REPLAY_CUE_SLOW',startCanonicalTick:64,decisionCanonicalTick:128,outcomeEndCanonicalTick:256,speed:0.5}}};
if(!isPlaybackCommandEnvelope(command)) throw Error('SMOKE_COMMAND_INVALID');
let holdTimer: ReturnType<typeof setTimeout>|undefined;
let pausedAt=0;
let probeSent=false;
const control=(action:'pause'|'resume')=>{const payload={type:'teachingPlayback',callId:command.payload.callId,runId:command.payload.runId,cueId:command.payload.cueId,generation:command.payload.generation,action};const envelope={channel:PLAYBACK_BRIDGE_CHANNEL,direction:'command',payload};if(!isPlaybackCommandEnvelope(envelope))throw Error('SMOKE_CONTROL_INVALID');if(action==='pause')state.pauseCommands++;else state.resumeCommands++;frame.contentWindow!.postMessage(envelope,location.origin);};
const render=()=>{state.returnedToDecisionAndPaused=state.ackCount===1&&state.completed&&state.ackStatus==='SUCCEEDED'&&state.ackCode==='CUE_PLAYED'&&!state.playing&&Math.abs(state.lastTick-128)<=1; state.interruptionPassed=state.mode==='interrupt'&&state.returnedToDecisionAndPaused&&state.pauseTick!==null&&state.checkedPauseTick===state.pauseTick&&state.heldMs>=1000&&state.firstResumedTick===state.pauseTick&&state.movedAfterResume&&state.resumeCommands===1; summary.textContent=JSON.stringify(state,null,2); status.textContent=state.returnedToDecisionAndPaused?'已完成一次动作回放，返回决策点并暂停':state.posted?'正在等待真实播放完成 ACK':state.ready?'Viewer 已就绪':'等待真实 ViewerStage 挂载';};
window.addEventListener('message',event=>{
 if(event.source!==frame.contentWindow||event.origin!==location.origin)return;
 if(event.data?.channel==='synthetic-viewer-smoke'&&event.data.type==='host-ready'){state.ready=true;button.disabled=state.posted>0;interruptButton.disabled=state.posted>0;render();return;}
 if(event.data?.channel==='synthetic-viewer-smoke'&&event.data.type==='error'){state.errors.push(String(event.data.code).slice(0,120));state.errors=state.errors.slice(-3);render();return;}
 if(!isPlaybackEventEnvelope(event.data))return;
 const message=event.data.payload;
 if(message.type==='PLAYBACK_STATE'){state.lastTick=message.canonicalTick;state.playing=message.playing;state.speed=message.speed;if(state.posted&&message.playing){state.minPlayingTick=Math.min(state.minPlayingTick??message.canonicalTick,message.canonicalTick);state.maxPlayingTick=Math.max(state.maxPlayingTick??message.canonicalTick,message.canonicalTick);}}
 if(message.type==='PLAYBACK_STATE'&&state.mode==='interrupt'&&state.posted&&!state.ackCount){
  if(message.playing&&message.canonicalTick>=96&&state.pauseCommands===0)control('pause');
  else if(!message.playing&&state.pauseCommands>0&&state.pauseTick===null){state.pauseTick=message.canonicalTick;pausedAt=performance.now();holdTimer=setTimeout(()=>{probeSent=true;control('pause');},1200);}
  else if(!message.playing&&probeSent&&state.checkedPauseTick===null){state.checkedPauseTick=message.canonicalTick;state.heldMs=Math.round(performance.now()-pausedAt);if(state.checkedPauseTick===state.pauseTick)control('resume');else state.errors.push('CLOCK_ADVANCED_WHILE_PAUSED');}
  if(message.playing&&state.resumeCommands===1){if(state.firstResumedTick===null)state.firstResumedTick=message.canonicalTick;if(message.canonicalTick>(state.pauseTick??Infinity))state.movedAfterResume=true;}
 }
 if(message.type==='TEACHING_TOOL_ACK'&&message.callId===command.payload.callId&&message.runId===command.payload.runId&&message.cueId===command.payload.cueId&&message.generation===command.payload.generation&&message.tool===command.payload.tool){state.ackCount++;state.ackStatus=message.status;state.ackCode=message.observationCode;state.completed=message.completed;}
 render();
});
const start=(mode:'continuous'|'interrupt')=>{if(!state.ready||state.posted||!frame.contentWindow)return;state.mode=mode;state.posted++;button.disabled=true;interruptButton.disabled=true;frame.contentWindow.postMessage(command,location.origin);render();};
button.addEventListener('click',()=>start('continuous'));
interruptButton.addEventListener('click',()=>start('interrupt'));
window.addEventListener('pagehide',()=>clearTimeout(holdTimer),{once:true});
frame.src='/child.html?parentOrigin='+encodeURIComponent(location.origin);
render();
`)
  await writeFile(resolve(generated, 'smoke.css'), `@import ${JSON.stringify(resolve(app, 'src/style.css'))};\n@source ${JSON.stringify(resolve(app, 'src'))};\nhtml,body,#app{height:100%;width:100%;margin:0;overflow:hidden}\n`)
  await writeFile(resolve(generated, 'child.ts'), `import { createApp, h } from 'vue';
import ViewerStage from '@/viewer/player/ViewerStage.vue';
import { i18n } from '@/app/i18n';
import './smoke.css';
import type { Replay } from '@/viewer/domain/schema';
const parentOrigin=new URL(location.href).searchParams.get('parentOrigin');
if(parentOrigin!==location.origin)throw Error('SMOKE_PARENT_ORIGIN_INVALID');
const report=(type:string,code?:string)=>parent.postMessage({channel:'synthetic-viewer-smoke',type,code},parentOrigin);
const players=[{steamId:'synthetic-self',name:'Synthetic T',startSide:'T' as const},{steamId:'synthetic-other',name:'Synthetic CT',startSide:'CT' as const}];
const replay:Replay={map:'de_mirage',demoTickRate:64,frameRate:8,players,finalScoreCt:0,finalScoreT:1,finalCtName:'Synthetic CT',finalTName:'Synthetic T',generatedBy:'synthetic-viewer-action-no-demo',rounds:[{number:1,freezeStartTick:0,startTick:64,decidedTick:320,endTick:320,postEndTick:384,winner:'T',reason:null,scoreCt:0,scoreT:0,ctName:'Synthetic CT',tName:'Synthetic T',damage:{},utilityDamage:{},events:[],bomb:[],grenadePaths:[],blinds:[],chat:[],defuses:[],groundWeapons:[],frames:Array.from({length:49},(_,i)=>({tick:i*8,t:i/8,players:players.map((player,index)=>({steamId:player.steamId,x:-700+index*100+i*3,y:-700+index*80,z:0,yaw:45,health:100,alive:true,side:player.startSide,weapon:'AK-47',primary:'AK-47',money:1000,equipValue:3000,armor:100}))}))}]};
// Fail before mounting canvas if ignored upstream sources were not scanned by Tailwind.
const probe=document.createElement('div');probe.className='absolute inset-0 h-full w-full';document.body.append(probe);
const computed=getComputedStyle(probe);
const cssReady=computed.position==='absolute'&&computed.top==='0px'&&Math.abs(probe.getBoundingClientRect().height-innerHeight)<2;
probe.remove();
if(!cssReady){report('error','SMOKE_REQUIRED_VIEWER_CSS_MISSING');throw Error('SMOKE_REQUIRED_VIEWER_CSS_MISSING');}
const app=createApp({render:()=>h(ViewerStage,{replay,sourceLabel:'Synthetic · not measured Demo ticks',hostMode:true,hostTargetPlayerId:'synthetic-self',autoplay:false,active:true,onHostReady:()=>report('host-ready')})});
app.config.errorHandler=error=>report('error',error instanceof Error?error.message:String(error));
window.addEventListener('error',event=>report('error',event.message));
app.use(i18n).mount('#app');
window.addEventListener('pagehide',()=>app.unmount(),{once:true});
`)
  const { build } = await import(pathToFileURL(dependency.resolve('vite')).href)
  const { default: vue } = await import(pathToFileURL(dependency.resolve('@vitejs/plugin-vue')).href)
  const { default: tailwind } = await import(pathToFileURL(dependency.resolve('@tailwindcss/vite')).href)
  await build({ configFile:false, root:generated, publicDir:resolve(app,'public'), plugins:[vue(),tailwind()],
    resolve:{alias:{'@':resolve(app,'src'),vue:resolve(dirname(dependency.resolve('vue/package.json')),'dist/vue.runtime.esm-bundler.js')},dedupe:['vue']},
    build:{outDir:dist,emptyOutDir:true,copyPublicDir:false,rollupOptions:{input:{parent:resolve(generated,'index.html'),child:resolve(generated,'child.html')}}},
  })
  console.log(JSON.stringify({built:true,dist,synthetic:true,parser:false,model:false}))
}
if(serve){
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.json':'application/json'}
  const roots={maps:resolve(app,'public/maps'),weapons:resolve(app,'public/weapons'),teams:resolve(app,'public/teams')}
  const server=createServer(async(req,res)=>{
    try{
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return}
      const pathname=decodeURIComponent(new URL(req.url??'/', 'http://127.0.0.1').pathname)
      const parts=pathname.split('/').filter(Boolean)
      const assetRoot=roots[parts[0]]
      const base=assetRoot||dist
      const file=await realpath(resolve(base,...(assetRoot?parts.slice(1):parts.length?parts:['index.html'])))
      const safeBase=await realpath(base)
      if(!file.startsWith(safeBase+sep)||(await stat(file)).isDirectory())throw Error('OUTSIDE_STATIC_ROOT')
      res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream')
      res.setHeader('Cache-Control','no-store')
      res.setHeader('X-Content-Type-Options','nosniff')
      res.end(req.method==='HEAD'?undefined:await readFile(file))
    }catch{res.writeHead(404);res.end('Not found')}
  })
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',done)})
  console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port,stop:'SIGINT or SIGTERM',staticRoots:['dist','maps','weapons','teams']}))
  const stop=()=>{server.close();server.closeAllConnections()}
  process.once('SIGINT',stop);process.once('SIGTERM',stop)
}
