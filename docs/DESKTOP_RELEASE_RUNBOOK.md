# macOS Desktop 发布 Runbook

本 Runbook 只描述发布工程，不授予第三方权利，也不取代 [ARCHITECTURE.md](../ARCHITECTURE.md)、历史冻结的 [ADR-0007](./adr/ADR-0007-local-first-tauri-desktop.md) 与实施修订 [ADR-0008](./adr/ADR-0008-desktop-runtime-implementation-amendments.md)。

## 当前结论：Stable blocked，未公证 Preview 已获 owner 授权

现在不得创建或宣传正式稳定桌面 Release，原因不是“还没写 workflow”，而是以下 Gate 尚未同时成立：

1. 固定 cs2d 上游没有已记录的明确再分发授权；
2. Valve 雷达/武器/游戏资产仍为 `LOCALHOST_ONLY` / `REVIEW_REQUIRED`；
3. `apps/desktop/src-tauri/tauri.conf.json` 的 updater 公钥是 `INVALID_PUBLIC_KEY_PUBLIC_RELEASE_BLOCKED`；
4. Developer ID、Team ID、notarization 和 updater 私钥只定义了受保护 CI 输入，尚无一轮满足 rights 后的公开验收证据。

机器可读 Gate 是 [DESKTOP_DISTRIBUTION_AUDIT.json](./DESKTOP_DISTRIBUTION_AUDIT.json)，当前 `publicReleaseApproved=false`。CLI 还会独立检查 `THIRD_PARTY_NOTICES.md`、受保护环境变量、公钥和 tag；改单个文件不能批准发布。

2026-08-31，项目所有者确认已取得所用第三方内容的再分发授权，并明确要求在没有 Apple Developer Program 的情况下继续发布。该确认只授权下述未公证 Preview，不伪造权利证据、Apple 签名或 notarization 成功状态，也不修改正式 `distribution:audit` 结论。

## 未公证 Preview 契约

- Tag 固定为 `desktop-preview-vX.Y.Z`，必须指向构建 DMG 的精确 commit。
- GitHub Release 必须标记 Pre-release，标题和首段必须写明“未签名、未公证”。
- 只上传 `CS-Agent-Coach_X.Y.Z_aarch64.dmg` 和仅覆盖该文件的 `SHA256SUMS`。
- 不上传 `latest.json`、`.app.tar.gz` 或 `.sig`；入库 updater 公钥继续保持阻断占位值。
- Release Notes 必须写明 Apple Silicon/macOS 13+、无自动更新、Gatekeeper 可能拒绝打开、不应关闭 Gatekeeper，并列出 build SHA 和 DMG SHA-256。
- Preview 不得更名或促销为 stable/signed/notarized；后续正式版仍必须走 `desktop-v*` protected workflow。

