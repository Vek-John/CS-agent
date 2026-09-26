# 默认WebGPU下载进度与取消

2026-09-27；基线a2a20b7，任务win-rate-download-progress。

## 来源与行动结论

首进展成本调查核实：runtime-webgpu原loadWebGpuModel等待完整arrayBuffer，不发downloading；首次有效进展要等fetch/hash/session/warmup/首批推理。runtime.ts已有下载reader并不证明默认WebGPU有进度。本地FP16模型19,452,396B和asyncify24,254,953B已存在，无下载或安装需求。

原主目录旧证据`.local-data/acceptance-csnet-webgpu-fp16/adapter-only-batch16-three-run-v2/edge-webgpu-benchmark.json`仍可读，cold样本fetch55.145ms、session601.335ms、warmup162.350ms、total16698.580ms、7,239samples。是旧Edge/M1记录，不是本轮性能测量；warm行重复缓存的fetch/session值，不能当每次额外成本。现有源码缺口已足够决定先修进度，不重跑整场大Demo。

## 实现和验证

- 私有readWebGpuModelBytes被实际WebGPU入口使用，非空chunk累计实际bytes并即时上报；一次EOF拼合，字节顺序不变。没有新公开接口或WASM路径重构。
- 缺失/非法长度、压缩响应、实际bytes超过声明长度时total=0，不产生假的100%；模型metadata使用实际buffer长度。
- AbortSignal先拒绝等待再cancel reader，防cancel生成done误作成功；不等待挂起cancel，finally清listener/释放锁，清理错误不覆盖原错误。无reader继续arrayBuffer兼容，完成前无虚构进度。
- 原完整SHA校验仍在ORT session之前；digest返回后再检查abort。读失败/取消/hash错误都不会创建session。
- 实际runWebGpuFp16Inference + 真实ReadableStream：未EOF首chunk旧实现progress=0红，新实现立即downloading completed=2绿。18新增覆盖取消、hash、兼容/错误和正常真实feature/timeline构建；连同旧WebGPU/runtime config和Viewer idle source回归，共4文件55tests通过。
- pnpm typecheck、pnpm cs2d:typecheck、pnpm build、pnpm cs2d:build全部退出0。主控独立检查runtime diff、SHA/取消顺序与Worker真实onProgress转发；执行者已RELEASE，测试和构建进程退出。

本地日志：.local-data/win-rate-download-progress/{red,smoke,tests,typecheck-web,typecheck-viewer,build-web,build-viewer}.txt。

## 适用范围

测试中ORT、GPU能力与hash结果为mock，stream/feature/timeline为真实；未运行真实ONNX、GPU、用户Demo/SQLite、网络耗时或内存测量。Viewer空闲续期单测同跑，不等于浏览器全链路实测。拼合暂存chunks与完整buffer会短暂占用双份字节；没有宣称内存或推理速度改进。无reader兼容环境无法提供中途字节进度；下载后的session创建、warmup仍可能无进度，120秒策略未校准为跨设备SLA。
