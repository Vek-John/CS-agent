# 默认带看整场收尾：真实 Host 验收

日期：2026-09-27。基线a0be7cf，codex/jev-decision-assessment。

## 范围

沿当前真实React Host、默认诊断、Vue Viewer自然时钟及内存Graph，走完小场景两cue与末段。首点一次503后本地诊断，第二点正常Graph诊断；只作已验证故障模式的既有输入，不继续扩故障矩阵。验证终结暂停、真实总结、回看片段和完成入口，保持本地与Graph病例共同交给总结来源校验。

186帧合成输入的时间/身份只用于测试，不是解析Demo的canonical tick/hash；文件/选人入口明确是合成替代，不涉及Parser、正式Demo、用户SQLite/Memory、.env、模型、安装部署。浏览器新origin的恢复记录不是桌面持久化验收。

## 真实依赖与验收标准

- Host的completeStage3SessionWrapUp先确认真实Graph COMPLETE_SESSION，再调用buildStage3WrapUpInput，传入Graph与本地教学案例；未完成或无可呈现依据不能冒充有效总结。两份diagnoses目前主要用于剔除已修订点对旧主题的支持；不会将INCONCLUSIVE诊断直接拼成重复错误。
- 当前requestSessionWrapUp走本地closed projection；只有显式兼容requestSessionWrapUpFromProvider会发HTTP。本轮不新增wrap-up路由、不模拟远端成功。
- 无重复且条件明确的证据时接受NO_REPEATED_THEME，不制造习惯、建议或专业判断提升。
- Graph完成与Viewer实际暂停分别记录。最终用户确认完成，不能仅把请求已发出当完成。

## 复跑

```sh
node tools/cs2d-host/react-host-smoke.mjs
node tools/cs2d-host/react-host-smoke.mjs --serve-only --port=0 --fail-first-reflection
```

在输出的新origin载入/合成选人；首点回答后走本地回退，继续第二点回答，继续到末段与总结，再完成本次复盘。工具只输出匿名摘要，bulk留页面。

## 本轮结果

IAB tab20 / 新origin55098实际走完整场：首点本地回退、第二点Graph诊断均确认后继续；最后停在合成3000、playing=false，界面100%与“全场总结”。总结明确“本场没有足够重复且条件明确的证据，暂不归纳为习惯”，保留2个回看入口，没有虚构重复错误或训练建议。

实际Graph一次COMPLETE_SESSION后run/session均COMPLETED，routeCursor11、completedCueCount2、OBSERVE_SEGMENT9（对应全部非cue段）、START_CUE2。Graph仅有第二点的case1；本地首点不冒充Graph结果。Graph原始summaryThemeCount1/representative1，经真实Host可呈现证据门过滤后NO_REPEATED_THEME/themes0；两个计数含义不同，不能把原始主题数当最终教学结论。

点击“完成本次复盘”后标题“复盘完成”，完成按钮消失。再点第1回合回看，实际落合成1336暂停；“结束自由回看”返回合成3000/paused及复盘完成。期间准备仍Analysis1/route1/narration2，COMPLETE_SESSION仍1，transport14/Runtime13（原定单次故障），外网/模型/视觉ACK0、errors=[]。[冻结摘要](GUIDED_DEFAULT_SESSION_WRAP_UP_RESULT.json)。

本轮没有产品缺口需要修改，只扩既有工具的匿名完成摘要及实际链路测试。

## 验证、清理与后继

```sh
pnpm exec vitest run tools/cs2d-host/react-host-smoke.test.mjs tools/cs2d-host/viewer-two-cue-fixture.test.mjs apps/web/lib/coaching/session-wrap-up-completion.test.ts
pnpm exec tsc --noEmit -p tools/cs2d-host/react-host-smoke.tsconfig.json
node --check tools/cs2d-host/react-host-smoke.mjs
pnpm typecheck
pnpm cs2d:typecheck
pnpm build
pnpm cs2d:build
```

3文件16tests、专项TS/语法、独立Vite build（3.75秒）和两端TS/build均通过。真实seam测试验证Session两次确认/呈现/消费、全部普通段顺序、Host病例2（local1+Graph1）与Graph病例1共同作为输入、合法无主题结果、完成动作与重复调用不重新dispatch/发布。UI另证实时钟暂停与按钮行为；不把fake test tick推进当Viewer证明。

root已审工具diff、真实Host/Graph/总结入口与测试输出，owner RELEASE，自建tab20与55098服务关闭。证据 .local-data/guided-default-session-wrap-up/{wrap-up.png,completed.png,final.png,final-runtime.json,final-observation.json} 与checks日志保留。没有操作用户数据、安装部署或重新运行旧拒判集合。

下一有限目标 real-demo-host-entry-preflight：目前真实Host整条控制/教学/收尾已用合成输入证明，但真实DemoAnalyzer文件选择、Parser/Worker到Host的入口仍未覆盖。先核实受控Viewer的真实DemoAnalyzer生命周期、WASM/模型资产、单次已授权test_demo预算和数据所有权；小挂载通过后再决定一次有界真实输入验收。不能借合成结果声称真实解析或大Demo体验通过，也不唤醒锁屏native A5。

