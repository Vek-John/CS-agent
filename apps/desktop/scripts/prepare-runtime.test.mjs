import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NODE_ARCHIVE_SHA256, TARGET_TRIPLE, prepareRuntime,
  sanitizeBuildPathPrefixes, sanitizeExactBuildRoot,
} from "./prepare-runtime.mjs";

test("sanitizes user-specific build roots without changing binary length", () => {
  const input = Buffer.from("\0/Users/alice/project\0/home/ci/source\0", "utf8");
  const sanitized = sanitizeBuildPathPrefixes(input);
  assert.equal(sanitized.replacements, 1);
  assert.equal(sanitized.bytes.length, input.length);
  assert.equal(sanitized.bytes.includes(Buffer.from("/Users/")), false);
  assert.equal(sanitized.bytes.includes(Buffer.from("/home/ci/source")), true);
  assert.equal(sanitized.bytes.includes(Buffer.from("/build/")), true);
});

test("removes the exact Unicode repository root without changing binary length", () => {
  const root = "/Users/alice/编程/CS-agent";
  const input = Buffer.from(`before\0${root}/apps/web/page.tsx\0after`, "utf8");
  const sanitized = sanitizeExactBuildRoot(input, root);
  assert.equal(sanitized.replacements, 1);
  assert.equal(sanitized.bytes.length, input.length);
  assert.equal(sanitized.bytes.includes(Buffer.from(root)), false);
  assert.equal(sanitized.bytes.includes(Buffer.from("/build/")), true);
});

async function fixture(layout) {
  const root = await mkdtemp(join(tmpdir(), "cs-agent-prepare-"));
  const paths = {
    root,
    runtimeEntry: join(root, "input/desktop-runtime.cjs"),
    checkpointProbe: join(root, "input/desktop-checkpoint-probe.cjs"),
    standalone: join(root, "input/standalone"),
    publicDir: join(root, "input/public"),
    staticDir: join(root, "input/static"),
    viewer: join(root, "input/viewer"),
    nodePath: join(root, "input/node"),
    nodeLicensePath: join(root, "input/node-LICENSE"),
    output: join(root, "output"),
  };
  const appRoot = layout === "monorepo" ? join(paths.standalone, "apps/web") : paths.standalone;
  for (const directory of [
    join(appRoot, ".next"), paths.publicDir, paths.staticDir, paths.viewer,
  ]) await mkdir(directory, { recursive: true });
  await writeFile(paths.runtimeEntry, "runtime");
  await writeFile(paths.checkpointProbe, "checkpoint");
  await writeFile(paths.nodePath, "node");
  await writeFile(paths.nodeLicensePath, "Node.js is licensed for use as follows:\nfixture\n");
  await writeFile(join(appRoot, "server.js"), "unused stock server");
  await writeFile(join(appRoot, "traced.js"), "traced");
  await symlink("traced.js", join(appRoot, "traced-link.js"));
  await writeFile(join(appRoot, ".next/required-server-files.json"), JSON.stringify({
    appDir: appRoot,
    relativeAppDir: layout === "monorepo" ? "apps/web" : ".",
    config: {
      outputFileTracingRoot: paths.root,
      repoRoot: paths.root,
      turbopack: { root: paths.root },
    },
  }));
  await writeFile(join(appRoot, ".env.production"), "SECRET=bad");
  await writeFile(join(appRoot, "server.test.js"), "test-source");
  await mkdir(join(appRoot, "node_modules/next/dist/docs"), { recursive: true });
  await writeFile(
    join(appRoot, "node_modules/next/dist/docs/environment.md"),
    "-----BEGIN RSA PRIVATE KEY-----\nplaceholder documentation only",
  );
  await mkdir(join(paths.publicDir, "generated-data"), { recursive: true });
  await writeFile(join(paths.publicDir, "generated-data/private.json"), "private");
  await writeFile(join(paths.publicDir, "safe.svg"), "safe");
  await writeFile(join(paths.staticDir, "chunk.js"), "static");
  await mkdir(join(paths.viewer, "replays"), { recursive: true });
  await writeFile(join(paths.viewer, "replays/sample.dem"), "demo");
  await writeFile(join(paths.viewer, "index.html"), "viewer");
  return { paths, appRelative: layout === "monorepo" ? "apps/web" : "" };
}

