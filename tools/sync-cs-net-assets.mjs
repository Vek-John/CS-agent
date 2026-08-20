#!/usr/bin/env node

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const source = resolve(root, "apps/web/public/generated-assets/models/cs-net");
const upstream = resolve(process.env.CS2D_UPSTREAM_DIR || resolve(root, ".local-data/upstream/cs2d"));
const destination = resolve(upstream, "apps/app/public/models/cs-net");
const viewerPublic = resolve(upstream, "apps/app/public");
const ortPnpmRoot = resolve(root, "node_modules/.pnpm");
const ortEntry = (await readdir(ortPnpmRoot)).find((entry) => entry.startsWith("onnxruntime-web@"));
if (!ortEntry) throw new Error("Missing onnxruntime-web in the workspace pnpm store.");
const ortRoot = resolve(ortPnpmRoot, ortEntry, "node_modules/onnxruntime-web");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
// The dedicated cs2d Worker uses ORT's module loader and its threaded-SIMD
// binary. Keep both files in dev and release viewers; the release asset scan
// enforces the Worker Static Assets per-file limit.
for (const asset of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  await cp(resolve(ortRoot, "dist", asset), resolve(viewerPublic, asset));
}
// FP32/FP16 and the asyncify WebGPU runtime are local benchmark artifacts. Keep
// the normal release build deterministic and INT8-only.
for (const asset of [
  "models/cs-net/win-rate.fp32.onnx",
  "models/cs-net/win-rate.fp16.onnx",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
]) {
  await rm(resolve(viewerPublic, asset), { force: true });
}
process.stdout.write(`[cs-net] synced verified model and ORT assets to ${destination}\n`);
