import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("stub sidecar accepts one init line and exits on SIGTERM", { timeout: 3000 }, async () => {
  const fixture = fileURLToPath(new URL("./fixtures/stub-sidecar.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
  const pid = child.pid;
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const ready = new Promise((resolve) => {
    lines.on("line", (line) => {
      if (line.startsWith("{")) resolve(JSON.parse(line));
    });
  });

  child.stdin.end(`${JSON.stringify({
    schemaVersion: "desktop-runtime-init.v1",
    appVersion: "0.1.0",
    buildSha: "test",
    targetTriple: "aarch64-apple-darwin",
    dataDir: "/tmp/data",
    cacheDir: "/tmp/cache",
    logDir: "/tmp/log",
    runtimeRoot: "/tmp/runtime",
    viewerRoot: "/tmp/viewer",
    provider: { kind: "NONE", apiKey: null, baseUrl: null, model: null },
  })}\n`);
  const envelope = await ready;
  assert.equal(envelope.pid, pid);
  assert.equal(envelope.schemaVersion, "desktop-runtime-ready.v2");
  assert.equal(envelope.protocolVersion, "desktop-runtime-http.v2");

  child.kill("SIGTERM");
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, 0);
  assert.throws(() => process.kill(pid, 0));
});
