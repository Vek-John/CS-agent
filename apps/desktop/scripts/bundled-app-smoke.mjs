import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const appPath = join(
  repoRoot,
  "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/CS Agent Coach.app",
);
const desktopMarker = `${appPath}/Contents/MacOS/cs-agent-desktop`;
const runtimeMarker = `${appPath}/Contents/MacOS/cs-agent-runtime`;

async function quit() {
  await run("/usr/bin/osascript", ["-e", 'tell application "CS Agent Coach" to quit'])
    .catch(() => {});
}

async function processSnapshot() {
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,command="]);
  const rows = stdout.trim().split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u);
    return match ? [[match[1], match[2], match[3]]] : [];
  });
  return {
    desktop: rows.find(([, , command]) => command?.includes(desktopMarker)),
    runtime: rows.find(([, , command]) => command?.includes(runtimeMarker)),
  };
}

async function hasBothLoopbackListeners(pid) {
  const { stdout } = await run("/usr/sbin/lsof", [
    "-nP", "-a", "-p", pid, "-iTCP", "-sTCP:LISTEN",
  ]).catch(() => ({ stdout: "" }));
  const ipv4Listeners = stdout.match(/TCP 127\.0\.0\.1:\d+ \(LISTEN\)/gu) ?? [];
  return ipv4Listeners.length === 2
    && !stdout.includes("TCP [::1]:")
    && !stdout.includes("TCP *:");
}

await quit();
await new Promise((resolve, reject) => {
  const child = spawn("/usr/bin/open", ["-n", appPath], { stdio: "ignore" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`open exited ${code}`)));
});

let reachedReady = false;
try {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const snapshot = await processSnapshot();
    if (snapshot.desktop && snapshot.runtime && await hasBothLoopbackListeners(snapshot.runtime[0])) {
      reachedReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} finally {
  await quit();
}

const cleanupDeadline = Date.now() + 10_000;
let remaining = await processSnapshot();
while ((remaining.desktop || remaining.runtime) && Date.now() < cleanupDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  remaining = await processSnapshot();
}

if (!reachedReady) {
  process.stderr.write("FAIL bundled app never reached its two-listener ready state\n");
  process.exitCode = 1;
} else if (remaining.desktop || remaining.runtime) {
  process.stderr.write("FAIL bundled app left a desktop or runtime process after quit\n");
  process.exitCode = 1;
} else {
  process.stdout.write("PASS bundled app reached ready and left no process after quit\n");
}

for (const row of [remaining.desktop, remaining.runtime]) {
  if (row) {
    try { process.kill(Number(row[0]), "SIGTERM"); } catch {}
  }
}
