#!/usr/bin/env node

// Bootstrap/verification helper for the checked-in FP16 viewer asset. It is
// still useful when regenerating an upstream checkout, while the normal sync
// path now publishes FP16 and asyncify by default.
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const upstream = resolve(process.env.CS2D_UPSTREAM_DIR || resolve(root, ".local-data/upstream/cs2d"));
const destination = resolve(upstream, "apps/app/public/models/cs-net");
const viewerPublic = resolve(upstream, "apps/app/public");
const pnpmRoot = resolve(root, "node_modules/.pnpm");
const ortEntry = (await (await import("node:fs/promises")).readdir(pnpmRoot)).find((entry) => entry.startsWith("onnxruntime-web@"));
if (!ortEntry) throw new Error("Missing onnxruntime-web in the workspace pnpm store.");
const ortRoot = resolve(pnpmRoot, ortEntry, "node_modules/onnxruntime-web/dist");

const sourceRoot = resolve(root, ".local-data/generated/cs-net");
const experimentRoot = resolve(root, ".local-data/experiments/cs-net-fp16");
await mkdir(destination, { recursive: true });
for (const [source, target] of [
  [resolve(sourceRoot, "win-rate.fp32.onnx"), resolve(destination, "win-rate.fp32.onnx")],
  [resolve(experimentRoot, "win-rate.fp16.onnx"), resolve(destination, "win-rate.fp16.onnx")],
  [resolve(ortRoot, "ort-wasm-simd-threaded.asyncify.mjs"), resolve(viewerPublic, "ort-wasm-simd-threaded.asyncify.mjs")],
  [resolve(ortRoot, "ort-wasm-simd-threaded.asyncify.wasm"), resolve(viewerPublic, "ort-wasm-simd-threaded.asyncify.wasm")],
]) {
  await cp(source, target);
}

async function sha256(path) {
  const hash = createHash("sha256");
  const file = await (await import("node:fs/promises")).readFile(path);
  hash.update(file);
  return hash.digest("hex");
}

const files = [
  resolve(destination, "win-rate.fp32.onnx"),
  resolve(destination, "win-rate.fp16.onnx"),
  resolve(viewerPublic, "ort-wasm-simd-threaded.asyncify.mjs"),
  resolve(viewerPublic, "ort-wasm-simd-threaded.asyncify.wasm"),
];
const result = [];
for (const file of files) {
  const stat = await (await import("node:fs/promises")).stat(file);
  result.push({ path: file, bytes: stat.size, sha256: await sha256(file) });
}
console.log(JSON.stringify({ localOnly: true, files: result }, null, 2));
