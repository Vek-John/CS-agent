import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const MAX_LOCAL_DEMO_BYTES = 512 * 1024 * 1024;
const WORKSPACE_MARKER = "ARCHITECTURE.md";
const DEMO_MAGIC = Buffer.from("PBDEMS2\0", "ascii");

export interface LocalDemoPlayer {
  player_id: string;
  display_name: string;
  side?: "T" | "CT";
}

export interface LocalDemoUpload {
  name: string;
  size: number;
  stream: () => ReadableStream<Uint8Array>;
}

export interface LocalDemoJob {
  id: string;
  status: "INSPECTING" | "AWAITING_PLAYER" | "ANALYZING" | "READY" | "FAILED";
  original_name: string;
  size_bytes: number;
  source_sha256: string;
  map_name?: string;
  players: LocalDemoPlayer[];
  selected_player_id?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

interface JobRecord extends LocalDemoJob {
  source_path: string;
  bundle_path: string;
}

const jobs = new Map<string, JobRecord>();
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function workspaceRoot(): string {
  const candidates = [process.cwd(), path.resolve(process.cwd(), "../..")];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, WORKSPACE_MARKER))) return candidate;
  }
  return path.resolve(process.cwd(), "../..");
}

function uploadsRoot(): string {
  return path.join(workspaceRoot(), ".local-data", "demo-jobs");
}

function jobDirectory(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error("Demo 作业编号无效。");
  return path.join(uploadsRoot(), jobId);
}

function jobMetadataPath(jobId: string): string {
  return path.join(jobDirectory(jobId), "job.json");
}

function pythonPath(): string {
  return path.join(workspaceRoot(), ".venv", "bin", "python");
}

function publicBundlePath(jobId: string): string {
  return path.join(workspaceRoot(), "apps", "web", "public", "generated-data", "uploads", `${jobId}.replay.json`);
}

function publicBundleUrl(jobId: string): string {
  return `/generated-data/uploads/${jobId}.replay.json`;
}

function toPublicJob(job: JobRecord): LocalDemoJob & { bundle_url?: string } {
  const { source_path: _sourcePath, bundle_path: _bundlePath, ...publicFields } = job;
  return job.status === "READY"
    ? { ...publicFields, bundle_url: publicBundleUrl(job.id) }
    : publicFields;
}

async function ensurePython(): Promise<void> {
  await access(pythonPath(), fsConstants.X_OK);
}

async function runPythonJson(args: string[]): Promise<Record<string, unknown>> {
  await ensurePython();
  return await new Promise((resolve, reject) => {
    const child = spawn(pythonPath(), args, {
      cwd: workspaceRoot(),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `分析进程退出（${code ?? "unknown"}）`));
        return;
      }
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) {
        reject(new Error("分析进程没有返回结果。"));
        return;
      }
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        reject(new Error("分析进程返回了无法识别的结果。"));
      }
    });
  });
}

function normalizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "未知错误";
  const lastLine = raw.split("\n").at(-1) || "";
  if (/PanicException|Traceback|pyo3_runtime|DemoParseError|parsing/i.test(raw)) {
    return "Demo 解析失败：文件可能损坏、未完整保存，或来自当前解析器尚不支持的版本。";
  }
  return lastLine.slice(0, 500) || "未知错误";
}

function updateJob(job: JobRecord, update: Partial<JobRecord>): void {
  Object.assign(job, update, { updated_at: new Date().toISOString() });
}

async function persistJobRecord(job: JobRecord): Promise<void> {
  const destination = jobMetadataPath(job.id);
  const temporary = path.join(jobDirectory(job.id), `${randomUUID()}.job-writing`);
  await mkdir(jobDirectory(job.id), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, destination);
}

async function loadJobRecord(id: string): Promise<JobRecord | undefined> {
  if (!JOB_ID_PATTERN.test(id)) return undefined;
  const cached = jobs.get(id);
  if (cached) return cached;
  try {
    const stored = JSON.parse(await readFile(jobMetadataPath(id), "utf8")) as Partial<JobRecord>;
    if (stored.id !== id || !Array.isArray(stored.players) || typeof stored.original_name !== "string") {
      return undefined;
    }
    const job: JobRecord = {
      ...stored,
      id,
      status: stored.status ?? "FAILED",
      original_name: stored.original_name,
      size_bytes: stored.size_bytes ?? 0,
      source_sha256: stored.source_sha256 ?? "",
      players: stored.players,
      created_at: stored.created_at ?? new Date().toISOString(),
      updated_at: stored.updated_at ?? new Date().toISOString(),
      source_path: path.join(jobDirectory(id), "source.dem"),
      bundle_path: publicBundlePath(id)
    };
    jobs.set(id, job);
    return job;
  } catch {
    return undefined;
  }
}

