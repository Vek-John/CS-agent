#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

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

process.stdout.write(`[cs2d-host] built Cloudflare viewer at ${dist}\n`);
