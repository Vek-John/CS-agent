import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(scriptDir, "../src-tauri/icons");
const source = join(iconsDir, "icon-source.svg");
const work = await mkdtemp(join(tmpdir(), "cs-agent-icons-"));
const iconset = join(work, "AppIcon.iconset");

try {
  await mkdir(iconset, { recursive: true });
  await exec("qlmanage", ["-t", "-s", "1024", "-o", work, source]);
  const preview = join(work, "icon-source.svg.png");
  const iconsetFiles = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of iconsetFiles) {
    await exec("sips", ["-z", String(size), String(size), preview, "--out", join(iconset, name)]);
  }
  await exec("sips", ["-z", "32", "32", preview, "--out", join(iconsDir, "32x32.png")]);
  await exec("sips", ["-z", "128", "128", preview, "--out", join(iconsDir, "128x128.png")]);
  await exec("sips", ["-z", "256", "256", preview, "--out", join(iconsDir, "128x128@2x.png")]);
  await exec("iconutil", ["-c", "icns", iconset, "-o", join(work, "icon.icns")]);
  await rename(join(work, "icon.icns"), join(iconsDir, "icon.icns"));
} catch (error) {
  process.stderr.write(`generate-icons: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
