import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { createDmg, DMG_BUILD_CONSTANTS, parseDmgArguments, resolveDmgPlan } from "./create-dmg.mjs";

test("Finder-free DMG plan is pinned to the Apple Silicon product and package version", async () => {
  const plan = await resolveDmgPlan([]);
  assert.equal(plan.version, "0.1.0");
  assert.equal(plan.volumeName, "CS Agent Coach");
  assert.match(plan.appPath, /target\/aarch64-apple-darwin\/release\/bundle\/macos\/CS Agent Coach\.app$/u);
  assert.match(plan.outputPath, /target\/aarch64-apple-darwin\/release\/bundle\/dmg\/CS Agent Coach_0\.1\.0_aarch64\.dmg$/u);
  assert.equal(DMG_BUILD_CONSTANTS.targetTriple, "aarch64-apple-darwin");
});

test("workflow-shaped relative paths resolve from the repository rather than pnpm --dir cwd", async () => {
  const plan = await resolveDmgPlan([
    "--app", "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/CS Agent Coach.app",
    "--output", "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/CS Agent Coach_0.1.0_aarch64.dmg",
  ]);
  assert.equal(plan.appPath, join(DMG_BUILD_CONSTANTS.repoRoot, "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/CS Agent Coach.app"));
  assert.equal(plan.outputPath, join(DMG_BUILD_CONSTANTS.repoRoot, "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/CS Agent Coach_0.1.0_aarch64.dmg"));
});

test("DMG CLI cannot replace an arbitrary app or image path", async () => {
  await assert.rejects(
    resolveDmgPlan(["--output", "/tmp/not-the-release-artifact.dmg"]),
    /DMG_PATH_INVALID/u,
  );
  await assert.rejects(
    resolveDmgPlan(["--app", "/tmp/not-the-release-app.app"]),
    /DMG_PATH_INVALID/u,
  );
});

test("DMG CLI rejects unknown, duplicated and truncated arguments", () => {
  assert.throws(() => parseDmgArguments(["--unknown", "value"]), /DMG_ARGUMENT_INVALID/u);
  assert.throws(() => parseDmgArguments(["--app"]), /DMG_ARGUMENT_INVALID/u);
  assert.throws(() => parseDmgArguments(["--app", "one", "--app", "two"]), /DMG_ARGUMENT_DUPLICATE/u);
});

test("DMG builder has no Finder or AppleScript lifecycle dependency", async () => {
  const source = await readFile(new URL("./create-dmg.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /osascript|tell application|Finder\.app/iu);
  assert.match(source, /\/usr\/bin\/ditto/u);
  assert.match(source, /\/usr\/bin\/hdiutil/u);
});

test("final verification failure restores the previous image and cleans staging artifacts", {
  skip: process.platform !== "darwin",
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "cs-agent-dmg-test-"));
  const appPath = join(fixtureRoot, "input", "CS Agent Coach.app");
  const outputPath = join(fixtureRoot, "output", "CS Agent Coach_0.1.0_aarch64.dmg");
  await mkdir(join(appPath, "Contents"), { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(join(appPath, "Contents", "Info.plist"), "fixture");
  await writeFile(outputPath, "previous-image");
  const execute = async (command, args) => {
    if (command === "/usr/bin/ditto") {
      await cp(args[0], args[1], { recursive: true });
      return;
    }
    assert.equal(command, "/usr/bin/hdiutil");
    if (args[0] === "create") {
      const sourceIndex = args.indexOf("-srcfolder") + 1;
      const stagingRoot = args[sourceIndex];
      assert.equal((await lstat(join(stagingRoot, "Applications"))).isSymbolicLink(), true);
      assert.equal(await readlink(join(stagingRoot, "Applications")), "/Applications");
      assert.equal((await lstat(join(stagingRoot, "CS Agent Coach.app", "Contents"))).isDirectory(), true);
      await writeFile(args.at(-1), "new-image");
      return;
    }
    assert.equal(args[0], "verify");
    if (!basename(args[1]).includes(".partial.dmg")) throw new Error("injected final verify failure");
  };
  try {
    await assert.rejects(
      createDmg({ appPath, outputPath, volumeName: "CS Agent Coach", version: "0.1.0" }, execute),
      /injected final verify failure/u,
    );
    assert.equal(await readFile(outputPath, "utf8"), "previous-image");
    assert.deepEqual((await readdir(dirname(outputPath))).sort(), [basename(outputPath)]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
