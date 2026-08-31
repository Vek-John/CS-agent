#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const RELEASE_PINS = Object.freeze({
  targetTriple: "aarch64-apple-darwin",
  nodeVersion: "24.19.0",
  pnpmVersion: "11.16.0",
  rustVersion: "1.89.0",
  tauriVersion: "2.11.5",
  runner: "macos-15",
});

export const REQUIRED_SECRET_NAMES = Object.freeze([
  "APPLE_CERTIFICATE_BASE64",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]);

const MAX_BUNDLE_BYTES = 450 * 1024 * 1024;
const MAX_TEXT_AUDIT_BYTES = 1024 * 1024;
const MAX_BUILD_PATH_AUDIT_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SENSITIVE_EXTENSIONS = new Set([".dem", ".db", ".sqlite", ".sqlite3", ".p12", ".p8", ".mobileprovision"]);
const SENSITIVE_SEGMENTS = new Set([".git", ".local-data", "generated-data", "fixtures", "demos", "replays", "logs"]);
const PRIVATE_MATERIAL = [
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u,
  /TAURI_SIGNING_PRIVATE_KEY\s*=/u,
  /APPLE_(?:PASSWORD|APP_SPECIFIC_PASSWORD)\s*=/u,
];

export class DistributionAuditError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
    this.name = "DistributionAuditError";
  }
}

function assert(condition, code, message = code) {
  if (!condition) throw new DistributionAuditError(code, message);
}

function exactKeys(value, keys, code) {
  assert(value && typeof value === "object" && !Array.isArray(value), code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(actual.length === expected.length && actual.every((key, index) => key === expected[index]), code);
}

async function json(path, code) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new DistributionAuditError(code);
  }
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function requireFile(path, code) {
  try {
    assert((await lstat(path)).isFile(), code);
  } catch (error) {
    if (error instanceof DistributionAuditError) throw error;
    throw new DistributionAuditError(code);
  }
}

async function requireDirectory(path, code) {
  try {
    assert((await lstat(path)).isDirectory(), code);
  } catch (error) {
    if (error instanceof DistributionAuditError) throw error;
    throw new DistributionAuditError(code);
  }
}

function safeRelative(root, path) {
  const value = relative(root, path);
  assert(value !== ".." && !value.startsWith(`..${sep}`), "PATH_ESCAPE");
  return value;
}

async function walk(root) {
  const canonicalRoot = await realpath(root);
  const files = [];
  async function visit(path) {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      const target = await realpath(path);
      assert(target === canonicalRoot || target.startsWith(`${canonicalRoot}${sep}`), "BUNDLE_SYMLINK_ESCAPE");
      files.push({ path, relativePath: safeRelative(root, path), bytes: stats.size, symbolicLink: true });
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
      return;
    }
    if (stats.isFile()) files.push({ path, relativePath: safeRelative(root, path), bytes: stats.size });
  }
  await visit(root);
  return files;
}

function auditSensitivePath(relativePath) {
  const segments = relativePath.split(/[\\/]/u).filter(Boolean).map((value) => value.toLowerCase());
  assert(!segments.some((segment) => SENSITIVE_SEGMENTS.has(segment)), "SENSITIVE_PATH_BUNDLED");
  const name = segments.at(-1) ?? "";
  assert(name !== ".env" && !name.startsWith(".env."), "SENSITIVE_PATH_BUNDLED");
  assert(!SENSITIVE_EXTENSIONS.has(extname(name)), "SENSITIVE_PATH_BUNDLED");
  assert(!/\.(?:test|spec)\.[^.]+$/u.test(name), "TEST_SOURCE_BUNDLED");
}

export function containsLocalBuildPath(buffer, repoRoot) {
  return buffer.includes(Buffer.from(`${resolve(repoRoot)}${sep}`));
}

async function auditPrivateMaterial(file, repoRoot) {
  if (file.symbolicLink) return;
  if (file.bytes <= MAX_BUILD_PATH_AUDIT_BYTES) {
    const buffer = await readFile(file.path);
    assert(!containsLocalBuildPath(buffer, repoRoot), "LOCAL_BUILD_PATH_BUNDLED");
  }
  if (file.bytes > MAX_TEXT_AUDIT_BYTES) return;
  const buffer = await readFile(file.path);
  if (buffer.includes(0)) return;
  const text = buffer.toString("utf8");
  assert(!PRIVATE_MATERIAL.some((pattern) => pattern.test(text)), "PRIVATE_MATERIAL_BUNDLED");
}

