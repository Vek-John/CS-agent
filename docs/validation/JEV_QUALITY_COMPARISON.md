# Jev 是否带来实际提升：同输入对照

日期：2026-09-23。结论：**当前接法没有验证出决策判断质量提升。固定输入与配置下，Jev按时返回结构化输出的表现更好，但没有产生新增、通过校验且非拒判的战术判断。继续保持实验状态，不应据此启用正式决策引擎。** 这不是“Jev普遍没有能力”的结论，也不是专业准确率排名。

本轮新增28次真实请求：Jev 9次，生成模型19次。真实Demo的5次Jev结果按原请求哈希复用，不重复计费；报告明确原测量日期。没有修改产品提示词、规则或接受门槛，没有发布教学或写入Memory。10秒测试只是离线诊断，不改变产品期限。

## 1. 三方同题对照：9个不同合成输入

复用既有11个工程案例，其中2个结果反事实使用相同输入并复用响应，因此主要统计单位是 **9个不同输入、6个人工Demo分组**，不是11次独立测试。双方均使用相同state及原子问题、固定3秒请求期限、各9次调用；最终HTTP不含作者答案和结果标签。规则仅为待验证的代理量表，与原产品的教学筛选不是同一个概念。

| 指标（分母9个不同输入） | 规则代理 | Jev | 现有生成模型 |
|---|---:|---:|---:|
| 可解析结果 | 9 | 9 | 4 |
| 通过确定性校验 | 9 | 4 | 4 |
| 通过校验且context充分、risk非UNKNOWN | 5 | 0 | 0 |
| 校验通过但信息不足 | 4 | 4 | 4 |
| 未完成/未通过 | 0 | 5次依据/引用拒绝 | 5次超时 |

规则在这些刻意构造的案例上吻合作者预期，不能把9/9当作专业准确率，更不能据此证明它优于模型。Jev在所有9个可解析输出上的risk作者集合命中为8/9；这只是合成代理一致性。

值得核查的失败：`bad-choice-good-result` 已明确提供可等待、无补枪窗口、可达安全掩体，作者设定期望UNWARRANTED/PREFERABLE；Jev原始输出为WARRANTED/NOT_ESTABLISHED/INSUFFICIENT，被UNSUPPORTED_RISK_JUDGMENT和UNSUPPORTED_CITATION拦截。这不能证明某段真实CS2选择一定错误，但说明当前输入/问题组合仍会产生与显式适用条件不一致的风险判断。其余肯定风险输出也没有通过引用支持门。

Jev本轮耗时395–2272ms，中位数501ms。生成模型4个完成响应为1785–2271ms，另外5个超过3秒；**超时是未观察到完成时间，不能当作模型在3秒完成，也不能拿它估算实际尾延迟。** 不报告可靠p95/p99或质量显著性。

证据：[全量原始结果](JEV_PAIRED_SYNTHETIC_LIVE.json)。其中byProvider旧汇总保留11条案例行，包含缓存复用；本报告主表明确按packetFingerprint去重。

## 2. 放宽到10秒的诊断：仅复测5个生成模型超时输入

为了避免把响应速度问题误说成模型不会判断，单独用相同输入、相同问题和同一模型配置复测5个超时案例。期限改为10秒，max_tokens仍为现有adapter的2400，保留3秒结果，不合并为统一实验或覆盖失败。

| 结果 | 数量 |
|---|---:|
| 通过校验，但仍UNKNOWN/INSUFFICIENT | 2 |
| 有可解析肯定风险输出，但引用支持不足被拒绝 | 1 |
| 达到2400输出token上限，UPSTREAM_FINISH | 2 |
| 新增通过校验且非拒判的判断 | 0 |

实际耗时4.48–6.27秒。这里只能归因到当前结构化协议、输出预算及题目设计；没有排除给生成模型更多预算或重做题目后的潜力。没有继续调整题目/输出上限以挑选更好的结果。

证据：[10秒诊断原始结果](JEV_GENERATION_DEADLINE_DIAGNOSTIC.json)。这不是未触碰的留出质量测试；它是按第一阶段超时选择的诊断子集。

## 3. 真实Demo：精确复用5个历史Jev请求

单子进程一次解析已有 `test_demo.dem`，核对原Demo及Parser JS/WASM SHA，再重建535个候选中的合法评估包。5个最终Jev HTTP body SHA256、state SHA及model/question/projection版本全部精确匹配此前真实测试后，才读取具名生成配置并发起5次新生成请求。原始Replay留在子进程，跨进程只传5个匿名白名单包和原教学assessment枚举。

