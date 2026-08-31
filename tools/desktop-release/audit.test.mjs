import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  auditBundle,
  auditPreflight,
  auditRelease,
  auditWorkflow,
  createReleaseManifest,
  DistributionAuditError,
  containsLocalBuildPath,
  REQUIRED_SECRET_NAMES,
  sha256,
  updaterPublicKeyConfigured,
} from "./audit.mjs";

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const approvedRepo = path.join(toolRoot, "fixtures/approved-repo");

function code(error) {
  return error instanceof DistributionAuditError ? error.code : undefined;
}

test("preflight binds desktop version, tag, target pins, rights and explicit approval", async () => {
  const result = await auditPreflight({
    repoRoot: approvedRepo,
    tag: "desktop-v1.2.3",
    approvalPath: path.join(approvedRepo, "rights.json"),
    env: { DESKTOP_DISTRIBUTION_APPROVED: "true" },
  });
  assert.deepEqual(result, { version: "1.2.3", tag: "desktop-v1.2.3", targetTriple: "aarch64-apple-darwin" });
  await assert.rejects(
    auditPreflight({ repoRoot: approvedRepo, tag: "desktop-v1.2.4", approvalPath: path.join(approvedRepo, "rights.json"), env: { DESKTOP_DISTRIBUTION_APPROVED: "true" } }),
    (error) => code(error) === "DESKTOP_TAG_VERSION_MISMATCH",
  );
});

test("preflight fails closed when release secrets are absent", async () => {
  await assert.rejects(
    auditPreflight({
      repoRoot: approvedRepo,
      tag: "desktop-v1.2.3",
      approvalPath: path.join(approvedRepo, "rights.json"),
      env: { DESKTOP_DISTRIBUTION_APPROVED: "true" },
      requireSecrets: true,
    }),
    (error) => code(error) === "RELEASE_SECRETS_MISSING" && REQUIRED_SECRET_NAMES.every((name) => error.message.includes(name)),
  );
});

test("preflight accepts only configured, non-placeholder release secret shapes", async () => {
  const env = {
    DESKTOP_DISTRIBUTION_APPROVED: "true",
    APPLE_CERTIFICATE_BASE64: "A".repeat(120),
    APPLE_CERTIFICATE_PASSWORD: "certificate-password",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Fixture Company (ABCDEFGHIJ)",
    APPLE_ID: "release@example.test",
    APPLE_APP_SPECIFIC_PASSWORD: "app-pass-1234",
    APPLE_TEAM_ID: "ABCDEFGHIJ",
    TAURI_SIGNING_PRIVATE_KEY: "K".repeat(96),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "updater-password",
  };
  const result = await auditPreflight({
    repoRoot: approvedRepo,
    tag: "desktop-v1.2.3",
    approvalPath: path.join(approvedRepo, "rights.json"),
    env,
    requireSecrets: true,
  });
  assert.equal(result.version, "1.2.3");
  await assert.rejects(
    auditPreflight({ repoRoot: approvedRepo, tag: "desktop-v1.2.3", approvalPath: path.join(approvedRepo, "rights.json"), env: { ...env, TAURI_SIGNING_PRIVATE_KEY: "placeholder" }, requireSecrets: true }),
    (error) => code(error) === "RELEASE_SECRETS_MISSING",
  );
});

test("the real repository remains blocked by recorded third-party rights", async () => {
  const repoRoot = path.resolve(toolRoot, "../..");
  await assert.rejects(
    auditPreflight({
      repoRoot,
      tag: "desktop-v0.1.0",
      approvalPath: path.join(repoRoot, "docs/DESKTOP_DISTRIBUTION_AUDIT.json"),
      env: { DESKTOP_DISTRIBUTION_APPROVED: "true" },
    }),
    (error) => code(error) === "THIRD_PARTY_RIGHTS_BLOCKED",
  );
});

