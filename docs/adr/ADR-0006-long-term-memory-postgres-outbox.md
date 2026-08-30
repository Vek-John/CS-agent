# ADR-0006：长期个人记忆的 PostgreSQL 真相源与 Durable Object Outbox

- 状态：Accepted
- 日期：2026-08-28
- 影响范围：长期个人记忆、匿名主体授权、Coach Agent 会话恢复、PostgreSQL、pgvector、Durable Object Outbox、记忆管理面

## 背景

3.8.0 的 Reflection Gate 已经能够在单个 cue 内把用户反思解析为 `UserClaim`，经过确定性诊断形成 `CoachVerdict`、`TransferRule` 和 Session `LearningThread`。这些对象目前是有界的会话快照：没有稳定的用户主体、跨 Demo provenance、授权、删除、不可变修订或长期存储契约。

长期记忆必须帮助教练识别跨 Demo 的反复学习主题，同时不能把会话状态、全知回放事实或 LLM 输出变成永久真相。它还必须在无正式账号、无记忆授权、数据库故障和向量索引不可用时保持现有回放与 Coach Agent 流程可用。

## 决策

### 1. 独立 Memory Domain 与现有领域模型的关系

新增独立 `libs/memory`，负责 Memory Domain、ports、Memory Service、Memory Brief 和授权/晋级 policy；新增独立 `libs/memory-postgres`，负责 PostgreSQL adapter、迁移和可选向量索引。领域层不得依赖 Drizzle、`pg` 或其他 ORM；适配器使用供应商中立的参数化 typed SQL seam。

`libs/contracts` 中已有的 `LearningThread`、`UserClaim`、`CoachVerdict` 和 `TransferRule` 继续是对应语义的唯一类型来源。Memory Domain 只能包裹或投影这些类型，不创建 `MemoryLearningThread`、`MemoryUserClaim`、`MemoryVerdict`、`MemoryTransferRule` 或其他平行领域模型。
`libs/memory` 的同名 Zod 定义只是运行时边界校验器：它复用 contracts
的枚举/类型语义，并额外施加 envelope 大小、provenance 和隐私约束；它们
不是第二套可供业务代码依赖的领域类型。语义字段变更必须先更新
`libs/contracts`，再同步校验器和版本化 envelope。

以下职责必须保持分离：

- `UserClaim` 是用户主观补充，永远不升级成 Demo `Fact`；
- `CoachVerdict` 与 `LearningThread.diagnosis` 是带置信度的推断；
- `TransferRule` 是可执行的建议；
- Demo `Fact`、`ObservationClaim`、职业 `Evidence` 只作为带命名空间、Demo content hash、Session 和 cue provenance 的证据引用或受限快照；
- `CueCase` 是 cue-local 操作快照，不是长期记忆 aggregate；它的 capabilities、attempt budget、presentation 状态和播放器字段不得写入长期记忆。

`LearningThread.scope="SESSION"` 继续表示当前会话主题。单 cue Agent 推断首先只能形成 `CANDIDATE` Memory Proposal；Memory Service 在达到晋级条件后，才生成使用相同语义的 `CROSS_DEMO` 长期记录。现有 Session/Graph 中的 `LearningThread` 不因新增长期记忆而改作存储真相。

Memory Proposal 至少包含以下逻辑字段；具体 TypeScript 名称和 JSON 细节由 `libs/memory` 冻结并版本化：

```text
MemoryProposal
  schemaVersion: memory-proposal.v1
  proposalId
  userId                         # 仅服务端和 Memory Event 内部字段
  operation: CREATE | UPDATE | CORRECT | DELETE
  targetMemoryId?
  requestedScope: CROSS_DEMO
  thread                       # 复用 contracts LearningThread 语义
  claims[]                     # 复用 UserClaim，保持 USER 来源
  verdict?                     # 复用 CoachVerdict
  transferRule?                # 复用 TransferRule
  origin
    sessionId, demoContentHash, cueId, caseId, sourceThreadId
    typedSourceRefs[]
  lifecycle
    CANDIDATE | OBSERVED | REPEATED | IMPROVING |
    STABLE | RESOLVED | DISPUTED | SUPERSEDED | ARCHIVED | DELETED
  consentState
  producerVersion
  idempotencyKey
  createdAt
```