function validateVersionAndTag(version, tag) {
  assert(SEMVER.test(version), "DESKTOP_VERSION_INVALID");
  assert(tag === `desktop-v${version}`, "DESKTOP_TAG_VERSION_MISMATCH");
}

export function updaterPublicKeyConfigured(value) {
  if (typeof value !== "string"
    || value === "INVALID_PUBLIC_KEY_PUBLIC_RELEASE_BLOCKED"
    || value.length < 80
    || value.length > 4096
    || /[\r\n]/u.test(value)
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  let decoded;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return false;
  }
  const lines = decoded.trim().split("\n");
  return lines.length === 2
    && lines[0].startsWith("untrusted comment:")
    && /^RW[A-Za-z0-9+/]{40,}={0,2}$/u.test(lines[1]);
}

function validateRightsApproval(approval) {
  exactKeys(approval, ["schemaVersion", "publicReleaseApproved", "reviewedAt", "reviewer", "cs2d", "valveAssets"], "RIGHTS_AUDIT_SCHEMA_INVALID");
  assert(approval.schemaVersion === "desktop-distribution-audit.v1", "RIGHTS_AUDIT_SCHEMA_INVALID");
  assert(approval.publicReleaseApproved === true, "RIGHTS_NOT_APPROVED");
  assert(typeof approval.reviewer === "string" && approval.reviewer.length >= 3 && approval.reviewer.length <= 160, "RIGHTS_REVIEWER_INVALID");
  assert(Number.isFinite(Date.parse(approval.reviewedAt)), "RIGHTS_REVIEW_DATE_INVALID");
  for (const record of [approval.cs2d, approval.valveAssets]) {
    exactKeys(record, ["status", "evidence"], "RIGHTS_AUDIT_SCHEMA_INVALID");
    assert(record.status === "APPROVED_FOR_PUBLIC_REDISTRIBUTION", "RIGHTS_NOT_APPROVED");
    const evidence = new URL(record.evidence);
    assert(evidence.protocol === "https:" && !evidence.username && !evidence.password && !evidence.hash, "RIGHTS_EVIDENCE_INVALID");
  }
}

function secretConfigured(name, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 100_000 || /[\u0000\r\n]/u.test(value)) return false;
  if (/^(?:changeme|placeholder|todo|unset|example)$/iu.test(value) || value.includes("${{")) return false;
  if (name === "APPLE_CERTIFICATE_BASE64") return value.length >= 100 && /^[A-Za-z0-9+/=]+$/u.test(value);
  if (name === "APPLE_SIGNING_IDENTITY") return /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u.test(value);
  if (name === "APPLE_ID") return /^[^@\s]+@[^@\s]+$/u.test(value);
  if (name === "APPLE_APP_SPECIFIC_PASSWORD") return value.length >= 8;
  if (name === "APPLE_TEAM_ID") return /^[A-Z0-9]{10}$/u.test(value);
  if (name === "TAURI_SIGNING_PRIVATE_KEY") return value.length >= 40;
  return true;
}

