# Parser Worker结束后的释放

2026-09-27；基线6ed34d1；root实现，partial_revision_restore默认配置只读预检/终审。

## 所有权与决定

useDemoParser原先在最终成功或解析失败后仅resolve，Worker与WASM实例持续存活到组件卸载。worker内部解析Replay、解码voice、free结果，再postMessage；页面收到后持有克隆Replay及转移的voice buffers。此时释放worker不会要求页面清Replay。

0022在最终消息和onerror统一finish：settled一次门、清两个handler、terminate捕获的w、仅引用仍匹配时清当前worker。旧回调入口先拒绝settled，不写新状态。progress保持活跃；next cold parse由ensureWorker创建新实例，0021温恢复使用page refs无需重建。

## 验证

只读真实Demo一次：60,601,900字节，当前WASM导出的memory在init后1,114,112 bytes、parse_demo后184,483,840、result.free后仍184,483,840。Python父进程120秒截止，Node heap3GiB；raw不离开进程，只返回内存/大小/耗时摘要。脚本及输出在`.local-data/parser-worker-release/retained-memory.mjs`与`memory.txt`。已有benchmark现在记录init及各阶段wasmLinearBytes，便于复现同类观察；本轮不再重复成本探针。

`pnpm exec vitest run tools/cs2d-host/parser-worker-release.integration.test.mjs tools/cs2d-host/managed-replay-reuse.integration.test.mjs tools/apply-cs2d-host-patch.test.mjs`：3文件33通过。新增5项执行实际patched useDemoParser配FakeWorker：成功保存refs后释放一次、progress不中断、解析失败/Worker错误后新建、旧error/success/progress不影响后继、完成后卸载不重复terminate。修复前5项业务红；最初动态函数import.meta替换错误属于harness问题，修正后才记录业务红。

`pnpm typecheck`、`pnpm cs2d:typecheck`、`pnpm build`、`pnpm cs2d:build`通过；日志同目录。标准Viewer build再次复用0022成功。CLI内存字段经smoke复验。独立终审无must-fix，已RELEASE，所有自建进程退出。

## 限制

约176MiB是样本的WASM线性内存容量，不是实测浏览器RSS下降量。FakeWorker不验证浏览器跨线程传输、播放器实际操作或物理内存回收时机。冷解析重建的真实启动代价未测；未完成时卸载、并发非managed parse和读取异常仍为独立路径。没有删除用户Demo/SQLite/Memory，未改Parser算法、缓存信任门、部署或安装；原A5仍独立。