`typedSourceRefs` 必须区分 `USER_CLAIM`、`VERDICT`、`TRANSFER_RULE`、`DEMO_FACT`、`OBSERVATION_CLAIM` 和 `PRO_EVIDENCE` 等命名空间；不得使用裸 `cueId` 或裸字符串 ref 作为跨用户、跨 Demo 的唯一来源。

### 2. 记忆生命周期、晋级、纠正与删除

记忆生命周期固定为：

```text
CANDIDATE → OBSERVED → REPEATED → IMPROVING → STABLE → RESOLVED
                                      ↘ DISPUTED / SUPERSEDED / ARCHIVED
任何可见状态 ─────────────────────────→ DELETED（tombstone）
```

- 单 cue Agent 推断只进入 `CANDIDATE`；
- 至少两个不同 `demoContentHash` 的证据，或用户明确确认，才能晋级为跨 Demo active memory；
- 用户纠正优先于模型/规则推断，产生不可变 revision，不原地覆盖历史内容，并将当前投影标为 `DISPUTED`；纠正内容仍可进入只读 Brief，供下一次教学复核；
- 删除产生 tombstone。旧的 outbox、重试或迟到事件即使再次到达，也不得复活已删除记录；
- `CANDIDATE`、失败提案和 dead-letter 记录必须使用有界 retention；当前 DO Outbox 即使未提供运维参数也使用保守的 terminal-row 上限，生产仍应设置明确的 cutoff/max-retained；已接受记录由用户删除或明确的保留策略控制；tombstone 至少保留到所有可能的旧事件不再可接受为止；
- 撤回 consent 立即阻断教学 recall、proposal、embedding 和 outbox；用户仍可通过管理面发起隐私删除，删除通道只枚举 opaque memory ID 并经同一幂等 tombstone 流程完成。用户级 purge 在同一 PostgreSQL 事务内锁定 principal、为所有 current record 写入脱敏 tombstone，并设置 `memory_deleted_at` marker；重新 opt-in 不复活已删除记录。已知 session DO 会收到 all invalidation，未被列出的 DO 由 marker 与每次实时 authority re-check fail-closed。

Memory Brief 的初始硬上限为最多 2 个 active threads、3 个 memories 和 2 个 corrections；进入 Agent 的去身份投影另按确定性近似限制在约 500–800 tokens。Brief 是只读输入，只能影响教学模式、候选优先级和习惯复查，不得改变当前 Demo facts、canonical tick、Outcome Gate、ReviewPlan 顺序或 Session 状态机。

### 3. PostgreSQL、pgvector 与 Redis 边界

PostgreSQL 是长期记忆的唯一真相源。结构化 migration 与向量 migration 分离：

- 核心 migration 负责 principal、consent、memory proposal/record、revision、typed provenance、tombstone、outbox consumer 状态和必要索引；
- pgvector migration 为可选派生索引，不能成为核心表、结构化召回或数据库启动的前置条件；
- 首版不建立 HNSW；向量索引失败、embedding provider 不可用或向量 migration 未执行时，必须回到结构化召回；
- embedding 不改变 memory record 的语义、生命周期、授权和删除结果；删除/纠正必须同步使向量结果不可见或失效；
- Redis 不实现。若接口需要缓存，提供 `NoopCacheProvider`；Redis 不作为事实源、memory store、LangGraph saver 或删除状态来源。

`libs/memory-postgres` 的 repository 是唯一允许触碰 PostgreSQL 的 memory adapter。Memory Domain、Coach Agent、LLM、前端和 API route 不得绕过 repository 直接写 SQL。

### 4. Durable Object Outbox 与一致性

每个 Session 的 Durable Object 只保存当前 Agent checkpoint 与独立的至少一次 Outbox；Graph 可在活跃请求的内存状态中暂存一个有界 Brief，但 checkpoint saver 在 durable write 前剥离它，DO 重启后由可信 provider 重新加载。DO 不是长期记忆真相源，也不保存 raw Demo、frames、完整 tick 流或长期记忆查询结果。

