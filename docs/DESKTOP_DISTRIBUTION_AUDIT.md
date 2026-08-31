# Desktop Distribution Audit

当前状态：**Stable Public Release blocked；owner-authorized unnotarized Preview allowed**。

本文件是 [DESKTOP_DISTRIBUTION_AUDIT.json](./DESKTOP_DISTRIBUTION_AUDIT.json) 的人类可读说明，不是 license grant，也不覆盖 `ARCHITECTURE.md`。

| Gate | 代码/记录状态 | 当前结论 |
| --- | --- | --- |
| 原创代码 | 根 MIT License | 可分发，但受第三方排除约束 |
| cs2d Viewer/Parser | 固定上游审计未发现明确 LICENSE | `BLOCKED_NO_LICENSE` |
| Valve 雷达/游戏资源 | notices/catalog 标记 local-only/review-required | `REVIEW_REQUIRED` |
| Developer ID / Team | workflow 要求受保护 secret | 尚无公开验收 |
| Apple notarization | workflow 要求 Accepted + staple validate | 尚无公开验收 |
| Updater 公钥 | config 为 `INVALID_PUBLIC_KEY_PUBLIC_RELEASE_BLOCKED` | 网络更新禁用 |
| Updater 私钥 | 只允许 protected CI secret | 尚无正式签名资产 |
| Bundled Node 许可 | 固定 tar 提取完整 `LICENSE`；manifest 记录 license SHA，bundle audit 复核 | local/internal 打包边界已实现；仍不替代其他第三方 rights Gate |
| CI updater verifier | Cargo `release-verifier` feature 单独构建 | 已验证不进入最终 App；公开 CI 仍必须用它反验正式签名 |
| Release identity / DMG fallback | preflight 输出 tag 的精确 commit；后续 job 复核 tag/HEAD/build SHA；fallback URL 按版本固定 | 不跟随移动分支，不接受 manifest/WebView 任意 DMG URL |

因此：

- public `desktop-v*` workflow 必须在 cheap preflight rights Gate 失败；
- local/internal ad-hoc app/DMG 不能称为 signed、notarized 或 publicly redistributable；
- 项目所有者明确授权的 `desktop-preview-v*` 只能作为 GitHub Pre-release，只含 ad-hoc Apple Silicon DMG 与其 `SHA256SUMS`，并显著标记未签名/未公证/无自动更新；
- Preview 不得发布 `latest.json`、updater archive/signature，也不得成为 `desktop-v*` stable Release；
- 代码层 updater 测试、quiescent backup、原子回滚与最终 internal bundle 验证不能替代正式公钥、Developer ID、notary 与 rights 证据。

Audit CLI 要求 `THIRD_PARTY_NOTICES.md`、机器可读批准记录、Environment approval、公钥/签名和最终资产相互一致，单文件修改不能放行。解除步骤与 CI 顺序见 [DESKTOP_RELEASE_RUNBOOK.md](./DESKTOP_RELEASE_RUNBOOK.md)。
