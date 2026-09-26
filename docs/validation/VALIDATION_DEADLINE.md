# VALIDATE确认等待期限

2026-09-27；基线4a4bf2a；root实现，partial_revision_restore默认配置只读预检/终审。

服务端finalizeDemoImport先reserveCapability消费一次性VALIDATE，再排队小SQLite更新。原Viewer finalize fetch/JSON均可无限等待，且READY失败后persistSelectedDemo catch会用同一token再发CORRUPT。

0025在finalize入口捕获并移除result.validationToken，以独立AbortController+Promise.race将fetch/body限制在共同20秒。超时先reject、再abort；请求晚返回headers时不读JSON，晚body不发布成功。现有HTTP/schema/demo/status校验保持。原catch只在token尚未尝试（如解析先失败）时提交CORRUPT，且该清理也有期限。Host/Viewer统一提示“Demo 验证结果尚未确认，请重新选择文件后重试。”

## 结果

`pnpm exec vitest run tools/cs2d-host/validation-deadline.integration.test.mjs tools/cs2d-host/managed-replay-reuse.integration.test.mjs tools/apply-cs2d-host-patch.test.mjs apps/web/lib/playback/cs2d-playback-host.test.ts`：4文件73通过，新增13项。原实际函数两种挂起20秒仍未结算，修复后结算、仅一次请求、无READY/成功事件，迟到不追加；较晚请求不被旧超时取消；旧load不报错；CORRUPT清理有界；无token去重零请求；HTTP/schema/demo/status/JSON错误保持拒绝，所有fake timer清理。

Web/Viewer TypeScript、Web production build通过。Viewer build第一次受0024 reverse上下文变化阻塞；registry现仅在0025完整reverse校验通过时允许该已覆盖旧补丁，未泛化接受未知修改，复验production build成功。独立终审无must-fix。

日志`.local-data/validation-deadline`；测试执行当前patched SFC真实finalize/persist函数，上传/Parser/transport均stub。不使用真实Demo/用户库、服务端事务或浏览器。没有安装/部署；进程与timer退出/清理，原A5独立。

超时没有证明服务端取消或回滚；记录可能已写入但响应未到。原READY门及同文件重新导入验证保持，不自动重发一次性令牌，也没有给大Demo传输/解析套此期限。
