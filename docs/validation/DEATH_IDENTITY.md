# 击杀即时身份与几何验证

2026-09-26，基线e7fba6b，codex/jev-decision-assessment。

## 契约与修复

真实链路为collector `player_death`→RawEvent::Kill→assemble→Event::Kill/replay-core→Viewer计分与死亡点、Adapter本人死亡/击杀及受击窗口。三个schema中的victim均非空String/string；未知victim原先就跳过。Viewer用victim作为死亡点键并消费x/y/z，因此不能只修actor而保留index-only几何，也不能直接向旧协议塞null。

0015仅修改death分支：victim须从`verified_event_pawn`得到当前有效pawn及唯一owner，三坐标同pawn读取；攻击者和助攻者独立验证，未知各自null；不读tick_start owner缓存。无alive资格检查，已死但身份有效的pawn仍可用。未知victim继续skip，不猜人或制造空ID。未修改ADR、userid映射或其他network handle。

Parser追加death-identity.v1；Adapter manifest记录完整已知hurt/shot/ammo/bomb/death链。旧产物按保存内容恢复，不重写索引或重新分析。

## 验收

- A1：已读collector/schema/replay-core非空victim，以及ViewerMap死亡点、scoreboard死亡计数和Adapter消费。source2回调只提供当前Context，不保证每个Demo死亡时pawn都仍存在；因此真实覆盖需要测量。
- A2/A3：`python3 tools/validate-death-identity-source.py --collector /tmp/cs-agent-death-before.rs`修前实际源9红/1绿；当前源10/10绿。源码注入实际death分支、Kill字段、props helpers、vendor get_by_handle。覆盖三方独立身份/几何、有效死亡pawn、serial复用/错class/缺pawn、无效/重复owner、未知可选actor、同tick重绑/解绑、signed native。首次fixture返回类型编译错已改正，不计作产品红例。
- A4：5文件98相关Vitest，12项patch工具测试，native parser9+vendor33通过；TypeScript、Web production build、parser WASM/Viewer build及Viewer vue-tsc通过。验证脚本修正后TypeScript再验通过；未变生产代码，不重复Web构建。既有上游deprecated warnings仍存在。
- patch接线：clean固定pin的15补丁顺序应用、0014→0015、0013→0014→0015与重复reuse通过；实际dirty构建checkout复用通过。临时checkout已清理。

真实消费工具`tools/validate-death-identity.ts`有baseline/verify两模式，外层120秒期限，禁止网络。既有60,601,900字节test_demo.dem：旧生产WASM7.180秒；新生产WASM最终7.112秒，含10人Adapter与往返总8.754秒。9回合73个Kill的完整字段逐项相等（含三方身份、时间、几何、武器等），0未知attacker、55未知assister；全部坐标有限。正式教练回合边界内64个死亡全部进入相应玩家时间线，边界外9个保留在Parser。0模型/网络调用。

验证脚本首轮将Parser全流73误当教练消费数量，64≠73失败；读取实际Adapter的`startTick <= tick < officialEndTick`规则后修正验收范围，未改产品过滤或放宽身份规则。修后再读一次确认。总计修前1次、修后2次read/parse，各自bulk留单进程；失败未输出原始身份。独立终审指出deepEqual失败可能dump身份/坐标，已改为布尔深比较和固定错误码。小摘要及本地紧凑基线位于忽略目录`.local-data/death-identity/`，不提交用户数据。

## 限制与后继

此样本未损失事件，不代表所有Demo零损失；实体生命周期异常是合成测试。world_coord缺字段默认规则未改，几何只是绑定正确pawn，不声称外部位置真值。无UI/SQLite恢复或专业判断质量实测；未安装或部署。代理均RELEASE，所有构建、解析与测试进程退出，原锁屏UI A5独立待验。

后续独立高价值线索：world_coord缺cell/offset回落默认0后可得到貌似真实的-16384坐标，当前几何schema非空；应先查真实字段缺失频率及Viewer/分析如何消费未知位置，再决定可空或明确降级方案。不能只因函数名推测该问题已在真实Demo发生，也不机械改动所有几何路径。
