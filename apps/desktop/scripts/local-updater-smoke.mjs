#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MAX_DOWNLOAD_BYTES = 450 * 1024 * 1024;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceApp = join(repoRoot, "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/CS Agent Coach.app");
const verifierManifest = join(repoRoot, "apps/desktop/src-tauri/Cargo.toml");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const result = { code, signal, stdout, stderr };
      if (code === 0 && signal === null) resolve(result);
      else reject(Object.assign(new Error(`${basename(command)} failed`), { result }));
    });
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function httpsBuffer(url, ca, maxBytes) {
  return new Promise((resolve, reject) => {
    const req = request(url, { ca, rejectUnauthorized: true, servername: "localhost" }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTPS_STATUS_${String(res.statusCode)}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) res.destroy(new Error("HTTPS_RESPONSE_TOO_LARGE"));
        else chunks.push(Buffer.from(chunk));
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.once("error", reject);
    req.end();
  });
}

function httpsDownload(url, ca, outputPath) {
  return new Promise((resolve, reject) => {
    const req = request(url, { ca, rejectUnauthorized: true, servername: "localhost" }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTPS_STATUS_${String(res.statusCode)}`));
        return;
      }
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD_BYTES) res.destroy(new Error("HTTPS_RESPONSE_TOO_LARGE"));
      });
      pipeline(res, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }))
        .then(() => resolve(bytes), reject);
    });
    req.once("error", reject);
    req.end();
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "cs-agent-local-updater-"));
let server;
try {
  const releaseRoot = join(temporaryRoot, "release");
  const downloadRoot = join(temporaryRoot, "download");
  const extractRoot = join(temporaryRoot, "extract");
  const keyRoot = join(temporaryRoot, "keys");
  const tlsRoot = join(temporaryRoot, "tls");
  const dataRoot = join(temporaryRoot, "data");
  await Promise.all([releaseRoot, downloadRoot, extractRoot, keyRoot, tlsRoot, dataRoot]
    .map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const dataSentinel = join(dataRoot, "cs-agent.sqlite3");
  await writeFile(dataSentinel, "SQLite format 3\0v0.1.0-user-data", { mode: 0o600 });

  const nextApp = join(releaseRoot, "CS Agent Coach.app");
  await run("/usr/bin/ditto", [sourceApp, nextApp]);
  const infoPlist = join(nextApp, "Contents/Info.plist");
  await run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleShortVersionString 0.1.1", infoPlist]);
  await run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleVersion 0.1.1", infoPlist]);
  await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", nextApp]);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", nextApp]);
  const stagedVersion = (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", infoPlist])).stdout.trim();
  if (stagedVersion !== "0.1.1") throw new Error("STAGED_VERSION_INVALID");
  const executable = join(nextApp, "Contents/MacOS/cs-agent-desktop");
  if ((await run("/usr/bin/lipo", ["-archs", executable])).stdout.trim() !== "arm64") {
    throw new Error("STAGED_ARCH_INVALID");
  }

  const archive = join(releaseRoot, "CS-Agent-Coach.app.tar.gz");
  await run("/usr/bin/tar", ["-czf", archive, "-C", releaseRoot, "CS Agent Coach.app"]);
  if ((await stat(archive)).size <= 0 || (await stat(archive)).size > MAX_DOWNLOAD_BYTES) {
    throw new Error("ARCHIVE_SIZE_INVALID");
  }

  const privateKey = join(keyRoot, "updater.key");
  const password = randomBytes(24).toString("hex");
  const tauriCli = join(repoRoot, "apps/desktop/node_modules/.bin/tauri");
  await run(tauriCli, [
    "signer", "generate", "--ci", "--write-keys", privateKey, "--password", password,
  ]);
  await run(tauriCli, [
    "signer", "sign", "--private-key-path", privateKey, "--password", password, archive,
  ]);
  const signaturePath = `${archive}.sig`;
  const publicKey = (await readFile(`${privateKey}.pub`, "utf8")).trim();
  const signature = (await readFile(signaturePath, "utf8")).trim();
  if (publicKey.length < 80 || signature.length < 40) throw new Error("EPHEMERAL_SIGNATURE_INVALID");

  const verifierArgs = [
    "run", "--quiet", "--locked", "--release",
    "--manifest-path", verifierManifest,
    "--features", "release-verifier", "--bin", "updater-signature-verify", "--",
  ];
  await run("cargo", [...verifierArgs, publicKey, archive, signaturePath]);

  const tlsKey = join(tlsRoot, "localhost.key");
  const tlsCert = join(tlsRoot, "localhost.crt");
  await run("/usr/bin/openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", tlsKey, "-out", tlsCert, "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  const manifest = {
    version: "0.1.1",
    notes: "Local updater smoke",
    pub_date: new Date().toISOString(),
    platforms: {
      "darwin-aarch64": { signature, url: "" },
    },
  };
  const archiveName = basename(archive);
  const archiveBytes = await stat(archive);
  server = createServer({
    key: await readFile(tlsKey),
    cert: await readFile(tlsCert),
  }, (req, res) => {
    if (req.url === "/latest.json") {
      const body = Buffer.from(JSON.stringify(manifest));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
      res.end(body);
      return;
    }
    if (req.url === `/${archiveName}`) {
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": archiveBytes.size });
      createReadStream(archive).pipe(res);
      return;
    }
    res.writeHead(404, { "Content-Length": 0 });
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  manifest.platforms["darwin-aarch64"].url = `https://localhost:${port}/${archiveName}`;
  const ca = await readFile(tlsCert);
  const downloadedManifest = JSON.parse((await httpsBuffer(`https://localhost:${port}/latest.json`, ca, 64 * 1024)).toString("utf8"));
  if (downloadedManifest.version !== "0.1.1"
    || downloadedManifest.platforms?.["darwin-aarch64"]?.signature !== signature
    || downloadedManifest.platforms?.["darwin-aarch64"]?.url !== manifest.platforms["darwin-aarch64"].url) {
    throw new Error("DOWNLOADED_MANIFEST_INVALID");
  }
  const downloadedArchive = join(downloadRoot, archiveName);
  const downloadedBytes = await httpsDownload(downloadedManifest.platforms["darwin-aarch64"].url, ca, downloadedArchive);
  if (downloadedBytes !== archiveBytes.size || await sha256(downloadedArchive) !== await sha256(archive)) {
    throw new Error("DOWNLOADED_ARCHIVE_INVALID");
  }
  const downloadedSignature = join(downloadRoot, `${archiveName}.sig`);
  await writeFile(downloadedSignature, signature, { mode: 0o600 });
  await run("cargo", [...verifierArgs, publicKey, downloadedArchive, downloadedSignature]);

  await run("/usr/bin/tar", ["-xzf", downloadedArchive, "-C", extractRoot]);
  const extractedEntries = await readdir(extractRoot);
  if (extractedEntries.length !== 1 || extractedEntries[0] !== "CS Agent Coach.app") {
    throw new Error("EXTRACTED_APP_SET_INVALID");
  }
  const extractedApp = join(extractRoot, extractedEntries[0]);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", extractedApp]);
  const extractedVersion = (await run("/usr/libexec/PlistBuddy", [
    "-c", "Print :CFBundleShortVersionString", join(extractedApp, "Contents/Info.plist"),
  ])).stdout.trim();
  if (extractedVersion !== "0.1.1") throw new Error("EXTRACTED_VERSION_INVALID");
  if ((await readFile(dataSentinel, "utf8")) !== "SQLite format 3\0v0.1.0-user-data") {
    throw new Error("USER_DATA_CHANGED");
  }

  await appendFile(downloadedArchive, "tampered");
  let tamperRejected = false;
  try {
    await run("cargo", [...verifierArgs, publicKey, downloadedArchive, downloadedSignature]);
  } catch (error) {
    tamperRejected = error?.result?.stdout?.includes("VERIFY_SIGNATURE_INVALID") === true;
  }
  if (!tamperRejected) throw new Error("TAMPERED_ARCHIVE_ACCEPTED");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fromVersion: "0.1.0",
    toVersion: "0.1.1",
    target: "darwin-aarch64",
    bytes: archiveBytes.size,
    https: true,
    signatureVerified: true,
    tamperRejected: true,
    extractedAppVerified: true,
    userDataUnchanged: true,
  })}\n`);
} finally {
  if (server) await closeServer(server).catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}
