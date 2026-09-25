# 放弃恢复：迟到、失败与初始无 Session 路径

2026-09-26；基线 `daaf8c1`（产品 `6509747`）。范围为显式 discard 入口及取消时已经派发的 landing timeout，不改 Runtime/DB/完成门。

## 复现

原样抽取 Host 使用的 `HostRecoveryDiscard.discard` 派发/发布入口。生产 BrowserSessionRecoveryRuntime＋隔离 fake IndexedDB 或延迟其结果，复现三项红例：旧A删除成功清掉B、真实REJECTED清掉当前identity/checkpoint、真实DEGRADED也被当耐久删除成功。三项修复后转绿。

| Before | After | Why |
|---|---|---|
| 任何返回都清理恢复资料 | 只认当前操作的READY/null/null | 降级内存删除不证明耐久删除 |
| 旧A慢返回影响B | 捕获generation/history epoch/runtime/recovery/session/run | 当前UI身份与存储完成分开 |
| 重复点击可连续删除同记录 | 当前pending复用同一Promise/一次dispatch | 不制造第二次缺记录的假失败 |
| 放弃失败显示通用恢复文案 | 固定提示尚未确认成功、资料保留 | 用户能区分失败与已放弃 |

保存record是放弃的身份依据，不要求liveSession/临时identity，也不拒绝recovering/takeover状态。成功取消mode、当前/待挂载landing、timer和checkpoint/identity，并推进history epoch使旧握手失效。失败只显示有限status与固定文案，不清资料或自动重试。

## 进行中取消的补充

独立只读复核发现：10秒timeout若已派发，clearTimeout不能取消其返回；慢删除成功后旧timeout仍可能覆写提示。主控确认属于A3取消的必要闭合。保留实际Host timeout派发入口，迟到返回回归1红→绿；timer触发前及返回/异常后复核epoch/generation/runtime/recovery/session/run。当前timeout仍正常显示，真实Runtime拒绝discard后同身份timeout也正常DEGRADED，不能一律吞掉超时。

## 验收证据

- A1：三个真实runtime/deferred discard红例＋一个已派发timeout红例，均转绿。
- A2：切换generation/history/runtime/record/session/run和卸载后的成功/异常不发布；REJECTED/DEGRADED/非空READY保留当前资料；新pending不被旧请求finally清掉；异常原文不进入提示。
- A3：真实DORMANT且无liveSession/identity成功删除并再BOOT确认无record；重复点击一次dispatch；相同身份新record对象不失效；恢复中取消callback取消timer，旧boundary operation失效；已发timeout晚到不再覆盖成功。成功cleanup接线经Host真实diff复核，callback/timer测试是隔离模拟，不称浏览器操作通过。
- A4：五文件94项通过：session-recovery-runtime、cs2d-session-recovery、session-wrap-up-completion、session-wrap-up-presentation、history-restore-controller。随后补当前timeout真实runtime正例，最终43项runtime/Host子集通过，总计95个不同相关用例。`pnpm typecheck`、`pnpm build`、`git diff --check`通过。独立默认配置只读复审确认must-fix闭合。
- A5：架构、学习与任务板同步，commit/push后释放。

沿用emil-design-eng/apple-design的真实状态反馈，实际SessionRecoveryStatus面板SSR显示固定放弃失败提示，未改布局、动画、透明度。Host仍不透传任意runtime reason。

## 限制与资源

只测内存、fake IndexedDB、SSR及Web production build；未使用真实Demo、模型、浏览器/服务、用户SQLite、Memory或密钥。原UI暂停A5未验证。全部fake存储测试清理，自有test/build退出。

DEGRADED时Runtime可能已删内存副本，Host保留资料不等于保证磁盘或刷新恢复；本轮不重写该存储语义或增加自动重试。相邻chooseRecoveryDemo仍直接accept REPLAY_LOADING返回，是可独立小fixture核实的候选，不在本轮扩大修复。
