# Jev 决策评估试点：本地使用与边界

本轮是默认关闭正式自动接受的研究实现。已有Demo可提名“本人移动离开后返回原开枪位置并再次开枪”的事实模式，进入真实Jev试点；该模式不能证明再次接敌或重复peek。v3把接触状态固定为UNVERIFIED，只能接受信息不足的结论，不提供专业对错判定。长期契约以 [ARCHITECTURE.md](../ARCHITECTURE.md) 6.6.1 为准。


当前新准备默认使用v4匿名观察投影与6题联合证据协议：可区分来源/知识、本人或匿名已知主体、精确点与区域/方向/最后已知位置；给出粗地图格和代码计算的有界相对关系。网格不是战术点位，距离不证明补枪或视线。判断必须与模型显式选择的最小证据组合一致，否则拒绝。旧冻结v1–v3记录仍按原投影本地恢复，不重新调用。准备仍并发2、配置后总6秒；未知接触的返回开枪分支仍只允许拒判。

## localhost

默认不设置任何新变量，或设 `CS_DECISION_ASSESSMENT_MODE=RULE_BASELINE`，保留现有规则。启用旁路时，在启动服务的同一个终端使用隐藏输入设置 `JEV_API_KEY`（不要写进文件、公开变量或命令参数）：

```sh
read -s 'JEV_API_KEY?Jev key: '
export JEV_API_KEY
export CS_DECISION_ASSESSMENT_MODE=JEV_SHADOW
export CS_DECISION_ASSESSMENT_ACCEPTANCE=SHADOW_ONLY
pnpm dev
```

上述 `read` 是本项目 macOS/zsh 用法。旁路不修改教学判断，在准备阶段有界等待；配置 GET 上限 750ms，随后整个评估阶段最多 6000ms。最多 10 个不同包的请求、并发 2，原生单次总期限 2500ms、零重试、本地往返上限 3500ms。到达总期限后保留已完成结果，其余记为 SESSION_TIME_BUDGET 并继续基线复盘。保存结果和同包复用不占新请求次数。无 key、HTTP 429/529、未知模型、非法引用/概率、取消/超时均降级。用户取消会终止准备；上游已经发生的费用不一定能撤销。

仅在受控工程实验中可改为：

```sh
export CS_DECISION_ASSESSMENT_MODE=JEV_EXPERIMENT
export CS_DECISION_ASSESSMENT_ACCEPTANCE=TEST_ONLY
```

`TEST_ONLY` 使用未经教练校准的保守策略，不是正式自动接受。关闭时设回 `RULE_BASELINE` 并重启；可 `unset JEV_API_KEY` 移除当前 shell 的凭证。生成模型继续使用既有 DeepSeek/OpenAI-compatible 配置，完全独立。

现有“导入本地 Demo → 选玩家 → 开始复盘”会走准备 seam；当前真实数据不符合范围时不会发模型请求，完整播放继续可用。支持条件包括 Mirage、决策时本人的存活/人数事实、合法当前 ObservableState 和独立结构化 RECONTACT/REPEEK 动作，或保守检测的 RETURN_AND_FIRE 事实模式。后者使用独立v3场景/问题，肯定战术判断会被CONTACT_UNVERIFIED拒绝。自由文本中出现“peek”无效，结果死亡/击杀也无效。

## 桌面实验配置

无需改变生成模型设置。使用 Keychain Access 添加 generic password，service 为 `com.csagent.coach.decision-provider`，account 为 `api-key`。密钥只经过 Rust Keychain → stdin 初始化包 → sidecar 内存；没有环境回退，不进入偏好文件或日志。

偏好文件位于 `~/Library/Application Support/com.csagent.coach/decision-provider-config.json`，只有以下四个字段：

```json
{"schemaVersion":"desktop-decision-provider-preferences.v1","mode":"JEV_SHADOW","acceptance":"SHADOW_ONLY","model":"jev-1.13.0"}
```

