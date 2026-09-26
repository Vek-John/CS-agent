# 同Demo温恢复验证

2026-09-27；基线f45c59e；root写入，partial_revision_restore默认配置只读方案/终审。

实际链：persistSelectedDemo→parseManagedFile→Parser→VALIDATE READY→REPLAY_READY；用户打开已有复盘后loadManagedDemo→fresh READ→parseManagedFile，原流程第二次Parser。useDemoParser没有自动缓存命中，hydrate反而清hash，不能作为可信缓存入口。

0021复用当前同身份的Replay/voice。仍读全body并计算真实SHA256，刷新filename/hash耗时；beginManagedLoad保留取消/代际与Worker终止，nextTick跨过清空选人后才新REPLAY_READY，后续选人沿原舞台ACK。不同身份、未ready、无hash、REANALYZE/SELECT_PLAYER仍冷解析。

## 证据

`pnpm exec vitest run tools/cs2d-host/managed-replay-reuse.integration.test.mjs tools/apply-cs2d-host-patch.test.mjs apps/web/lib/review-history/history-restore-controller.test.ts`：3文件41通过，新增12项。执行本地patched SFC真实函数，Parser为spy、9字节fixture非有效Demo；授权响应stub，SHA256使用真实WebCrypto。

- import→restore：fresh READ一次，Parser合计一次，保留同Replay对象，新的requestId/mode及ready generation；清空选择的nextTick先于ready。
- 非匹配身份/无hash/未ready/其他模式：仍两次Parser。
- 授权拒绝、长度或内容变化：失败且无ready。
- 旧body、hash或nextTick完成：不发布，不清后继loading。
- 在忽略目录副本反向还原0021，单条warm回归实际失败：期望1次而原实现2次。该结果在`baseline.txt`；最初的提取/微任务错误不是业务红。

`pnpm typecheck`、`pnpm cs2d:typecheck`、`pnpm build`、`pnpm cs2d:build`均exit 0。正常build再次复用补丁成功，未安装依赖。日志`.local-data/managed-replay-reuse`；函数集成suite缺upstream时显式skip，必须cs2d准备后才算验证。

## 限制

未实际WASM解析用户Demo、未测大文件时延/内存、未真实Vue卸载或舞台ACK；nextTick为测试stub只确认顺序。依然承担一次完整READ和SHA成本，不能声称零IO或实测倍数提速。没有修改Parser算法、Host保存产物/版本检查、库文件/SQLite/Memory或密钥。所有自建测试/build进程退出，没有浏览器/服务/模型请求或部署。独立窄审无must-fix，原UI A5保持独立。
