## 问题与决定

<!-- 说明改了什么、为什么，以及它如何服务整场 guided coaching session。 -->

## 边界影响

- [ ] 不改变 Demo/Replay 所有权或 WKWebView File → Worker/WASM seam
- [ ] 不泄漏 future information、secret、token、用户数据或完整路径
- [ ] remote coaching WebView 仍为零 Tauri capability
- [ ] Memory consent/export/delete/tombstone 与 updater backup/rollback 保持 fail closed
- [ ] 已说明第三方 rights、签名/notarization 和 public release 影响

## 验证

<!-- 列出真实运行过的命令、结果、未运行项和剩余限制。 -->

## 隐私确认

- [ ] PR、fixture、截图和输出不含 `.dem`、SQLite/backup、原始日志、Keychain 导出、API Key、token、Memory 正文或完整本机路径
- [ ] 若改变架构契约，已更新 `ARCHITECTURE.md`；重要取舍已更新/新增 ADR；实现学习已记录