保存后重启。关闭时移走该偏好文件并重启，不删除原生成模型配置或用户数据。无效/缺失偏好退回基线，缺失/锁定的 key 不阻止启动。本任务没有安装或替换用户应用、没有将提供的密钥持久化到 Keychain。

## 评测与结果

```sh
pnpm eval:decision-assessment > .local-data/jev-offline.json
# 已有服务端 JEV_API_KEY 时，显式少量真实调用：
pnpm eval:decision-assessment --live --max-calls=10 --timeout-ms=2500 > .local-data/jev-live.json
```

先 `mkdir -p .local-data`。也支持 `--key-stdin` 从标准输入仅读一行凭证；交互终端使用时需关闭回显（`stty -echo`，结束后 `stty echo`），或由有权限的父进程通过私有 stdin 管道发送；不要把 key 作为 shell argv。runner 不写配置、不打印 key、不读取全部环境。缺生成模型凭证时该对照列为 BLOCKED，绝不使用 mock 代替。

默认最多 10 次，硬上限 100 次，整个评测最多 10 分钟；相同 packet 在单次评测内复用。11 个案例由实现 Agent 编写、6 个人工 Demo 分组、2 组结果反事实，标注为 `SYNTHETIC_AUTHOR_EXPECTATION`，不是专家黄金集。输出保留 risk/alternative/context 各原子、全部可解析的被拒诊断、概率/独立 confidence、别名、限制码、版本、usage 与延迟。label 命中仅为合成作者代理指标；自动正式接受覆盖率为 0，错误率未知。按 Demo 分组 bootstrap 的区间也是小样本探索值，不能外推专业质量。

实际产物：

- [当前真实Demo离线结果](validation/JEV_RETURN_FIRE_OFFLINE.json)：535候选、18返回开枪模式、8个合法评估包，默认路线数量不变。
- [当前真实Demo live结果](validation/JEV_RETURN_FIRE_LIVE.json)：5次真实Jev拒判、2个实际教学消费、恢复零重新评估；[本轮独立审查](validation/JEV_RETURN_FIRE_REVIEW.md)无打开P1/P2。

- [验收报告](validation/JEV_ACCEPTANCE.md)：逐条状态、命令及剩余缺口。
- [真实 Jev 首轮](validation/JEV_LIVE_SMOKE.json)：7 次调用；v1 指标只含通过者，不能用其命中率声称整体质量。
- [真实 Jev 诊断轮](validation/JEV_LIVE_DIAGNOSTIC.json)：7 次调用，v2 将被拒输出纳入代理指标，解析/校验/失败分开。
- [初始真实 Demo smoke](validation/JEV_REAL_SMOKE.json) 与 [引用修复后复验](validation/JEV_REAL_BOUNDARY_SMOKE.json)：各一次真实 WASM 解析；后者517候选中354个不在场景、163个缺动作，仍0可评估输入。
- [评测定义](validation/JEV_EVALUATION.md)、[独立审查](validation/JEV_REVIEW.md)。

在保存的 ReviewPlan 中查看 `decision_assessment_run.records`；选中的冻结 cue 查看 `decisionAssessment`。这是本地审计产物，没有新增面向玩家的报告 dashboard。历史查看/重复打开只重验保存的 artifact，不发 Jev 请求；实验拒判不能创建习惯计数，也不能绕过结果播放或 Memory 同意。

真实输入复验工具（只读输入，输出必须在当前工作树）：

```sh
pnpm exec tsx tools/verify-jev-real-smoke.ts \
  --demo /absolute/path/test_demo.dem \
  --parser-dir /absolute/path/cs2d/apps/app/src/viewer/parser \
  --out docs/validation/JEV_REAL_SMOKE.json
```

该工具单个子进程拥有 Demo/WASM/Replay，1536 MiB heap、10 分钟期限，只返回匿名摘要，不把原始 Replay 搬进模型。只有此工具的真实 Demo 来源使用 canonical tick；合成回归从不声称 canonical。

