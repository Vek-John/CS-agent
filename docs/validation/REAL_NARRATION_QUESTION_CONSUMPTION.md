# 真实讲解与追问消费验证

2026-09-27；任务 `real-narration-question-consumption`；实现基线 `f62894b`。单一已授权 Demo、原指定玩家，不保存身份、原文、坐标、引用 ID 或精确 tick。

## 实际结果

| 项目 | 自然 cue 1 | 自然 cue 2 |
| --- | --- | --- |
| 判断 | INSUFFICIENT_EVIDENCE | INSUFFICIENT_EVIDENCE |
| 决策前本人开火来源 | 2 条 | 3 条 |
| 开火说明进入 Narration / 三段 View 实际文字字段 | 是 / 否 | 是 / 否 |
| 公开时钟已知 / 讲解包含 / 显示标签 | 否 / 否 / 否 | 是 / 是 / 是 |
| 血量显示 | KNOWN | KNOWN |
| 可问提示 | health、utilityKinds | health、clock、utilityKinds |
| 原问答函数返回有据项 | 2 / 2 | 3 / 3 |

[匿名结果](REAL_NARRATION_QUESTION_CONSUMPTION_RESULT.json)。所有回答引用均属于当前 CoachingPackage 的允许 decision 引用集；5 个提示全部可答，未因缺少时钟制造可答项。道具种类不等于数量。两个 cue 均保留证据不足的判断，结果不证明专业判断改善。

60,601,900B Demo 读取一次、8fps WASM 解析一次，解析 7640ms / 总流程 7815ms；9 回合、51 候选、2 cue，胜率 UNAVAILABLE。单次记录不是延迟承诺。Graph 未创建，Policy/Viewer ACK/fetch 均为 0。

## 呈现缺口与下一步

`buildThreeStageCoachingView` 有状态 chips 时不保留 currentSituation 正文；Host 对应区域只渲染 StatusList 和 limitations。两个自然 cue 的已验证本人开火说明已进入 Narration，却未进入 View 的文字字段。因此不能把此前“讲解包含事实”称为用户已经看见。

下一有限目标 `baseline-prior-fire-presentation`：用既有小 fixture 复现这个差异，仅将当前 cue 已验证、已引用的决策前本人开火事实呈现到基础状态区域。保留本人、时间、新鲜度、可见引用及不充分证据边界，不扩大为整段未知数值正文，也不把决策前开火当成处理窗口动作来开放工具。先小 View/实际组件验证，不再次读取真实 Demo，不依赖 native A5。

## 方法和限制

现有有界 probe 增加 `--questions`，共用实际 Adapter、冻结 route 和 Session 完成门；每段使用真实 CoachingPackage、确定性 Narration、ThreeStageView、CurrentCueResourceCache、QuestionContext、可问提示及原 answer 函数。先运行两个 smoke，再唯一一次正式解析；原无 flag 工具模式保持。

```sh
node --import tsx tools/probe-real-route-tools.ts --questions --smoke
node --import tsx tools/probe-real-route-tools.ts --smoke
node --import tsx tools/probe-real-route-tools.ts --questions <existing.dem> <player-name>
```

父进程 120 秒硬期限、child JS 堆 3GiB、输入 128MiB 上限、stdout/stderr 合计 64KiB 上限。Replay 留在 child，parser.free，匿名小结果先落盘。堆限制不是总 RSS 测量；Session tick 通知由 harness 驱动，没有浏览器渲染、模型、数据库或整场播放验收。

首个 smoke 暴露根 ESM 脚本混用 tsx ESM/CJS 导致 page-local WeakMap 双实例。将 cache 与 questions 统一从同一 CJS 入口加载后恢复，不改产品来源门；smoke 显式要求 health、clock 两项均有据，防止零提示空集通过。正式运行未受该问题影响，未重复解析。

## 验收与清理

6 文件 158 个相关测试通过；probe 专项 TypeScript、`pnpm typecheck`、`pnpm cs2d:typecheck`、`pnpm build`、`pnpm cs2d:build` 均退出 0。主控已读实际 diff、两个 smoke 与正式摘要，执行者 RELEASE。日志位于 `.local-data/real-narration-question-consumption`；本轮所有 probe/test/build 进程已退出，没有启动浏览器或服务。产品文件未修改。
