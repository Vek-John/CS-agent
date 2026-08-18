import * as ort from "onnxruntime-web/wasm";
import {
  buildWinProbabilityTimeline,
  CS_NET_SOURCE,
  flattenFeatureBatch,
  type CsNetFeatureSample,
  type CsNetModelBatch,
  type CsNetModelInputs,
  type CsNetReplay,
  type WinProbabilityTimelineV1,
} from "./index";

export interface WinRateRuntimeProgress {
  phase: "downloading" | "inference" | "ready";
  completed: number;
  total: number;
  detail?: string;
}

export interface WinRateRuntimeOptions {
  modelUrl?: string;
  selectedPlayerId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: WinRateRuntimeProgress) => void;
}

let sessionPromise: Promise<ort.InferenceSession> | undefined;
let sessionUrl: string | undefined;

function configureLocalWasmAsset(): void {
  // Vite serves linked package dependencies from the dev iframe, while the
  // production build rewrites the same import to a hashed asset. Keep the
  // localhost path explicit so the real Worker does not fall through to the
  // SPA HTML response when ORT asks for its WASM binary.
  if (typeof location === "undefined" || !["localhost", "127.0.0.1", "::1"].includes(location.hostname) || location.port !== "5174") return;
  ort.env.wasm.wasmPaths = {
    wasm: new URL("/ort-wasm-simd-threaded.wasm", location.origin).toString(),
  };
}

function tensorInputs(batch: CsNetModelBatch, start: number, end: number): Record<string, ort.Tensor> {
  const inputs = {} as CsNetModelInputs;
  for (const key of Object.keys(batch.inputs) as (keyof CsNetModelInputs)[]) {
    inputs[key] = batch.inputs[key].slice(start, end) as never;
  }
  const chunk: CsNetModelBatch = { samples: batch.samples.slice(start, end), inputs };
  const flat = flattenFeatureBatch(chunk);
  const size = end - start;
  return {
    mlp1_f: new ort.Tensor("float32", flat.mlp1_f, [size, 31, 3]),
    mlp1_i: new ort.Tensor("int64", flat.mlp1_i, [size, 31]),
    mlp1_mask: new ort.Tensor("bool", flat.mlp1_mask, [size, 31]),
    mlp2_f: new ort.Tensor("float32", flat.mlp2_f, [size, 31, 14]),
    mlp2_mask: new ort.Tensor("bool", flat.mlp2_mask, [size, 31]),
    mlp3_f: new ort.Tensor("float32", flat.mlp3_f, [size, 31, 1]),
    mlp3_i: new ort.Tensor("int64", flat.mlp3_i, [size, 31]),
    mlp3_mask: new ort.Tensor("bool", flat.mlp3_mask, [size, 31]),
    mlp4_f: new ort.Tensor("float32", flat.mlp4_f, [size, 31, 4]),
    mlp4_mask: new ort.Tensor("bool", flat.mlp4_mask, [size, 31]),
    mlp5_f: new ort.Tensor("float32", flat.mlp5_f, [size, 31, 9, 13]),
    mlp5_i: new ort.Tensor("int64", flat.mlp5_i, [size, 31, 9]),
    mlp5_mask: new ort.Tensor("bool", flat.mlp5_mask, [size, 31, 9]),
    emb1_i: new ort.Tensor("int64", flat.emb1_i, [size, 31, 9]),
    emb1_mask: new ort.Tensor("bool", flat.emb1_mask, [size, 31, 9]),
    emb2_i: new ort.Tensor("int64", flat.emb2_i, [size, 31]),
    emb2_mask: new ort.Tensor("bool", flat.emb2_mask, [size, 31]),
    dead_mask: new ort.Tensor("bool", flat.dead_mask, [size, 31]),
    pad_mask: new ort.Tensor("bool", flat.pad_mask, [size, 31]),
  };
}

async function loadModel(url: string, options: WinRateRuntimeOptions): Promise<ort.InferenceSession> {
  if (sessionPromise && sessionUrl === url) return sessionPromise;
  sessionUrl = url;
  configureLocalWasmAsset();
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  sessionPromise = (async () => {
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok) throw new Error(`胜率模型下载失败（${response.status}）。`);
    const total = Number(response.headers.get("content-length") ?? CS_NET_SOURCE.assetBytes);
    const reader = response.body?.getReader();
    let buffer: Uint8Array;
    if (!reader) {
      buffer = new Uint8Array(await response.arrayBuffer());
      options.onProgress?.({ phase: "downloading", completed: buffer.byteLength, total });
    } else {
      const chunks: Uint8Array[] = [];
      let completed = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        completed += next.value.byteLength;
        options.onProgress?.({ phase: "downloading", completed, total });
      }
      buffer = new Uint8Array(completed);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    }
    return ort.InferenceSession.create(buffer, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  })();
  try {
    return await sessionPromise;
  } catch (error) {
    sessionPromise = undefined;
    sessionUrl = undefined;
    throw error;
  }
}

export async function runWinRateInference(
  replay: CsNetReplay,
  batch: CsNetModelBatch,
  options: WinRateRuntimeOptions = {},
): Promise<WinProbabilityTimelineV1> {
  const url = options.modelUrl ?? CS_NET_SOURCE.assetUrl;
  const session = await loadModel(url, options);
  const logits: number[] = [];
  const chunkSize = 128;
  for (let start = 0; start < batch.samples.length; start += chunkSize) {
    const end = Math.min(batch.samples.length, start + chunkSize);
    const output = await session.run(tensorInputs(batch, start, end));
    const data = output.logit?.data;
    if (!data) throw new Error("胜率模型没有返回 logit 输出。");
    for (const value of data) logits.push(Number(value));
    options.onProgress?.({ phase: "inference", completed: end, total: batch.samples.length, detail: `${end}/${batch.samples.length}` });
  }
  options.onProgress?.({ phase: "ready", completed: batch.samples.length, total: batch.samples.length });
  return buildWinProbabilityTimeline({
    replay,
    selectedPlayerId: options.selectedPlayerId,
    samples: batch.samples as readonly CsNetFeatureSample[],
    logits,
  });
}
