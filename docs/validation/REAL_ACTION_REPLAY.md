# 真实规则路线的自然慢放资格

2026-09-25；基线 `458ec88`，产品实现 `b5da690`。本轮不修改产品、Parser、Viewer、判断门或路线选择。新增验证工具与匿名证据：[机器摘要](REAL_ACTION_REPLAY_EVIDENCE.json)、[脚本](../../tools/validate-real-action-replay.ts)。

## 实际结果

已有授权 `test_demo.dem` 读取、WASM 解析各 **1 次**，采样参数 8；解析 6255 ms，解析及所有派生总计 7053 ms。唯一 Node 进程持有 Replay，顺序派生 6 名玩家，消费完第一个含合法案例的完整路线后停止，没有派生剩余玩家。网络请求 0，无模型、浏览器、服务、用户数据库或 Memory 操作。

| 验证玩家 | 候选 | 自然教学点 | 自然慢放 | 无动作事实而结束 |
|---|---:|---:|---:|---:|
| P1（原选手） | 44 | 4 | 0 | 4 |
| P2 | 58 | 2 | 0 | 2 |
| P3 | 63 | 2 | 0 | 2 |
| P4 | 66 | 1 | 0 | 1 |
| P5 | 67 | 3 | 0 | 3 |
| P6 | 58 | 4 | 1 | 3 |
| 合计 | 356 | 16 | 1 | 15 |

16 个实际 cue 都经过真实 Session reducer 完整结果门和默认内存 Graph；15 个没有 PlayerActionFact，也没有 candidate/cue/Narrator action refs，Host 零 capability、Graph 正确结束。不是因模型拒绝或后端报错。所有 cue 仍为 REVIEW_UNCERTAINTY / INSUFFICIENT_EVIDENCE。

此处使用 Adapter 的确定性 Director 规则路线、确定性 Narrator，没有 CS-Net 或模型。因此不能当成此前浏览器 Director/CS-Net 的同一条路线。P1 本次决策 tick 为 19426、31179、44507、45091，已经与此前 UI 记录不同。

## 可供后续界面定位的自然案例

匿名 P6，规则路线 `c1`、第 1 回合：

- canonical decision/reveal/outcome end：**8257 / 8259 / 8515**。
- 本人动作 `fact-cs2d-r1-event-123-action`，发生于 **8259**；DEMO 来源、本人 actor、窗口、candidate/cue/action fact 绑定、当前 playerAction 引用全部通过。
- capability 用途 `ACTION_FACT_REPLAY`，默认 Graph 自然生成一条 `REPLAY_CUE_SLOW` effect；没有注入选择、工具或 callId。
- Host 命令窗口 **8193–8515**、决策点 8257、**0.5 倍速**；callId 来自 Graph，重复请求被抑制。
- 模拟 ACK 经 Host 校验和 resume 关闭该内存工具生命周期，随后同一路线剩余 3 个 cue 正常结束。

P6 的可重建编号规则：将此前选择的 Dog 放第一位，再按解析后 `Replay.players` 原顺序追加其余玩家、排除 Dog；验证序列的第六位即 P6。身份及姓名未写入机器证据。原 A5 owner 在已有页面缓存可用时可于页面内重建这一顺序，不需为找身份导出 Replay 或重新解析。

证据引用含 `candidate-r1-bomb`，结合生产来源可判断这是 C4 类候选的动作事实；本次未保存动作文字或植包/拆包子类型，不进一步命名动作。它不证明战术选择正确、错误或动作准确起始时刻。后续 UI 如因模型/CS-Net 得到不同路线，应检查自然资格；不得为复现这条命令强制选点或工具。

## 验证路径与检查

1. `pnpm exec tsx tools/validate-real-action-replay.ts --smoke`：两个合成候选经 Compiler/Narrator，涵盖一条有动作、一条无动作、普通 SKIP、自动 FREEZE、结果末端前 LOCKED/末端后 COMPLETE、Graph 和 Host 命令/去重/模拟 ACK。合成时间不是 Demo tick 测量。
2. 在同一脚本真实模式，生产 Session 由 START、SKIP_SEGMENT、TICK、ADVANCE_SEGMENT 推进；没有手写 PAUSED_FOR_COACHING 或 COMPLETE gate。Session 自动跳过的冻结段按生产 Controller 的规则向 Graph 补发 observer。每个阶段、每个 cue 先写小摘要再进入下游，异常隔离。
3. 唯一真实命令由 Python `subprocess.Popen(..., start_new_session=True)` 监督，`wait(timeout=120)`；超时对该进程组 SIGKILL 并回收。Node 参数为 `--import tsx tools/validate-real-action-replay.ts <既有Demo路径> Dog`。**120 秒期限由外部 supervisor 强制，脚本内没有能中断同步 WASM 的计时器。** 实际退出码 0，未触发超时。
4. `pnpm typecheck` 通过；为脚本建立临时 tsconfig（extends 根 tsconfig.base、include 本脚本、Node types、incremental=false），`pnpm exec tsc --project .local-data/real-action-replay/tsconfig.json` 通过。未重复已有 257 项产品回归。
5. `pnpm build` 最初被上一轮临时 `/api/teaching-acceptance` 已删除但 Next dev 类型缓存仍引用的问题阻塞；将 `.next/dev/types` 移入本轮忽略目录保留后，重新 production build 通过。没有改源码绕过检查。
6. `real_route_evidence_review` 按默认配置完成限时只读审查：核对 Session/资格/身份/匿名摘要及真实与模拟边界，无 must-fix；未启动任何额外解析或进程。

Smoke 先暴露并修正了验证脚本自身的假设：两个不确定候选被生产去重合并；Session 自动跳过冻结段但 Graph 仍需要对应 observer；结束必须使用 COMPLETE_SESSION；普通 SKIP 必须显式纳入合成场景。均在读取真实 Demo 前解决。真实阶段没有失败、补读或改产品。

## 验收边界与后续

- A1 小样本前置通过；A2 一次真实解析与 120 秒期限通过；A3 取得一条合法自然 effect/Host 命令和 15 条有来源的拒绝结果；A4 未发现产品缺陷，无必要窄修；A5 证据、学习日志、任务板和同分支交付完成。
- 所有 6 条 **Session** 路线走到 COMPLETED；Graph 验证覆盖每 cue 及前置 observer，但没有同步最后 cue 后的普通段或 COMPLETE_SESSION，因此不声称 Graph 整场闭合通过。
- 未测试真实 Viewer 渲染、工具暂停至少 12 秒/续播、seek、重连或桌面 UI；模拟 ACK 不计入原 A5。原窗口仍由原 owner 在控制恢复后处理。本轮不改变其验收状态。
- 下一项可独立推进的工作：Adapter `index.ts` 的 `hasVerifiedAction` 当前只认 RETURN_AND_FIRE / UTILITY / 非爆炸 BOMB；可靠归属的普通 shot 在 `buildSelectedMatchEvents` 成为 WEAPON_FIRE，尚未自动绑定到已有 DEATH/HP_CHANGE 窗口。先用现有射击小 fixture 证明在确有合法 shot 时是否存在事实传递缺口，区分窗口内确实无动作与已有本人事件未绑定。不修改选点或判断门，不以结果反推玩家动作；本次没有统计未选候选的动作覆盖率，不能直接下结论说是遗漏。
- 唯一解析进程、smoke、类型检查和构建均已退出；无服务/浏览器生命周期，无额外 Demo 读取，原始数据未持久导出，工作树以外用户文件未修改。
