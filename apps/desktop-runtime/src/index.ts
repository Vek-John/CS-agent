import { parseDesktopRuntimeInit, readInitLine, RuntimeStartupError, type StartupErrorCode } from "./contracts";
import { startDesktopRuntime } from "./runtime";

const protocolWrite = process.stdout.write.bind(process.stdout);

export * from "./contracts";
export * from "./runtime";
export * from "./security";
export * from "./viewer";

function writeProtocolLine(value: unknown): void {
  protocolWrite(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  // stdout is a strict one-line supervision protocol. Next and dependencies
  // must not race readiness with informational logging.
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    if (!process.permission || process.permission.has("child")) {
      throw new RuntimeStartupError("RUNTIME_START_FAILED");
    }
    const init = parseDesktopRuntimeInit(await readInitLine(process.stdin));
    process.stdin.pause();
    const runtime = await startDesktopRuntime(init, {
      onAdminShutdown: () => process.exit(0),
    });
    writeProtocolLine(runtime.ready);
    const supervisorPid = process.ppid;
    let stopping = false;
    let supervisorWatch: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (supervisorWatch) clearInterval(supervisorWatch);
      const hardStop = setTimeout(() => process.exit(1), 6_000);
      void runtime.shutdown().finally(() => {
        clearTimeout(hardStop);
        process.exit(0);
      });
    };
    supervisorWatch = setInterval(() => {
      if (process.ppid !== supervisorPid || !processExists(supervisorPid)) stop();
    }, 500);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    const code: StartupErrorCode = error instanceof RuntimeStartupError ? error.code : "RUNTIME_START_FAILED";
    writeProtocolLine({ schemaVersion: "desktop-runtime-error.v1", code });
    process.exitCode = 1;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (process.env.NODE_ENV !== "test") void main();