当前已发布 Preview：[`desktop-preview-v0.1.0`](https://github.com/Vek-John/CS-agent/releases/tag/desktop-preview-v0.1.0)，绑定 commit `6f1b841102147c2fd26a5d598af8c84c867af72e`；DMG 为 206,236,857 bytes，SHA-256 `4bb715af35231c633ede3b61df62313b9d6787a5d47230912201253192fe99de`。GitHub 远端 asset digest 已与本地校验一致。

## 固定发布身份

- 版本唯一源：`apps/desktop/package.json`。
- Tag：`desktop-vX.Y.Z`，必须与版本完全一致并已指向待发布 commit。
- Target：`aarch64-apple-darwin` / updater `darwin-aarch64`。
- Tauri：`2.11.5`；CLI：`2.11.4`。
- Bundled Node：`24.19.0`，验证 archive SHA、binary SHA、Mach-O arm64 和 `--version`；从同一固定 tar 提取完整 `LICENSE`，prepared manifest 记录 license SHA，bundle audit 复核；`THIRD_PARTY_NOTICES.md` 必须保留 binary 来源和 Node/随附第三方许可说明。
- CI：pnpm `11.16.0`、Rust `1.89.0`、Apple Silicon `macos-15` runner；workflow 仍执行 `uname -m=arm64`。

## Rights 批准步骤

公开 workflow 通过前必须全部完成：

1. 获得并记录 cs2d 明确再分发授权，或替换该 substrate；
2. 完成 Valve/game asset 再分发审查，或移除/替换受影响资源；
3. 更新 `THIRD_PARTY_NOTICES.md`，不再保留 unresolved/local-only/review-required 状态；
4. 更新 `DESKTOP_DISTRIBUTION_AUDIT.json`：批准位为 true、两项 status 为 `APPROVED_FOR_PUBLIC_REDISTRIBUTION`，并填写 HTTPS evidence、reviewer、时间；
5. 在仓库 Actions Variables 设置 `DESKTOP_DISTRIBUTION_PREFLIGHT_APPROVED=true`，只供无 secret 的 Linux rights preflight 使用；另在受保护 `desktop-release` GitHub Environment 设置 `DESKTOP_DISTRIBUTION_APPROVED=true` 并要求人工批准；
6. 将正式 minisign/Tauri updater 公钥提交到 Tauri config，并由私钥签名后在 CI 反向验证；
7. 配置并验证下列受保护 secret：
   - `APPLE_CERTIFICATE_BASE64`
   - `APPLE_CERTIFICATE_PASSWORD`
   - `APPLE_SIGNING_IDENTITY`
   - `APPLE_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD`
   - `APPLE_TEAM_ID`
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

测试 fixture 不是 rights evidence。Updater 私钥、Developer ID 证书和 Apple 凭据不得进入 Git、artifact、release 目录或日志。

## 本地检查

以下命令不发布资产：

```bash
pnpm desktop:test:unit
pnpm desktop:test
pnpm desktop:build
pnpm desktop:smoke:bundle
pnpm desktop:smoke:update-local
pnpm desktop:smoke:webkit-demo

node --test tools/desktop-release/audit.test.mjs
node tools/desktop-release/audit.mjs workflow --path .github/workflows/desktop-release.yml
pnpm distribution:audit
pnpm release:check
```

当前真实 `distribution:audit` 应失败；典型错误是 `THIRD_PARTY_RIGHTS_BLOCKED`，公钥 Gate 解除 rights 后仍会拒绝 placeholder。不要为了本地 build 削弱它。

`desktop:smoke:update-local` 不访问 GitHub、不安装到 `/Applications`：它复制当前真实 App 为 0.1.1、用运行时临时 Tauri key 签名 archive、通过自签 CA 的本地 HTTPS 流式下载、调用 production Rust verifier、拒绝篡改并验证解包后的 arm64/codesign/version；私钥和全部大文件在同一 controller 的临时目录中清理。Rust 纵向 fixture 另以真实 `RENAME_SWAP` 验证 1.2.3→1.2.4、pending receipt、用户数据不变和 health 后清理旧 App。它证明更新工程，不是 Developer ID/notary/public Release 证据。

`pnpm desktop:build` 使用 ad-hoc identity `-`，默认只能用于开发机或受控 internal RC；只有满足上述隔离 Preview 契约时才可作为公开 Pre-release DMG。Tauri 只产出 App；`apps/desktop/scripts/create-dmg.mjs` 使用 `ditto`＋`hdiutil` 创建并双重校验 DMG，不启动 Finder/AppleScript，失败时保留旧镜像。它不是 Developer ID 签名、notarization 或公开再分发证据，也不生成/发布 `latest.json`。通过浏览器或聊天工具传输会引入 quarantine，Gatekeeper 可能阻止打开；不要要求测试者关闭 Gatekeeper。

## CI 精确流程

`.github/workflows/desktop-release.yml` 只接受已有 `desktop-v*` tag 或显式指定的已有 tag：

1. 在 Linux runner 使用仓库级 `DESKTOP_DISTRIBUTION_PREFLIGHT_APPROVED` 验证已有 tag→HEAD、版本、target、rights JSON 和 notices，并输出该 tag 的精确 commit；该 job 不声明 Environment，因此不读取 Environment secret 或变量；
2. 通过 `desktop-release` Environment 人工批准后，Apple Silicon job 使用该 Environment 内的 `DESKTOP_DISTRIBUTION_APPROVED=true`，并验证所有受保护 secret 仅“存在”，不打印内容；
3. Apple Silicon job 只 checkout preflight 输出的精确 commit，再次验证 tag、`HEAD` 与 `CS_AGENT_BUILD_SHA` 完全相等；随后使用 lockfile 和 pinned Node/pnpm/Rust，执行 `desktop:prepare`、desktop unit/real sidecar、typecheck；
4. 将 Developer ID 证书导入临时 Keychain，使用临时 Tauri config overlay 构建 App，再复用 Finder-free DMG 构建器；检查入库 config 保持 ad-hoc；
5. 提交 Apple notarization，要求 `Accepted`，对 app 和 DMG staple 并 validate；
6. `distribution:audit bundle` 验证 prepared manifest、Node binary/license SHA、arm64、filesystem permission、app version/architecture/Developer ID/team/notary；精确 repo build-root 只做等长清理，上游 Node binary 自带的 `/Users/runner` 不作为仓库路径泄漏；
7. 从 stapled app 生成 updater archive，以 CI 私钥签名，再用 `release-verifier` Cargo feature 构建的 CI 专用 verifier 和检查入库公钥验证签名；确认该 verifier binary 不在 App bundle；
8. 生成并审计固定资产、不可变 URL、SemVer、hash 与单平台 `latest.json`；
9. 先创建 draft GitHub Release，完整上传后再发布；失败时删除本 workflow 创建的 draft；
10. `always()` 清理临时证书、Keychain、notary profile 与 config overlay。

Workflow 不创建 tag、不推 commit，也不上传约 318 MB prepared runtime 中间产物。

## 正式稳定版固定公开资产

版本 `X.Y.Z` 只能发布：

- `CS-Agent-Coach_X.Y.Z_aarch64.dmg`
- `CS-Agent-Coach.app.tar.gz`
- `CS-Agent-Coach.app.tar.gz.sig`
- `latest.json`
- `SHA256SUMS`

`latest.json` 只含 `darwin-aarch64`，URL 必须指向同一个 immutable `desktop-vX.Y.Z` Release；signature 与 `.sig` 完全相同；`SHA256SUMS` 覆盖其余四个文件。

## Updater 实现与发布证据

代码已实现并有单元/fixture 验证的顺序：HTTPS check、24 小时自动频控、用户分开确认下载/安装、stream limit、minisign、safe archive extraction、Developer ID/team/version/permission 校验、coaching busy gate、sidecar runtime 进入 `DRAINING`、拒绝新 Next 请求、等待既有 handler 与 response active count 归零、SQLite writer/checkpoint drain 与 backup、同卷 staging、`RENAME_SWAP`、pending receipt、新版本首次 health confirmation、失败 rollback、DMG fallback。activity counter 只覆盖 Next/API；iframe parser 不产生 server write。关闭主窗口只隐藏并继续保持 busy；只有 Settings 的“结束当前复盘”成功导航到 bundled maintenance page 后才解除，选择“稍后”或关闭 Settings 会恢复复盘。

DMG fallback 只在 updater 进入对应状态时开放。用户点击一次后，Rust 重新构造并校验精确 `https://github.com/Vek-John/CS-agent/releases/download/desktop-v{version}/CS-Agent-Coach_{version}_aarch64.dmg`，再调用系统打开；manifest、WebView 或重定向参数不能替换该 URL。

这不等于正式公开更新已通过。当前公钥阻断网络更新，且还没有一组由 rights-approved、Developer ID signed、notarized、正式私钥签名的公开资产完成端到端验收。最新资源修订与 feature-gated verifier 合入后的本机 App/DMG 已重建并通过 bundle、内容和 GUI 证据复核；这些 internal ad-hoc 结果仍不能外推为公开 Release 验收。任何文档或 Release Note 都必须保留这一区分。

失败规则：缺 rights/公钥/secret/tag/identity/team/arm64/hash/notary/staple/backup/atomic swap/health/asset 任一项即停止；不得调用 Tauri 官方破坏性 install 路径，不得覆盖当前 app 或伪造成功状态。