## 后续进展：具体用户报点与射击事实

Observation 的可选 `user_tactical_context` 可以表达有实际内容的用户陈述：

```json
{"version":"user-tactical-context.v1","enemyArea":"A_SITE","enemyCount":2,"plan":"TRADE"}
```

它仅允许USER_CONTEXT/USER_ASSERTED/USER_CONTEXT_ONLY来源，所有字段封闭；不接受自由指令、玩家姓名或任意报点文本。敌区可选A_SITE/B_SITE/MID/UNKNOWN，计划可选TRADE/TAKE_SPACE/HOLD/RETREAT/EXECUTE/UNKNOWN，数量0–5或null。缺少该字段时保留旧v1请求和缓存键；带字段时使用v2投影。该schema供合法Observation构建和评测使用，本轮没有新增报点输入UI，也没有把它称为已验证语音。

仅运行新增一对报点案例：

```sh
pnpm eval:decision-assessment --case-prefix=structured-report-
# 配好私有输入后可显式加 --live；两个案例需要至多2次请求。
```

[JEV_USER_CONTEXT_LIVE.json](validation/JEV_USER_CONTEXT_LIVE.json) 记录了两次真实调用：只有敌区从A变B，来源/时效/置信度相同，请求及概率改变，但两例都诚实回答信息不足。它证明输入内容可区分，不证明专业调整正确。本任务累计16个真实请求、78276输入tokens、19599输出tokens，按公开费率估算$0.003287592；未持久化凭证。

0007 parser补丁已保留明确射手，真实Demo的1242次射击均有合法actor，见 [射击事实验证](validation/JEV_SHOT_ACTOR_SMOKE.json)。当前adapter1.5.2仅生成明确本人的WEAPON_FIRE事实；[新WASM全链路smoke](validation/JEV_REAL_SHOT_SMOKE.json)仍是354个场景外、163个缺动作。射击、雷达spotted或坐标重返都不等于已经证明再次接触。剩余可靠接触/曝光事实与专家标注不能由这些工程改动替代。

已有localhost生成模型配置可显式只读用于对照：

```sh
pnpm eval:decision-assessment --live --case-prefix=structured-report- --max-calls=2 \
  --generation-env-file=/absolute/path/.local-data/deepseek.env
```

工具只解析所需key/model，不复制文件或输出凭证。本任务已有两次成功的生成模型对照，服务端返回deepseek-flash，两例也均拒判信息不足；[完整记录](validation/GENERATION_USER_CONTEXT_JSON_LIVE.json)。另保留4次HTTP400失败，全部provider费用未知，不把失败当免费。Jev累计仍为16次，全部provider累计22次。

重建新增射手字段需要 `pnpm cs2d:patch`（包含 `--build-parser`），随后 `pnpm cs2d:build`；该脚本使用已存在的 `~/.cargo/bin` 工具链。仅打包旧WASM不会凭空得到射手字段，旧Replay缺字段仍按未知处理。

真实输入live复验在上述命令追加 `--live --key-stdin --max-calls 5`。使用本任务带射手归属补丁的parser；旧parser缺actor时诚实无候选。密钥从唯一子进程stdin读取一行，父进程不读取、不传argv/env；调用方负责不回显输入。单次完整运行10分钟期限、1536MiB heap，全局最多5次远端请求，重复请求在本次运行内复用。报告明确区分真实Jev和确定性Director/Narrator；本次5次均UNKNOWN/UNKNOWN/INSUFFICIENT，不代表战术准确率。

## v4语义与六题对照

`pnpm exec tsx tools/eval-decision-semantics.ts --split=development` 默认只列离线计划。显式live使用不回显stdin及已有具名生成配置；开发最多9次，冻结代理测试18次。本轮已经执行27次并停止：Jev有效明确判断仍0，生成模型仅在相似开发家族上出现代理成功，不能启用正式自动判断。详见 [阶段验收与实测](validation/JEV_SEMANTIC_ACCEPTANCE.md)。
