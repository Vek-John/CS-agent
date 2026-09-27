# 分析容量失败反馈

日期：2026-09-27；基线 ffb8a0c；任务 analysis-capacity-feedback。

## 问题与改动

合法小 AnalysisBundle 在 metadata.limitations 内加入一个有界超限字符串，通过真实 serializeCs2dAnalysisBundle 触发原 16 MiB 门。实际受控 Viewer selectHostPlayer 的 catch 发出 ANALYSIS_FAILED，通过严格桥接 envelope 检查后进入实际 Host 失败分支，原提示仍要求重新选择比赛/玩家。错误卡出现后，标题和准备步骤也仍宣称正在分析/构建。

Host 现在只将三条当前生产容量错误原文精确映射为容量说明，指出原样重试不能解决，建议选择其他比赛或打开已有复盘。未知、相似子串、前后缀、非字符串均返回既有通用反馈；没有显示任意 transport 错误或引入协议/上游 patch。Adapter 与完整覆盖、字节/候选上限不变。

标题显示“分析未完成”，准备步骤说明分析已停止、完整教学复盘尚未就绪。用可用性措辞，因为序列化超限可能发生在内部 plan 已生成之后，不能断言此前从未生成产物。

## 验证方法与限制

- 有限字符串一次触达真实16MiB边界；小Replay的513个合成事件触达真实候选上限。未扩大性能样本或解析正式Demo。
- 读取并执行实际受控 Viewer 函数、Host ANALYSIS_FAILED分支、标题和setupSteps表达式，使用边界依赖stub/setter spy。检查不发ANALYSIS_READY、仍清本次准备/标记失败、旧玩家失败不发布提示。
- 这不是完整Vue/React挂载或GUI验收；Viewer源码缺席的环境会跳过对应集成case，本轮存在受控源码且实际执行，不能将其他环境的skip算通过。
- 没有修改事件归属、保存代际、播放器选择锁或恢复入口。没有用户库/Memory/密钥、模型、网络、安装或部署操作。

## 下一项

root读到Viewer在selectHostPlayer开始后锁定hostSelectedPlayerId，失败catch不解锁；Host通用失败仍建议重选玩家。下一有限目标 analysis-failure-retry-entry：用有界真实选择函数/已有命令验证失败后可用的重选或重新分析路径，区分普通本地入口与managed历史入口。只有确认用户无法按提示恢复才修最小入口/反馈，不扩大本轮容量范围、不动完整时间线或增加自动重分析。

## 最终验收

新增15项通过；最终容量/generation/player-selection 3文件31项通过，其余已运行相关55项通过（重叠项不重复累计）。基线generation静态断言曾因旧内联门已抽入helper失败，改验真实接线并补实测选择门后通过。`pnpm typecheck`、`pnpm cs2d:typecheck`、`pnpm build`、`pnpm cs2d:build`及`git diff --check`均通过。日志在`.local-data/analysis-capacity-feedback/`，root已查看实际输出；无遗留测试/构建进程。

```sh
pnpm exec vitest run apps/web/lib/coaching/analysis-capacity-feedback.test.ts apps/web/lib/review-history/generation-gate.test.ts apps/web/lib/review-history/player-selection-history.test.ts
```
