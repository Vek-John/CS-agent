# Jev 受限决策评估试点验收

**2026-09-24 集成修复**：实验评估改为并发2、配置后6秒总体期限，保存/同包结果复用不受新请求预算阻挡；修复 RETURN_AND_FIRE 遮蔽原 WIN_RATE_DROP 讲解的默认路线回归。`pnpm check` 1,039 tests通过/5既有跳过、TypeScript/Web production通过；80项桌面unit、Viewer及desktop prepare构建、正常与decision-pilot真实sidecar均通过。本轮没有新增模型请求或专业准确率结论，未执行完整WKWebView视觉走查或安装发布。详见技术学习日志2026-09-24记录。


**后续效果验证**：[同输入质量对照](JEV_QUALITY_COMPARISON.md)新增28次真实请求，当前没有验证出决策质量提升；固定配置下Jev结构化响应更快。下文保留原工程试点验收统计，后续累计调用与质量结论以该对照报告为准。

更新：2026-09-23。用户要求使用已有材料继续；本轮复用既有 Demo、解析工具和凭证完成本地实现与实测，无需用户补充材料。未提交、部署或安装到用户应用。

| 维度 | 结论 |
|---|---|
| 工程实现 | 原生Jev、独立配置、真实输入、校验、Director/Narrator消费、冻结恢复、评测与回退已验证。真实输入闭合的是 **RETURN_AND_FIRE 的受限拒判支线**；它不证明真正再次接敌/重复peek。 |
| 模型实测 | 新增5次真实Demo输入请求，全部UNKNOWN/UNKNOWN/INSUFFICIENT，全部通过拒判校验；其中2段进入实际教学消费。累计21次Jev、6次生成模型请求，失败也保留。 |
| 专业质量 | **未验证，不能宣布专业决策判断达标。** 无教练留出标签；新支线明确禁止肯定战术判断，正式自动接受关闭。高模型confidence不等于CS2正确率。 |

本地交付的是可回退试点和明确的能力限制，不是已经验证的专业CS2自动裁判。仍缺可靠视野/曝光、战术条件和真实专家质量证据，不要求用户为本轮工程验证另行提供资料。

## 真实输入结果

只读 `demoTests/test_demo.dem`，SHA256 `84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2`，60,601,900 bytes。使用本任务工作树带0007射手归属补丁的WASM，SHA256 `5ba3c62319d2f24cb6bc60e031ed0e9e39f0d11bd6e5b641c19bf804e16b7242`。每次运行只有一个子进程拥有Demo/Replay并解析一次，8Hz自身状态采样，10玩家×9回合。10个玩家视角属于同一Demo，不能当作10个独立质量样本。

- 535个候选，其中18个是本人离开后返回原开枪位置附近再开枪的几何模式；8个满足人数优势与证据绑定条件。其余364个不属于适用场景、163个没有独立结构动作。
- 默认模式10个玩家的cue/segment/explicit skip数量逐项与此前报告一致；新增模式不会默认产生教学。
- 离线运行8.237秒、峰值RSS580,911,104 bytes；1,999个断言、完整时间线覆盖、显式跳过、每玩家序列化恢复均通过。[离线证据](JEV_RETURN_FIRE_OFFLINE.json)
- Live运行17.835秒，硬预算5次，剩余3个eligible候选明确预算跳过，没有后台追加请求。[实际调用与消费证据](JEV_RETURN_FIRE_LIVE.json)

| 实际live计数 | 数值 |
|---|---:|
| 原生Jev请求 | 5 |
| schema/证据门通过并接受为TEST_ONLY拒判 | 5 |
| 实际Director摘要消费 | 2 |
| 冻结cue / Narrator实际消费 | 2 / 2 |
| 历史恢复Narration / 其中再读实验artifact | 28 / 2 |
| 恢复触发重新评估 | 0 |
| 真实合法包的结果反事实检查 | 8 |

消费计数在真实对象上断言：Director摘要与本地重新验证的assessment深等；Narrator实际收到artifact与INSUFFICIENT_EVIDENCE，coreIssue使用“不能确认再次接敌”的解释。没有按“文件存在/保存了artifact”冒充消费。其余通过的候选由原有教学选择与节奏去重，不强行插入讲解。

本次只有决策provider调用真实Jev；Director和Narrator使用现有确定性fallback，明确记录provider，不冒充生成模型全链路实测。普通浏览器/WKWebView全场视觉走查未在本轮执行。

固定模型 `jev-1.13.0`，投影 `decision-assessment-projection.v3`，问题 `return-and-fire-questions.v1`，接受策略 `recontact-acceptance.v1`。5次输出全部risk=UNKNOWN、alternative=UNKNOWN、context=INSUFFICIENT；这是按未知接触信息约束的拒判服从性，不能算战术准确率。模型confidence 0.98–0.99，证据confidence保持0。

| 本轮用量/延迟 | 结果 |
|---|---:|
| 输入 / 输出tokens | 13,180 / 2,455 |
| 按已记录公开输入费率估算USD | 0.00055356 |
| p50 | 461ms |
| p95 / p99 | null / null（5次不足以估计尾部） |

费用是返回usage乘费率的估算，不是账单核对。Jev全任务已记录用量为91,456输入、22,054输出tokens，估算USD0.003841152。生成模型成本未知，不编造全provider总价。所有凭证仅在不回显stdin/进程内存中使用，未写配置、报告或Keychain；远端只收到匿名白名单包，没有原始Demo/Replay/身份/路径/tick/结果标签。

