# Bomb事件即时归属验证

日期2026-09-26；基线0f94799，codex/jev-decision-assessment。

## 问题与实现

collector三种Bomb事件原先用native handle的低index找pawn，再读tick_start owner缓存；plant坐标也仅按index读取。同index实体换serial、同tick controller重绑或解绑会把公共事件误归给旧玩家，并使用替代实体的位置。

0014复用既有`verified_event_pawn`一次解析：native→packed、当前class/index/可见serial、唯一当前controller绑定。actor和plant几何使用同一结果。pawn无效时保留事件kind/tick与defuse完成标记，身份/几何null；pawn有效但owner未知时保留几何。defuse/explosion不附坐标，爆炸仍不构成本人动作。未迁移其他事件或network m_hThrower。

Parser追加bomb-identity.v1；修复Adapter旧endsWith识别在已有ammo尾标记下丢失hurt/shot来源的问题，显式保留已知hurt/shot/ammo/bomb完整链，未知链不臆测。旧存档直接恢复，未重写历史数据。

## 验收证据

- A1/A2：`python3 tools/validate-bomb-identity-source.py --collector /tmp/cs-agent-bomb-before.rs`实际分支8红/2绿；默认当前源10绿。旧源码通过本轮补丁反向应用到临时副本重建，未回滚真实checkout。注入真实Bomb分支、props helpers、vendor lookup；实体/属性/坐标是合成fixture时间，不是Demo测量。覆盖serial复用、错class、缺/无效handle、重复/无效owner、同tick重绑/解绑及公共事件保留。
- A3：Adapter的null/他人/本人×plant/defuse/explosion小链验证，未知不生成本人动作，已知plant/defuse保留动作，爆炸不生成PLAYER_ACTION；JSON往返保持。
- A4：4文件89相关Vitest通过；patch工具11项通过。Parser native9项和vendor33项通过，Web TypeScript与production build、parser WASM/Viewer build及Viewer vue-tsc通过。新增验证工具后TypeScript再次通过。存在上游既有deprecated API warnings，不影响构建。
- 补丁接线：固定pin隔离稀疏checkout顺序应用全部14补丁、0013→0014受控升级和再次复用通过；实际dirty checkout复用通过。尾索引改固定位置以避免新增补丁错指旧升级。

真实消费命令：`pnpm exec tsx tools/validate-bomb-identity.ts <authorized-demo.dem>`，外层120秒期限。已有test_demo.dem 60,601,900字节只读一次、生产WASM解析一次；7,407ms解析、9,064ms总计，9回合、7次plant/1次defuse/2次explosion，10事件owner均非空。10位玩家的实际Adapter bundle合计8个个人plant/defuse，均能对应原事件且来源完整，JSON往返通过。0网络/模型调用，bulk留同一进程，仅输出统计。摘要留忽略目录`.local-data/bomb-identity/real-summary.log`。

## 限制与后继

这份Demo消费验证不是外部身份真值，也没有测到真实recycled实体异常；异常由源注入生命周期覆盖。不验证精确坐标计算、实际UI或SQLite恢复，不声称教练专业判断改善。低10serial无法验证未传输高位。全部进程退出，临时fixture目录清理，无用户数据写入、安装或部署。

下一独立目标：真实collector `player_death`仍用旧缓存解析victim/attacker/assister并按index取位置，且victim缺失直接丢事件。先复现并核实非空victim schema与Viewer/Adapter消费要求，再选择最小兼容修复；不直接机械替换全局handle helper。原锁屏UI A5继续独立待验。