test("public updater key gate rejects the explicit local-build placeholder", async () => {
  const repoRoot = path.resolve(toolRoot, "../..");
  const config = JSON.parse(await readFile(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(updaterPublicKeyConfigured(config.plugins.updater.pubkey), false);
  assert.equal(updaterPublicKeyConfigured("INVALID_PUBLIC_KEY_PUBLIC_RELEASE_BLOCKED"), false);
  assert.equal(
    updaterPublicKeyConfigured("dW50cnVzdGVkIGNvbW1lbnQ6IHN5bnRoZXRpYyBmaXh0dXJlIG1pbmlzaWduIHB1YmxpYyBrZXkKUldUTXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpNek16TXpBPT0="),
    true,
  );
});

async function makePreparedFixture(root) {
  const prepared = path.join(root, "prepared");
  const runtimeRoot = path.join(prepared, "resources/runtime-root");
  const viewerRoot = path.join(prepared, "resources/viewer-root");
  const binaryRoot = path.join(prepared, "binaries");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(viewerRoot, { recursive: true });
  await mkdir(binaryRoot, { recursive: true });
  await writeFile(path.join(runtimeRoot, "runtime.cjs"), "module.exports = {}\n");
  await mkdir(path.join(runtimeRoot, "third-party"), { recursive: true });
  const nodeLicensePath = path.join(runtimeRoot, "third-party/node-v24.19.0-LICENSE");
  await writeFile(nodeLicensePath, "Node.js is licensed for use as follows:\nfixture\n");
  await writeFile(path.join(viewerRoot, "index.html"), "<!doctype html>fixture\n");
  const nodePath = path.join(binaryRoot, "cs-agent-runtime-aarch64-apple-darwin");
  await writeFile(nodePath, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]));
  await chmod(nodePath, 0o755);
  const runtimeBytes = (await readFile(path.join(runtimeRoot, "runtime.cjs"))).byteLength;
  const viewerBytes = (await readFile(path.join(viewerRoot, "index.html"))).byteLength;
  const nodeBytes = (await readFile(nodePath)).byteLength;
  await writeFile(path.join(prepared, "resources/desktop-runtime-manifest.json"), JSON.stringify({
    schemaVersion: "desktop-runtime-bundle.v1",
    targetTriple: "aarch64-apple-darwin",
    nodeVersion: "24.19.0",
    nodeSha256: await sha256(nodePath),
    standaloneLayout: "apps/web",
    nodeLicenseSha256: await sha256(nodeLicensePath),
    files: 4,
    bytes: runtimeBytes + (await readFile(nodeLicensePath)).byteLength + viewerBytes + nodeBytes,
    runtime: { files: 2, bytes: runtimeBytes + (await readFile(nodeLicensePath)).byteLength },
    viewer: { files: 1, bytes: viewerBytes },
  }));

  const app = path.join(root, "CS Agent Coach.app");
  await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
  await writeFile(path.join(app, "Contents/Info.plist"), "fixture plist");
  await writeFile(path.join(app, "Contents/MacOS/CS Agent Coach"), "fixture executable");
  await writeFile(path.join(app, "Contents/MacOS/cs-agent-runtime"), "fixture sidecar");
  const notary = path.join(root, "notary.json");
  await writeFile(notary, JSON.stringify({ status: "Accepted", id: "123e4567-e89b-42d3-a456-426614174000" }));
  return { repoRoot: root, prepared, app, notary, nodePath };
}

function fakeMacRunner(version, executable = "CS Agent Coach") {
  return async (command, args) => {
    if (command === "/usr/bin/file") {
      return { stdout: args[1].endsWith(executable) ? "Mach-O 64-bit executable arm64\n" : "ASCII text\n", stderr: "" };
    }
    if (command === "/usr/bin/lipo") return { stdout: "arm64\n", stderr: "" };
    if (args?.[0] === "--version") return { stdout: "v24.19.0\n", stderr: "" };
    if (command === "/usr/libexec/PlistBuddy" && args[1].includes("CFBundleShortVersionString")) return { stdout: `${version}\n`, stderr: "" };
    if (command === "/usr/libexec/PlistBuddy" && args[1].includes("CFBundleExecutable")) return { stdout: `${executable}\n`, stderr: "" };
    if (command === "/usr/bin/codesign" && args[0] === "-dv") {
      return { stdout: "", stderr: "Authority=Developer ID Application: Fixture (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ\nSignature size=9000\n" };
    }
    return { stdout: "", stderr: "" };
  };
}

