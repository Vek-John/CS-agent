import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, lstatSync } from "node:fs";
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const TARGET_TRIPLE = "aarch64-apple-darwin";
export const PINNED_NODE_VERSION = "24.19.0";
export const NODE_ARCHIVE = `node-v${PINNED_NODE_VERSION}-darwin-arm64.tar.gz`;
export const NODE_ARCHIVE_SHA256 = "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d";
const NODE_ARCHIVE_URL = `https://nodejs.org/download/release/v${PINNED_NODE_VERSION}/${NODE_ARCHIVE}`;

const execFile = promisify(execFileCallback);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "../..");
const defaults = {
  runtimeEntry: join(repoRoot, "apps/desktop-runtime/dist/desktop-runtime.cjs"),
  checkpointProbe: join(repoRoot, "apps/desktop-runtime/dist/desktop-checkpoint-probe.cjs"),
  standalone: join(repoRoot, "apps/web/.next/standalone"),
  publicDir: join(repoRoot, "apps/web/public"),
  staticDir: join(repoRoot, "apps/web/.next/static"),
  viewer: join(repoRoot, ".local-data/upstream/cs2d/apps/app/dist"),
  output: join(desktopDir, "src-tauri"),
  nodeCache: join(repoRoot, ".local-data/desktop-node"),
};

const forbiddenSegments = new Set([
  ".git", ".local-data", "generated-data", "log", "logs", "db", "database",
  "demo", "demos", "replay", "replays", "test", "tests", "__tests__", "fixtures", "docs",
]);
const forbiddenExtensions = new Set([".dem", ".db", ".sqlite", ".sqlite3", ".log", ".map"]);
const MAX_BUILD_PATH_SANITIZE_BYTES = 64 * 1024 * 1024;

export function isSensitiveRelativePath(relativePath) {
  return relativePath.split(/[\\/]/).filter(Boolean).some((segment) => {
    const lower = segment.toLowerCase();
    return forbiddenSegments.has(lower)
      || lower === ".env"
      || lower.startsWith(".env.")
      || /\.(?:test|spec)\.[^.]+$/u.test(lower)
      || forbiddenExtensions.has(extname(lower));
  });
}

export function sanitizeBuildPathPrefixes(bytes) {
  const output = Buffer.from(bytes);
  let replacements = 0;
  for (const root of [Buffer.from("/Users/")]) {
    let offset = 0;
    while (offset < output.length) {
      const start = output.indexOf(root, offset);
      if (start < 0) break;
      const usernameStart = start + root.length;
      const end = output.indexOf(0x2f, usernameStart);
      const username = end >= 0 ? output.subarray(usernameStart, end) : Buffer.alloc(0);
      const valid = username.length > 0
        && username.length <= 128
        && username.every((byte) => (byte >= 0x30 && byte <= 0x39)
          || (byte >= 0x41 && byte <= 0x5a)
          || (byte >= 0x61 && byte <= 0x7a)
          || byte === 0x2d || byte === 0x2e || byte === 0x5f);
      if (!valid) {
        offset = usernameStart;
        continue;
      }
      const prefixLength = end + 1 - start;
      const replacement = Buffer.from(`/build/${"_".repeat(prefixLength - 8)}/`);
      replacement.copy(output, start);
      replacements += 1;
      offset = end + 1;
    }
  }
  return { bytes: output, replacements };
}

export function sanitizeExactBuildRoot(bytes, buildRoot = repoRoot) {
  const output = Buffer.from(bytes);
  const prefix = Buffer.from(`${resolve(buildRoot)}${sep}`);
  const stem = Buffer.from("/build/");
  if (prefix.length <= stem.length + 1) return { bytes: output, replacements: 0 };
  const replacement = Buffer.concat([
    stem,
    Buffer.from("_".repeat(prefix.length - stem.length - 1)),
    Buffer.from("/"),
  ]);
  let replacements = 0;
  let offset = 0;
  while (offset < output.length) {
    const start = output.indexOf(prefix, offset);
    if (start < 0) break;
    replacement.copy(output, start);
    replacements += 1;
    offset = start + replacement.length;
  }
  return { bytes: output, replacements };
}

async function sanitizeCopiedFile(path, options = {}) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.size > MAX_BUILD_PATH_SANITIZE_BYTES) return;
  let bytes = await readFile(path);
  let replacements = 0;
  const exact = sanitizeExactBuildRoot(bytes);
  bytes = exact.bytes;
  replacements += exact.replacements;
  if (options.genericUserPrefix) {
    const generic = sanitizeBuildPathPrefixes(bytes);
    bytes = generic.bytes;
    replacements += generic.replacements;
  }
  if (replacements > 0) await writeFile(path, bytes);
}

