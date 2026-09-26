# Demo同文件重新选择验证

日期：2026-09-27；基线42222ca；实现分支codex/jev-decision-assessment。

主Demo input的onInput原先只转交files。0020补丁同步转交后清input.value，复用同组件.cs2dv入口方式。onFiles在第一个await前捕获File，因此pendingManagedImport持有原引用，清值不会清掉待导入文件。不改变协议、解析或上传行为。

## 验证

- 当前上游实际onInput/onFiles函数隔离执行：旧入口仍有选值；新入口清值后pending仍为同一File；第二次调用生成不同requestId和generation、取消旧signal；空选择没有额外请求。模拟input清空时同时清FileList，仍保留File引用。仅小metadata对象，不声称真实浏览器change事件已实测。
- 本地探针：`.local-data/demo-picker-reselection/probe.mjs`，输出`probe.txt`；该临时探针不属于CI，复核逻辑是直接提取当前SFC两个函数、Node stripTypeScriptTypes后注入managed状态/事件收集器。旧实现对照仅还原onInput原行。
- `node tools/apply-cs2d-host-patch.mjs --reuse-patched-checkout`：第一次应用0020、第二次安全复用，均成功。
- `pnpm exec vitest run tools/apply-cs2d-host-patch.test.mjs apps/web/lib/review-history/import-capability-deadline.test.ts`：2文件22测试通过。
- `pnpm typecheck`、`pnpm cs2d:typecheck`、`pnpm build`、`pnpm cs2d:build`均exit 0。Viewer标准构建使用已有依赖/Parser工具链，无安装。日志在同一本地忽略目录。

主控复查patch及registry增量应用接线，测试/构建进程全部退出。未读用户Demo、SQLite、Memory或密钥；无新浏览器/服务/模型请求，未部署。没有真实文件选择器/上传验证，原UI A5仍独立等待。