## A1–A8

| 验收 | 状态与证据 |
|---|---|
| A1 | 真实Demo→动作事实→最终HTTP→校验→Director→Compiler→Narrator→恢复，2个真实拒判cue已实际消费。真正再次接敌的肯定决策判断仍未验证。另有synthetic实验的错误/正向映射工程回归。 |
| A2 | 最终HTTP及缓存fingerprint在相同决策/动作下替换随后个人生死、胜率与结果文本保持不变；8个真实合法包通过。nomination受既有live-round阶段范围限制，不声称任意改回合边界仍是同一候选。OutcomeCompletionGate回归通过。 |
| A3 | 封闭USER战术内容v2改变最终包与fingerprint，保留USER_PROVIDED及不确定性；队友看到不自动等于本人得知。两种报点有规则/Jev/生成模型实测对照，输出均拒判，专业语义调整质量未知；未新增报点输入UI。 |
| A4 | 缺证据/异常版本/引用/概率、HTTP429/529、超时、取消及迟到均明确回退。RETURN_AND_FIRE肯定判断被CONTACT_UNVERIFIED拒绝，原答案保留诊断。缺key不阻塞基础复盘。 |
| A5 | 11个人工设定案例、6个分组、2组结果反事实，明确SYNTHETIC_AUTHOR_EXPECTATION；另有真实Demo来源。只有真实解析时间称canonical tick，8Hz采样不称逐tick位置。 |
| A6 | runner保留所有可解析标签（含拒绝诊断）、拒判/接受覆盖、代理标签/替代项命中、代理Brier/ECE、按Demo分组探索CI及实际usage。没有专家标签，专业错误率/替代项质量/校准未知，正式自动接受覆盖0。 |
| A7 | 全量tests、TS、Web production、Viewer构建通过；原独立桌面初始化/runtime/Rust/sidecar smoke通过。完整覆盖、显式跳过、冻结/恢复/Memory边界回归通过。无WKWebView视觉smoke或用户应用安装验收。 |
| A8 | ARCHITECTURE 5.8.0、TECHNICAL_LEARNINGS、使用指南、任务卡及独立终审更新。PRD/MVP未改。 |

## 可复现命令与验证

```sh
pnpm check
pnpm cs2d:build
pnpm exec vitest run tools/jev-real-live.test.mjs
pnpm eval:decision-assessment
pnpm exec tsx tools/verify-jev-real-smoke.ts \
  --demo /absolute/path/test_demo.dem \
  --parser-dir /absolute/path/patched/cs2d/apps/app/src/viewer/parser \
  --out docs/validation/JEV_RETURN_FIRE_OFFLINE.json
# live另加 --live --key-stdin --max-calls 5；用不回显私有stdin发送一行凭证。
```

本轮 `pnpm check`：131文件、1,018 tests通过，3文件/5 tests既有跳过，TypeScript和Next production build通过；之后新增harness小测试及adapter兼容测试独立通过，最终完整test为132文件、1,024 tests通过，3文件/5 tests既有跳过。Viewer已重新构建。工具不在根tsconfig覆盖范围内，两个真实smoke文件另以严格tsc（显式`--types node`、Bundler resolution、allowImportingTsExtensions）通过。

早期桌面验证：runtime14、prepare/IPC21、stub1、Rust44通过；runtime/standalone build及真实sidecar两次启动、SQLite/导入去重、Memory导出删除、backup、可选decision init配置与关闭通过。用户真实数据库/Memory未被测试改动。

## 既有对照与失败记录

- [Jev首轮](JEV_LIVE_SMOKE.json)：7次请求，早期统计只含通过者，保留审计但不能宣传其命中率。
- [Jev诊断轮](JEV_LIVE_DIAGNOSTIC.json)：7次请求，所有可解析输出含被引用门拒绝的输出。解析/概率/引用拒绝已如实记录。
- [封闭报点Jev](JEV_USER_CONTEXT_LIVE.json)：2次请求；[生成模型对照](GENERATION_USER_CONTEXT_JSON_LIVE.json)：2次成功，configured deepseek-v4-flash / returned deepseek-flash。生成模型自报概率与Jev原生confidence不等价。
- 生成模型此前4次HTTP400分别保留在 [首次对照](GENERATION_USER_CONTEXT_LIVE.json) 与 [非thinking对照](GENERATION_USER_CONTEXT_NONTHINKING_LIVE.json)。后来依据JSON模式要求补充明确JSON指令后成功，没有隐藏失败或无限重试。
- 旧真实Demo零eligible记录保留于 [初始](JEV_REAL_SMOKE.json)、[引用修复](JEV_REAL_BOUNDARY_SMOKE.json)、[shot归属](JEV_REAL_SHOT_SMOKE.json)。本轮补齐更窄的本人返回开枪支线，并未伪造旧缺失的contact/LOS事实。
- [本轮独立终审](JEV_RETURN_FIRE_REVIEW.md)：消费计数P2已修复，无打开P1/P2。[评测定义](JEV_EVALUATION.md)说明分组与代理指标限制。

精确剩余限制：可靠contact/LOS/曝光未知；自身采样有0.25秒容差与未校准几何阈值；仅一份Mirage Demo的5次真实请求；没有专家留出标签；正式自动接受关闭；旁路仍在准备阶段有界等待；封闭报点只有schema/程序路径无新UI；无本轮全场视觉与安装包验收。以上不以接口成功、拒判成功或测试通过替代。
