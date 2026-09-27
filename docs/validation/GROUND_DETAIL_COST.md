# 采样地面元数据的历史详情成本

日期：2026-09-27。实现基线：2ef2901。本项验证新增 GroundSampleEvidence 是否造成可观察的历史打开成本，不改变产品契约。

## 测量边界

- 有无 ground 的同规模合成 Replay 分别经过真实 Adapter 生成，不修改生成后的 Timeline、候选或冻结哈希；生产序列化的 16 MiB 上限仍然生效。
- 通过隔离临时 SQLite 保存、关闭重开，执行实际历史 GET、JSON 读取、Controller 和恢复准备链。合成 header 只用于资料库生命周期，不是 Demo 解析。
- 原始输入含 10 名玩家，但 Adapter collectStates 每帧只保留选中玩家；历史采样数量不能乘以玩家数。
- 先小规模 smoke，再一组有限放大比较。单次观测用于定位成本，不是统计基准、真实整场性能或 120 秒等待预算的 SLA 证明。
- GET 构造包含资料库读取、外置产物解压校验及 Response JSON 序列化；响应体 JSON 读取另计。Controller.open 包含前两项，恢复校验/准备在其后，包含关系不能相加重复计时。
- 保存阶段的重复校验、fixture 深比较、计量用重序列化与断言不代表用户打开等待；fixture 保留对象与 spy 会影响内存，因此不将测试进程内存作为产品峰值。

## 资源与安全范围

执行者独占有界进程；无真实 Demo、网络模型、Viewer 冷解析或 GUI。临时数据库、控制器和准备器在 finally 中清理，仅删除自建随机目录。原用户数据库、Demo、Memory 和密钥不变。

## 观测结果与决定

机器为 Apple M1 / 8 GiB，darwin arm64、Node v22.17.0。[完整匿名摘要](GROUND_DETAIL_COST_RESULT.json)保留本次单对观测，不包含 Replay 或用户数据。

| 1 万条本人采样、1 个 cue | 无 ground | 有 ground |
| --- | ---: | ---: |
| Analysis UTF-8 JSON | 4,291,484 B | 5,810,894 B |
| Detail UTF-8 JSON | 4,419,082 B | 5,939,268 B |
| GET 构造（含本地物化与序列化） | 64.52 ms | 58.73 ms |
| Response.json | 19.65 ms | 19.61 ms |
| Controller.open（包含前两项） | 84.68 ms | 78.74 ms |
| 后续校验与恢复准备 | 34.26 ms | 46.87 ms |
| open 到 READY（包含以上打开/恢复阶段） | 119.47 ms | 125.70 ms |

两组均有 9,998 条存活采样。有 ground 组的 10,000 条来源中，FLAG_SET 7,998、FLAG_UNSET 1,500、null 502。两组分别真实通过 16 MiB 序列化门；恢复期间 analysis/narration 生成、网络及 Viewer 请求均为 0。

Detail 新增 1,520,186 B，约每条本人采样 152 B。新增元数据确实增加明文载荷，但本次未显示需要生产优化的打开瓶颈，决定保留现有契约、16 MiB 边界和 120 秒等待策略，不作压缩 schema、删样本或提高上限的改动。这里测的是 JSON 载荷，不是 gzip 文件磁盘占用。

88 帧 smoke 已先确认两组的样本数和来源保留：Analysis 141,164→154,986 B，Detail 268,470→283,088 B。其 GET 首组约 18 ms、次组约 2.7 ms，说明单次有序对存在冷暖与初始化影响；不能把较大样本 GET 后组更快解释为 ground 提升性能，也不能把总时间差当作稳定增量。

## 复现与验证

```sh
node tools/measure-ground-detail-cost.mjs smoke
node tools/measure-ground-detail-cost.mjs bounded
```

probe 默认不参加常规测试，仅在显式环境模式启用。parent 120 秒强制结束进程组，捕获输出上限 32 KiB；每个 Node/V8 进程 old-space 上限 2048 MiB，不是总 RSS 或整棵进程内存硬上限。单次 smoke / bounded 进程分别 1,402 / 2,842 ms，退出码均 0；runner 在测量后补强了独占 TMPDIR 和 SIGINT/SIGTERM 的进程组清理，并通过 node --check；未为清理改动重复性能测量。正常运行中的 fixture 已通过 finally 关闭并删除自己的临时库；补强后的父进程也仅清理自建随机根。

本轮 root 集中审阅真实 helper、probe、生产 collectStates/序列化/GET/恢复路径与日志；没有产品代码变更。样本是单合成回合与一个自然 cue，不是整场多 cue、真实 HTTP 网络、浏览器主线程或 Viewer 冷启动。

## 下一有限目标

本次读到的实际错误链是 serializer 的确定性容量失败 → Viewer 的 ANALYSIS_FAILED.message → Host 通用“请重新选择比赛或玩家”。下一项 analysis-capacity-feedback 先用有界夹具核实容量失败是否被误导为可通过原样重试恢复；若成立，只增加可操作的容量反馈，保留完整时间线与既有门，不再扩大本次性能样本或重跑正式 Demo。

最终验证：原库存与ground历史恢复2文件10项tests通过，`pnpm typecheck`、`pnpm cs2d:typecheck`、`pnpm build`、`pnpm cs2d:build`全部退出0，`git diff --check`通过。日志保留于`.local-data/ground-detail-cost-smoke/`。
