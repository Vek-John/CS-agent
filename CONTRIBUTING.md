# 参与贡献

感谢参与 CS Agent Coach。Desktop 是主产品；Cloudflare/localhost 是开发兼容 adapter，不应反向扩大桌面前置条件。

## 开始前

1. 阅读 [AGENTS.md](./AGENTS.md)、[ARCHITECTURE.md](./ARCHITECTURE.md) 和相关 ADR。
2. 对行为变化说明它是否影响完整时间线、显式跳过、结果后讲解、observable-state 边界、Memory 删除或桌面权限。
3. 不在 Issue、PR、fixture 或命令输出中附带真实 `.dem`、SQLite/backup、日志、API Key、token、Keychain 导出、用户 Memory 正文或完整本机路径。
4. 未解决 third-party rights、正式 updater 公钥、Developer ID/notarization 不能通过代码描述或测试 fixture 被“批准”。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build

pnpm desktop:test:unit
pnpm desktop:test
pnpm desktop:build
pnpm release:check
```

只运行与你修改范围相关的最小命令，但 PR 必须列出真实执行过的命令、结果和未执行项。`desktop:build` 是 ad-hoc/internal 构建，不是正式 Release。涉及大 Demo 或 bundle smoke 时，遵守 AGENTS.md 的单 controller、阶段 smoke、超时和 cleanup 规则。

## 代码与文档边界

- Parser 输出事实，不输出教练结论；事实、推断、建议、证据分离。
- raw Demo/Replay/frames 留在 Viewer/Worker；不要把路径或 bytes 搬进 Rust/Next/Agent。
- remote coaching WebView 保持零 Tauri capability；新增系统能力必须是 bundled window 的窄命令并有负测。
- Secret 不进 argv、environment、URL、日志、SQLite 或前端返回值。
- 架构契约变化先更新 `ARCHITECTURE.md`，重要取舍增加或取代 ADR；实现经验追加 `docs/TECHNICAL_LEARNINGS.md`。
- 不修改 `PRD.md` / `MVP_SCOPE.md`，除非产品范围确实变化。

## Pull Request

PR 应包含：问题、决定、风险、测试、数据/权限影响、rights/update 影响和明确限制。保持改动有界，不顺手重构无关模块。提交前运行 `git diff --check`，检查新增文档链接，并人工复查 diff 中没有 secret 或用户数据。
