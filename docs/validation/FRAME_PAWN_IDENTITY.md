# 玩家采样network packed身份验证

2026-09-26，基线af8e53a，codex/jev-decision-assessment。

## 修复范围

原采样把controller的m_hPlayerPawn交给index-only get_by_handle，实体编号复用后可将替代pawn的生命、资源与位置归给原玩家。此字段已是network packed，不能使用native事件的15位index转换。

0016新增verified_controller_pawn：要求Unsigned32、packed<0xffffff、当前CCSPlayerPawn class/index/可见低10serial一致，且唯一当前controller绑定的有效SteamID与调用controller相符。不检查alive，合法死亡玩家仍采集；不改cache/ADR/其他network handle。

参与采样的playing controller若身份/绑定或pawn阵营资格失效，不发错误PlayerState，但保留原frame tick和其他合法玩家，并设置仅内部RawFrame.identity_complete=false。该标记同时约束assemble的全员存活满血respawn、整回合纯刀、暖场刀局拆分三处推断；否则删掉一个受伤或持枪玩家可能错误提前freeze或制造刀局。public Replay schema保持原状。

Adapter沿现有缺当前名单/本人语义降级，不从前一完整帧补人，移动提名遇缺本人样本中断。Viewer既有相邻采样插值最多保持前一有效位置至缺base帧，随后不显示该行，不跨空帧向更远样本插值；本轮未改UI。

## 验收证据

- A1/A2：`python3 tools/validate-frame-identity-source.py --baseline-dir /tmp/cs-agent-frame-before`实际源8红/2绿；当前源码10/10绿。注入真实玩家采样段及PlayerState/RawFrame、props helpers、vendor lookup；武器/弹药/几何读取外围为stub，不声称全tick调度或解码实测。覆盖stale serial、错class、缺字段/错类型/无效packed、重复owner、有效死亡pawn、当前重绑。
- A3：同fixture注入assemble三处真实closure；不完整早帧不能提前respawn，残存持刀玩家不构成纯刀回合/刀局拆分，完整帧旧行为保留。Adapter新增缺本人/队友但前帧完整的测试，当前9人样本保持未知；既有return-and-fire缺样本回归保持。
- A4：3文件80相关tests、13项patch工具tests，native parser9+vendor33通过；TypeScript、Web production build、WASM/Viewer build与Viewer vue-tsc通过。验证工具正规化比较调整后TypeScript再验。存在既有deprecated警告。
- patch接线：固定pin clean16patch顺序、0015→0016、0013→14→15→16和重复reuse均通过；实际dirty checkout复用通过。只读终审无生产must-fix，两默认配置代理分别独占补丁和生命周期fixture，主控审真实diff/集成。

## 真实消费与验证工具纠偏

`tools/validate-frame-identity.ts`baseline/verify模式各有120秒外层期限，禁止网络。既有60,601,900字节test_demo.dem，修前7.076秒解析；最终修后7.713秒、含10人Adapter消费/JSON往返总10.125秒。9回合、7,239帧、72,193玩家行，完整frame字段和freeze/start/decided/end/postEnd边界在JSON契约下逐项一致。10个bundle及来源标记/时间线往返通过，0网络/模型调用。单样本不证明通用身份准确率或任何Demo零缺行。

最初直接用isDeepStrictEqual比较runtime与持久化JSON，因数值表示差异误报；增加紧凑诊断后，离线两份压缩projection解码对比完全相等，且所有边界/数量未变。随后时间线runtime与JSON往返同类误报。没有改产品来迁就检查：简化比较器为双方JSON契约正规化，保留全部字段，最终测到18个玩家采样含-0坐标/yaw，JSON标准序列化为0。未把真实非零差异忽略，失败仍固定错误码且不dump身份/坐标。

总计修前1次、修后3次read/parse，后两次为验证工具纠偏；两次同边界失败后先简化比较器，再最终验证。每次bulk留同一进程；本地压缩基线815,960字节及日志位于忽略目录`.local-data/frame-identity/`，不提交用户数据。没有性能改善结论。首fixture借用冲突编译错误已修正，不计功能红例。

## 限制、清理与下一项

错误绑定会保守缺行、延后或放弃部分推断，不能保证所有Demo与旧坏输出完全一致。只有当前可见低10serial可校验，未验证高位。旧产物继续直接恢复；未实测UI/SQLite，未部署或安装。所有本轮构建/解析/测试进程退出，临时checkout/fixture目录清理，代理RELEASE。原锁屏UI A5独立待验。

下一明确线索：weapons.rs active_weapon_label仍把m_hActiveWeapon交给index-only lookup，而弹药来源已有独立serial校验；可能出现弹药被正确拒绝但武器名称仍取替代实体。先构造该源函数的小生命周期案例与当前资源消费，再决定窄修复，不直接重写全部背包或继续重复本轮Demo。
