# 采样地面标志真实覆盖

2026-09-27；任务 sampled-ground-coverage；基线6b129e7。使用既有授权Demo与原指定目标，身份、原handle、精确tick、位置均不输出。生产Parser、schema、教学与模型未修改。

## 本次观察

| 本人样本 | Tick-start | Tick-end |
| --- | ---: | ---: |
| 按8 tick stride调度 | 7248 | 7248 |
| 当前pawn身份验证通过 | 7050 | 7051 |
| 严格生命/生命状态确认存活 | 4778 | 4778 |
| 存活且FLAG_SET | 4569 | 4569 |
| 存活且FLAG_UNSET | 209 | 209 |
| 存活辅助handle关系一致 | 4778 | 4778 |

每阶段eligible样本的flags均有Unsigned32值，ground handle均为当前实体绑定或网络invalid sentinel，缺失/错型/关系冲突观察数为0。结果JSON的计数map只输出出现过的类别；未出现的类别不是预设可用性。[匿名结果](SAMPLED_GROUND_COVERAGE_RESULT.json)。统计覆盖整份Demo的playing-side本人状态，含非live阶段；不外推所有地图、Demo或版本。

7050对相同owner/index/serial样本可比；其中8对bit0投影变化，均在两侧明确存活，16对完整flags变化，8对ground handle变化。两阶段汇总相同不等于逐样本相同。另198对**至少一侧缺失**而不可比，包含双方均缺失的情况；正式结果字段missingOnePhase沿用原名，不能解释成198次仅单侧缺失。

60,601,900B，读取/解析各1次，native observer墙钟346ms（含启动，不是性能承诺）；不构建Replay。父进程120秒硬期限、输入128MiB和stdout/stderr合计64KiB上限，输出1173字节。正式摘要先落盘，未重跑解析。

## 方法、验证和行动

探针复用当前props.rs的verified_controller_pawn；controller及pawn均限playing side，明确存活要求严格正健康与lifeState=0。m_fFlags严格类型读取，bit0仅命名FLAG_SET/FLAG_UNSET。辅助m_hGroundEntity匹配当前entity index/serial或网络sentinel，数值关系一致不等于完整物理语义。源码位于tools/cs2d-host/fixtures/ground-coverage.rs，编译时复制到受控parser的examples/cs_coach_sampled_ground.rs，以复用同crate props.rs；结束后只删除本探针临时文件。

13项smoke断言覆盖missing、错型、0、bit0/其他位、非法handle与冲突。首次Cargo相对patch路径、随后proto宏限定名导致编译失败，两次均未运行正式输入；简化为已知绝对vendor路径和既有示例同名import后编译退出0，再smoke，最后唯一正式运行。没有安装或下载依赖，也未误运行旧binary。

```sh
cargo build --offline --locked --no-default-features --release --example cs_coach_sampled_ground --config 'patch.crates-io.source2-demo.path="<absolute-repo>/vendor/source2-demo"' --manifest-path .local-data/upstream/cs2d/packages/parser/Cargo.toml
# 编译退出0后，经拥有120秒硬期限/64KiB输出上限的父进程先运行 --smoke。
# 正式调用参数为 <existing.dem> <player-name>；不得把路径或名字写入摘要。
```

结论：支持为当前来源设计可选的采样地面事实，必须先选定并记录phase。现有frame由tick-start产生，新增字段应在同一当前pawn、同一frame采样，不能混入tick-end读数；缺失/错型/关系冲突保持unknown。已读属性是当时实体状态，不证明该属性本tick刚更新。FLAG_UNSET不自动称为空中，更不授予急停、射击精度或战术错误结论；不接CS-Net。

下一有限目标 sampled-ground-fact-contract：先定义与现有tick-start帧对齐的最小来源字段、unknown及旧记录兼容，再用小fixture验证Adapter/当前事实消费；只有能改善可见状态或当前追问才实施，不新增判错类别、不重算旧保存记录、不重复本次真实parse。native A5独立等待原恢复条件。

## 完成交付检查

13项smoke断言、实际props::hurt_handle_tests的2项原生身份测试通过；Web/Viewer TypeScript与production build全部退出0。原生库现有deprecated warnings保留，未改变工具链或安装。执行者RELEASE，临时example、自建probe binary、父子进程/timer与全部检查进程退出。日志位于.local-data/sampled-ground-coverage。
