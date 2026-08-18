#!/usr/bin/env node

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const sourceRoot = path.join(workspaceRoot, "apps", "web", ".open-next", "assets");
const deployRoot = path.join(workspaceRoot, "apps", "web", ".open-next", "cloudflare-assets");
const viewerSourceRoot = path.join(workspaceRoot, ".local-data", "upstream", "cs2d", "apps", "app", "dist");
const viewerDeployRoot = path.join(deployRoot, "cs2d");

async function copyReleaseAssets(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    // generated-data contains localhost-only ReplayBundles and uploaded Demo
    // output. It must never become a public Cloudflare asset.
    if (entry.name === "generated-data") continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyReleaseAssets(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await cp(sourcePath, destinationPath);
    }
  }
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function copyViewerSidecar(name) {
  const source = path.join(viewerSourceRoot, name);
  const destination = path.join(deployRoot, name);
  if (!(await pathExists(source)) || (await pathExists(destination))) return;
  const sourceInfo = await stat(source);
  if (sourceInfo.isDirectory()) await copyReleaseAssets(source, destination);
  else await cp(source, destination);
}

async function countFilesAndBytes(root) {
  let files = 0;
  let bytes = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(target)).size;
      }
    }
  }
  await walk(root);
  return { files, bytes };
}

await rm(deployRoot, { recursive: true, force: true });
await copyReleaseAssets(sourceRoot, deployRoot);

if (!(await pathExists(viewerSourceRoot))) {
  throw new Error(`Missing cs2d viewer build: ${path.relative(workspaceRoot, viewerSourceRoot)}. Run pnpm cs2d:build first.`);
}
await copyReleaseAssets(viewerSourceRoot, viewerDeployRoot);

// The upstream viewer still has a few public absolute URLs (for example
// `/maps/...` and `/weapons/...`). Keep these small compatibility sidecars at
// the Worker root while the actual app shell lives under `/cs2d/`.
for (const name of [
  "maps",
  "weapons",
  "replays",
  "teams",
  "icon.svg",
  "apple-touch-icon-180x180.png",
  "pwa-64x64.png",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "maskable-icon-512x512.png",
  "zstd.wasm",
]) {
  await copyViewerSidecar(name);
}

const required = [
  path.join(deployRoot, "generated-assets", "maps", "de_mirage.png"),
  path.join(deployRoot, "generated-assets", "items", "catalog.json"),
  path.join(viewerDeployRoot, "index.html"),
  path.join(viewerDeployRoot, "assets"),
  path.join(viewerDeployRoot, "ort-wasm-simd-threaded.mjs"),
  path.join(viewerDeployRoot, "ort-wasm-simd-threaded.wasm"),
  path.join(viewerDeployRoot, "zstd.wasm"),
  path.join(deployRoot, "maps", "de_mirage_radar.png"),
  path.join(deployRoot, "weapons", "ak47.svg"),
  path.join(deployRoot, "zstd.wasm"),
];
for (const file of required) {
  try {
    await stat(file);
  } catch {
    throw new Error(`Cloudflare release asset is missing: ${path.relative(workspaceRoot, file)}`);
  }
}

const summary = await countFilesAndBytes(deployRoot);
process.stdout.write(`${JSON.stringify({
  directory: path.relative(workspaceRoot, deployRoot),
  files: summary.files,
  bytes: summary.bytes,
  viewer: path.relative(workspaceRoot, viewerDeployRoot),
  excluded: "generated-data/**"
})}\n`);