Outbox event 至少包含：

```text
MemoryEvent
  schemaVersion: memory-event.v1
  eventId
  userId
  sessionId
  proposalId / targetMemoryId
  operation
  idempotencyKey
  producerVersion
  payloadRef or bounded proposal snapshot
  attemptCount, nextAttemptAt
```

Outbox 写入必须先于发送；consumer 使用 `userId + idempotencyKey` 幂等，重复事件返回同一结果，不产生第二个 revision 或第二次删除。重试使用有界退避；超过上限进入 dead-letter，并保留脱敏错误码供管理面/运维处理。消费成功、永久失败和 tombstone 都必须是可观测、可重放但不会重复生效的状态。

状态名按存储层区分：DO 内的 `MemoryOutbox` 使用
`PENDING → RETRY → DELIVERED`（或 `DEAD_LETTER`）；PostgreSQL
`memory_events` 使用 `POSTED → CONSUMED`（失败时为 `RETRY` 或
`DEAD_LETTER`）。`DELIVERED` 只表示 DO 已完成 sink transport，不能替代
PostgreSQL 的 `CONSUMED`；只有后者才表示长期记忆投影已接受或幂等收敛。

DO sink、consumer、PostgreSQL 或 Outbox 故障不能阻塞基础回放、已冻结路线、Outcome Gate 或 Baseline Narration。故障只能产生受限 fallback/待同步状态；不可把“写入 DO 成功”当成“PostgreSQL 已接受”。

### 5. 匿名 principal、授权与 Feature Flag

当前不建立正式账号体系。服务端首次需要记忆授权时生成高熵 opaque anonymous principal cookie；cookie 只携带不可猜测、签名的 token，服务端将该 token 直接作为无语义的内部 `userId`（不把它当正式账号，也不提供账号恢复或跨 cookie 合并）。清除 cookie 即失去该 principal 的访问能力；正式注册、登录、找回和账号迁移留给后续边界。

`userId` 只存在于服务端 Memory Event、Memory repository 和授权上下文中，不加入现有 `CoachAgentIdentity`，不进入 Director/Narrator/Coach Policy 的 prompt，也不改变已有 Agent event identity。

云记忆由两道门同时开启：

```text
MEMORY_ENABLED=true  AND  principal consent=GRANTED
```

服务端 `MEMORY_ENABLED` 默认关闭；任一门关闭时必须做到零 recall、零 write、零 embedding、零 memory outbox，并保持既有 Session/Agent envelope 与旧回放行为兼容。consent API 的授权、撤回和版本/时间记录属于 Memory 管理面，不接受请求体伪造的 userId。

生产开启 `MEMORY_ENABLED` 时，匿名 principal secret（至少 16 个字符）、DO 内部认证（至少 16 个字符的 token 或 HMAC secret），以及可验证的实时 consent authority（binding/URL）是必需配置。缺少 authority 或 authority 暂时不可用时，DO 不信任本地旧 GRANTED 快照；请求和 Outbox 保持 Baseline/pending，不把旧记忆送入 Agent。HMAC 使用 `timestamp + 原始 body` 签名并在边缘与 Node 两侧校验。Worker 只从已验证签名 principal cookie 转发 consent version，客户端同名 header 会被剥离。

只有已完成且可追溯、通过 `OutcomeCompletionGate` 的 cue/Session 才能产生 proposal；cue 级 proposal 可先进入 Outbox，`SESSION_COMPLETED` 只记录会话闭合元数据。单 cue 仍只能是 `CANDIDATE`，不得绕过跨 Demo 或用户确认门槛成为 active memory。

### 6. API、UI 与 Memory Brief

记忆管理面与带看主流程分离。首版管理能力包括：查看有限 Memory Brief/records、查看来源/置信度/限制、查看授权状态、确认候选、纠正、删除和撤回授权。匿名同步必须明确标注为匿名 principal，不能在 UI 上冒充正式账号。

Coach Agent 与 Teaching Director 只接收结构化、限额、只读的 Memory Brief；不接收原始记忆表、任意 SQL、embedding、用户 cookie 或完整历史。Brief 失败、超限、过期或语义召回失败时使用结构化部分或空 Brief，并继续旧教学流程。

