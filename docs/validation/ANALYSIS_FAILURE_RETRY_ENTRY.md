# 分析失败后的实际恢复入口

2026-09-27；基线31d4089；任务analysis-failure-retry-entry。

## 实证问题

实际selectHostPlayer函数在第一次选人后锁定主体。普通分析失败后再调用同人或其他人均不再次build，这个锁保留会话身份，不能直接解除来实现重试。

恢复应使用新的Demo选择或已有历史的显式重新分析。实际Vue模板的唯一file input却处在landing的v-else中：compiler＋SSR证明idle有1个input、done为0，已有requestDemoPicker→pick仅执行input.value?.click，因此已就绪舞台上的导入入口缺失实际目标。

## 最小修复

- 0033只把原file input整体移到根容器常驻区域，accept/onInput/click.stop原样保留；不新增桥接命令、不改变Parser或选人锁。
- Host失败卡增加原生“重新选择 Demo”按钮，复用已有requestDemoPicker。它只请求打开选择器，不预先清错误或原始回放。
- 普通反馈与实际按钮一致，只有desktopLibraryEnabled时才提示已有历史菜单；容量反馈仍说明原样重试无益，Web也不再建议不存在的历史入口。
- 使用原cs2d-coach-primary样式与原生button交互，无新动画/透明层，保持既有减弱效果规则。

## 验收

- 实际Vue完整模板编译与SSR：idle/done/reading三态均保留1个Demo file input。Vue依赖解析及初版render包装失败后，收敛为现有compiler的prefixIdentifiers与单函数包装，没有新装测试工具。
- 实际Host按钮handler→唯一requestDemoPicker，Viewer已接到pick；打开后取消/空FileList不调用parse、不变更Replay/主体锁、不新发分析事件。
- 实际onInput同文件连续两次选择均清value并调用原文件入口；实际新Replay watcher重置选择锁。root将成功case从stub READY补强为真实buildCs2dAnalysisBundle→serialize→deserialize，可校验玩家身份和非空cue。
- managed选择新文件才beginManagedLoad；旧infer在换source后完成不会发布READY/FAILED；RESTORE不增加推理/分析调用。原sidebar重新分析/其他玩家菜单及Revision逻辑不变。
- 0032→0033隔离apply/reverse、实际受控树reuse通过；临时patch目录清理。仅Viewer模板修改，没有Rust/WASM改动，未重复编译WASM。
- 6文件70项相关tests通过，root补强成功case后受影响7项再次通过（包含于前述70，不累计）；Web与Viewer TypeScript、两端production build和diff检查通过。日志`.local-data/analysis-failure-retry-entry/`。

```sh
pnpm exec vitest run tools/cs2d-host/analysis-retry-entry.test.mjs
node tools/apply-cs2d-host-patch.mjs --reuse-patched-checkout
pnpm typecheck
pnpm cs2d:typecheck
pnpm build
pnpm cs2d:build
```

## 限制与后继

本轮是实际模板SSR、source handler与Adapter验证，ViewerStage渲染/Parser文件读取/模型仍为边界stub；没有实测系统文件对话框或完整GUI，没有读取真实Demo/用户数据库/Memory/密钥。重新导入会按已有流程工作，本轮不承诺省去解析。执行者及root的test/build均退出，未安装或部署。

下一有限目标guided-two-cue-handoff：现有真实Viewer小场景主要证明单次工具播放/暂停/返回，不能直接等同完整带看。先复用合成输入生成两个自然cue，验证第一段完成→回决策点讲解→显式继续→第二段的真实Session/命令衔接，记录每段覆盖、ACK和错误计数。保持一个controller、小数据、明确超时，不解析正式Demo、不重启原native A5锁屏路径。
