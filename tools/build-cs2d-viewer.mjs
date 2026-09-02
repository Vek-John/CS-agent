#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sanitizeViewerHtml } from "./cs2d-host/sanitize-viewer-html.mjs";

const root = process.cwd();
const upstream = resolve(process.env.CS2D_UPSTREAM_DIR || resolve(root, ".local-data/upstream/cs2d"));
const patcher = resolve(root, "tools/apply-cs2d-host-patch.mjs");
const modelSync = resolve(root, "tools/sync-cs-net-assets.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
  }
}

const patchArgs = ["--clone", "--reuse-patched-checkout"];
if (!existsSync(resolve(upstream, "node_modules"))) patchArgs.push("--install");
run(process.execPath, [patcher, ...patchArgs]);
// Clone and install the pinned upstream before syncing model/runtime assets.
// The sync step creates directories under the checkout; running it first
// leaves git clone with a non-empty destination in clean CI workspaces.
run(process.execPath, [modelSync]);

run("pnpm", ["--dir", upstream, "--filter", "cs2-demo-viewer", "build"], {
  env: { ...process.env, CS2D_BASE_PATH: "/cs2d/" },
});

const dist = resolve(upstream, "apps/app/dist");
for (const required of ["index.html", "assets", "zstd.wasm"]) {
  if (!existsSync(resolve(dist, required))) {
    throw new Error(`cs2d viewer build is missing ${required}: ${dist}`);
  }
}
const viewerJavaScript = readdirSync(resolve(dist, "assets"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(resolve(dist, "assets", name), "utf8"))
  .join("\n");
for (const marker of ["DEMO_IMPORT_REQUESTED", "loadManagedDemo", "MANAGED_LIBRARY"]) {
  if (!viewerJavaScript.includes(marker)) {
    throw new Error(`cs2d viewer build is missing managed-library marker: ${marker}`);
  }
}

const viewerIndex = resolve(dist, "index.html");
writeFileSync(viewerIndex, sanitizeViewerHtml(readFileSync(viewerIndex, "utf8")));

process.stdout.write(`[cs2d-host] built Cloudflare viewer at ${dist}\n`);