### 7. 版本、保留和隐私

Memory envelope、Memory Event、Memory Record、Memory Brief 和每个 repository migration 都必须有独立 schema/version。现有 `CueCase`、`UserClaim`、`CoachVerdict`、`TransferRule`、`LearningThread` 的历史 JSON 不自动回填为长期记忆；迁移只能通过显式、可审计的 proposal 流程完成。

长期记忆只保留最小化的语义内容、typed provenance、版本、置信度、限制、授权和修订，不保存 raw Demo、frames、完整 tick、播放器缓存、Prompt、chain-of-thought、API key 或完整 Agent checkpoint。日志只记录 principal/memory/proposal/event ID、版本、状态和脱敏错误码，不记录记忆正文。

## 兼容性与验收门禁

实现代理必须至少覆盖：

1. `MEMORY_ENABLED=false` 与 consent 未授权时零 memory side effect，旧 Session/Agent dispatch byte-compatible；
2. 同一用户与不同用户、同一 Demo 与不同 Demo 的隔离；
3. `userId + idempotencyKey` 重试不重复写入、修订或删除；
4. 两个不同 Demo 或明确确认才晋级；单 cue/跳过/失败回退不会产生 accepted memory；
5. 用户纠正产生不可变 revision，删除 tombstone 阻止迟到事件复活；
6. 结构化召回、可选 pgvector 召回、embedding 失败降级和 Brief 上限；
7. Outbox POSTED/RETRY/DEAD_LETTER/CONSUMED 状态、恢复、重放和脱敏日志；
8. 不泄漏 raw Demo、frames、完整 tick、cookie 或正式身份；
9. migration 可从空数据库执行，核心 migration 不依赖 pgvector，Redis 只由 `NoopCacheProvider` 满足接口；
10. DB、embedding、DO、consumer 和 API/UI 故障均保留 Baseline 回放与教学流程。

## 被拒绝的替代方案

- **直接把 Session `LearningThread` 当长期表**：它只有 Session 语义、有限数组和 cue IDs，没有 principal、授权、跨 Demo provenance、revision 或删除语义。
- **让 Durable Object 作为记忆真相源**：DO 只为 Session checkpoint 和可靠 outbox 服务，受 retention、会话生命周期和恢复边界约束。
- **把 pgvector 作为主召回或主存储**：向量召回不可解释、不可替代结构化授权/删除，并增加首版故障面；它只能是可选派生索引。
- **引入 Redis 实现 memory cache/store**：增加基础设施并制造第二真相源；首版仅保留 `NoopCacheProvider`。
- **现在建立正式账号体系**：超出匿名 Session 的当前产品边界；opaque principal 满足授权隔离，正式认证另行 ADR。
- **赋予 LLM 永久写入权**：违反事实/推断/建议分离和用户控制要求；模型只能参与受限提案，写入由 Memory Service、授权 policy 和 repository 完成。
- **复制现有五种领域类型**：会造成 contracts、Session、Graph 和 Memory 语义漂移；只新增 envelope/port，不复制领域语义。

## 后续实现所有权

- `libs/memory`：领域接口、proposal/lifecycle policy、Memory Brief、consent policy、结构化 recall port；不得依赖 ORM/数据库。
- `libs/memory-postgres`：typed SQL adapter、核心 migration、可选 pgvector migration、consumer 幂等和 `NoopCacheProvider`。
- `libs/coach-agent`：仅发出受 identity/gate/feature-flag 约束的 Memory Event/Outbox effect；不得直接写 PostgreSQL。
- `libs/session`：继续拥有播放、Outcome Gate、Session cue case 和 Session-scoped thread；不得成为长期记忆 store。
- `apps/web` / `apps/api`：匿名 principal cookie、consent API、独立管理 UI、Memory Brief 注入和 Baseline fallback；不得从客户端传入可信 userId。
- `ARCHITECTURE.md`：长期契约唯一事实来源；本 ADR 记录本次不可逆取舍，后续变更须新增 ADR。
