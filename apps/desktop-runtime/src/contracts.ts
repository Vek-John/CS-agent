import path from "node:path";

const INIT_FIELDS = [
  "schemaVersion",
  "appVersion",
  "buildSha",
  "targetTriple",
  "dataDir",
  "cacheDir",
  "logDir",
  "runtimeRoot",
  "viewerRoot",
  "provider",
] as const;

const NONE_PROVIDER_FIELDS = ["kind", "apiKey", "baseUrl", "model"] as const;

export interface NoneProviderConfig {
  readonly kind: "NONE";
  readonly apiKey: null;
  readonly baseUrl: null;
  readonly model: null;
}

export interface DeepseekProviderConfig {
  readonly kind: "DEEPSEEK";
  readonly apiKey: string;
  readonly baseUrl: "https://api.deepseek.com" | "https://api.deepseek.com/";
  readonly model: string;
}

export interface OpenAiCompatibleProviderConfig {
  readonly kind: "OPENAI_COMPATIBLE";
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly model: string;
}

export type DesktopProviderConfig =
  | NoneProviderConfig
  | DeepseekProviderConfig
  | OpenAiCompatibleProviderConfig;

export interface DesktopRuntimeInit {
  readonly schemaVersion: "desktop-runtime-init.v1";
  readonly appVersion: string;
  readonly buildSha: string;
  readonly targetTriple: string;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly logDir: string;
  readonly runtimeRoot: string;
  readonly viewerRoot: string;
  readonly provider: DesktopProviderConfig;
}

export type StartupErrorCode =
  | "INIT_TIMEOUT"
  | "INIT_TOO_LARGE"
  | "INIT_INVALID"
  | "VIEWER_START_FAILED"
  | "NEXT_START_FAILED"
  | "CHECKPOINT_UNAVAILABLE"
  | "RUNTIME_START_FAILED";

export class RuntimeStartupError extends Error {
  constructor(readonly code: StartupErrorCode) {
    super(code);
    this.name = "RuntimeStartupError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string"
    && value.length >= min
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function absolutePath(value: unknown): value is string {
  return boundedString(value, 1, 4096) && path.isAbsolute(value);
}

function validateProviderUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
}

export function validateDesktopProviderConfig(value: unknown): DesktopProviderConfig {
  if (!isRecord(value) || !hasExactFields(value, NONE_PROVIDER_FIELDS)) {
    throw new RuntimeStartupError("INIT_INVALID");
  }
  if (value.kind === "NONE") {
    if (value.apiKey !== null || value.baseUrl !== null || value.model !== null) {
      throw new RuntimeStartupError("INIT_INVALID");
    }
    return Object.freeze({ kind: "NONE", apiKey: null, baseUrl: null, model: null });
  }
  if (value.kind === "DEEPSEEK") {
    if (!boundedString(value.apiKey, 8, 512)
      || (value.baseUrl !== "https://api.deepseek.com" && value.baseUrl !== "https://api.deepseek.com/")
      || !boundedString(value.model, 1, 120)) {
      throw new RuntimeStartupError("INIT_INVALID");
    }
    return Object.freeze({ kind: "DEEPSEEK", apiKey: value.apiKey, baseUrl: value.baseUrl, model: value.model });
  }
  if (value.kind === "OPENAI_COMPATIBLE") {
    if ((value.apiKey !== null && !boundedString(value.apiKey, 1, 512))
      || !boundedString(value.baseUrl, 1, 2048)
      || !validateProviderUrl(value.baseUrl)
      || !boundedString(value.model, 1, 120)) {
      throw new RuntimeStartupError("INIT_INVALID");
    }
    return Object.freeze({ kind: "OPENAI_COMPATIBLE", apiKey: value.apiKey, baseUrl: value.baseUrl, model: value.model });
  }
  throw new RuntimeStartupError("INIT_INVALID");
}

export function parseDesktopRuntimeInit(line: string): DesktopRuntimeInit {
  if (Buffer.byteLength(line, "utf8") > 32 * 1024) throw new RuntimeStartupError("INIT_TOO_LARGE");
  let input: unknown;
  try {
    input = JSON.parse(line);
  } catch {
    throw new RuntimeStartupError("INIT_INVALID");
  }
  if (!isRecord(input) || !hasExactFields(input, INIT_FIELDS)) throw new RuntimeStartupError("INIT_INVALID");
  if (input.schemaVersion !== "desktop-runtime-init.v1"
    || !boundedString(input.appVersion, 1, 120)
    || !boundedString(input.buildSha, 1, 120)
    || !boundedString(input.targetTriple, 1, 120)
    || !/^[A-Za-z0-9_.-]+$/u.test(input.targetTriple)
    || !absolutePath(input.dataDir)
    || !absolutePath(input.cacheDir)
    || !absolutePath(input.logDir)
    || !absolutePath(input.runtimeRoot)
    || !absolutePath(input.viewerRoot)) {
    throw new RuntimeStartupError("INIT_INVALID");
  }
  return Object.freeze({
    schemaVersion: "desktop-runtime-init.v1",
    appVersion: input.appVersion,
    buildSha: input.buildSha,
    targetTriple: input.targetTriple,
    dataDir: input.dataDir,
    cacheDir: input.cacheDir,
    logDir: input.logDir,
    runtimeRoot: input.runtimeRoot,
    viewerRoot: input.viewerRoot,
    provider: validateDesktopProviderConfig(input.provider),
  });
}

const RUNTIME_PROVIDER_SYMBOL = Symbol.for("cs-agent.desktop.provider.v1");
type ProviderGlobal = typeof globalThis & { [RUNTIME_PROVIDER_SYMBOL]?: DesktopProviderConfig };

/** In-memory provider seam. The value is never copied into process.env. */
export function installRuntimeProviderConfig(provider: DesktopProviderConfig): void {
  (globalThis as ProviderGlobal)[RUNTIME_PROVIDER_SYMBOL] = provider;
}

export function currentRuntimeProviderConfig(): DesktopProviderConfig | undefined {
  return (globalThis as ProviderGlobal)[RUNTIME_PROVIDER_SYMBOL];
}

export async function readInitLine(
  input: NodeJS.ReadableStream,
  timeoutMs = 5_000,
  maxBytes = 32 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffered = Buffer.alloc(0);
    const finish = (error?: RuntimeStartupError, line?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      if (error) reject(error);
      else resolve(line ?? "");
    };
    const onData = (chunk: string | Buffer) => {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const newline = buffered.indexOf(0x0a);
      const firstLineBytes = newline >= 0 ? newline : buffered.length;
      if (firstLineBytes > maxBytes) return finish(new RuntimeStartupError("INIT_TOO_LARGE"));
      if (newline >= 0) {
        const end = newline > 0 && buffered[newline - 1] === 0x0d ? newline - 1 : newline;
        finish(undefined, buffered.subarray(0, end).toString("utf8"));
      }
    };
    const onEnd = () => finish(new RuntimeStartupError("INIT_INVALID"));
    const onError = () => finish(new RuntimeStartupError("INIT_INVALID"));
    const timer = setTimeout(() => finish(new RuntimeStartupError("INIT_TIMEOUT")), timeoutMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}
