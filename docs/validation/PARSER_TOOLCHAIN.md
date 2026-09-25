# Parser WASM工具链验证（2026-09-25）

基线1e39be4。9150d51让Viewer构建重新编译parser源码，本轮补齐CI依赖和本地提前检查；不退回旧WASM，也不改变parser事实/Viewer协议。

## 确认的缺口和版本

- parser Cargo.lock锁定wasm-bindgen **0.2.125**，上游build.sh注释也要求该CLI版本，但此前desktop CI只有Rust1.89.0与aarch64-apple-darwin target，缺WASM target和CLI。
- source2-demo0.5.4声明Rust1.79；按wasm32过滤的离线Cargo metadata中，相关已锁依赖声明最高1.85。官方[wasm-bindgen CLI 0.2.125](https://github.com/wasm-bindgen/wasm-bindgen/blob/0.2.125/crates/cli/Cargo.toml)及cli-support声明1.86。保持CI **Rust1.89.0**，未无依据升级。它是项目支持的构建基线，不声称计算出了所有源码特性的精确MSRV。
- [setup-rust-toolchain action](https://github.com/actions-rust-lang/setup-rust-toolchain/blob/v1/action.yml)默认设置`-D warnings`，本地实际parser编译存在上游deprecated API warning；保留CI原有-D warnings，只在第三方parser的Cargo子进程追加`--force-warn deprecated`，保持deprecated警告可见且不放宽其他警告或自有桌面代码。
- 本机普通shell选中Homebrew Cargo，旧构建脚本则优先`~/.cargo/bin`。只查shell版本或其他toolchain的target不能证明实际构建可用。

## 实现

`cs2d-parser-toolchain.mjs`在parser目录解析rustup的active toolchain，沿用环境/目录override；优先使用CARGO_HOME/bin（未设置时~/.cargo/bin），以`rustup which --toolchain`取得绝对Cargo/rustc路径。检查所选toolchain安装的WASM target、项目Rust基线和锁文件要求的CLI版本。构建使用同样的绝对可执行文件及RUSTC，不让其他PATH编译器混入。冲突RUSTC先报错。parser对deprecated的窄豁免同时支持RUSTFLAGS与优先级更高的CARGO_ENCODED_RUSTFLAGS；不改父进程、bindgen或桌面编译环境。

预检设置[`RUSTUP_AUTO_INSTALL=0`](https://rust-lang.github.io/rustup/environment-variables.html)，不安装或升级用户工具。缺工具/target、过旧Rust、CLI与lock不匹配时给出针对所选toolchain的操作命令。每条探针10秒上限；Cargo/CLI构建各10分钟上限。Cargo使用`--locked`和明确target-dir，bindgen读取同一输出。

`pnpm cs2d:check`只准备固定上游checkout并预检，不编译或安装工具；`desktop:prepare`在runtime/Web资源构建前先执行它。单独`cs2d:build/setup/patch --build-parser`也在昂贵构建前检查。成功后只执行一次Cargo build和一次bindgen生成，不运行双重完整构建。

CI保留Rust1.89.0，增加wasm32-unknown-unknown；CLI安装固定0.2.125且使用`--locked`。只有缺少或版本不符才安装；不会每次对已有匹配CLI重复安装。未来parser lock升级需同步CI版本，否则预检明确失败。

## 实际验证

| 检查 | 结果 |
|---|---|
| `pnpm cs2d:check` | 通过：stable-aarch64-apple-darwin、CLI0.2.125 |
| `pnpm exec vitest run tools/cs2d-parser-toolchain.test.mjs tools/apply-cs2d-host-patch.test.mjs` | 21项相关测试通过（工具链最终14项，未改动patch工具7项）；隔离可执行命令探针覆盖缺rustup/cargo/rustc/CLI、选中target缺失、旧Rust、CLI不匹配、RUSTC冲突、lock变化及恰好一次build/生成 |
| CI安装shell | 测试提取并执行实际workflow的shell body，但PATH内全是假工具；缺失/错误版本触发一次固定安装，匹配版本零安装，未下载或安装软件 |
| `pnpm cs2d:build` / 作用域修正后 `RUSTFLAGS='-D warnings' pnpm cs2d:build` | 真实parser WASM＋Viewer构建通过，使用本机已安装Rust1.97.1、CLI0.2.125；严格父环境下仅parser deprecated保持warning |
| `pnpm typecheck` / `pnpm build` | 均通过 |
| 干净GitHub CI / Rust1.89实际编译 / desktop发布 | 未运行；没有触发CI或发布，也没有为测试安装1.89或删除缓存 |

最初不限定平台的离线metadata因无关libredox缓存缺失拒绝解析，未联网下载；随后限定wasm32得到了所需依赖声明。首次命令探针测试暴露macOS `/tmp`与`/private/tmp`路径别名，修正测试比较为实际路径后通过；不是产品编译失败。随后严格父环境复验确认普通`-W deprecated`仍会被`-D warnings`升级，改用rustc明确支持的[`--force-warn deprecated`](https://doc.rust-lang.org/rustc/lints/levels.html#force-warn)，用小编译探针确认后再做实际parser构建；另一探针确认unused-variable仍被-D warnings拒绝；没有取消其他lint或桌面策略。命令探针在并行编译负载下曾超过Vitest默认5秒，只有两个多子进程成功路径测试改为20秒上限。

没有浏览器、Demo、模型、用户SQLite或签名/公证操作。所有构建/测试进程已退出，临时假工具目录由测试清理；未更改用户全局工具链、默认版本或缓存。原教学工具暂停A5和其InPrivate窗口保持原负责人状态。本轮push后释放代码写入。
