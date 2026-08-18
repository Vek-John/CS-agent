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
if (process.env.CS2D_DEV_ASSETS === "1") {
  await cp(resolve(ortRoot, "dist/ort-wasm-simd-threaded.wasm"), resolve(viewerPublic, "ort-wasm-simd-threaded.wasm"));
} else {
  await rm(resolve(viewerPublic, "ort-wasm-simd-threaded.wasm"), { force: true });
}
process.stdout.write(`[cs-net] synced verified model assets to ${destination}\n`);