test("bundle audit verifies manifest totals, arm64, Developer ID and accepted notarization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-audit-bundle-"));
  try {
    const fixture = await makePreparedFixture(root);
    const result = await auditBundle({ ...fixture, preparedRoot: fixture.prepared, appPath: fixture.app, notaryResultPath: fixture.notary, version: "1.2.3", run: fakeMacRunner("1.2.3") });
    assert.equal(result.targetTriple, "aarch64-apple-darwin");
    assert.equal(result.notaryId, "123e4567-e89b-42d3-a456-426614174000");

    await writeFile(path.join(fixture.app, "Contents/MacOS/unexpected-tool"), "must not ship");
    await assert.rejects(
      auditBundle({ ...fixture, preparedRoot: fixture.prepared, appPath: fixture.app, notaryResultPath: fixture.notary, version: "1.2.3", run: fakeMacRunner("1.2.3") }),
      (error) => code(error) === "APP_EXECUTABLE_SET_INVALID",
    );
    await rm(path.join(fixture.app, "Contents/MacOS/unexpected-tool"));

    const signedRunner = fakeMacRunner("1.2.3");
    await assert.rejects(
      auditBundle({
        repoRoot: root,
        preparedRoot: fixture.prepared,
        appPath: fixture.app,
        notaryResultPath: fixture.notary,
        version: "1.2.3",
        run: async (command, args) => command === "/usr/bin/codesign" && args[0] === "-dv"
          ? { stdout: "", stderr: "Authority=Developer ID Application: Fixture (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ\nSignature=adhoc\n" }
          : signedRunner(command, args),
      }),
      (error) => code(error) === "APP_ADHOC_SIGNATURE_REJECTED",
    );

    await writeFile(path.join(fixture.prepared, "resources/runtime-root/.env"), "TOKEN=secret\n");
    await assert.rejects(
      auditBundle({ repoRoot: root, preparedRoot: fixture.prepared, appPath: fixture.app, notaryResultPath: fixture.notary, version: "1.2.3", run: fakeMacRunner("1.2.3") }),
      (error) => ["RUNTIME_MANIFEST_COUNTS_MISMATCH", "SENSITIVE_PATH_BUNDLED"].includes(code(error)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local build-path audit targets the exact repository root, not upstream builder paths", () => {
  const repoRoot = "/Users/release/work/CS-agent";
  assert.equal(containsLocalBuildPath(Buffer.from(`${repoRoot}/apps/web/page.tsx`), repoRoot), true);
  assert.equal(containsLocalBuildPath(Buffer.from("/Users/runner/libvips/source.cc"), repoRoot), false);
});

test("release manifest and final audit bind the updater signature, URL and every hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-audit-release-"));
  try {
    await writeFile(path.join(root, "CS-Agent-Coach_1.2.3_aarch64.dmg"), "signed notarized dmg");
    await writeFile(path.join(root, "CS-Agent-Coach.app.tar.gz"), "signed app archive");
    await writeFile(path.join(root, "CS-Agent-Coach.app.tar.gz.sig"), "A".repeat(96));
    await createReleaseManifest({ releaseDir: root, version: "1.2.3", tag: "desktop-v1.2.3", repoSlug: "fixture/example" });
    const result = await auditRelease({
      releaseDir: root,
      version: "1.2.3",
      tag: "desktop-v1.2.3",
      repoSlug: "fixture/example",
      run: async () => ({ stdout: "", stderr: "" }),
    });
    assert.deepEqual(result.assets, [
      "CS-Agent-Coach.app.tar.gz",
      "CS-Agent-Coach.app.tar.gz.sig",
      "CS-Agent-Coach_1.2.3_aarch64.dmg",
      "SHA256SUMS",
      "latest.json",
    ]);

    await writeFile(path.join(root, "CS-Agent-Coach.app.tar.gz"), "tampered archive");
    await assert.rejects(
      auditRelease({ releaseDir: root, version: "1.2.3", tag: "desktop-v1.2.3", repoSlug: "fixture/example", run: async () => ({ stdout: "", stderr: "" }) }),
      (error) => code(error) === "CHECKSUM_MISMATCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop release workflow keeps triggers, pins, gates and publication order narrow", async () => {
  const repoRoot = path.resolve(toolRoot, "../..");
  assert.deepEqual(await auditWorkflow(path.join(repoRoot, ".github/workflows/desktop-release.yml")), { ok: true });
});

test("workflow audit rejects runner-only context in job-level environment", async () => {
  const repoRoot = path.resolve(toolRoot, "../..");
  const source = await readFile(path.join(repoRoot, ".github/workflows/desktop-release.yml"), "utf8");
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "desktop-workflow-context-"));
  const fixturePath = path.join(fixtureRoot, "desktop-release.yml");
  try {
    await writeFile(
      fixturePath,
      source.replace(
        "RELEASE_COMMIT: ${{ needs.preflight.outputs.commit }}",
        "RELEASE_COMMIT: ${{ needs.preflight.outputs.commit }}\n      RELEASE_DIR: ${{ runner.temp }}/desktop-release-assets",
      ),
    );
    await assert.rejects(
      auditWorkflow(fixturePath),
      (error) => code(error) === "WORKFLOW_RUNNER_CONTEXT_INVALID",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("workflow audit rejects restoring Finder DMG or moving custom DMG after notarization", async () => {
  const repoRoot = path.resolve(toolRoot, "../..");
  const source = await readFile(path.join(repoRoot, ".github/workflows/desktop-release.yml"), "utf8");
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "desktop-workflow-dmg-"));
  const fixturePath = path.join(fixtureRoot, "desktop-release.yml");
  const createLine = "pnpm --dir apps/desktop create:dmg --app \"$APP_PATH\" --output \"$DMG_PATH\"";
  try {
    await writeFile(fixturePath, source.replace("--bundles app", "--bundles dmg"));
    await assert.rejects(
      auditWorkflow(fixturePath),
      (error) => code(error) === "WORKFLOW_STATIC_AUDIT_FAILED" || code(error) === "WORKFLOW_FINDER_DMG_FORBIDDEN",
    );

    const reordered = source
      .replace(createLine, "true # custom DMG deliberately moved")
      .replace("xcrun notarytool submit \"$DMG_PATH\"", `xcrun notarytool submit \"$DMG_PATH\"\n          ${createLine}`);
    await writeFile(fixturePath, reordered);
    await assert.rejects(
      auditWorkflow(fixturePath),
      (error) => code(error) === "WORKFLOW_DMG_ORDER_INVALID",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
