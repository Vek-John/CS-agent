# 换文件时结算旧解析

2026-09-27；基线8406814；partial_revision_restore默认配置实现，root确定接口、独立审查/构建/交付。

## 实现与证据

实际beginManagedLoad＋parseManagedFile＋useDemoParser小例中，旧Parser悬挂时切文件，原实现oldSettled=false，新解析留在串行tail。0026在推进generation后调用parser.cancel，每个parse拥有独立AbortController。读取等待可先结算；解压和Parser清handler、终止捕获Worker并结算；所有迟到回调校验owner。已开始File.arrayBuffer无法物理中止，但晚结果不再消费；同栈即取消不会新启动IO。

public parse取消返回false，正常成功/错误保留void；非managed handleFile仅false即退出，防止hydrate新结果被旧导入保存/导航。reset/hydrate/unmount结束pending；单独cancel不清已完成Replay/voice/hash，因此warm RESTORE不受影响。保留原managed串行/hash/代际检查，未动VALIDATE/数据库。

新增11项：managed tail解锁；read/decompress/parser三阶段取消和迟到success/progress/error；晚read失败不覆盖新完成；reset/hydrate/unmount结算；实际旧handleFile不recent.save/不router.push；已完成数据保留；立即取消不启动File IO。

`pnpm exec vitest run tools/cs2d-host/parser-cancellation.integration.test.mjs tools/cs2d-host/parser-worker-release.integration.test.mjs tools/cs2d-host/managed-replay-reuse.integration.test.mjs tools/cs2d-host/validation-deadline.integration.test.mjs tools/apply-cs2d-host-patch.test.mjs`：5文件60通过。原阻塞红例与最终日志位于`.local-data/parser-cancellation/{red,tests}.txt`。

0025→0026隔离受控升级、重复复用及真实checkout复用通过；旧worker/read补丁仅在0026完整reverse通过时认定已覆盖。静态bulk门从全patch stack缩到Viewer控制面，Parser保有原字节所有权；managed IndexedDB bypass仅精确接受新增取消早退。空upstream验证11项显式skip且exit0，未计入通过数。

root完成真实源码/diff集中复查，`pnpm typecheck`、`pnpm cs2d:typecheck`、`pnpm build`、`pnpm cs2d:build`、`node tools/benchmark-managed-replay-reuse.mjs --smoke`通过；日志同目录。所有自建进程退出，隔离checkout/空目录清理，执行者RELEASE。

## 限制

FakeWorker/source测试验证函数和Promise/状态顺序，不是浏览器真实WASM中断或大文件延迟测量。已开始的文件读取无法停止底层IO。未扩大处理archive/其他历史载入竞争；Parser构造同步异常路径留下一轮小验证。无真实Demo、用户DB/Memory、网络、模型、GUI或安装部署，原A5保持独立。
