# 真实路线默认工具选择

2026-09-27；实现基线58e0535；任务real-route-default-policy。只读已有授权test_demo.dem的既有目标玩家，原始Replay始终留在单一child，输出不含原身份、坐标、引用ID、Demo hash或讲解正文。

## 本次观察

| 项目 | 结果 |
| --- | --- |
| 文件与解析 | 60,601,900B，读取1次、8fps WASM解析1次，parse7567ms/总7813ms（单次记录，不是SLA） |
| 当前Adapter输出 | 9回合、51候选、2cue；胜率UNAVAILABLE |
| cue 1 | REVIEW_UNCERTAINTY / INSUFFICIENT_EVIDENCE；action引用0、decision引用6；合法工具0，直接FINISH/CUE_COMPLETED |
| cue 2 | 同样保持不确定性；action引用1、decision引用5；唯一REPLAY_CUE_SLOW / ACTION_FACT_REPLAY，实际source RULE |
| 策略与模型 | policyCalls=0，fetch=0；没有模型调用或专业判断改善结论 |

[匿名结果](REAL_ROUTE_DEFAULT_POLICY_RESULT.json)。旧摘要44候选/4cue不具有完整可比输入/运行条件，不能把51/2直接归为回归或提升。

## 为什么会这样

当前Compiler判断类别不等同战术工具目的。`teaching-purpose.ts`对当前类别只定义ACTION_FACT_REPLAY；Host要求动作同时绑定当前玩家、候选、冻结cue、合法时间窗与讲解引用。Graph零能力直接结束，单能力通过确定性检查后走RULE快速路径，policyCalls仍为0；只有多能力分支才调用PolicyAdapter。当前API未注入模型Policy，默认Adapter也是deterministic。

Runtime不保存实际rationaleCode，本probe以null及NOT_RETAINED_OR_NOT_CALLED表达，不另调用策略函数编造“实际理由”。Runtime历史source MODEL表示策略适配器分支，本身也不能证明发生模型请求。

可执行结论：保留无独立动作时的FINISH，不为提高工具/Policy调用数强造能力。动作慢放可以复查已记录动作，不能把它说成验证了战术错误。下一步先核实当前动作事实的覆盖范围，区分“没有记录成独立动作”和“没有动作”；只有源事实足够才考虑补充。

## 可重放工具与约束

```sh
node --import tsx tools/probe-real-route-tools.ts --smoke
node --import tsx tools/probe-real-route-tools.ts <existing.dem> <player-name>
```

父进程硬期限120秒、child JS堆3GiB、输入最多128MiB、stdout/stderr总量最多64KiB。3GiB是JS堆限制，不是实测总RSS；同步WASM由父进程kill约束。child一次读取同时计算普通会话身份，未单独做哈希审计。先smoke后唯一真实运行，未重复正式解析。

真实Adapter/讲解/冻结route/默认Runtime/HostAdapter使用实际实现；Session tick通知及Viewer成功ACK由harness驱动以继续后续cue，不是实际播放验收。无SQLite、GUI、模型、部署或安装。

主控复查后额外给未来运行增加START结果activeCue/segment/cursor匹配断言，防旧状态被误计为新行；该新增guard只复验合成smoke，未为了新断言重复真实解析。正式匿名结果保留最初的一次运行，两个不同自然分支及输入/Graph门由源码复核。

19相关tests通过，probe专项tsc检查、pnpm typecheck、pnpm cs2d:typecheck、pnpm build、pnpm cs2d:build均退出0。日志.local-data/real-route-default-policy/{smoke,smoke-reviewed,result}.json、tests.txt、typecheck-probe.txt及两端TS/build日志。执行者RELEASE，父子进程/timer全部退出。