export async function auditPreflight({ repoRoot, tag, approvalPath, env = process.env, requireSecrets = false }) {
  const root = resolve(repoRoot);
  const desktopPackage = await json(join(root, "apps/desktop/package.json"), "DESKTOP_PACKAGE_INVALID");
  validateVersionAndTag(desktopPackage.version, tag);

  const tauriConfig = await json(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "TAURI_CONFIG_INVALID");
  assert(tauriConfig.version === "../package.json", "DESKTOP_VERSION_SOURCE_DIVERGED");
  assert(tauriConfig.bundle?.targets?.length === 2
    && tauriConfig.bundle.targets.includes("app")
    && tauriConfig.bundle.targets.includes("dmg"), "TAURI_TARGETS_INVALID");

  const prepareSource = await readFile(join(root, "apps/desktop/scripts/prepare-runtime.mjs"), "utf8");
  assert(prepareSource.includes(`TARGET_TRIPLE = "${RELEASE_PINS.targetTriple}"`), "TARGET_TRIPLE_PIN_MISMATCH");
  assert(prepareSource.includes(`PINNED_NODE_VERSION = "${RELEASE_PINS.nodeVersion}"`), "NODE_PIN_MISMATCH");

  const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert(!/(?:did not contain a `LICENSE`|not approved for public redistribution|LOCALHOST_ONLY|REVIEW_REQUIRED|distribution review pending)/iu.test(notices), "THIRD_PARTY_RIGHTS_BLOCKED");
  const licensePath = join(root, "LICENSE");
  await requireFile(licensePath, "PROJECT_LICENSE_MISSING");
  assert(/MIT License/u.test(await readFile(licensePath, "utf8")), "PROJECT_LICENSE_INVALID");
  validateRightsApproval(await json(resolve(approvalPath), "RIGHTS_AUDIT_INVALID"));
  assert(env.DESKTOP_DISTRIBUTION_APPROVED === "true", "RIGHTS_ENV_APPROVAL_MISSING");

  const updater = tauriConfig.plugins?.updater;
  assert(updater?.endpoints?.length === 1
    && updater.endpoints[0] === "https://github.com/Vek-John/CS-agent/releases/latest/download/latest.json", "UPDATER_ENDPOINT_INVALID");
  assert(updaterPublicKeyConfigured(updater.pubkey), "INVALID_PUBLIC_KEY_PUBLIC_RELEASE_BLOCKED");

  if (requireSecrets) {
    const missing = REQUIRED_SECRET_NAMES.filter((name) => !secretConfigured(name, env[name]));
    assert(missing.length === 0, "RELEASE_SECRETS_MISSING", `RELEASE_SECRETS_MISSING:${missing.join(",")}`);
  }

  return { version: desktopPackage.version, tag, targetTriple: RELEASE_PINS.targetTriple };
}

async function treeStats(root) {
  const files = await walk(root);
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), entries: files };
}

async function defaultRun(command, args) {
  return execFile(command, args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 30_000 });
}

function parsePlistValue(output) {
  return String(output.stdout ?? output).trim();
}

