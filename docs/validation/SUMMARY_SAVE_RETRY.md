# 总结保存失败后的显式重试（2026-09-26）

原完成流程已保留屏幕上的总结，但保存失败仅写通用historyError。RuntimeHeadRetry只重交恢复点，无法恢复SESSION_SUMMARY。现在完成seam在发布结果前复制一份结果快照，失败时向当前Host提供独立重试句柄，卡内反馈保存状态。

| Before | After | Why |
|---|---|---|
| 总结保存失败只有错误文案 | “重试保存总结”原生按钮，原总结/回看/完成保留 | 明确可执行恢复动作 |
| 用户不知道重试是否在进行 | 保存中禁用按钮，成功显示“总结已保存” | 重复点击不产生重复并发请求 |
| 总结请求可无限等待网络 | 复用20秒fetch+JSON共用期限 | 超时回到可重试状态，迟到成功不冒充当前ACK |

沿用已应用emil/apple的现有按钮、焦点、reduced motion/transparency样式，没有新增动画/布局系统。

## 实现边界

- 原结果只生成一次；每次写入复制同一保留快照，artifact type/key/revision/schema与幂等键不变。即使响应丢失、服务端可能已成功，重试也不会故意创建新版本。
- in-flight promise先发布再执行依赖，重复点击共用请求；成功后旧句柄再调用返回false。再次失败需要用户再次明确点击，没有自动重试循环。
- 继续使用Host完整owner guard，并增加HistoryPersistenceController.ownershipGeneration；即使同一对象重新adopt相同review/revision，旧重试也失效。更换历史清空retry/busy/confirmed，晚写完成不清新owner状态。
- 保存错误与总结生成错误分开。重试不重跑Graph/总结，不提交RuntimeHead，也不改变教学/引用门。刷新会丢失这份未保存的内存内容，UI如实说明。

## 验收

7项新重试回归：同payload/key与零重新生成、双击合并、不同review失效、同ID重新adopt失效、旧owner晚回包不报成功、再次失败再重试、Panel失败/忙/成功呈现。另把SESSION_SUMMARY加入原API期限测试，fetch或body悬挂在20秒结算，abort后晚成功不翻转结果。

7文件95项相关tests、TypeScript和production Web build全部通过。独立partial_revision_restore默认配置只读窄审无must-fix；主控核对真实diff与输出。既有两个测试仅增加微任务等待以适配先认领promise再写入，发布总结本身仍同步；原按五类教学产物验证顺序的测试未被摘要类型污染。

测试使用真实完成seam、HistoryPersistenceController与API deadline模块，外部append/网络为受控fake，Panel是SSR；未验真实浏览器、实际断网或SQLite丢ACK。已有DAL同key幂等机制复用，本轮不宣称跨文件/DB新事务保证。没有用户Demo/数据库/模型/服务/安装操作，所有测试进程退出。

下一有限线索：agent-checkpoint-mirror仍拒绝takenOver，且WRAP_UP stable record builder不接受已COMPLETED阶段。需要用实际结束事件延迟序列核实自由seek/提前完成后历史恢复点是否仍停上一cue；本轮的总结保存成功不能冒称终结恢复点已确认。
