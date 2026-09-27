# Demo 解析失败的行动反馈

日期：2026-09-27。基线cb61684，codex/jev-decision-assessment。

## 已复现的问题与来源

上一轮真实filechooser选择8字节PBDEMS2样本，WASM返回“Supports only Source 2 replays”，Viewer原样显示。当前vendor/source2-demo/src/parser/mod.rs的Parser::new在len<16或前8字节magic不符时都返回WrongMagic，error.rs将它格式化为同一英文字符串。经过WASM/Parser Worker到useDemoParser直接显示，不能据此断言文件不是CS2、已损坏或解析器永远不支持。

本轮只在Viewer错误呈现边界提供明确下一步，保留Parser事实/协议、读取/解压/解析/Worker/取消的区别与现有所有权。已知格式检查失败提示选择完整CS2.dem；未知错误不泄露底层任意诊断，也不把运行环境错误归为文件损坏。原文件重选入口保持。

## 范围与验收

通过受控0034尾patch修改实际useDemoParser，registry保持复现，Rust/WASM不变。使用极小无效样本和真实composable的受控Worker结果验证错误、清理、后继成功/取消/迟到消息；不再次读取正式Demo、不触碰用户数据、模型或数据库。

真实界面只沿现有real入口选择8B自建样本，验证中文行动反馈与再次选择入口。后继成功由真实composable测试证明，不能冒称本轮再次解析了真实Demo。

## 结果

- 真实IAB原filechooser连续选择同一个8B样本两次：均出现中文格式检查提示，第二次parse/cache错误落定20ms；Parser Worker累计2、active0，model/agent/provider请求0。无控制台error/warn。提示与原重选入口保留。
- 新增9项真实composable错误/清理/后继成功测试（最初8项红例），最终4文件56tests通过；两端TypeScript与production build、real入口工具构建4.84s通过。0034隔离apply/reverse/reapply与实际受控尾升级、reuse通过。root核验真实diff与日志，执行者RELEASE。
- 截图补录使用另一新origin和同一8B样本；已用origin的存储保护如期拒绝重新挂载，未清理其缓存。全部自建页面/服务退出，正式Demo、用户SQLite/Memory/密钥未变。
- 行为测试命令：`pnpm exec vitest run tools/apply-cs2d-host-patch.test.mjs tools/cs2d-host/parser-worker-release.integration.test.mjs tools/cs2d-host/parser-cancellation.integration.test.mjs tools/cs2d-host/analysis-retry-entry.test.mjs`。另运行`pnpm typecheck`、`pnpm cs2d:typecheck`、`pnpm build`、`pnpm cs2d:build`。

证据 `.local-data/parser-file-error-feedback/`，匿名UI摘要见 [PARSER_FILE_ERROR_FEEDBACK_RESULT.json](PARSER_FILE_ERROR_FEEDBACK_RESULT.json)。仅改反馈，无新动画/布局，沿用已应用emil/apple技能；未重新验证操作系统原生窗口、模型完成或正式Demo的成功解析。