for (const layout of ["monorepo", "flat"]) {
  test(`places public and static inside ${layout} standalone app root`, async (context) => {
    const { paths, appRelative } = await fixture(layout);
    context.after(() => rm(paths.root, { recursive: true, force: true }));
    let inspectedNode;
    const { manifest } = await prepareRuntime({
      ...paths,
      inspectNode: async (path) => {
        inspectedNode = path;
        return { path, sha256: "1".repeat(64) };
      },
    });
    const runtimeRoot = join(paths.output, "resources/runtime-root");
    const appRoot = join(runtimeRoot, "standalone", appRelative);
    assert.equal(inspectedNode, paths.nodePath);
    assert.equal(await readFile(join(runtimeRoot, "runtime.cjs"), "utf8"), "runtime");
    assert.equal(
      await readFile(join(runtimeRoot, "desktop-checkpoint-probe.cjs"), "utf8"),
      "checkpoint",
    );
    await assert.rejects(stat(join(appRoot, "server.js")));
    assert.equal(await readFile(join(appRoot, "traced.js"), "utf8"), "traced");
    assert.equal(await readFile(join(appRoot, "traced-link.js"), "utf8"), "traced");
    assert.equal((await lstat(join(appRoot, "traced-link.js"))).isSymbolicLink(), false);
    const required = JSON.parse(await readFile(join(appRoot, ".next/required-server-files.json"), "utf8"));
    assert.equal(required.appDir, ".");
    assert.equal(required.config.outputFileTracingRoot, appRelative ? "../.." : ".");
    assert.equal(required.config.repoRoot, appRelative ? "../.." : ".");
    assert.equal(required.config.turbopack.root, appRelative ? "../.." : ".");
    assert.equal(JSON.stringify(required).includes(paths.root), false);
    assert.equal(await readFile(join(appRoot, "public/safe.svg"), "utf8"), "safe");
    assert.equal(await readFile(join(appRoot, ".next/static/chunk.js"), "utf8"), "static");
    await assert.rejects(stat(join(runtimeRoot, "public")));
    await assert.rejects(stat(join(runtimeRoot, ".next")));
    await assert.rejects(stat(join(appRoot, ".env.production")));
    await assert.rejects(stat(join(appRoot, "server.test.js")));
    await assert.rejects(stat(join(appRoot, "node_modules/next/dist/docs")));
    await assert.rejects(stat(join(appRoot, "public/generated-data")));
    await assert.rejects(stat(join(paths.output, "resources/viewer-root/replays")));
    const saved = JSON.parse(await readFile(
      join(paths.output, "resources/desktop-runtime-manifest.json"), "utf8"));
    assert.deepEqual(saved, manifest);
    assert.equal(saved.nodeSha256, "1".repeat(64));
    assert.match(saved.nodeLicenseSha256, /^[a-f0-9]{64}$/u);
    assert.equal(saved.standaloneLayout, appRelative || ".");
    assert.equal(Number.isInteger(saved.files) && saved.files > 0, true);
    assert.equal(Number.isInteger(saved.bytes) && saved.bytes > 0, true);
    assert.equal(Number.isInteger(saved.runtime.files), true);
    assert.equal(saved.runtime.files, 8);
    assert.match(
      await readFile(join(runtimeRoot, "third-party/node-v24.19.0-LICENSE"), "utf8"),
      /Node\.js is licensed/u,
    );
    assert.equal(Number.isInteger(saved.runtime.bytes), true);
    assert.equal(JSON.stringify(saved).includes(paths.root), false);
    assert.equal(
      (await stat(join(paths.output, `binaries/cs-agent-runtime-${TARGET_TRIPLE}`))).mode & 0o111,
      0o111,
    );
  });
}

test("falls back to the pinned downloader when the process Node is not pinned", async (context) => {
  const { paths } = await fixture("flat");
  context.after(() => rm(paths.root, { recursive: true, force: true }));
  delete paths.nodePath;
  delete paths.nodeLicensePath;
  let downloaded = false;
  await prepareRuntime({
    ...paths,
    downloadPinnedNode: async () => {
      downloaded = true;
      return {
        path: join(paths.root, "input/node"),
        sha256: "2".repeat(64),
        licensePath: join(paths.root, "input/node-LICENSE"),
        licenseSha256: "3".repeat(64),
        cleanup: async () => {},
      };
    },
  });
  assert.equal(downloaded, true);
});

test("pins the official Node 24.19.0 darwin-arm64 archive checksum", () => {
  assert.equal(
    NODE_ARCHIVE_SHA256,
    "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
  );
});

test("rejects unsupported standalone layouts", async (context) => {
  const { paths } = await fixture("flat");
  context.after(() => rm(paths.root, { recursive: true, force: true }));
  await rm(join(paths.standalone, ".next/required-server-files.json"));
  await assert.rejects(
    prepareRuntime({ ...paths, inspectNode: async (path) => ({ path, sha256: "3".repeat(64) }) }),
    /standalone layout is unsupported/,
  );
});

test("fails closed when the production checkpoint probe is missing", async (context) => {
  const { paths } = await fixture("flat");
  context.after(() => rm(paths.root, { recursive: true, force: true }));
  await rm(paths.checkpointProbe);
  await assert.rejects(
    prepareRuntime({ ...paths, inspectNode: async (path) => ({ path, sha256: "4".repeat(64) }) }),
    /checkpoint probe is missing or invalid/,
  );
});
