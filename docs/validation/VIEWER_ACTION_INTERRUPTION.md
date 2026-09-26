# 真实动作工具暂停与恢复

2026-09-27，基线ca82c56，任务viewer-action-interruption。复用上一轮通过的真实Viewer小harness，只增加可选“验证暂停与恢复”按钮和driver观察；产品Viewer/Graph均未修改。

## 方法与证据

使用原脚本build/serve方式，选择“验证暂停与恢复”。父页在真实PLAYBACK_STATE推进至合成96时发相同callId/runId/cueId/generation的teachingPlayback pause；实际paused消息记录位置。约1.2秒后再发同身份pause，促使Viewer重新回报当前时钟，不能只拿父页缓存值断言停住。复查同位置后发一次resume，记录真实首个playing位置和后续推进。driver的setTimeout只调度消息，不替换Viewer的RAF/时钟，也不伪造ACK。

root IAB实际观察：pauseTick=96，checkedPauseTick=96，heldMs=1204，firstResumedTick=96，之后继续推进；原工具只发送一次，pause消息两次（第二次为状态探针），resume一次。最终ACK1、SUCCEEDED/CUE_PLAYED，返回合成128、playing=false、speed=1；errors=[]，canvas2496×1280稳定。[摘要](VIEWER_ACTION_INTERRUPTION_RESULT.json)。

合成时间不是测得Demo tick；约1.2秒仅此次暂停观察时长，不是延迟性能指标。已有连续播放按钮保留，同页只能启动一个场景；pagehide清driver timer并卸载子组件，全部tab和4321服务已关闭。

## 范围

真实Vue ViewerStage/useReplay/ViewerMap/bridge与本地静态资产，未加载真实Demo、Parser、ONNX或用户数据库；不是整场Next/Graph端到端或native A5。源码/helper和Host integration暂停测试复用，未再扩展单位矩阵。新增控件为原生按钮、无动画/透明层，沿用emil/apple的及时反馈和可打断交互原则。

本地记录.local-data/viewer-action-interruption/。小harness构建和语法检查通过，23相关tests、pnpm typecheck、pnpm cs2d:typecheck、pnpm build、pnpm cs2d:build均通过。
