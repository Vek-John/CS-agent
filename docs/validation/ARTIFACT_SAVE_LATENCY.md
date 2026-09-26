# 历史保存校验等待（2026-09-26）

上一轮真实Demo的17项产物保存约4秒。本轮在同一隔离SQLite集成测试的正式POST调用中，分别用透传spy计时loadReview、validateReviewArtifactAppend和appendArtifact；保留真实实现与body/领域/存储校验。小smoke后，对授权60.6MB样本前后各单读单解析一次，每次外部150秒期限，临时库与managed副本finally删除。

| 指标 | 修改前 | 修改后 |
|---|---:|---:|
| 全保存阶段（含终结head） | 4094ms | 2642ms |
| 17次artifact请求合计 | 3824ms | 2461ms |
| 请求中读取/解压合计 | 725ms | 651ms |
| 请求中领域校验合计 | 2918ms | 1632ms |
| 请求中DAL写入合计 | 116ms | 114ms |

保存阶段下降35.5%；主要变化为消除重复校验。这里只做单次前后对照，不是p95、冷启动SLA或全部Demo的保证；各阶段取整且包含未单独计时的Request/JSON开销，合计不要求严格等于总耗时。[匿名原始统计](ARTIFACT_SAVE_LATENCY_RESULT.json)。

## 改动与验证

完整Analysis/Candidate/Plan已存在时，validateCollection原先先反序列化校验Analysis并比较Candidate，再调用validateStoredReviewArtifacts重复以上步骤。现在把原始Analysis payload直接交给后者，它仍执行原有完整schema、身份、Candidate、plan/引用/叙事和恢复检查。反序列化函数不做迁移或改写，因此不丢迁移步骤。

bootstrap尚无Candidate或Plan时仍保留原检查和追加顺序。没有跨请求缓存，没有“已校验”旁路，每个新请求仍读取当前revision并执行一次领域验证。原有并发删除/FK/revision写入约束保持；不声称新事务快照保证。

- A1通过：校验占17个请求约76%的基线耗时。
- A2通过：同请求完整Analysis校验两次变一次；小artifact、head与重复请求均单独验证。
- A3通过：新增8项回归覆盖bootstrap、坏Analysis/身份/Candidate/schema、缺Candidate以及每请求一次校验。旧v1历史兼容现有测试保持；真实API→SQLite终结checkpoint→关闭重开仍恢复相同17产物、4skip、摘要，零新分析/讲解/Viewer请求。
- A4通过：4文件56项相关tests（opt-in真实测试另行通过）、TypeScript和production Web build。partial_revision_restore默认配置只读独立审查实际diff，RELEASE，无must-fix；主控负责计时、代码与最终验收。

本轮没有UI、真实网络服务器、Graph reconnect或CS-Net验收。学习结论只针对当前存储请求的实际等待，不把性能改善当教学质量改善。
