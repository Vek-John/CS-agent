#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const repoRoot = resolve(desktopRoot, "../..");
const TARGET_TRIPLE = "aarch64-apple-darwin";
const PRODUCT_NAME = "CS Agent Coach";
const canonicalDmgDirectory = join(desktopRoot, "src-tauri", "target", TARGET_TRIPLE, "release", "bundle", "dmg");

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolveRun();
      else reject(new Error(`${basename(command)} failed code=${String(code)} signal=${String(signal)}`));
    });
  });
}

export function parseDmgArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("DMG_ARGUMENT_INVALID");
    if (!new Set(["--app", "--output", "--volume-name"]).has(key)) throw new Error("DMG_ARGUMENT_INVALID");
    if (Object.hasOwn(values, key)) throw new Error("DMG_ARGUMENT_DUPLICATE");
    values[key] = value;
  }
  return values;
}

export async function resolveDmgPlan(argv) {
  const args = parseDmgArguments(argv);
  const desktopPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(desktopPackage.version)) {
    throw new Error("DMG_VERSION_INVALID");
  }
  const bundleRoot = join(desktopRoot, "src-tauri", "target", TARGET_TRIPLE, "release", "bundle");
  const expectedAppPath = join(bundleRoot, "macos", `${PRODUCT_NAME}.app`);
  const expectedOutputPath = join(canonicalDmgDirectory, `${PRODUCT_NAME}_${desktopPackage.version}_aarch64.dmg`);
  // pnpm --dir changes the child cwd. CLI paths remain repository-relative so
  // the local command and GitHub workflow resolve the same artifact identity.
  const appPath = args["--app"]
    ? resolve(repoRoot, args["--app"])
    : expectedAppPath;
  const outputPath = args["--output"]
    ? resolve(repoRoot, args["--output"])
    : expectedOutputPath;
  const volumeName = args["--volume-name"] ?? PRODUCT_NAME;
  if (extname(appPath) !== ".app"
    || extname(outputPath) !== ".dmg"
    || appPath !== expectedAppPath
    || outputPath !== expectedOutputPath) throw new Error("DMG_PATH_INVALID");
  if (volumeName !== PRODUCT_NAME) throw new Error("DMG_VOLUME_NAME_INVALID");
  return { appPath, outputPath, volumeName, version: desktopPackage.version };
}

async function requireDirectory(path, code) {
  const stats = await lstat(path).catch(() => undefined);
  if (!stats?.isDirectory()) throw new Error(code);
}

async function pathExists(path) {
  return Boolean(await lstat(path).catch(() => undefined));
}

export async function createDmg(plan, execute = run) {
  if (process.platform !== "darwin") throw new Error("DMG_DARWIN_REQUIRED");
  await requireDirectory(plan.appPath, "DMG_APP_MISSING");
  await requireDirectory(join(plan.appPath, "Contents"), "DMG_APP_INVALID");
  await mkdir(dirname(plan.outputPath), { recursive: true });

  const temporaryRoot = await mkdtemp(join(tmpdir(), "cs-agent-dmg-"));
  const stagingRoot = join(temporaryRoot, "staging");
  const stagedApp = join(stagingRoot, `${PRODUCT_NAME}.app`);
  const partialPath = join(dirname(plan.outputPath), `.${basename(plan.outputPath)}.${process.pid}.${randomUUID()}.partial.dmg`);
  const previousPath = join(dirname(plan.outputPath), `.${basename(plan.outputPath)}.${process.pid}.${randomUUID()}.previous`);
  let previousSaved = false;
  try {
    await mkdir(stagingRoot, { mode: 0o700 });
    await execute("/usr/bin/ditto", [plan.appPath, stagedApp]);
    await symlink("/Applications", join(stagingRoot, "Applications"));
    await writeFile(join(stagingRoot, ".metadata_never_index"), "", { mode: 0o600 });
    await execute("/usr/bin/hdiutil", [
      "create",
      "-volname", plan.volumeName,
      "-srcfolder", stagingRoot,
      "-format", "UDZO",
      partialPath,
    ]);
    await execute("/usr/bin/hdiutil", ["verify", partialPath]);

    if (await pathExists(plan.outputPath)) {
      await rename(plan.outputPath, previousPath);
      previousSaved = true;
    }
    await rename(partialPath, plan.outputPath);
    try {
      await execute("/usr/bin/hdiutil", ["verify", plan.outputPath]);
    } catch (error) {
      await rm(plan.outputPath, { force: true });
      if (previousSaved) await rename(previousPath, plan.outputPath);
      previousSaved = false;
      throw error;
    }
    if (previousSaved) await rm(previousPath, { force: true });
    previousSaved = false;
    if (dirname(plan.outputPath) === canonicalDmgDirectory) {
      // A repository may already contain ignored output from Tauri's former
      // Finder-based generator. Remove only its two exact generated siblings.
      await Promise.all([
        rm(join(canonicalDmgDirectory, "bundle_dmg.sh"), { force: true }),
        rm(join(canonicalDmgDirectory, "icon.icns"), { force: true }),
      ]);
    }
    const bytes = (await lstat(plan.outputPath)).size;
    return { ...plan, bytes };
  } finally {
    await rm(partialPath, { force: true }).catch(() => undefined);
    if (previousSaved && !(await pathExists(plan.outputPath))) {
      try {
        await rename(previousPath, plan.outputPath);
        previousSaved = false;
      } catch {
        // Preserve the previous image at its explicit recovery path. Deleting
        // it here would turn a packaging failure into data loss.
      }
    }
    if (!previousSaved) await rm(previousPath, { force: true }).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const plan = await resolveDmgPlan(process.argv.slice(2));
  const result = await createDmg(plan);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    targetTriple: TARGET_TRIPLE,
    version: result.version,
    output: result.outputPath,
    bytes: result.bytes,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`desktop:dmg ${error instanceof Error ? error.message : "DMG_FAILED"}\n`);
    process.exitCode = 1;
  });
}

export const DMG_BUILD_CONSTANTS = Object.freeze({ repoRoot, desktopRoot, targetTriple: TARGET_TRIPLE, productName: PRODUCT_NAME });
