# 真实Demo恢复成本对照

2026-09-27；基线4aa4555；Node v22.17.0；样本为已授权test_demo.dem，60,601,900字节，真实解析9回合、10玩家。未输出玩家身份、帧、坐标或内容哈希。

## 方法

`node tools/benchmark-managed-replay-reuse.mjs --smoke`先验证当前patched Viewer函数执行和控制流程；再运行：

```sh
node tools/benchmark-managed-replay-reuse.mjs /Users/vekel/编程/CS-agent/demoTests/test_demo.dem
```

父进程管理唯一子进程，120秒外部终止；子进程JS heap限制3GiB，输入限制128MiB。Demo只读，raw/Replay均在子进程，结束释放。工具不启动HTTP服务或浏览器，不调用模型/用户库。

同进程按序：实际loadManagedDemo首次解析→仅使ready资格失效、同RESTORE命令再次走原Parser→匹配身份的温恢复。真实WASM parse_demo(frameRate=8)、Replay JSON解析、WebCrypto SHA256；HTTP READ用每次本地文件读取构建Response替代，fresh token检查仅模拟，不是权限验收。首次源身份预读39ms、WASM init1ms在三个阶段外；预读已暖OS缓存。digest调用计数只统计Viewer warm digest，Parser内部hash另列耗时。

## 正式结果

| 阶段 | 加载函数耗时 | Parser次数 | 文件READ次数 | 阶段末RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 首次解析 | 7427ms | 1 | 1 | 797.1 |
| 重复解析基线 | 7168ms | 1 | 1 | 1010.4 |
| 温恢复 | 63ms | 0 | 1 | 954.3 |

重复解析基线内部：File.arrayBuffer 14.32ms、SHA256 31.23ms、WASM 6959.94ms、Replay字符串读取与JSON解析133.82ms。温恢复仍完成完整读取和SHA，且保留同一Replay引用。整个进程累计峰值约1010.8MiB；阶段末RSS受GC/allocator与之前阶段影响，不是单阶段独立峰值。

结论：在这份样本及此执行器中，移除重复Parser可省去主要计算工作。没有证明减少文件IO或内存，也不能把比例外推为真实桌面端提速倍数。只有一次正式三阶段对照，无分布/统计置信区间。

## 记录与限制

日志`.local-data/managed-replay-cost/isolated.txt`为正式三阶段；`real.txt`是与build并发的首次试跑，**不作时间结论**。发现干扰后等待构建退出，再重测一次；没有反复调参或修改门槛。smoke日志与28项相关tests、TypeScript、Web production build日志位于同目录，均通过；最终CLI还通过node --check。

Parser wrapper没有解码voice，也没有跨浏览器Worker的结构化克隆/传输。nextTick为stub，未测Vue卸载、ViewerStage ACK、渲染、真实HTTP/权限或磁盘冷缓存。累计内存不能直接归因于WASM Worker保留或泄漏。下一步先核实实际Parser Worker的对象释放边界；不由这次数字直接改生命周期。

只读方法审查发现引用断言失败会打印Replay，最终工具改用布尔比较及固定错误码并复跑小smoke；不重跑真实Demo。

测试/build及父子进程均已退出，保留原Demo/SQLite/Memory/密钥；未安装、部署，原UI A5不受此验证替代。
