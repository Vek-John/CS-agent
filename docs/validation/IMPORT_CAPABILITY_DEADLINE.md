# 导入授权等待期限（2026-09-27）

import-capability POST只收默认≤16KiB元数据；issueImportCapability同步在内存签发绑定requestId/文件名/预期大小的IMPORT令牌，默认TTL60秒，不读取Demo。实际文件流和解析在Viewer收到persistSelectedDemo后发生。

API仅改为复用HISTORY20秒fetch+JSON共同期限。原Host当前requestId门、失败清进度/报错保持；超时不交付迟到token，不自动重发或撤销服务端可能已签发的token，原TTL/一次性消费不变。

6个新用例包括fetch/body挂起、A到期而后来B仍有效、200/400/500请求与错误码兼容。原两个挂起用例20秒后仍未结算，两红；修复后只失败一次、成功回调0、迟到headers不读JSON、timer全部清理。两个请求仍仅请求各一次，不触文件或模型。

`pnpm exec vitest run apps/web/lib/review-history/import-capability-deadline.test.ts apps/web/lib/review-history/api.test.ts apps/web/lib/recovery/recovery-demo-picker.test.ts apps/web/lib/playback/cs2d-playback-host.test.ts`：4文件42项通过；`pnpm typecheck`、`pnpm build`通过。root独占实现、检查与文档，无代理/后台进程。transport为stub，未实测Host/Viewer或真实导入。

后继限制：当前Viewer主Demo文件输入onInput未清value，而旁边.cs2dv入口明确清值以支持同文件重选；下一轮针对授权失败后的同文件重试检查这一差异，不把本轮API期限完成当作完整文件选择交互已验收。
