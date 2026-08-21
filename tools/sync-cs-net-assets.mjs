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
// binary. Keep the WebGPU asyncify pair alongside it: WebGPU is now the
// default provider, and a missing optional asset would turn every local run
// into an avoidable 404/fallback. The release asset scan controls precaching;
// it does not need to hide a valid, independently hashed asset.
for (const asset of [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
]) {
  await cp(resolve(ortRoot, "dist", asset), resolve(viewerPublic, asset));
}
// FP32 and the older JSEP pair remain benchmark-only. FP16 is copied from the
// checked-in generated asset above and is part of the default WebGPU path.
for (const asset of [
  "models/cs-net/win-rate.fp32.onnx",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
]) {
  await rm(resolve(viewerPublic, asset), { force: true });
}
process.stdout.write(`[cs-net] synced verified model and ORT assets to ${destination}\n`);