export async function auditBundle({ repoRoot, preparedRoot, appPath, notaryResultPath, version, run = defaultRun }) {
  validateVersionAndTag(version, `desktop-v${version}`);
  const sourceRoot = resolve(repoRoot);
  await requireDirectory(sourceRoot, "REPOSITORY_ROOT_MISSING");
  const root = resolve(preparedRoot);
  await requireDirectory(root, "PREPARED_BUNDLE_MISSING");
  const manifestPath = join(root, "resources/desktop-runtime-manifest.json");
  const manifest = await json(manifestPath, "RUNTIME_MANIFEST_INVALID");
  exactKeys(manifest, ["schemaVersion", "targetTriple", "nodeVersion", "nodeSha256", "nodeLicenseSha256", "standaloneLayout", "files", "bytes", "runtime", "viewer"], "RUNTIME_MANIFEST_SCHEMA_INVALID");
  exactKeys(manifest.runtime, ["files", "bytes"], "RUNTIME_MANIFEST_SCHEMA_INVALID");
  exactKeys(manifest.viewer, ["files", "bytes"], "RUNTIME_MANIFEST_SCHEMA_INVALID");
  assert(manifest.schemaVersion === "desktop-runtime-bundle.v1", "RUNTIME_MANIFEST_SCHEMA_INVALID");
  assert(manifest.targetTriple === RELEASE_PINS.targetTriple, "RUNTIME_TARGET_INVALID");
  assert(manifest.nodeVersion === RELEASE_PINS.nodeVersion, "RUNTIME_NODE_VERSION_INVALID");
  assert(Number.isInteger(manifest.files) && manifest.files > 0, "RUNTIME_MANIFEST_COUNTS_INVALID");
  assert(Number.isInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= MAX_BUNDLE_BYTES, "RUNTIME_BUNDLE_SIZE_INVALID");
  assert(SHA256.test(manifest.nodeSha256), "RUNTIME_NODE_HASH_INVALID");
  assert(SHA256.test(manifest.nodeLicenseSha256), "RUNTIME_NODE_LICENSE_HASH_INVALID");

  const runtime = await treeStats(join(root, "resources/runtime-root"));
  const viewer = await treeStats(join(root, "resources/viewer-root"));
  const resourceEntries = (await readdir(join(root, "resources"))).sort();
  assert(resourceEntries.length === 3
    && resourceEntries[0] === "desktop-runtime-manifest.json"
    && resourceEntries[1] === "runtime-root"
    && resourceEntries[2] === "viewer-root", "RUNTIME_RESOURCE_SET_INVALID");
  const binaries = await treeStats(join(root, "binaries"));
  const nodePath = join(root, `binaries/cs-agent-runtime-${RELEASE_PINS.targetTriple}`);
  const nodeLicensePath = join(root, `resources/runtime-root/third-party/node-v${RELEASE_PINS.nodeVersion}-LICENSE`);
  await requireFile(nodePath, "RUNTIME_NODE_MISSING");
  await requireFile(nodeLicensePath, "RUNTIME_NODE_LICENSE_MISSING");
  const nodeStat = await lstat(nodePath);
  assert(binaries.files === 1 && binaries.entries[0]?.path === nodePath, "RUNTIME_BINARY_SET_INVALID");
  assert((nodeStat.mode & 0o111) !== 0, "RUNTIME_NODE_NOT_EXECUTABLE");
  assert(runtime.files === manifest.runtime?.files && runtime.bytes === manifest.runtime?.bytes, "RUNTIME_MANIFEST_COUNTS_MISMATCH");
  assert(viewer.files === manifest.viewer?.files && viewer.bytes === manifest.viewer?.bytes, "VIEWER_MANIFEST_COUNTS_MISMATCH");
  assert(manifest.files === runtime.files + viewer.files + 1 && manifest.bytes === runtime.bytes + viewer.bytes + nodeStat.size, "RUNTIME_MANIFEST_TOTAL_MISMATCH");
  assert(await sha256(nodePath) === manifest.nodeSha256, "RUNTIME_NODE_HASH_MISMATCH");
  assert(await sha256(nodeLicensePath) === manifest.nodeLicenseSha256, "RUNTIME_NODE_LICENSE_HASH_MISMATCH");
  assert((await readFile(nodeLicensePath, "utf8")).startsWith("Node.js is licensed for use as follows:"), "RUNTIME_NODE_LICENSE_INVALID");

  const allFiles = [...runtime.entries, ...viewer.entries, ...binaries.entries];
  for (const file of allFiles) {
    auditSensitivePath(file.relativePath);
    await auditPrivateMaterial(file, sourceRoot);
  }
  await auditPrivateMaterial({ path: manifestPath, relativePath: relative(root, manifestPath), bytes: (await lstat(manifestPath)).size }, sourceRoot);

  const nodeArch = await run("/usr/bin/lipo", ["-archs", nodePath]);
  assert(parsePlistValue(nodeArch) === "arm64", "RUNTIME_NODE_ARCH_INVALID");
  const nodeVersion = await run(nodePath, ["--version"]);
  assert(parsePlistValue(nodeVersion) === `v${RELEASE_PINS.nodeVersion}`, "RUNTIME_NODE_VERSION_INVALID");

  const app = resolve(appPath);
  await requireDirectory(app, "APP_BUNDLE_MISSING");
  const info = join(app, "Contents/Info.plist");
  await requireFile(info, "APP_INFO_PLIST_MISSING");
  const appVersion = await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", info]);
  assert(parsePlistValue(appVersion) === version, "APP_VERSION_MISMATCH");
  const executableName = parsePlistValue(await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", info]));
  assert(/^[A-Za-z0-9._ -]{1,160}$/u.test(executableName), "APP_EXECUTABLE_INVALID");
  const executableDirectory = join(app, "Contents/MacOS");
  const executableEntries = (await readdir(executableDirectory)).sort();
  const expectedExecutables = [executableName, "cs-agent-runtime"].sort();
  assert(executableEntries.length === expectedExecutables.length
    && executableEntries.every((name, index) => name === expectedExecutables[index]), "APP_EXECUTABLE_SET_INVALID");
  const appExecutable = join(executableDirectory, executableName);
  const sidecarExecutable = join(executableDirectory, "cs-agent-runtime");
  await requireFile(appExecutable, "APP_EXECUTABLE_MISSING");
  await requireFile(sidecarExecutable, "RUNTIME_SIDECAR_MISSING");
  assert(parsePlistValue(await run("/usr/bin/lipo", ["-archs", appExecutable])) === "arm64", "APP_ARCH_INVALID");
  assert(parsePlistValue(await run("/usr/bin/lipo", ["-archs", sidecarExecutable])) === "arm64", "RUNTIME_SIDECAR_ARCH_INVALID");
  for (const file of await walk(app)) {
    if (file.symbolicLink) continue;
    await auditPrivateMaterial(file, sourceRoot);
    const kind = parsePlistValue(await run("/usr/bin/file", ["-b", file.path]));
    if (!/Mach-O/u.test(kind)) continue;
    assert(parsePlistValue(await run("/usr/bin/lipo", ["-archs", file.path])) === "arm64", "APP_CONTAINS_NON_ARM64_BINARY");
  }

  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const signature = await run("/usr/bin/codesign", ["-dv", "--verbose=4", app]);
  const signatureText = `${signature.stdout ?? ""}\n${signature.stderr ?? ""}`;
  assert(/Authority=Developer ID Application:/u.test(signatureText), "APP_DEVELOPER_ID_SIGNATURE_MISSING");
  assert(/TeamIdentifier=[A-Z0-9]{10}/u.test(signatureText), "APP_TEAM_IDENTIFIER_MISSING");
  assert(!/Signature=adhoc/u.test(signatureText), "APP_ADHOC_SIGNATURE_REJECTED");
  await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  await run("/usr/bin/xcrun", ["stapler", "validate", app]);

  const notary = await json(resolve(notaryResultPath), "NOTARY_RESULT_INVALID");
  assert(notary.status === "Accepted" && UUID.test(notary.id), "NOTARIZATION_NOT_ACCEPTED");

  return { version, targetTriple: manifest.targetTriple, files: manifest.files, bytes: manifest.bytes, notaryId: notary.id };
}

function releaseNames(version) {
  return {
    dmg: `CS-Agent-Coach_${version}_aarch64.dmg`,
    archive: "CS-Agent-Coach.app.tar.gz",
    signature: "CS-Agent-Coach.app.tar.gz.sig",
    latest: "latest.json",
    checksums: "SHA256SUMS",
  };
}

function validateReleaseUrl(raw, repoSlug, tag, filename) {
  const url = new URL(raw);
  assert(url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.search && !url.hash, "UPDATER_URL_INVALID");
  assert(url.pathname === `/${repoSlug}/releases/download/${tag}/${filename}`, "UPDATER_URL_INVALID");
}

export async function createReleaseManifest({ releaseDir, version, tag, repoSlug, notes = "Desktop release" }) {
  validateVersionAndTag(version, tag);
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repoSlug), "REPOSITORY_SLUG_INVALID");
  const dir = resolve(releaseDir);
  const names = releaseNames(version);
  await requireFile(join(dir, names.dmg), "RELEASE_DMG_MISSING");
  await requireFile(join(dir, names.archive), "RELEASE_ARCHIVE_MISSING");
  await requireFile(join(dir, names.signature), "RELEASE_SIGNATURE_MISSING");
  const signature = (await readFile(join(dir, names.signature), "utf8")).trim();
  assert(signature.length >= 40 && signature.length <= 4096 && !PRIVATE_MATERIAL.some((pattern) => pattern.test(signature)), "UPDATER_SIGNATURE_INVALID");
  const latest = {
    version,
    notes: String(notes).slice(0, 2000),
    pub_date: new Date().toISOString(),
    platforms: {
      "darwin-aarch64": {
        signature,
        url: `https://github.com/${repoSlug}/releases/download/${tag}/${names.archive}`,
      },
    },
  };
  await writeFile(join(dir, names.latest), `${JSON.stringify(latest, null, 2)}\n`, { mode: 0o600 });
  const hashed = [names.dmg, names.archive, names.signature, names.latest];
  const sums = [];
  for (const name of hashed) sums.push(`${await sha256(join(dir, name))}  ${name}`);
  await writeFile(join(dir, names.checksums), `${sums.join("\n")}\n`, { mode: 0o600 });
  return { names, latest };
}

