# 历史回放入口等待与迟到失败隔离

2026-09-26；基线c8bba49（产品1f7c091），7f2b/codex/jev-decision-assessment。仅viewer-source小DTO与Controller/Host该阶段的归属；没有更改大detail、共享deadline helper或Revision流程。

## A1 生产复现

将原Host source attach/expected-source/activate及RESTORE catch直接提取为`attachHistoryViewerSource`，真实Host两条分支均调用该入口，先保留旧语义。不是在测试内复制catch。生产API、Controller和该入口产生6红：

1. fetch挂起和JSON挂起在20秒后仍未结算（2项）。
2. A等source→切B→A的AbortError或普通晚失败使反馈callback被调用，覆盖B提示（2项）。
3. Controller旧请求取消仍抛普通AbortError，未转STALE_REQUEST（1项）。
4. Host已失效但Controller代还没变时，旧失败仍写反馈（1项）。

先修Controller/API后5项变绿、独立Host epoch仍红，补Host错误写入门后6项全部通过。所有数据在内存fixture，HTTP/时钟由测试控制；没有真实网络/Viewer/数据库。

## A2 请求期限与来源授权

viewer-source返回requestId/demoId/capabilityToken/filename/byteSize/contentHash六项。route的loadReview不要求external artifact materialization；20秒是沿用项目小JSON请求的本地交互政策，不是测得的SLA或端到端上限。

`requestJsonWithDeadline`同时拥有fetch和body的一条期限，父signal取消传入；设置readErrorBody/allowInvalidJson以保留原HTTPcode及坏JSON语义。非合作transport也必须结算；到期先结算再abort，迟到headers不调用json，迟到body成功/失败不发布且reject被观察；计时器和父监听器清理。成功非法JSON仍按旧API返回undefined，Host将缺source作为该阶段失败处理；未将旧兼容行为宣称DTO校验成功。

仅此小DTO新增期限；大detail/AnalysisBundle、Demo文件流、Viewer解析及前置控制面恢复均未加期限。无自动retry。服务端可能已签发capability：既有VIEW绑定Demo、默认60秒有效（可配置）、首次使用尝试消费；客户端取消无服务端撤销保证，未使用token按既有到期检查/清理规则失效。不记录token，也没有新释放请求。

## A3 归属与反馈

Controller.attachViewerSource在resolve与reject路径都核对generation和parent abort；已失效统一STALE_REQUEST，当前普通错误原样保留。Host入口在expected source/activate前检查openEpoch；catch在任何反馈callback之前检查openEpoch和STALE，覆盖Controller尚未换代的窗口。旧返回不激活Viewer、不写当前错误/详情。

| Before | After | Why |
| --- | --- | --- |
| RESTORE旧失败可覆盖新复盘READY/detail/error | 失败写入前再次核对当前openEpoch | 普通AbortError不再绕过归属 |
| source请求可一直等 | fetch＋正文共用20秒，当前失败可见 | 不依赖transport配合abort |
| REANALYZE/SELECT_PLAYER源失败落入产物校验提示 | 单独说明入口超时/暂不可用、操作尚未启动 | 网络失败不等于保存产物损坏 |

RESTORE当前失败保持已恢复的控制面及READY，只更新现有反馈；另外两种mode使用ERROR提示本次操作未启动、原复盘未改。没有新增状态框架、重分析动作或模型调用；反馈沿现有UI样式，不改变原先先恢复讲解、后台加载比赛的顺序。

## A4 验证命令与结果

```sh
pnpm exec vitest run apps/web/lib/review-history/viewer-source-lifecycle.test.ts apps/web/lib/review-history/history-restore-controller.test.ts apps/web/lib/review-history/api.test.ts apps/web/lib/review-history/checkpoint-save-api.test.ts apps/web/lib/coaching/preparation-transport.test.ts apps/web/lib/coaching/coach-agent-transport.test.ts apps/web/lib/recovery/agent-checkpoint-mirror.test.ts
pnpm typecheck
pnpm build
```

新增29项、相关7文件99项全部通过，TypeScript与Web production build通过。覆盖三mode当前timeout/HTTP失败、B正常激活后A晚成功/失败、单独Host epoch、父取消在fetch前/中/body中、同一总期限、HTTP/JSON兼容、late headers不读body、late body reject、timer/listener退出，以及detail不受新期限影响。对恢复控制面的对象进行前后比较，没有删除/改写保存内容。

默认配置`viewer_source_race_review`5分钟内只读复核实际API/Controller/Host接线与竞态，无must-fix；主控真实diff复核同样通过。没有并行写入。日志在`.local-data/viewer-source-evidence/`，本轮test/build进程退出。

## A5 / 限制与研究衔接

ARCHITECTURE、TECHNICAL_LEARNINGS、任务板同步；文档后commit/push/RELEASE。测试是实际生产模块的定时/竞态与Host反馈callback，不是完整Host挂载、真实浏览器/桌面或托管Demo流验收；原锁屏工具暂停A5未运行。detail和真实Demo加载仍可能有自己的等待/失败，不能把此20秒外推。

本轮只读核对`tools/verify-jev-real-smoke.ts`确实校验逐候选packet后输出统计；主控已核实replayed-projections.json只含资源/roster，不是完整cue资料。目前没有已核实可直接打包的新完整标注材料，不把摘要当专业gold，也不为纸面材料重复解析旧Demo。未调用模型、读取真实Demo/用户DB/密钥、安装部署或合并main。
