import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCsNetFeatureBatches, type CsNetReplay } from "./index";
const mock = vi.hoisted(() => ({ create: vi.fn(), run: vi.fn(), digest: vi.fn() }));
vi.mock("onnxruntime-web/webgpu", () => ({
  env: { webgpu: {}, wasm: {}, versions: { web: "test" } },
  InferenceSession: { create: mock.create },
  Tensor: class { constructor(public type: string, public data: unknown, public dims: number[]) {} dispose() {} },
}));
import { CS_NET_WEBGPU_FP16_MODEL_SHA256, decideWebGpuFailure, resetWebGpuRuntimeForWorkerRestart, runWebGpuFp16Inference, type WebGpuRuntimeOptions } from "./runtime-webgpu";

const replay: CsNetReplay = {
  map: "de_mirage", demoTickRate: 64, frameRate: 8,
  players: Array.from({ length: 10 }, (_, i) => ({ steamId: `p${i}`, startSide: i < 5 ? "CT" : "T" })),
  rounds: [{ number: 1, startTick: 64, freezeStartTick: 0, decidedTick: 128, endTick: 128, postEndTick: 192,
    winner: "CT", scoreCt: 0, scoreT: 0, events: [],
    frames: [{ tick: 64, t: 1, players: Array.from({ length: 10 }, (_, i) => ({ steamId: `p${i}`, side: i < 5 ? "CT" : "T", x: i, y: 0, z: 0, yaw: 0, health: 100, alive: true, weapon: "AK-47", money: 3000, equipValue: 4500, armor: 100 })) }],
  }],
};
function run(options: WebGpuRuntimeOptions = {}) {
  return runWebGpuFp16Inference(replay, buildCsNetFeatureBatches(replay, 16), options);
}
function streamed(header?: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  const response = new Response(body, { headers: header === undefined ? {} : { "content-length": header } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return { controller, body, cancel };
}
beforeEach(() => {
  resetWebGpuRuntimeForWorkerRestart();
  mock.create.mockReset().mockResolvedValue({ run: mock.run });
  mock.run.mockReset().mockResolvedValue({ logit: { data: new Float32Array([0]), dispose() {} } });
  mock.digest.mockReset().mockResolvedValue(Uint8Array.from(CS_NET_WEBGPU_FP16_MODEL_SHA256.match(/../g)!, value => parseInt(value, 16)).buffer);
  vi.stubGlobal("crypto", { subtle: { digest: mock.digest } });
  vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({ features: new Set(["shader-f16"]) }) } });
});
afterEach(() => { resetWebGpuRuntimeForWorkerRestart(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("WebGPU model download via actual inference entry", () => {
  it("reports actual nonempty chunks before done and preserves model bytes/timeline", async () => {
    const stream = streamed("3");
    const progress = vi.fn();
    const pending = run({ onProgress: progress });
    stream.controller.enqueue(new Uint8Array([1, 2]));
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "downloading", completed: 2, total: 3 })), { timeout: 150 });
    expect(mock.digest).not.toHaveBeenCalled();
    stream.controller.enqueue(new Uint8Array());
    stream.controller.enqueue(new Uint8Array([3]));
    stream.controller.close();
    const result = await pending;
    expect(progress.mock.calls.filter(([p]) => p.phase === "downloading").map(([p]) => p.completed)).toEqual([2, 3]);
    expect([...mock.create.mock.calls[0][0]]).toEqual([1, 2, 3]);
    expect(result.rounds).toHaveLength(1);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "ready", completed: 1 }));
    expect(stream.body.locked).toBe(false);
  });
  it.each([undefined, "NaN", "-5", "1.5", "Infinity", "9007199254740992", "1"])("does not invent a total for absent/invalid/undersized length %s", async (header) => {
    const stream = streamed(header);
    const progress = vi.fn();
    const pending = run({ onProgress: progress });
    stream.controller.enqueue(new Uint8Array([1, 2]));
    stream.controller.close();
    await pending;
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "downloading", completed: 2, total: 0 }));
  });
  it("does not use compressed content-length as the decoded byte total", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { "content-length": "200", "content-encoding": "gzip" } })));
    const progress = vi.fn();
    await run({ onProgress: progress });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "downloading", completed: 2, total: 0 }));
  });
  it.each([null, {}])("keeps no-reader arrayBuffer compatibility without pretending early progress: %s", async (body) => {
    let resolve!: (value: ArrayBuffer) => void;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), body, arrayBuffer: () => new Promise<ArrayBuffer>(done => { resolve = done; }) }));
    const progress = vi.fn();
    const pending = run({ onProgress: progress });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    expect(progress).not.toHaveBeenCalled();
    resolve(new Uint8Array([4, 5]).buffer);
    await pending;
    expect([...mock.create.mock.calls[0][0]]).toEqual([4, 5]);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "downloading", completed: 2, total: 0 }));
  });
  it("rejects a hash mismatch before creating a session", async () => {
    const stream = streamed();
    mock.digest.mockResolvedValue(new Uint8Array(32).buffer);
    const pending = run();
    stream.controller.enqueue(new Uint8Array([7])); stream.controller.close();
    await expect(pending).rejects.toThrow("WEBGPU_MODEL_SHA256_MISMATCH");
    expect(mock.create).not.toHaveBeenCalled();
    expect(stream.body.locked).toBe(false);
  });
  it("empty EOF reports no fabricated progress and still applies the hash gate", async () => {
    const stream = streamed("100");
    mock.digest.mockResolvedValue(new Uint8Array(32).buffer);
    const progress = vi.fn();
    const pending = run({ onProgress: progress }); stream.controller.close();
    await expect(pending).rejects.toThrow("WEBGPU_MODEL_SHA256_MISMATCH");
    expect(progress).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled();
    expect(stream.body.locked).toBe(false);
  });
  it("read failure releases the lock and never hashes or creates a session", async () => {
    const stream = streamed(); const pending = run();
    const result = pending.catch(error => error);
    await vi.waitFor(() => expect(stream.body.locked).toBe(true));
    stream.controller.error(new Error("download interrupted"));
    expect(await result).toMatchObject({ message: "download interrupted" });
    expect(stream.body.locked).toBe(false);
    expect(mock.digest).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled();
  });
  it("aborts a hanging read without waiting for an underlying cancel promise", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = run({ signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort();
    const error = await result;
    expect(decideWebGpuFailure(error)).toMatchObject({ kind: "ABORTED", shouldFallback: false });
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(mock.digest).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled();
  });
  it("aborts the compatibility body wait and ignores its late bytes", async () => {
    let resolve!: (value: ArrayBuffer) => void;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), body: null, arrayBuffer: () => new Promise<ArrayBuffer>(done => { resolve = done; }) }));
    const controller = new AbortController(); const progress = vi.fn();
    const result = run({ signal: controller.signal, onProgress: progress }).catch(error => error);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function")); controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    resolve(new Uint8Array([1]).buffer); await Promise.resolve();
    expect(progress).not.toHaveBeenCalled(); expect(mock.digest).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled();
  });
  it("rechecks cancellation after hash work before creating the ORT session", async () => {
    let resolve!: (value: ArrayBuffer) => void;
    mock.digest.mockImplementation(() => new Promise<ArrayBuffer>(done => { resolve = done; }));
    const stream = streamed(); const controller = new AbortController();
    const result = run({ signal: controller.signal }).catch(error => error);
    stream.controller.enqueue(new Uint8Array([1])); stream.controller.close();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function")); controller.abort();
    resolve(Uint8Array.from(CS_NET_WEBGPU_FP16_MODEL_SHA256.match(/../g)!, value => parseInt(value, 16)).buffer);
    expect(await result).toMatchObject({ name: "AbortError" }); expect(mock.create).not.toHaveBeenCalled();
  });

});