export async function auditRelease({ releaseDir, version, tag, repoSlug, run = defaultRun }) {
  validateVersionAndTag(version, tag);
  const dir = resolve(releaseDir);
  await requireDirectory(dir, "RELEASE_DIRECTORY_MISSING");
  const names = releaseNames(version);
  const actual = (await readdir(dir)).sort();
  const expected = Object.values(names).sort();
  assert(actual.length === expected.length && actual.every((name, index) => name === expected[index]), "RELEASE_ASSET_SET_INVALID");
  for (const name of actual) auditSensitivePath(name);

  const latest = await json(join(dir, names.latest), "UPDATER_MANIFEST_INVALID");
  exactKeys(latest, ["version", "notes", "pub_date", "platforms"], "UPDATER_MANIFEST_SCHEMA_INVALID");
  assert(latest.version === version && Number.isFinite(Date.parse(latest.pub_date)), "UPDATER_MANIFEST_VERSION_INVALID");
  exactKeys(latest.platforms, ["darwin-aarch64"], "UPDATER_PLATFORM_SET_INVALID");
  const platform = latest.platforms["darwin-aarch64"];
  exactKeys(platform, ["signature", "url"], "UPDATER_PLATFORM_SCHEMA_INVALID");
  const signature = (await readFile(join(dir, names.signature), "utf8")).trim();
  assert(platform.signature === signature && signature.length >= 40 && signature.length <= 4096, "UPDATER_SIGNATURE_MISMATCH");
  assert(!PRIVATE_MATERIAL.some((pattern) => pattern.test(signature)), "PRIVATE_MATERIAL_BUNDLED");
  validateReleaseUrl(platform.url, repoSlug, tag, names.archive);

  const lines = (await readFile(join(dir, names.checksums), "utf8")).trim().split("\n");
  const checksumNames = [names.dmg, names.archive, names.signature, names.latest];
  assert(lines.length === checksumNames.length, "CHECKSUM_SET_INVALID");
  for (const [index, name] of checksumNames.entries()) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/u.exec(lines[index]);
    assert(match && match[2] === name && match[1] === await sha256(join(dir, name)), "CHECKSUM_MISMATCH");
  }
  const totalBytes = (await Promise.all(actual.map(async (name) => (await lstat(join(dir, name))).size))).reduce((sum, value) => sum + value, 0);
  assert(totalBytes > 0 && totalBytes <= MAX_BUNDLE_BYTES, "RELEASE_SIZE_INVALID");
  await run("/usr/bin/hdiutil", ["verify", join(dir, names.dmg)]);
  await run("/usr/bin/xcrun", ["stapler", "validate", join(dir, names.dmg)]);
  return { version, tag, assets: expected, totalBytes };
}