| 同样的5个真实输入 | 规则代理 | Jev（历史复用） | 生成模型（本次实测） |
|---|---|---|---|
| risk | 5个UNKNOWN | 5个UNKNOWN | 5个UNKNOWN |
| alternative | 5个UNKNOWN | 5个UNKNOWN | 5个UNKNOWN |
| context | 5个INSUFFICIENT | 5个INSUFFICIENT | 5个INSUFFICIENT |
| 请求成功 | 本地规则 | 5/5 | 5/5 |
| 中位请求耗时 | 无远程请求 | 461ms | 1814ms |

这些v3输入描述本人返回位置再开枪，contactStatus=UNVERIFIED，接受策略本来就禁止肯定战术判断。因此三者一致主要证明信息边界与拒判行为；**不能用5/5一致证明任何一方的专业能力。** Jev和生成模型测量不同时，样本只有同一Demo里的5个相关片段，耗时差不应外推为普遍倍数优势。

原产品在这5个节点的assessment均为NO_TEACHING_VALUE。原试点曾把其中2个节点选入“证据不足”讲解；本轮对照表明，模型没有提供超出规则拒判的新增决策内容。不能把多了2次讲解中断视为已改善体验；本轮没有用户体验实验。

证据：[真实同输入对照](JEV_EXISTING_MODEL_COMPARISON.json)、[被复用的原Jev调用](JEV_RETURN_FIRE_LIVE.json)。历史记录只有choices/聚合confidence/usage等摘要，没有完整概率与引用，未伪造补齐或计算真实样本校准指标。

## 4. 结论与处理

- **可确认的工程优势**：当前受限Choice协议下，Jev在这批输入上更快，复杂合成包在3秒内解析完成率也更高。
- **没有验证出的产品收益**：更准确的决策判断、更好的可执行建议、更好的教学质量；两模型均没有新增通过门的非拒判判断。
- **当前主要瓶颈**：真实输入缺少可靠contact/LOS与战术条件；合成输入中原子问题与具体引用支持仍不稳。多做同一种拒判调用无法补上这些信息。
- **当前处理**：保留可关闭实验，默认规则与正式自动接受关闭。要推进核心判断重构，应先补充合法且有区分度的情境、重新验证原子问题与引用支持，再用固定同题对照证明新增判断。不能仅凭速度替换核心判断。

本轮结果足以作出“目前不值得作为正式决策引擎启用”的工程判断；不足以断言Jev本身永远不能改善CS2教学。没有教练标注留出集，专业准确率、接受错误率和建议质量均保持未知。

## 5. 可复现与费用/验证

```sh
# 首轮：私有不回显stdin一行Jev凭证；生成设置仅流式读取API_KEY/MODEL。
pnpm exec tsx tools/eval-decision-assessment.ts --live --key-stdin \
  --max-calls=18 --timeout-ms=3000 \
  --generation-env-file=/absolute/path/existing/deepseek.env
# 10秒诊断：默认无--live只输出计划；使用首次报告筛选，不改首次结果。
pnpm exec tsx tools/compare-jev-deadlines.ts --live \
  --generation-env-file=/absolute/path/existing/deepseek.env
# 真实5包：匹配全部原哈希后才调用，最多5次。
pnpm exec tsx tools/compare-jev-existing.ts \
  --demo /absolute/path/test_demo.dem \
  --parser-dir /absolute/path/task-owned/patched/parser \
  --jev-report docs/validation/JEV_RETURN_FIRE_LIVE.json \
  --out docs/validation/JEV_EXISTING_MODEL_COMPARISON.json \
  --live --generation-env-file=/absolute/path/existing/deepseek.env --max-calls 5
```

新增Jev9次usage为41,473输入/10,291输出tokens，按此前记录费率估算USD0.001741866；生成模型19次中5次首次超时没有usage，成本未知，不报告虚假的总成本。包含此前试点的累计实际调用为55次（Jev30、生成25），仍低于原100次上限。没有自动重试、密钥落盘、用户数据改动或远端原始Demo上传。

新增两个工具5个测试及独立严格TypeScript检查通过；脚本输出软链接越界检查在独审后补齐并回归通过。产品代码/接受门没有为本次测评改动，上一阶段1,024项测试及生产构建证据仍另列于 [工程验收](JEV_ACCEPTANCE.md)。本次不把回归测试数量当作模型质量指标。

[独立评价审查](JEV_QUALITY_COMPARISON_REVIEW.md)复核分母、诊断选择偏差、超时延迟与作者标签限制。
