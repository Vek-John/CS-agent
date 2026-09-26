# 当前会话恢复点显式重试

2026-09-26，基线a9c80a8，7f2b / codex/jev-decision-assessment。

## 交付与验收

A1通过：原路径仅报告head保存未确认；新增Controller保留原请求、Mirror限定资格和Sidebar入口。实际API timeout→重试请求body完全相同，原expected/completedAt保持。请求序列仅artifact→head→head；Recovery dispatch一次、成功accept一次，重复点击共享Promise。没有重新诊断或调用Graph的路径。

A2通过：新artifact/head intent、adopt、transport、checkpoint变更后无请求；重试已发送后owner/新教学变化再收到ACK也不accept旧record。原请求晚成功被deadline忽略。CAS409后撤销入口、原确认record保持；二次瞬时失败仍可再次明确点击，零自动retry。未确认artifact与已知缺产物/非法请求不提供该入口。

A3通过（组件层）：真实Sidebar SSR及原生button callback，无prop无入口，busy显示“正在重试…”并disabled；普通error/list保持。无新CSS/动效，复用原focus/媒体设置。Host只给合法当前句柄供UI，点击时再复核；旧回调不能清除其他新句柄。

| Before | After | Why |
| --- | --- | --- |
| 失败只有说明 | 独立保留提示与“重试保存” | 给出当前合法下一步 |
| 无重试忙态 | 状态文字与原生disabled按钮 | 反馈执行中并避免重复操作 |
| 普通历史错误与列表 | 保持原样，重试区域独立 | 不掩盖其他内容 |

A4通过：相关7文件121tests；追加3项定向在途/再失败测试后Mirror31tests、TypeScript及production Web build通过（仅原SQLite experimental warning）。

```sh
pnpm exec vitest run apps/web/lib/review-history/history-persistence-controller.test.ts apps/web/lib/recovery/agent-checkpoint-mirror.test.ts apps/web/components/history/review-history-sidebar.test.ts apps/web/lib/review-history/checkpoint-save-api.test.ts apps/web/lib/review-history/teaching-save-deadline.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts libs/review-library/src/library.test.ts
pnpm exec vitest run apps/web/lib/recovery/agent-checkpoint-mirror.test.ts
pnpm typecheck
pnpm build
```

A5通过：UI子代理revision_semantics_review（默认配置）完成独占组件/tests；partial_revision_restore（默认配置）独立只读审查未发现must-fix，建议在途ACK测试已补。主控查实际diff/验证输出，架构/学习/任务板同步；owner与测试/build均释放。

## 限制与下一项

仅默认Agent镜像最后head提交的本页重试。ROUTE_START、artifact未确认和跨重启不支持。20秒只限每请求等待，不能证明服务器已取消。新动作会使旧重试无效，不重取最新Graph或修改预期指针。

模块与SSR验证，不是完整Host/浏览器/辅助技术实测；本轮CAS库回归使用临时SQLite，不碰用户库/Demo/Memory/密钥，无模型/服务/部署安装。真实桌面A5继续独立待验。

下一项：起点保存未知结果时的markFailed路径是否误标已经提交的有效历史，先复现，不扩通用保存框架。
