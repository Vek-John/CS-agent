import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.once("line", (line) => {
  const init = JSON.parse(line);
  if (init.schemaVersion !== "desktop-runtime-init.v1" || init.provider?.kind !== "NONE") {
    process.exit(64);
  }
  process.stdout.write("stub boot log\n");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "desktop-runtime-ready.v2",
    protocolVersion: "desktop-runtime-http.v2",
    appOrigin: "http://127.0.0.1:43001",
    viewerOrigin: "http://localhost:43002",
    sessionToken: "s".repeat(48),
    adminToken: "a".repeat(48),
    pid: process.pid,
    targetTriple: "aarch64-apple-darwin",
    nodeVersion: "24.19.0",
    checkpointBackend: "SQLITE",
    recoverableAfterRefresh: true,
  })}\n`);
});

process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