async function persistUpload(file: LocalDemoUpload, jobId: string): Promise<{ sourcePath: string; sha256: string }> {
  const jobDir = jobDirectory(jobId);
  await mkdir(jobDir, { recursive: false });
  const sourcePath = path.join(jobDir, "source.dem");
  const temporaryPath = path.join(jobDir, `${randomUUID()}.uploading`);
  const handle = await open(temporaryPath, "wx");
  const hash = createHash("sha256");
  let total = 0;
  let prefix = Buffer.alloc(0);
  let closed = false;
  try {
    const reader = file.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_LOCAL_DEMO_BYTES) throw new Error("Demo 超过 localhost 版 512 MB 限制。");
      if (prefix.length < DEMO_MAGIC.length) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, DEMO_MAGIC.length - prefix.length)]);
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.close();
    closed = true;
    if (total !== file.size) throw new Error("Demo 上传长度不一致。请重新选择文件。");
    if (prefix.length < DEMO_MAGIC.length || !prefix.equals(DEMO_MAGIC)) {
      throw new Error("文件不是可识别的 CS2 Demo（缺少 PBDEMS2 文件头）。");
    }
    await rename(temporaryPath, sourcePath);
    return { sourcePath, sha256: hash.digest("hex") };
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function createLocalDemoJob(file: LocalDemoUpload): Promise<ReturnType<typeof toPublicJob>> {
  if (!file.name.toLowerCase().endsWith(".dem")) throw new Error("请选择扩展名为 .dem 的 CS2 Demo。");
  if (file.size <= 0) throw new Error("Demo 文件为空。");
  if (file.size > MAX_LOCAL_DEMO_BYTES) throw new Error("Demo 超过 localhost 版 512 MB 限制。");

  await mkdir(uploadsRoot(), { recursive: true });
  const id = randomUUID();
  const { sourcePath, sha256 } = await persistUpload(file, id);
  const now = new Date().toISOString();
  const job: JobRecord = {
    id,
    status: "INSPECTING",
    original_name: path.basename(file.name),
    size_bytes: file.size,
    source_sha256: sha256,
    players: [],
    created_at: now,
    updated_at: now,
    source_path: sourcePath,
    bundle_path: publicBundlePath(id)
  };
  jobs.set(id, job);
  await persistJobRecord(job);

  try {
    const inspected = await runPythonJson([
      "-m", "cs2_demo_parser.inspect_demo", sourcePath
    ]);
    const mapName = typeof inspected.map_name === "string" ? inspected.map_name : undefined;
    if (mapName !== "de_mirage") {
      throw new Error(`当前 localhost MVP 只支持 de_mirage；这份 Demo 是 ${mapName || "未知地图"}。`);
    }
    const players = Array.isArray(inspected.players) ? inspected.players : [];
    updateJob(job, {
      status: "AWAITING_PLAYER",
      map_name: mapName,
      players: players.flatMap((value): LocalDemoPlayer[] => {
        if (typeof value !== "object" || value === null) return [];
        const item = value as Record<string, unknown>;
        if (typeof item.player_id !== "string") return [];
        return [{
          player_id: item.player_id,
          display_name: typeof item.display_name === "string" ? item.display_name : item.player_id,
          side: item.side === "T" || item.side === "CT" ? item.side : undefined
        }];
      })
    });
  } catch (error) {
    updateJob(job, { status: "FAILED", error: normalizeError(error) });
  }
  await persistJobRecord(job);
  return toPublicJob(job);
}

export async function getLocalDemoJob(id: string): Promise<ReturnType<typeof toPublicJob> | undefined> {
  const job = await loadJobRecord(id);
  return job ? toPublicJob(job) : undefined;
}

export async function startLocalDemoAnalysis(id: string, selectedPlayerId: string): Promise<ReturnType<typeof toPublicJob>> {
  const job = await loadJobRecord(id);
  if (!job) throw new Error("找不到这次 Demo 上传，请重新选择文件。");
  if (job.status !== "AWAITING_PLAYER" && job.status !== "READY") {
    throw new Error("当前 Demo 尚未完成玩家识别。");
  }
  if (!job.players.some((player) => player.player_id === selectedPlayerId)) {
    throw new Error("所选玩家不属于这份 Demo。");
  }
  updateJob(job, { status: "ANALYZING", selected_player_id: selectedPlayerId, error: undefined });
  await persistJobRecord(job);
  void (async () => {
    try {
      await mkdir(path.dirname(job.bundle_path), { recursive: true });
      await runPythonJson([
        "-m", "cs2_demo_parser.build_replay",
        job.source_path,
        job.bundle_path,
        "--selected-player-id", selectedPlayerId
      ]);
      const bundle = JSON.parse(await readFile(job.bundle_path, "utf8")) as Record<string, unknown>;
      const timeline = bundle.match_timeline as Record<string, unknown> | undefined;
      if (!timeline || timeline.selected_player_id !== selectedPlayerId || !bundle.review_plan) {
        throw new Error("生成结果未绑定所选玩家，已拒绝发布。");
      }
      updateJob(job, { status: "READY" });
      await persistJobRecord(job);
    } catch (error) {
      updateJob(job, { status: "FAILED", error: normalizeError(error) });
      await persistJobRecord(job);
    }
  })();
  return toPublicJob(job);
}