export async function auditWorkflow(path) {
  const source = await readFile(path, "utf8");
  const required = [
    /workflow_dispatch:/u,
    /tags:\s*\[["']?desktop-v\*["']?\]/u,
    /runs-on:\s*macos-15/u,
    /actions\/checkout@v4/u,
    /pnpm\/action-setup@v4/u,
    /actions\/setup-node@v4/u,
    /actions-rust-lang\/setup-rust-toolchain@v1/u,
    /Swatinem\/rust-cache@v2/u,
    /node-version:\s*24\.19\.0/u,
    /version:\s*11\.16\.0/u,
    /toolchain:\s*1\.89\.0/u,
    /aarch64-apple-darwin/u,
    /commit:\s*\$\{\{\s*steps\.release\.outputs\.commit\s*\}\}/u,
    /ref:\s*\$\{\{\s*needs\.preflight\.outputs\.commit\s*\}\}/u,
    /RELEASE_COMMIT:\s*\$\{\{\s*needs\.preflight\.outputs\.commit\s*\}\}/u,
    /CS_AGENT_BUILD_SHA:\s*\$\{\{\s*needs\.preflight\.outputs\.commit\s*\}\}/u,
    /echo "RELEASE_DIR=\$RUNNER_TEMP\/desktop-release-assets" >> "\$GITHUB_ENV"/u,
    /permissions:\s*\n\s*contents:\s*write/u,
    /distribution:audit rights/u,
    /distribution:audit secrets/u,
    /distribution:audit bundle/u,
    /distribution:audit release/u,
    /tauri build[^\n]*--bundles app/u,
    /create:dmg --app "\$APP_PATH" --output "\$DMG_PATH"/u,
    /updater-signature-verify/u,
    /--features\s+release-verifier\s+--bin\s+updater-signature-verify/u,
    /gh release create/u,
  ];
  for (const pattern of required) assert(pattern.test(source), "WORKFLOW_STATIC_AUDIT_FAILED", `WORKFLOW_STATIC_AUDIT_FAILED:${pattern}`);
  for (const name of REQUIRED_SECRET_NAMES) {
    assert(source.includes(`secrets.${name}`), "WORKFLOW_SECRET_GATE_INCOMPLETE", `WORKFLOW_SECRET_GATE_INCOMPLETE:${name}`);
  }
  assert(!/branches:\s*\[?main/u.test(source), "WORKFLOW_TRIGGER_TOO_BROAD");
  assert(!/CS_AGENT_BUILD_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/u.test(source), "WORKFLOW_BUILD_SHA_NOT_TAG_PINNED");
  assert(!/\$\{\{\s*runner\.temp\s*\}\}/u.test(source), "WORKFLOW_RUNNER_CONTEXT_INVALID");
  assert(!/-----BEGIN .*PRIVATE KEY-----/u.test(source), "PRIVATE_MATERIAL_BUNDLED");
  assert(!/tauri signer sign[^\n]*(?:\s-k\s|--private-key)/u.test(source), "WORKFLOW_PRIVATE_KEY_ON_COMMAND_LINE");
  assert(!/bundle_dmg\.sh|osascript|--bundles\s+dmg/u.test(source), "WORKFLOW_FINDER_DMG_FORBIDDEN");
  const rightsIndex = source.indexOf("distribution:audit rights");
  const secretsIndex = source.indexOf("distribution:audit secrets");
  const buildIndex = source.indexOf("Build desktop resources");
  const appBuildIndex = source.indexOf("tauri build");
  const dmgBuildIndex = source.indexOf("create:dmg");
  const notaryIndex = source.indexOf("notarytool submit");
  const bundleIndex = source.indexOf("distribution:audit bundle");
  const signerIndex = source.indexOf("tauri signer sign");
  const verifierIndex = source.indexOf("updater-signature-verify");
  const manifestIndex = source.indexOf("audit.mjs manifest");
  const finalAuditIndex = source.indexOf("distribution:audit release");
  const releaseIndex = source.indexOf("gh release create");
  assert(rightsIndex >= 0 && rightsIndex < secretsIndex && secretsIndex < buildIndex && buildIndex < bundleIndex && bundleIndex < releaseIndex, "WORKFLOW_ORDER_INVALID");
  assert(appBuildIndex >= 0
    && appBuildIndex < dmgBuildIndex
    && dmgBuildIndex < notaryIndex
    && notaryIndex < bundleIndex, "WORKFLOW_DMG_ORDER_INVALID");
  assert(signerIndex >= 0
    && signerIndex < verifierIndex
    && verifierIndex < manifestIndex
    && manifestIndex < finalAuditIndex
    && finalAuditIndex < releaseIndex, "WORKFLOW_UPDATER_VERIFICATION_ORDER_INVALID");
  return { ok: true };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new DistributionAuditError("CLI_ARGUMENT_INVALID");
    values[key.slice(2)] = value;
  }
  return values;
}

async function cli(argv) {
  const args = parseArgs(argv);
  if (args.command === "preflight") {
    return auditPreflight({
      repoRoot: args.repo ?? process.cwd(),
      tag: args.tag,
      approvalPath: args.approval,
      requireSecrets: args.secrets === "true",
    });
  }
  if (args.command === "bundle") {
    return auditBundle({ repoRoot: args.repo, preparedRoot: args.prepared, appPath: args.app, notaryResultPath: args.notary, version: args.version });
  }
  if (args.command === "manifest") {
    return createReleaseManifest({ releaseDir: args.release, version: args.version, tag: args.tag, repoSlug: args.repoSlug, notes: args.notes });
  }
  if (args.command === "release") {
    return auditRelease({ releaseDir: args.release, version: args.version, tag: args.tag, repoSlug: args.repoSlug });
  }
  if (args.command === "workflow") return auditWorkflow(args.path);
  throw new DistributionAuditError("CLI_COMMAND_INVALID");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await cli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const code = error instanceof DistributionAuditError ? error.code : "DISTRIBUTION_AUDIT_FAILED";
    process.stderr.write(`distribution:audit ${code}\n`);
    process.exitCode = 1;
  }
}
