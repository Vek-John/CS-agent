#!/usr/bin/env node

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const sourceRoot = path.join(workspaceRoot, "apps", "web", ".open-next", "assets");
const deployRoot = path.join(workspaceRoot, "apps", "web", ".open-next", "cloudflare-assets");

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

const required = [
  path.join(deployRoot, "generated-assets", "maps", "de_mirage.png"),
  path.join(deployRoot, "generated-assets", "items", "catalog.json")
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
  excluded: "generated-data/**"
})}\n`);
