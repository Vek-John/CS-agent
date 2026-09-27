import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function writeTwoCueHarness({ root, generated }) {
  await writeFile(resolve(generated, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic two-cue handoff</title><style>body{margin:16px;background:#10141d;color:#eee;font:16px system-ui}button{font:inherit;padding:10px 16px}button:disabled{opacity:.5}iframe{width:100%;height:580px;border:1px solid #657084;margin-top:12px}pre{white-space:pre-wrap;font-size:12px}#teaching{max-width:80ch}p{max-width:85ch}</style><h1>合成双教学点连续播放验收</h1><p>合成时间与位置，不是真实 Demo。实际 Adapter、Session、Host 合法工具与 ViewerStage；受控 driver 不运行 Graph Runtime、Parser 或模型。</p><button id="start" disabled>开始连续带看</button> <button id="continue" disabled>等待讲解完成</button><p id="status" role="status">等待 Viewer</p><p id="teaching"></p><iframe id="viewer" title="Synthetic two-cue Viewer"></iframe><pre id="summary"></pre><script type="module" src="/parent.ts"></script></html>`)
  await writeFile(resolve(generated, 'parent.ts'), `import ${JSON.stringify(resolve(root, 'tools/cs2d-host/viewer-two-cue-parent.ts'))};\n`)
  await writeFile(resolve(generated, 'child.ts'), `import { createApp, h } from 'vue';
import ViewerStage from '@/viewer/player/ViewerStage.vue';
import { i18n } from '@/app/i18n';
import './smoke.css';
import { twoCueViewerReplay, twoCueViewerPlayer } from ${JSON.stringify(resolve(root, 'tools/cs2d-host/viewer-two-cue-fixture.ts'))};
const parentOrigin=new URL(location.href).searchParams.get('parentOrigin');
if(parentOrigin!==location.origin)throw Error('SMOKE_PARENT_ORIGIN_INVALID');
const report=(type:string,code?:string)=>parent.postMessage({channel:'synthetic-viewer-smoke',type,code},parentOrigin);
const probe=document.createElement('div');probe.className='absolute inset-0 h-full w-full';document.body.append(probe);
const computed=getComputedStyle(probe);const cssReady=computed.position==='absolute'&&computed.top==='0px'&&Math.abs(probe.getBoundingClientRect().height-innerHeight)<2;probe.remove();
if(!cssReady){report('error','SMOKE_REQUIRED_VIEWER_CSS_MISSING');throw Error('SMOKE_REQUIRED_VIEWER_CSS_MISSING');}
const app=createApp({render:()=>h(ViewerStage,{replay:twoCueViewerReplay(),sourceLabel:'Synthetic · not measured Demo ticks',hostMode:true,hostTargetPlayerId:twoCueViewerPlayer,autoplay:false,active:true,onHostReady:()=>report('host-ready')})});
app.config.errorHandler=()=>report('error','VIEWER_COMPONENT_ERROR');
window.addEventListener('error',()=>report('error','VIEWER_WINDOW_ERROR'));
app.use(i18n).mount('#app');window.addEventListener('pagehide',()=>app.unmount(),{once:true});
`)
}
