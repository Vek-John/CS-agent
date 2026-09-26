# 真实结束产物的SQLite重开恢复（2026-09-26）

目标：将真实解析后的整场路线、讲解、跳过记录及结束摘要写入隔离库，关闭重开后复用；不以合成小产物替代真实规模验证。

## 实际发现与修复

1. 当前Parser完整补丁版本链超过恢复schema的160字符上限；真实Demo与带同版本链的小fixture均在`buildSessionRecoveryRecord`失败。只将保存记录和ANALYSIS_READY事件的parser字段改为512字符，完整保留版本、精确比较，不截断/散列，实体ID保持160。
2. 真实CandidateSet请求为1,729,563字节。AnalysisBundle POST成功后，它被DAL的256KiB小JSON门拒绝为ARTIFACT_INVALID。只将CandidateSet加入现有gzip白名单，共用原子发布/清理/物化读取；Narration等不可重建小产物仍保留原限制。不改变8MiB HTTP门或16MiB分析序列化门。
3. 新集成测试先驱动实际Session/Controller/SQLite Graph到结束，再使用正式artifact POST与runtime-head PUT。后者核对真实已完成checkpoint与完整身份；没有插入假checkpoint或绕过body/语义校验。

## 验收结果

- A1通过：授权60,601,900字节Demo；成功验收运行单读单WASM解析7501ms，9回合/33段/44候选/4cue。失败定位后有独立复跑，单次运行计数不是本轮累计次数。
- A2通过：分析5,881,159字节、候选约1.73MB均为GZIP_FILE，17项artifact经正式POST，终结head经PUT；保存阶段3927ms。4个skip/CueCase与原Session一致，摘要保留NO_REPEATED_THEME而不编造重复习惯。
- A3通过：关闭原owner后重开隔离SQLite，GET→HistoryRestoreController→恢复校验/冻结准备用204ms；Review为COMPLETED、Session恢复到合法WRAP_UP，原摘要/教学记录及head保持。0新分析、0新讲解、0网络、0Viewer资料请求、无新增artifact。
- A4通过：141项相关测试（恢复schema/Session恢复/runtime/artifact/结束/资料库），以及opt-in真实Demo测试；TypeScript和production Web build通过。独立只读代理partial_revision_restore默认配置窄验收RELEASE，无必修问题；它额外跑4项目标测试，主控读真实diff/输出。

成功运行数值见[匿名统计](REAL_HISTORY_REOPEN_RESULT.json)。该次总耗时12130ms，不是用户观看时长或冷启动SLA。

## 复用

正常回归不依赖本地Parser产物：

```sh
pnpm exec vitest run apps/web/lib/review-history/real-history-reopen.integration.test.ts
```

已有Parser产物且明确授权Demo后，设置CS_AGENT_VALIDATION_DEMO、CS_AGENT_VALIDATION_PLAYER；可选CS_AGENT_VALIDATION_RESULT输出匿名JSON，再运行同一测试。必须加外部150秒进程期限，测试自身120秒无法打断同步WASM。本次Python subprocess期限包裹了Vitest；没有超时。动态加载本地WASM仅发生在opt-in分支。

## 范围与限制

- 使用真实HTTP route handlers，但在进程内调用，并非启动服务器/真实Host/Viewer/浏览器。Session tick通知由harness驱动，无CS-Net或专业判断质量评估。
- SQLite Graph checkpoint已真实保存并被terminal head验证，本轮没有重新dispatch Graph重连事件。managed Demo身份按现有协议传入，不额外声称端到端Viewer导入握手通过。
- 最初harness误传超长generatedBy到可选finalize parserVersion，随后对齐实际Viewer finalize不传该字段；这是测试修正，不据此宣称Viewer导入故障。另修正harness在COMPLETED后捕获边界和Demo ID不一致，均未放宽产品门。
- 旧短版本记录继续兼容；旧应用不保证读新长parser版本。未更改数据库schema，无数据迁移。原用户Demo只读，临时SQLite/managed副本在finally清理，没有用户库写入或安装部署。
- 后继证据：小artifact每次保存约200ms，17次保存合计约4秒。下一项先测重复物化/校验的实际占比，只有能证明收益且保持revision/删除/并发语义才优化，避免无依据缓存或全量审计；原UI A5独立待桌面恢复。