async function assertDirectory(path, label) {
  try { if ((await lstat(path)).isDirectory()) return; } catch {}
  throw new Error(`${label} is missing or invalid`);
}

async function assertFile(path, label) {
  try { if ((await lstat(path)).isFile()) return; } catch {}
  throw new Error(`${label} is missing or invalid`);
}

async function copyTree(source, destination, root = source, state, logicalRelativePath) {
  const copyState = state ?? {
    canonicalRoot: await realpath(root),
    activeDirectories: new Set(),
  };
  const stats = await lstat(source);
  const relativePath = logicalRelativePath ?? relative(root, source);
  if (relativePath && isSensitiveRelativePath(relativePath)) return;
  if (stats.isSymbolicLink()) {
    const canonicalTarget = await realpath(source);
    if (canonicalTarget !== copyState.canonicalRoot
      && !canonicalTarget.startsWith(`${copyState.canonicalRoot}${sep}`)) {
      throw new Error("Bundled resource symlink escapes its source root");
    }
    const canonicalRelative = relative(copyState.canonicalRoot, canonicalTarget);
    if (canonicalRelative && isSensitiveRelativePath(canonicalRelative)) return;
    return copyTree(canonicalTarget, destination, root, copyState, relativePath);
  }
  if (stats.isDirectory()) {
    const canonicalDirectory = await realpath(source);
    if (copyState.activeDirectories.has(canonicalDirectory)) {
      throw new Error("Bundled resource symlink cycle detected");
    }
    const childState = {
      ...copyState,
      activeDirectories: new Set(copyState.activeDirectories).add(canonicalDirectory),
    };
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of (await readdir(source)).sort()) {
      await copyTree(
        join(source, entry),
        join(destination, entry),
        root,
        childState,
        relativePath ? join(relativePath, entry) : entry,
      );
    }
  } else if (stats.isFile()) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    await sanitizeCopiedFile(destination, {
      genericUserPrefix: extname(destination).toLowerCase() === ".wasm",
    });
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function isMachOArm64(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 8) return false;
    const arm64 = 0x0100000c;
    if (header.readUInt32LE(0) === 0xfeedfacf) return header.readUInt32LE(4) === arm64;
    const magic = header.readUInt32BE(0);
    if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
    const count = header.readUInt32BE(4);
    const stride = magic === 0xcafebabf ? 32 : 20;
    for (let index = 0; index < count && 8 + index * stride + 4 <= bytesRead; index += 1) {
      if (header.readUInt32BE(8 + index * stride) === arm64) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

async function inspectNode(path) {
  await assertFile(path, "Node executable");
  const { stdout } = await execFile(path, ["--version"], { encoding: "utf8", env: {}, timeout: 5000 });
  if (stdout.trim() !== `v${PINNED_NODE_VERSION}`) throw new Error("Node executable version is not pinned");
  if (!(await isMachOArm64(path))) throw new Error("Node executable is not Mach-O arm64");
  return { path, sha256: await sha256(path) };
}

export async function downloadPinnedNode(cacheDir) {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const archivePath = join(cacheDir, NODE_ARCHIVE);
  let validCache = false;
  try { validCache = (await sha256(archivePath)) === NODE_ARCHIVE_SHA256; } catch {}
  if (!validCache) {
    const temporary = await mkdtemp(join(cacheDir, ".download-"));
    try {
      const response = await fetch(NODE_ARCHIVE_URL, { redirect: "error" });
      if (!response.ok || !response.body || response.url !== NODE_ARCHIVE_URL) {
        throw new Error("Pinned Node download failed");
      }
      const downloaded = join(temporary, NODE_ARCHIVE);
      await pipeline(response.body, createWriteStream(downloaded, { mode: 0o600 }));
      if ((await sha256(downloaded)) !== NODE_ARCHIVE_SHA256) {
        throw new Error("Pinned Node archive checksum mismatch");
      }
      await rm(archivePath, { force: true });
      await rename(downloaded, archivePath);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  const extracted = await mkdtemp(join(cacheDir, ".extract-"));
  try {
    await execFile("/usr/bin/tar", [
      "-xzf", archivePath, "-C", extracted, "--strip-components", "1",
      `node-v${PINNED_NODE_VERSION}-darwin-arm64/bin/node`,
      `node-v${PINNED_NODE_VERSION}-darwin-arm64/LICENSE`,
    ], { env: {}, timeout: 30000 });
    const nodePath = join(extracted, "bin/node");
    const licensePath = join(extracted, "LICENSE");
    const inspected = await inspectNode(nodePath);
    await assertFile(licensePath, "Node license");
    return {
      ...inspected,
      licensePath,
      licenseSha256: await sha256(licensePath),
      cleanup: () => rm(extracted, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(extracted, { recursive: true, force: true });
    throw error;
  }
}

async function resolveNode(config, options) {
  const inspect = options.inspectNode ?? inspectNode;
  if (config.nodePath) {
    await assertFile(config.nodeLicensePath, "Node license");
    return {
      ...(await inspect(config.nodePath)),
      licensePath: config.nodeLicensePath,
      licenseSha256: await sha256(config.nodeLicensePath),
      cleanup: async () => {},
    };
  }
  return (options.downloadPinnedNode ?? downloadPinnedNode)(config.nodeCache);
}

function standaloneAppRelativeRoot(standalone) {
  for (const candidate of ["", join("apps", "web")]) {
    try {
      if (lstatSync(join(standalone, candidate, ".next", "required-server-files.json")).isFile()) {
        return candidate;
      }
    } catch {}
  }
  throw new Error("Next standalone layout is unsupported");
}

async function countTree(root) {
  let files = 0;
  let bytes = 0;
  async function visit(path) {
    const stats = await lstat(path);
    if (stats.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
    } else if (stats.isFile() || stats.isSymbolicLink()) {
      files += 1;
      bytes += stats.size;
    }
  }
  await visit(root);
  return { files, bytes };
}

async function moveTree(source, destination) {
  let destinationStats;
  try { destinationStats = await lstat(destination); } catch {}
  if (!destinationStats) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(source, destination);
    return;
  }
  const sourceStats = await lstat(source);
  if (!sourceStats.isDirectory() || !destinationStats.isDirectory()) {
    throw new Error("Materialized Next dependency collision");
  }
  for (const entry of (await readdir(source)).sort()) {
    await moveTree(join(source, entry), join(destination, entry));
  }
  await rm(source, { recursive: true, force: true });
}

async function relocateMaterializedNext(standaloneRoot, appRoot) {
  const pnpmRoot = join(standaloneRoot, "node_modules", ".pnpm");
  let entries;
  try { entries = await readdir(pnpmRoot); } catch { return; }
  const packages = entries.filter((entry) => entry.startsWith("next@") && !entry.includes("node_modules"));
  if (packages.length !== 1) throw new Error("Materialized Next package layout is ambiguous");
  const packageRoot = join(pnpmRoot, packages[0]);
  const packageModules = join(packageRoot, "node_modules");
  const appModules = join(appRoot, "node_modules");
  await assertDirectory(join(packageModules, "next"), "materialized Next package");
  await assertDirectory(join(appModules, "next"), "materialized app Next package");
  for (const entry of (await readdir(packageModules)).sort()) {
    if (entry === "next") continue;
    await moveTree(join(packageModules, entry), join(appModules, entry));
  }
  await rm(packageRoot, { recursive: true, force: true });
}

async function normalizeStandaloneConfig(appRoot, standaloneRoot) {
  const configPath = join(appRoot, ".next", "required-server-files.json");
  let required;
  try { required = JSON.parse(await readFile(configPath, "utf8")); } catch {
    throw new Error("Next standalone config is invalid");
  }
  if (!required || typeof required !== "object" || Array.isArray(required)) {
    throw new Error("Next standalone config is invalid");
  }
  const relativeRoot = relative(appRoot, standaloneRoot) || ".";
  if ("appDir" in required) required.appDir = ".";
  if (required.config && typeof required.config === "object" && !Array.isArray(required.config)) {
    required.config.outputFileTracingRoot = relativeRoot;
    required.config.repoRoot = relativeRoot;
    if (required.config.turbopack && typeof required.config.turbopack === "object") {
      required.config.turbopack.root = relativeRoot;
    }
  }
  await writeFile(configPath, JSON.stringify(required), { mode: 0o600 });
}

export async function prepareRuntime(options = {}) {
  const config = { ...defaults, ...options };
  await assertFile(config.runtimeEntry, "desktop runtime entry");
  await assertFile(config.checkpointProbe, "desktop checkpoint probe");
  await assertDirectory(config.standalone, "Next standalone output");
  await assertDirectory(config.publicDir, "Next public resources");
  await assertDirectory(config.staticDir, "Next static resources");
  await assertDirectory(config.viewer, "cs2d viewer output");
  const appRelativeRoot = standaloneAppRelativeRoot(config.standalone);
  const node = await resolveNode(config, options);
  await mkdir(config.output, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(config.output, ".prepare-runtime-"));
  const runtimeOutput = join(staging, "resources/runtime-root");
  const standaloneOutput = join(runtimeOutput, "standalone");
  const appOutput = join(standaloneOutput, appRelativeRoot);
  const viewerOutput = join(staging, "resources/viewer-root");
  const binaryOutput = join(staging, `binaries/cs-agent-runtime-${TARGET_TRIPLE}`);
  try {
    await mkdir(runtimeOutput, { recursive: true, mode: 0o700 });
    await copyFile(config.runtimeEntry, join(runtimeOutput, "runtime.cjs"));
    await copyFile(config.checkpointProbe, join(runtimeOutput, "desktop-checkpoint-probe.cjs"));
    await sanitizeCopiedFile(join(runtimeOutput, "runtime.cjs"));
    await sanitizeCopiedFile(join(runtimeOutput, "desktop-checkpoint-probe.cjs"));
    await mkdir(join(runtimeOutput, "third-party"), { recursive: true, mode: 0o700 });
    await copyFile(
      node.licensePath,
      join(runtimeOutput, "third-party", `node-v${PINNED_NODE_VERSION}-LICENSE`),
    );
    await copyTree(config.standalone, standaloneOutput);
    // Tauri resource copying drops pnpm symlinks. Materialize them first, then
    // retain exactly one Next package at the application root and relocate its
    // sibling dependencies there so both Next internals and route chunks use a
    // conventional, symlink-free Node resolution layout.
    await relocateMaterializedNext(standaloneOutput, appOutput);
    await normalizeStandaloneConfig(appOutput, standaloneOutput);
    await rm(join(appOutput, "server.js"), { force: true });
    await rm(join(appOutput, "public"), { recursive: true, force: true });
    await rm(join(appOutput, ".next/static"), { recursive: true, force: true });
    await copyTree(config.publicDir, join(appOutput, "public"));
    await copyTree(config.staticDir, join(appOutput, ".next/static"));
    await copyTree(config.viewer, viewerOutput);
    await mkdir(dirname(binaryOutput), { recursive: true, mode: 0o700 });
    await copyFile(node.path, binaryOutput);
    await chmod(binaryOutput, 0o755);

    const runtimeStats = await countTree(runtimeOutput);
    const viewerStats = await countTree(viewerOutput);
    const nodeBytes = (await lstat(binaryOutput)).size;
    const manifest = {
      schemaVersion: "desktop-runtime-bundle.v1",
      targetTriple: TARGET_TRIPLE,
      nodeVersion: PINNED_NODE_VERSION,
      nodeSha256: node.sha256,
      nodeLicenseSha256: node.licenseSha256,
      standaloneLayout: appRelativeRoot || ".",
      files: runtimeStats.files + viewerStats.files + 1,
      bytes: runtimeStats.bytes + viewerStats.bytes + nodeBytes,
      runtime: runtimeStats,
      viewer: viewerStats,
    };
    await writeFile(
      join(staging, "resources/desktop-runtime-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    for (const relativeTarget of [
      "resources/runtime-root",
      "resources/viewer-root",
      "resources/desktop-runtime-manifest.json",
      "binaries",
    ]) {
      const target = join(config.output, relativeTarget);
      await rm(target, { recursive: true, force: true });
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(join(staging, relativeTarget), target);
    }
    return { manifest };
  } finally {
    await node.cleanup();
    await rm(staging, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const config = {};
  const keys = new Map([
    ["--runtime", "runtimeEntry"], ["--checkpoint-probe", "checkpointProbe"],
    ["--standalone", "standalone"],
    ["--public", "publicDir"], ["--static", "staticDir"], ["--viewer", "viewer"],
    ["--output", "output"], ["--node", "nodePath"], ["--node-license", "nodeLicensePath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys.get(argv[index]);
    if (!key || !argv[index + 1]) throw new Error(`Unknown or incomplete option: ${argv[index]}`);
    config[key] = resolve(argv[++index]);
  }
  return config;
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : "";
  const allowed = [
    /^(?:desktop runtime entry|desktop checkpoint probe|Next standalone output|Next public resources|Next static resources|cs2d viewer output|Node executable|Node license) is missing or invalid$/u,
    /^(?:Bundled resource symlink escapes its source root|Bundled resource symlink cycle detected|Materialized Next dependency collision|Materialized Next package layout is ambiguous|materialized Next package is missing or invalid|materialized app Next package is missing or invalid|Next standalone config is invalid|Node executable version is not pinned|Node executable is not Mach-O arm64|Pinned Node download failed|Pinned Node archive checksum mismatch|Pinned Node extraction or verification failed|Next standalone layout is unsupported)$/u,
    /^Unknown or incomplete option: --[a-z-]+$/u,
  ];
  return allowed.some((pattern) => pattern.test(message)) ? message : "Desktop runtime preparation failed safely";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { manifest } = await prepareRuntime(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } catch (error) {
    process.stderr.write(`prepare-runtime: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
