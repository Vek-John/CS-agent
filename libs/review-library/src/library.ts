import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  fstatSync,
  openSync,
  closeSync,
  type ReadStream,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import {
  SqliteCheckpointSaver,
  type SqliteDatabaseOwner,
} from "@cs-coach/memory-sqlite/server";
import type {
  AppendArtifactInput,
  ClaimMemoryOpportunityInput,
  ClaimMemoryOpportunityResult,
  CommitRuntimeHeadInput,
  CreateReviewInput,
  DeleteResult,
  DemoDeletionImpact,
  DemoAsset,
  DemoLibraryEntry,
  ImportDemoResult,
  JsonValue,
  LibraryCapability,
  LibraryCacheCleanupResult,
  LibraryReconcileResult,
  LibraryStats,
  LibraryVerificationIssue,
  LibraryVerificationResult,
  ListReviewsInput,
  LoadedReview,
  LoadReviewOptions,
  RecoveryBoundary,
  ReviewArtifact,
  ReviewArtifactIssue,
  ReviewArtifactType,
  ReviewLibraryEntries,
  ReviewPage,
  ReviewRecord,
  ReviewRevision,
  ReviewRuntimeHead,
  ReviewStatus,
  StartRevisionInput,
} from "./index";
import { LibraryPathError, LibraryPathPolicy } from "./path-policy";

const gunzipBytes = promisify(gunzip);
const DEMO_MAGIC = Buffer.from([0x50, 0x42, 0x44, 0x45, 0x4d, 0x53, 0x32, 0]);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const PARTIAL_NAME_PATTERN = /^(?:import|artifact)-[0-9a-f-]{36}\.partial$/u;
const DEFAULT_CAPABILITY_TTL_MS = 60_000;
const DEFAULT_SMALL_JSON_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DEMO_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_PARTIAL_MAX_AGE_MS = 15 * 60_000;
const MAX_REVIEW_DETAIL_ARTIFACTS = 512;
const MAX_LIBRARY_ENTRIES = 50;
const MAX_DELETION_IMPACT_REVIEWS = 50;
const REQUIRED_RUNTIME_ARTIFACTS = [
  "REVIEW_PLAN",
  "ANALYSIS_BUNDLE",
  "CANDIDATE_SET",
  "SESSION_RECOVERY",
] as const satisfies readonly ReviewArtifactType[];

export type ReviewLibraryErrorCode =
  | "NOT_INITIALIZED"
  | "INVALID_ARGUMENT"
  | "INVALID_RELATIVE_PATH"
  | "SYMLINK_ESCAPE"
  | "INVALID_CAPABILITY"
  | "CAPABILITY_EXPIRED"
  | "CAPABILITY_ALREADY_USED"
  | "INVALID_DEMO"
  | "IMPORT_LENGTH_MISMATCH"
  | "DEMO_NOT_FOUND"
  | "DEMO_NOT_READY"
  | "DEMO_IN_USE"
  | "REVIEW_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "ARTIFACT_CONFLICT"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_CORRUPT"
  | "REVISION_ARTIFACTS_INCOMPLETE"
  | "RUNTIME_HEAD_IDENTITY_MISMATCH"
  | "DELETION_IMPACT_CHANGED"
  | "DELETE_FAILED"
  | "EVIDENCE_CONFLICT";

export class ReviewLibraryError extends Error {
  constructor(readonly code: ReviewLibraryErrorCode) {
    super(code);
    this.name = "ReviewLibraryError";
  }
}

interface CapabilityRecord {
  readonly token: string;
  readonly purpose: "IMPORT" | "VIEW" | "VALIDATE";
  readonly objectId: string;
  readonly expiresAtMs: number;
  readonly originalFilename?: string;
  readonly expectedByteLength?: number;
}

interface ArtifactJobRow {
  job_id: string;
  artifact_id: string;
  review_revision_id: string;
  artifact_type: ReviewArtifactType;
  artifact_key: string;
  artifact_revision: number;
  schema_version: string;
  checksum: string;
  idempotency_key: string;
  temp_relative_path: string;
  final_relative_path: string;
  status: "WRITING" | "PUBLISHING" | "COMPLETED" | "FAILED";
  created_at: string;
}

interface DemoRow {
  demo_id: string;
  content_hash: string;
  relative_path: string;
  original_filename: string;
  byte_size: number;
  map_name: string | null;
  match_started_at: string | null;
  match_duration_ms: number | null;
  status: DemoAsset["status"];
  imported_at: string;
  last_opened_at: string;
  parser_version: string | null;
}

interface ReviewRow {
  review_id: string;
  demo_id: string;
  original_filename: string;
  selected_player_id: string;
  selected_player_name: string;
  title: string;
  map_name: string | null;
  score_text: string | null;
  status: ReviewStatus;
  active_revision_id: string | null;
  current_cue_id: string | null;
  current_playback_tick: number | null;
  completed_cue_count: number;
  total_cue_count: number;
  created_at: string;
  last_opened_at: string;
  completed_at: string | null;
  demo_status: DemoAsset["status"];
}

interface RevisionRow {
  review_revision_id: string;
  review_id: string;
  analysis_version: string;
  graph_version: string;
  prompt_version: string;
  model_json: string;
  route_id: string | null;
  route_hash: string;
  status: ReviewRevision["status"];
  artifact_contract_version: 1 | 2;
  created_at: string;
}

interface ArtifactRow {
  artifact_id: string;
  review_revision_id: string;
  artifact_type: ReviewArtifactType;
  artifact_key: string;
  artifact_revision: number;
  schema_version: string;
  checksum: string;
  storage_kind: ReviewArtifact["storageKind"];
  relative_path: string | null;
  json_payload: string | null;
  byte_size: number;
  idempotency_key: string;
  created_at: string;
}

interface RuntimeHeadRow {
  review_id: string;
  review_revision_id: string;
  recovery_artifact_id: string | null;
  recovery_artifact_key: string | null;
  recovery_artifact_revision: number | null;
  session_id: string;
  run_id: string;
  demo_id: string;
  demo_content_hash: string;
  selected_player_id: string;
  route_id: string;
  route_hash: string;
  recovery_boundary: RecoveryBoundary;
  checkpoint_thread_id: string | null;
  checkpoint_namespace: string | null;
  checkpoint_id: string | null;
  current_cue_id: string | null;
  default_route_cursor: number;
  completed_cue_count: number;
  total_cue_count: number;
  last_playback_tick: number | null;
  stable_progress_json: string;
  updated_at: string;
}

interface ImportJobRow {
  job_id: string;
  object_id: string;
  candidate_demo_id: string;
  original_filename: string;
  expected_byte_length: number;
  temp_relative_path: string;
  final_relative_path: string | null;
  content_hash: string | null;
  byte_size: number | null;
  status: "WRITING" | "PUBLISHING" | "COMPLETED" | "FAILED";
}

interface DeleteSnapshot {
  readonly reviewIds: readonly string[];
  readonly demoContentHash?: string;
  readonly filePaths: readonly string[];
  readonly checkpointThreadIds: readonly string[];
  readonly removedReviewCount: number;
  readonly removedDemo: boolean;
}

interface DeleteJobRow {
  job_id: string;
  target_kind: "REVIEW" | "DEMO";
  target_id: string;
  status: "PREPARED" | "FILES_DELETED" | "COMPLETED" | "FAILED";
  snapshot_json: string;
}

export interface DesktopReviewLibraryOptions {
  readonly owner: SqliteDatabaseOwner;
  readonly dataRoot: string;
  readonly now?: () => Date;
  readonly capabilityTtlMs?: number;
  readonly smallJsonMaxBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly maxDemoBytes?: number;
  readonly partialMaxAgeMs?: number;
}

export interface IssueImportCapabilityInput {
  readonly objectId: string;
  readonly originalFilename: string;
  readonly expectedByteLength: number;
}

export interface ImportDemoInput {
  readonly authorization?: string;
  readonly objectId: string;
  readonly stream: AsyncIterable<Uint8Array>;
}

export interface ViewerDemoSource {
  readonly demoId: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly originalFilename: string;
  readonly body: ReadStream;
}

export interface DeleteDemoOptions {
  readonly impactToken?: string;
}

function defined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function demoFromRow(row: DemoRow): DemoAsset {
  return {
    demoId: row.demo_id,
    contentHash: row.content_hash,
    originalFilename: row.original_filename,
    byteSize: row.byte_size,
    mapName: defined(row.map_name),
    matchStartedAt: defined(row.match_started_at),
    matchDurationMs: defined(row.match_duration_ms),
    status: row.status,
    importedAt: row.imported_at,
    lastOpenedAt: row.last_opened_at,
    parserVersion: defined(row.parser_version),
  };
}

function reviewFromRow(row: ReviewRow): ReviewRecord {
  return {
    reviewId: row.review_id,
    demoId: row.demo_id,
    originalFilename: row.original_filename,
    selectedPlayerId: row.selected_player_id,
    selectedPlayerName: row.selected_player_name,
    title: row.title,
    mapName: defined(row.map_name),
    scoreText: defined(row.score_text),
    status: row.status,
    activeRevisionId: defined(row.active_revision_id),
    currentCueId: defined(row.current_cue_id),
    currentPlaybackTick: defined(row.current_playback_tick),
    completedCueCount: row.completed_cue_count,
    totalCueCount: row.total_cue_count,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    completedAt: defined(row.completed_at),
    demoStatus: row.demo_status,
  };
}

function revisionFromRow(row: RevisionRow): ReviewRevision {
  return {
    reviewRevisionId: row.review_revision_id,
    reviewId: row.review_id,
    analysisVersion: row.analysis_version,
    graphVersion: row.graph_version,
    promptVersion: row.prompt_version,
    modelMetadata: JSON.parse(row.model_json) as JsonValue,
    routeId: defined(row.route_id),
    routeHash: row.route_hash,
    status: row.status,
    artifactContractVersion: row.artifact_contract_version,
    createdAt: row.created_at,
  };
}

function runtimeHeadFromRow(row: RuntimeHeadRow): ReviewRuntimeHead {
  return {
    reviewId: row.review_id,
    reviewRevisionId: row.review_revision_id,
    ...(row.recovery_artifact_id && row.recovery_artifact_key && row.recovery_artifact_revision
      ? {
          recoveryArtifactId: row.recovery_artifact_id,
          recoveryArtifactKey: row.recovery_artifact_key,
          recoveryArtifactRevision: row.recovery_artifact_revision,
        }
      : {}),
    sessionId: row.session_id,
    runId: row.run_id,
    demoId: row.demo_id,
    demoContentHash: row.demo_content_hash,
    selectedPlayerId: row.selected_player_id,
    routeId: row.route_id,
    routeHash: row.route_hash,
    recoveryBoundary: row.recovery_boundary,
    checkpointThreadId: defined(row.checkpoint_thread_id),
    checkpointNamespace: defined(row.checkpoint_namespace),
    checkpointId: defined(row.checkpoint_id),
    currentCueId: defined(row.current_cue_id),
    defaultRouteCursor: row.default_route_cursor,
    completedCueCount: row.completed_cue_count,
    totalCueCount: row.total_cue_count,
    lastPlaybackTick: defined(row.last_playback_tick),
    stableProgress: JSON.parse(row.stable_progress_json) as JsonValue,
    updatedAt: row.updated_at,
  };
}

function json(value: JsonValue, maxBytes: number): { text: string; bytes: number } {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new ReviewLibraryError("INVALID_ARGUMENT");
  }
  if (text === undefined) throw new ReviewLibraryError("INVALID_ARGUMENT");
  const bytes = Buffer.byteLength(text);
  if (bytes > maxBytes) throw new ReviewLibraryError("ARTIFACT_TOO_LARGE");
  return { text, bytes };
}

function text(value: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes("\0"))
    throw new ReviewLibraryError("INVALID_ARGUMENT");
  return normalized;
}

function opaque(value: string): string {
  if (!OPAQUE_ID_PATTERN.test(value))
    throw new ReviewLibraryError("INVALID_ARGUMENT");
  return value;
}

function hash(value: string): string {
  if (!HASH_PATTERN.test(value))
    throw new ReviewLibraryError("INVALID_ARGUMENT");
  return value;
}

function natural(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ReviewLibraryError("INVALID_ARGUMENT");
  return value;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ReviewLibraryError("INVALID_ARGUMENT");
  return value;
}

function originalFilename(value: string): string {
  const normalized = text(value, 255);
  if (normalized.includes("/") || normalized.includes("\\"))
    throw new ReviewLibraryError("INVALID_ARGUMENT");
  return normalized;
}

function codeOf(error: unknown): string {
  return error instanceof ReviewLibraryError
    ? error.code
    : error instanceof LibraryPathError
      ? error.code
      : "INTERNAL";
}

function mapPathError(error: unknown): never {
  if (error instanceof LibraryPathError)
    throw new ReviewLibraryError(error.code);
  throw error;
}

async function unlinkMissingOkay(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function sha256File(path: string): Promise<{ checksum: string; bytes: number }> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    digest.update(value);
  }
  return { checksum: digest.digest("hex"), bytes };
}

async function sha256Gunzip(path: string, maxBytes: number): Promise<string> {
  const digest = createHash("sha256");
  const source = createReadStream(path).pipe(createGunzip());
  let bytes = 0;
  for await (const chunk of source) {
    bytes += (chunk as Buffer).byteLength;
    if (bytes > maxBytes) {
      source.destroy();
      throw new ReviewLibraryError("ARTIFACT_TOO_LARGE");
    }
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

function hasDemoMagic(prefix: Uint8Array): boolean {
  return prefix.byteLength >= DEMO_MAGIC.byteLength &&
    Buffer.from(prefix.subarray(0, DEMO_MAGIC.byteLength)).equals(DEMO_MAGIC);
}

function cursorEncode(lastOpenedAt: string, reviewId: string): string {
  return Buffer.from(JSON.stringify([lastOpenedAt, reviewId]), "utf8").toString(
    "base64url",
  );
}

function cursorDecode(value: string): readonly [string, string] {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    )
      throw new Error("invalid");
    return [text(parsed[0], 64), opaque(parsed[1])];
  } catch {
    throw new ReviewLibraryError("INVALID_ARGUMENT");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

function deletionImpactToken(demoId: string, reviewIds: Iterable<string>): string {
  const digest = createHash("sha256").update(demoId);
  for (const reviewId of reviewIds) digest.update("\0").update(reviewId);
  return digest.digest("hex");
}

function deletionImpactTokenFromRows(
  demoId: string,
  rows: Iterable<{ readonly review_id: string }>,
): string {
  function* ids() {
    for (const row of rows) yield row.review_id;
  }
  return deletionImpactToken(demoId, ids());
}

function checkpointThreadIdForSession(sessionId: string): string {
  let value = 2_166_136_261;
  for (let index = 0; index < sessionId.length; index += 1) {
    value ^= sessionId.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return `coach-agent-v1-session-${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function objectValue(value: JsonValue): { readonly [key: string]: JsonValue } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as { readonly [key: string]: JsonValue };
}

function requiredNarrationCueIds(
  reviewPlanPayload: JsonValue,
  recoveryPayload: JsonValue,
): { readonly cueIds: ReadonlySet<string>; readonly invalidReference: boolean } {
  const plan = objectValue(reviewPlanPayload);
  const recovery = objectValue(recoveryPayload);
  const planCueIds = new Set<string>();
  const required = new Set<string>();
  const cues = plan?.cues;
  if (Array.isArray(cues)) {
    for (const rawCue of cues) {
      const cue = objectValue(rawCue);
      if (!cue) continue;
      const cueId = typeof cue?.id === "string" ? cue.id : undefined;
      if (!cueId) continue;
      planCueIds.add(cueId);
      if (cue.readiness === "READY" || cue.readiness === "FALLBACK")
        required.add(cueId);
      if (cue.status === "READY" || cue.status === "FALLBACK")
        required.add(cueId);
    }
  }
  let invalidReference = false;
  const readiness = objectValue(recovery?.routeReadiness as JsonValue);
  if (readiness) {
    for (const [cueId, status] of Object.entries(readiness)) {
      if (status !== "READY" && status !== "FALLBACK") continue;
      if (planCueIds.size > 0 && !planCueIds.has(cueId)) invalidReference = true;
      required.add(cueId);
    }
  }
  const recoveryNarrations = recovery?.narrationArtifacts;
  if (Array.isArray(recoveryNarrations)) {
    for (const rawNarration of recoveryNarrations) {
      const narration = objectValue(rawNarration);
      if (!narration) continue;
      const cueId = typeof narration?.cueId === "string" ? narration.cueId : undefined;
      if (
        !cueId ||
        (narration.readiness !== "READY" && narration.readiness !== "FALLBACK")
      )
        continue;
      if (planCueIds.size > 0 && !planCueIds.has(cueId)) invalidReference = true;
      required.add(cueId);
    }
  }
  return { cueIds: required, invalidReference };
}

function recoveryArtifactMatchesHead(
  payload: JsonValue,
  input: CommitRuntimeHeadInput,
): boolean {
  const record = objectValue(payload);
  const boundary = objectValue(record?.boundary as JsonValue);
  const frozenPlan = objectValue(record?.frozenReviewPlan as JsonValue);
  const cueProgress = objectValue(record?.cueProgress as JsonValue);
  const completedCueIds = cueProgress?.completedCueIds;
  const cues = frozenPlan?.cues;
  if (!record || !boundary || !frozenPlan) return false;
  if (
    record.sessionId !== input.sessionId ||
    record.runId !== input.runId ||
    record.demoContentHash !== input.demoContentHash ||
    record.selectedPlayerId !== input.selectedPlayerId ||
    record.routeId !== input.routeId ||
    record.routeHash !== input.routeHash ||
    frozenPlan.id !== input.routeId ||
    boundary.kind !== input.recoveryBoundary ||
    boundary.segmentIndex !== input.defaultRouteCursor ||
    record.agentCheckpointId !== (input.checkpointId ?? null) ||
    !Array.isArray(completedCueIds) ||
    completedCueIds.length !== input.completedCueCount ||
    !Array.isArray(cues) ||
    cues.length !== input.totalCueCount
  ) return false;
  if (input.recoveryBoundary === "CUE_PAUSED") {
    return typeof input.currentCueId === "string" && boundary.cueId === input.currentCueId;
  }
  return input.currentCueId === undefined || input.currentCueId === null;
}

export class DesktopReviewLibrary {
  readonly owner: SqliteDatabaseOwner;
  private readonly paths: LibraryPathPolicy;
  private readonly now: () => Date;
  private readonly capabilityTtlMs: number;
  private readonly smallJsonMaxBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly maxDemoBytes: number;
  private readonly partialMaxAgeMs: number;
  private readonly capabilities = new Map<string, CapabilityRecord>();
  private readonly activeJobIds = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(options: DesktopReviewLibraryOptions) {
    this.owner = options.owner;
    this.paths = new LibraryPathPolicy(options.dataRoot);
    this.now = options.now ?? (() => new Date());
    this.capabilityTtlMs = positive(
      Math.floor(options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS),
    );
    this.smallJsonMaxBytes = positive(
      Math.floor(options.smallJsonMaxBytes ?? DEFAULT_SMALL_JSON_MAX_BYTES),
    );
    this.maxArtifactBytes = positive(
      Math.floor(options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES),
    );
    this.maxDemoBytes = positive(
      Math.floor(options.maxDemoBytes ?? DEFAULT_MAX_DEMO_BYTES),
    );
    this.partialMaxAgeMs = positive(
      Math.floor(options.partialMaxAgeMs ?? DEFAULT_PARTIAL_MAX_AGE_MS),
    );
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new ReviewLibraryError("NOT_INITIALIZED");
  }

  private async critical<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(work);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async initialize(): Promise<LibraryReconcileResult> {
    try {
      this.paths.initialize();
    } catch (error) {
      mapPathError(error);
    }
    this.initialized = true;
    return this.cleanup();
  }

  private pruneCapabilities(): void {
    const now = this.now().getTime();
    for (const [token, capability] of this.capabilities)
      if (capability.expiresAtMs <= now) this.capabilities.delete(token);
  }

  private issue(
    purpose: "IMPORT" | "VIEW" | "VALIDATE",
    objectId: string,
    extra: Pick<CapabilityRecord, "originalFilename" | "expectedByteLength"> = {},
    ttlMs = this.capabilityTtlMs,
  ): LibraryCapability {
    this.requireInitialized();
    this.pruneCapabilities();
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now().getTime() + ttlMs;
    this.capabilities.set(token, {
      token,
      purpose,
      objectId: opaque(objectId),
      expiresAtMs,
      ...extra,
    });
    return {
      authorization: `Bearer ${token}`,
      objectId,
      purpose,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  issueImportCapability(input: IssueImportCapabilityInput): LibraryCapability {
    const length = positive(input.expectedByteLength);
    if (length < DEMO_MAGIC.byteLength || length > this.maxDemoBytes)
      throw new ReviewLibraryError("INVALID_ARGUMENT");
    return this.issue("IMPORT", input.objectId, {
      originalFilename: originalFilename(input.originalFilename),
      expectedByteLength: length,
    });
  }

  issueViewerCapability(input: { readonly demoId: string }): LibraryCapability {
    return this.issue("VIEW", input.demoId);
  }

  private reserveCapability(
    authorization: string | undefined,
    purpose: "IMPORT" | "VIEW" | "VALIDATE",
    objectId: string,
  ): CapabilityRecord {
    if (!authorization?.startsWith("Bearer "))
      throw new ReviewLibraryError("INVALID_CAPABILITY");
    const token = authorization.slice(7);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token))
      throw new ReviewLibraryError("INVALID_CAPABILITY");
    const capability = this.capabilities.get(token);
    if (!capability || capability.purpose !== purpose || capability.objectId !== objectId)
      throw new ReviewLibraryError("INVALID_CAPABILITY");
    if (capability.expiresAtMs <= this.now().getTime()) {
      this.capabilities.delete(token);
      throw new ReviewLibraryError("CAPABILITY_EXPIRED");
    }
    // Authorization is one-shot: the first attempted use consumes it even if
    // the subsequent stream, file validation, or database operation fails.
    this.capabilities.delete(token);
    return capability;
  }

  private managedPath(relativePath: string, kind: "demos" | "artifacts" | "tmp"): string {
    if (!relativePath.startsWith(`library/${kind}/`))
      throw new ReviewLibraryError("INVALID_RELATIVE_PATH");
    try {
      return this.paths.resolve(relativePath);
    } catch (error) {
      mapPathError(error);
    }
  }

  private ensureManagedParent(
    relativePath: string,
    kind: "demos" | "artifacts" | "tmp",
  ): string {
    if (!relativePath.startsWith(`library/${kind}/`))
      throw new ReviewLibraryError("INVALID_RELATIVE_PATH");
    try {
      return this.paths.ensureParent(relativePath);
    } catch (error) {
      mapPathError(error);
    }
  }

  async importDemo(input: ImportDemoInput): Promise<ImportDemoResult> {
    this.requireInitialized();
    const objectId = opaque(input.objectId);
    const capability = this.reserveCapability(
      input.authorization,
      "IMPORT",
      objectId,
    );
    const expectedByteLength = capability.expectedByteLength!;
    const filename = capability.originalFilename!;
    const jobId = randomUUID();
    const candidateDemoId = randomUUID();
    const tempRelativePath = this.paths.relative(
      "library",
      "tmp",
      `import-${jobId}.partial`,
    );
    const tempPath = this.ensureManagedParent(tempRelativePath, "tmp");
    const createdAt = this.iso();
    await this.owner.enqueueWrite((db) => {
      db.prepare(
        "INSERT INTO library_import_jobs(job_id,object_id,candidate_demo_id,original_filename,expected_byte_length,temp_relative_path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'WRITING',?,?)",
      ).run(
        jobId,
        objectId,
        candidateDemoId,
        filename,
        expectedByteLength,
        tempRelativePath,
        createdAt,
        createdAt,
      );
    });
    this.activeJobIds.add(jobId);

    const digest = createHash("sha256");
    const maxDemoBytes = this.maxDemoBytes;
    let byteSize = 0;
    let prefix = Buffer.alloc(0);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let output: ReturnType<Awaited<ReturnType<typeof open>>["createWriteStream"]> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      const inspect = new Transform({
        readableHighWaterMark: 64 * 1024,
        writableHighWaterMark: 64 * 1024,
        transform(raw: Buffer, _encoding, callback) {
          if (!(raw instanceof Uint8Array)) {
            callback(new ReviewLibraryError("INVALID_ARGUMENT"));
            return;
          }
          const chunk = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
          byteSize += chunk.byteLength;
          if (byteSize > expectedByteLength || byteSize > maxDemoBytes) {
            callback(new ReviewLibraryError("IMPORT_LENGTH_MISMATCH"));
            return;
          }
          if (prefix.byteLength < DEMO_MAGIC.byteLength) {
            const needed = DEMO_MAGIC.byteLength - prefix.byteLength;
            prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      output = handle.createWriteStream({
        autoClose: false,
        highWaterMark: 64 * 1024,
      });
      await pipeline(
        Readable.from(input.stream, { highWaterMark: 64 * 1024, objectMode: false }),
        inspect,
        output,
      );
      if (byteSize !== expectedByteLength)
        throw new ReviewLibraryError("IMPORT_LENGTH_MISMATCH");
      if (!hasDemoMagic(prefix)) throw new ReviewLibraryError("INVALID_DEMO");
      await handle.sync();
      const closed = once(output, "close");
      output.destroy();
      await closed;
      output = undefined;
      handle = undefined;
      await chmod(tempPath, 0o600);
      await this.paths.fsyncDirectory(this.paths.tmpRoot);
    } catch (error) {
      if (output && !output.closed) {
        const closed = once(output, "close");
        output.destroy();
        await closed.catch(() => undefined);
      }
      if (handle) await handle.close().catch(() => undefined);
      await unlinkMissingOkay(tempPath).catch(() => undefined);
      await this.owner.enqueueWrite((db) => {
        db.prepare(
          "UPDATE library_import_jobs SET status='FAILED',error_code=?,updated_at=? WHERE job_id=?",
        ).run(codeOf(error), this.iso(), jobId);
      });
      this.activeJobIds.delete(jobId);
      if (error instanceof ReviewLibraryError) throw error;
      throw error;
    }

    const contentHash = digest.digest("hex");
    const finalRelativePath = this.paths.relative(
      "library",
      "demos",
      contentHash.slice(0, 2),
      `${contentHash}.dem`,
    );
    try {
      await this.owner.enqueueWrite((db) => {
        db.prepare(
          "UPDATE library_import_jobs SET status='PUBLISHING',content_hash=?,byte_size=?,final_relative_path=?,updated_at=? WHERE job_id=?",
        ).run(contentHash, byteSize, finalRelativePath, this.iso(), jobId);
      });
    } catch (error) {
      this.activeJobIds.delete(jobId);
      throw error;
    }

    try {
      const result = await this.critical(() =>
        this.publishImport({
          job_id: jobId,
          object_id: objectId,
          candidate_demo_id: candidateDemoId,
          original_filename: filename,
          expected_byte_length: expectedByteLength,
          temp_relative_path: tempRelativePath,
          final_relative_path: finalRelativePath,
          content_hash: contentHash,
          byte_size: byteSize,
          status: "PUBLISHING",
        }),
      );
      this.activeJobIds.delete(jobId);
      return result;
    } catch (error) {
      this.activeJobIds.delete(jobId);
      throw error;
    }
  }

  private async publishImport(job: ImportJobRow): Promise<ImportDemoResult> {
    const contentHash = hash(job.content_hash!);
    const byteSize = positive(job.byte_size!);
    const tempPath = this.managedPath(job.temp_relative_path, "tmp");
    const finalPath = this.ensureManagedParent(job.final_relative_path!, "demos");
    let deduplicated = false;
    const verifyPublishedFile = async () => {
      const existing = await sha256File(finalPath);
      if (existing.bytes !== byteSize || existing.checksum !== contentHash)
        throw new ReviewLibraryError("INVALID_DEMO");
    };
    let finalAlreadyExists = false;
    try {
      const metadata = await lstat(finalPath);
      if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new ReviewLibraryError("INVALID_DEMO");
      finalAlreadyExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (finalAlreadyExists) {
      await verifyPublishedFile();
      deduplicated = true;
    } else {
      try {
        await link(tempPath, finalPath);
        await chmod(finalPath, 0o600);
        await this.paths.fsyncDirectory(dirname(finalPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await verifyPublishedFile();
        deduplicated = true;
      }
    }
    await unlinkMissingOkay(tempPath);
    await this.paths.fsyncDirectory(this.paths.tmpRoot);

    const now = this.iso();
    const outcome = await this.owner.enqueueWrite((db) => {
      const existing = db
        .prepare("SELECT * FROM demo_assets WHERE content_hash=?")
        .get(contentHash) as DemoRow | undefined;
      if (existing) {
        if (
          existing.relative_path !== job.final_relative_path ||
          existing.byte_size !== byteSize
        )
          throw new ReviewLibraryError("INVALID_DEMO");
        const status = existing.status === "READY" ? "READY" : "IMPORTING";
        db.prepare(
          "UPDATE demo_assets SET status=?,last_opened_at=? WHERE demo_id=?",
        ).run(status, now, existing.demo_id);
        db.prepare(
          "UPDATE library_import_jobs SET status='COMPLETED',error_code=NULL,updated_at=? WHERE job_id=?",
        ).run(now, job.job_id);
        return {
          row: { ...existing, status, last_opened_at: now } as DemoRow,
          duplicate: true,
          requiresValidation: status !== "READY",
        };
      }
      db.prepare(
        "INSERT INTO demo_assets(demo_id,content_hash,relative_path,original_filename,byte_size,status,imported_at,last_opened_at) VALUES(?,?,?,?,?,'IMPORTING',?,?)",
      ).run(
        job.candidate_demo_id,
        contentHash,
        job.final_relative_path,
        job.original_filename,
        byteSize,
        now,
        now,
      );
      db.prepare(
        "UPDATE library_import_jobs SET status='COMPLETED',error_code=NULL,updated_at=? WHERE job_id=?",
      ).run(now, job.job_id);
      return {
        row: db
          .prepare("SELECT * FROM demo_assets WHERE demo_id=?")
          .get(job.candidate_demo_id) as unknown as DemoRow,
        duplicate: false,
        requiresValidation: true,
      };
    });
    return {
      demo: demoFromRow(outcome.row),
      deduplicated: deduplicated || outcome.duplicate,
      ...(outcome.requiresValidation
        ? { validationCapability: this.issue("VALIDATE", outcome.row.demo_id, {}, 15 * 60_000) }
        : {}),
    };
  }

  /** Completes the two-phase import only after the real parser accepts bytes. */
  async finalizeDemoImport(input: {
    readonly authorization?: string;
    readonly demoId: string;
    readonly valid: boolean;
    readonly parserVersion?: string;
  }): Promise<DemoAsset> {
    this.requireInitialized();
    const demoId = opaque(input.demoId);
    this.reserveCapability(input.authorization, "VALIDATE", demoId);
    await this.owner.enqueueWrite((db) => {
      const row = db.prepare("SELECT status FROM demo_assets WHERE demo_id=?").get(demoId) as
        | { status: DemoAsset["status"] }
        | undefined;
      if (!row) throw new ReviewLibraryError("DEMO_NOT_FOUND");
      const nextStatus = input.valid ? "READY" : row.status === "READY" ? "READY" : "CORRUPT";
      db.prepare(
        "UPDATE demo_assets SET status=?,parser_version=COALESCE(?,parser_version),last_verified_at=?,last_opened_at=? WHERE demo_id=?",
      ).run(
        nextStatus,
        input.valid && input.parserVersion ? text(input.parserVersion, 160) : null,
        this.iso(),
        this.iso(),
        demoId,
      );
    });
    const row = this.owner.db.prepare("SELECT * FROM demo_assets WHERE demo_id=?").get(demoId) as unknown as DemoRow;
    return demoFromRow(row);
  }

  async resolveViewerDemo(input: {
    readonly authorization?: string;
    readonly demoId: string;
  }): Promise<ViewerDemoSource> {
    this.requireInitialized();
    const demoId = opaque(input.demoId);
    this.reserveCapability(
      input.authorization,
      "VIEW",
      demoId,
    );
    let descriptor: number | undefined;
    try {
      const pendingDelete = this.owner.db
        .prepare(
          "SELECT 1 present FROM library_delete_jobs WHERE target_kind='DEMO' AND target_id=? AND status!='COMPLETED' LIMIT 1",
        )
        .get(demoId);
      if (pendingDelete) throw new ReviewLibraryError("DEMO_NOT_READY");
      const row = this.owner.db
        .prepare("SELECT * FROM demo_assets WHERE demo_id=?")
        .get(demoId) as DemoRow | undefined;
      if (!row) throw new ReviewLibraryError("DEMO_NOT_FOUND");
      if (row.status !== "READY")
        throw new ReviewLibraryError("DEMO_NOT_READY");
      const absolute = this.managedPath(row.relative_path, "demos");
      descriptor = openSync(
        absolute,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      if (fstatSync(descriptor).size !== row.byte_size)
        throw new ReviewLibraryError("DEMO_NOT_READY");
      const now = this.iso();
      await this.owner.enqueueWrite((db) => {
        db.prepare("UPDATE demo_assets SET last_opened_at=? WHERE demo_id=?").run(
          now,
          demoId,
        );
      });
      const body = createReadStream(absolute, {
        fd: descriptor,
        autoClose: true,
      });
      descriptor = undefined;
      return {
        demoId,
        contentHash: row.content_hash,
        byteSize: row.byte_size,
        originalFilename: row.original_filename,
        body,
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      throw error;
    }
  }

  async listReviews(input: ListReviewsInput = {}): Promise<ReviewPage> {
    this.requireInitialized();
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 50), 100));
    const cursor = input.cursor ? cursorDecode(input.cursor) : undefined;
    const search = input.search?.trim().slice(0, 160);
    const clauses: string[] = [
      "NOT EXISTS (SELECT 1 FROM library_delete_jobs j WHERE j.status!='COMPLETED' AND ((j.target_kind='REVIEW' AND j.target_id=r.review_id) OR (j.target_kind='DEMO' AND j.target_id=r.demo_id)))",
    ];
    const values: Array<string | number> = [];
    if (search) {
      clauses.push(
        "(lower(r.title) LIKE ? ESCAPE '\\' OR lower(r.map_name) LIKE ? ESCAPE '\\' OR lower(r.selected_player_name) LIKE ? ESCAPE '\\' OR lower(d.original_filename) LIKE ? ESCAPE '\\')",
      );
      const pattern = `%${escapeLike(search.toLocaleLowerCase())}%`;
      values.push(pattern, pattern, pattern, pattern);
    }
    if (cursor) {
      clauses.push("(r.last_opened_at<? OR (r.last_opened_at=? AND r.review_id<?))");
      values.push(cursor[0], cursor[0], cursor[1]);
    }
    values.push(limit + 1);
    const rows = this.owner.db
      .prepare(
        `SELECT r.*,d.original_filename,d.status AS demo_status FROM reviews r JOIN demo_assets d ON d.demo_id=r.demo_id ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY r.last_opened_at DESC,r.review_id DESC LIMIT ?`,
      )
      .all(...values) as unknown as ReviewRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      items: selected.map(reviewFromRow),
      nextCursor:
        hasMore && last
          ? cursorEncode(last.last_opened_at, last.review_id)
          : null,
    };
  }

  async listLibraryEntries(input: { readonly limit?: number } = {}): Promise<ReviewLibraryEntries> {
    this.requireInitialized();
    const limit = Math.max(
      1,
      Math.min(Math.floor(input.limit ?? MAX_LIBRARY_ENTRIES), MAX_LIBRARY_ENTRIES),
    );
    const reviews = await this.listReviews({ limit });
    const demoRows = this.owner.db
      .prepare(
        `SELECT d.demo_id,d.original_filename,d.byte_size,d.map_name,d.status,d.imported_at,d.last_opened_at,COUNT(r.review_id) AS review_count
         FROM demo_assets d
         LEFT JOIN reviews r ON r.demo_id=d.demo_id
           AND NOT EXISTS (SELECT 1 FROM library_delete_jobs j WHERE j.status!='COMPLETED' AND j.target_kind='REVIEW' AND j.target_id=r.review_id)
         WHERE NOT EXISTS (SELECT 1 FROM library_delete_jobs j WHERE j.status!='COMPLETED' AND j.target_kind='DEMO' AND j.target_id=d.demo_id)
         GROUP BY d.demo_id
         ORDER BY d.last_opened_at DESC,d.demo_id DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
        demo_id: string;
        original_filename: string;
        byte_size: number;
        map_name: string | null;
        status: DemoAsset["status"];
        imported_at: string;
        last_opened_at: string;
        review_count: number;
      }>;
    const demos: DemoLibraryEntry[] = demoRows.map((row) => ({
      demoId: row.demo_id,
      originalFilename: row.original_filename,
      byteSize: row.byte_size,
      mapName: defined(row.map_name),
      status: row.status,
      importedAt: row.imported_at,
      lastOpenedAt: row.last_opened_at,
      reviewCount: row.review_count,
    }));
    return {
      schemaVersion: "review-library-entries.v1",
      reviews: reviews.items,
      demos,
    };
  }

  private artifactFromRow(row: ArtifactRow, payload?: JsonValue): ReviewArtifact {
    return {
      artifactId: row.artifact_id,
      reviewRevisionId: row.review_revision_id,
      artifactType: row.artifact_type,
      artifactKey: row.artifact_key,
      artifactRevision: row.artifact_revision,
      schemaVersion: row.schema_version,
      checksum: row.checksum,
      storageKind: row.storage_kind,
      byteSize: row.byte_size,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      ...(payload === undefined ? {} : { payload }),
    };
  }

  private async materializeArtifact(row: ArtifactRow): Promise<ReviewArtifact> {
    if (row.storage_kind === "SQLITE_JSON")
      return this.artifactFromRow(
        row,
        JSON.parse(row.json_payload!) as JsonValue,
      );
    const absolute = this.managedPath(row.relative_path!, "artifacts");
    let compressed: Buffer;
    try {
      const info = await stat(absolute);
      if (
        info.size !== row.byte_size ||
        info.size > this.maxArtifactBytes + 1024 * 1024
      )
        throw new ReviewLibraryError("ARTIFACT_CORRUPT");
      compressed = await readFile(absolute);
    } catch {
      throw new ReviewLibraryError("ARTIFACT_CORRUPT");
    }
    let uncompressed: Buffer;
    try {
      uncompressed = await gunzipBytes(compressed, {
        maxOutputLength: this.maxArtifactBytes,
      });
    } catch {
      throw new ReviewLibraryError("ARTIFACT_CORRUPT");
    }
    if (
      createHash("sha256").update(uncompressed).digest("hex") !== row.checksum
    )
      throw new ReviewLibraryError("ARTIFACT_CORRUPT");
    try {
      return this.artifactFromRow(
        row,
        JSON.parse(uncompressed.toString("utf8")) as JsonValue,
      );
    } catch {
      throw new ReviewLibraryError("ARTIFACT_CORRUPT");
    }
  }

  async loadReview(
    reviewIdValue: string,
    options: LoadReviewOptions = {},
  ): Promise<LoadedReview> {
    this.requireInitialized();
    const reviewId = opaque(reviewIdValue);
    const now = this.iso();
    await this.owner.enqueueWrite((db) => {
      if (
        db
          .prepare(
            "SELECT 1 FROM reviews r JOIN library_delete_jobs j ON j.status!='COMPLETED' AND ((j.target_kind='REVIEW' AND j.target_id=r.review_id) OR (j.target_kind='DEMO' AND j.target_id=r.demo_id)) WHERE r.review_id=? LIMIT 1",
          )
          .get(reviewId)
      )
        throw new ReviewLibraryError("DELETE_FAILED");
      const result = db
        .prepare("UPDATE reviews SET last_opened_at=? WHERE review_id=?")
        .run(now, reviewId);
      if (result.changes !== 1)
        throw new ReviewLibraryError("REVIEW_NOT_FOUND");
      db.prepare(
        "UPDATE demo_assets SET last_opened_at=? WHERE demo_id=(SELECT demo_id FROM reviews WHERE review_id=?)",
      ).run(now, reviewId);
    });
    const reviewRow = this.owner.db
      .prepare(
        "SELECT r.*,d.original_filename,d.status AS demo_status FROM reviews r JOIN demo_assets d ON d.demo_id=r.demo_id WHERE r.review_id=?",
      )
      .get(reviewId) as unknown as ReviewRow;
    const demoRow = this.owner.db
      .prepare("SELECT * FROM demo_assets WHERE demo_id=?")
      .get(reviewRow.demo_id) as unknown as DemoRow;
    const revisionRows = this.owner.db
      .prepare(
        "SELECT * FROM review_revisions WHERE review_id=? ORDER BY created_at,review_revision_id",
      )
      .all(reviewId) as unknown as RevisionRow[];
    const requestedRevisionId = options.reviewRevisionId
      ? opaque(options.reviewRevisionId)
      : undefined;
    if (requestedRevisionId && !revisionRows.some((row) => row.review_revision_id === requestedRevisionId)) {
      throw new ReviewLibraryError("REVISION_NOT_FOUND");
    }
    const detailRevisionId = requestedRevisionId ??
      reviewRow.active_revision_id ?? revisionRows.at(-1)?.review_revision_id;
    const artifactRows = detailRevisionId
      ? (this.owner.db
          .prepare(
            "SELECT * FROM review_artifacts WHERE review_revision_id=? ORDER BY created_at,artifact_id LIMIT ?",
          )
          .all(detailRevisionId, MAX_REVIEW_DETAIL_ARTIFACTS + 1) as unknown as ArtifactRow[])
      : [];
    const selectedArtifactRows = artifactRows.slice(0, MAX_REVIEW_DETAIL_ARTIFACTS);
    const artifacts: ReviewArtifact[] = [];
    const artifactIssues: ReviewArtifactIssue[] = [];
    for (const row of selectedArtifactRows) {
      try {
        artifacts.push(
          row.storage_kind === "SQLITE_JSON" ||
            options.materializeExternalArtifacts === true
            ? await this.materializeArtifact(row)
            : this.artifactFromRow(row),
        );
      } catch (error) {
        if (
          options.materializeExternalArtifacts === true &&
          error instanceof ReviewLibraryError &&
          error.code === "ARTIFACT_CORRUPT"
        ) {
          artifactIssues.push({
            kind: row.artifact_type,
            key: row.artifact_key,
            code: "ARTIFACT_CORRUPT",
          });
          continue;
        }
        throw error;
      }
    }
    const overflow = artifactRows[MAX_REVIEW_DETAIL_ARTIFACTS];
    if (overflow) {
      artifactIssues.push({
        kind: overflow.artifact_type,
        key: overflow.artifact_key,
        code: "ARTIFACT_LIMIT_EXCEEDED",
      });
    }
    const runtimeRow = this.owner.db
      .prepare("SELECT * FROM review_runtime_heads WHERE review_id=?")
      .get(reviewId) as RuntimeHeadRow | undefined;
    return {
      demo: demoFromRow(demoRow),
      review: reviewFromRow(reviewRow),
      revisions: revisionRows.map(revisionFromRow),
      artifacts,
      artifactIssues,
      runtimeHead: runtimeRow ? runtimeHeadFromRow(runtimeRow) : undefined,
    };
  }

  async createReview(input: CreateReviewInput): Promise<ReviewRecord> {
    this.requireInitialized();
    const demoId = opaque(input.demoId);
    const reviewId = randomUUID();
    const now = this.iso();
    await this.owner.enqueueWrite((db) => {
      const demo = db
        .prepare("SELECT status,map_name FROM demo_assets WHERE demo_id=?")
        .get(demoId) as { status: DemoAsset["status"]; map_name: string | null } | undefined;
      if (!demo) throw new ReviewLibraryError("DEMO_NOT_FOUND");
      if (demo.status !== "READY")
        throw new ReviewLibraryError("DEMO_NOT_READY");
      if (
        db
          .prepare(
            "SELECT 1 FROM library_delete_jobs WHERE target_kind='DEMO' AND target_id=? AND status!='COMPLETED' LIMIT 1",
          )
          .get(demoId)
      )
        throw new ReviewLibraryError("DEMO_NOT_READY");
      db.prepare(
        "INSERT INTO reviews(review_id,demo_id,selected_player_id,selected_player_name,title,map_name,score_text,status,created_at,last_opened_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        reviewId,
        demoId,
        text(input.selectedPlayerId, 160),
        text(input.selectedPlayerName, 160),
        text(input.title, 200),
        input.mapName ? text(input.mapName, 120) : demo.map_name,
        input.scoreText ? text(input.scoreText, 80) : null,
        input.status ?? "PREPARING",
        now,
        now,
      );
    });
    return this.reviewById(reviewId);
  }

  private reviewById(reviewId: string): ReviewRecord {
    if (
      this.owner.db
        .prepare(
          "SELECT 1 FROM reviews r JOIN library_delete_jobs j ON j.status!='COMPLETED' AND ((j.target_kind='REVIEW' AND j.target_id=r.review_id) OR (j.target_kind='DEMO' AND j.target_id=r.demo_id)) WHERE r.review_id=? LIMIT 1",
        )
        .get(reviewId)
    )
      throw new ReviewLibraryError("DELETE_FAILED");
    const row = this.owner.db
      .prepare(
        "SELECT r.*,d.original_filename,d.status AS demo_status FROM reviews r JOIN demo_assets d ON d.demo_id=r.demo_id WHERE r.review_id=?",
      )
      .get(reviewId) as ReviewRow | undefined;
    if (!row) throw new ReviewLibraryError("REVIEW_NOT_FOUND");
    return reviewFromRow(row);
  }

  async startRevision(input: StartRevisionInput): Promise<ReviewRevision> {
    this.requireInitialized();
    const reviewId = opaque(input.reviewId);
    const reviewRevisionId = randomUUID();
    const model = json(input.modelMetadata, this.smallJsonMaxBytes);
    const now = this.iso();
    await this.owner.enqueueWrite((db) => {
      if (!db.prepare("SELECT 1 FROM reviews WHERE review_id=?").get(reviewId))
        throw new ReviewLibraryError("REVIEW_NOT_FOUND");
      db.prepare(
        "INSERT INTO review_revisions(review_revision_id,review_id,analysis_version,graph_version,prompt_version,model_json,route_id,route_hash,status,artifact_contract_version,created_at) VALUES(?,?,?,?,?,?,?,?, 'PREPARING',2,?)",
      ).run(
        reviewRevisionId,
        reviewId,
        text(input.analysisVersion, 160),
        text(input.graphVersion, 160),
        text(input.promptVersion, 160),
        model.text,
        input.routeId ? text(input.routeId, 160) : null,
        text(input.routeHash, 160),
        now,
      );
    });
    return revisionFromRow(
      this.owner.db
        .prepare("SELECT * FROM review_revisions WHERE review_revision_id=?")
        .get(reviewRevisionId) as unknown as RevisionRow,
    );
  }

  async appendArtifact(input: AppendArtifactInput): Promise<ReviewArtifact> {
    this.requireInitialized();
    const reviewRevisionId = opaque(input.reviewRevisionId);
    const artifactKey = text(input.artifactKey, 240);
    const idempotencyKey = text(input.idempotencyKey, 240);
    const schemaVersion = text(input.schemaVersion, 160);
    const artifactRevision = positive(input.artifactRevision);
    const serialized = json(input.payload, this.maxArtifactBytes);
    const checksum = createHash("sha256").update(serialized.text).digest("hex");
    return this.critical(async () => {
      const existingByIdempotency = this.owner.db
        .prepare(
          "SELECT * FROM review_artifacts WHERE review_revision_id=? AND idempotency_key=?",
        )
        .get(reviewRevisionId, idempotencyKey) as ArtifactRow | undefined;
      const existingByIdentity = this.owner.db
        .prepare(
          "SELECT * FROM review_artifacts WHERE review_revision_id=? AND artifact_type=? AND artifact_key=? AND artifact_revision=?",
        )
        .get(
          reviewRevisionId,
          input.artifactType,
          artifactKey,
          artifactRevision,
        ) as ArtifactRow | undefined;
      for (const existing of [existingByIdempotency, existingByIdentity]) {
        if (!existing) continue;
        if (
          existing.checksum !== checksum ||
          existing.artifact_type !== input.artifactType ||
          existing.artifact_key !== artifactKey ||
          existing.artifact_revision !== artifactRevision ||
          existing.schema_version !== schemaVersion ||
          existing.idempotency_key !== idempotencyKey
        )
          throw new ReviewLibraryError("ARTIFACT_CONFLICT");
        return existing.storage_kind === "SQLITE_JSON"
          ? this.materializeArtifact(existing)
          : this.artifactFromRow(existing);
      }
      const revision = this.owner.db
        .prepare(
          "SELECT rr.review_id FROM review_revisions rr WHERE rr.review_revision_id=?",
        )
        .get(reviewRevisionId) as { review_id: string } | undefined;
      if (!revision) throw new ReviewLibraryError("REVISION_NOT_FOUND");
      const external = serialized.bytes > this.smallJsonMaxBytes;
      if (external && input.artifactType !== "ANALYSIS_BUNDLE")
        throw new ReviewLibraryError("ARTIFACT_TOO_LARGE");
      const artifactId = randomUUID();
      const now = this.iso();
      if (!external) {
        await this.owner.enqueueWrite((db) => {
          db.prepare(
            "INSERT INTO review_artifacts(artifact_id,review_revision_id,artifact_type,artifact_key,artifact_revision,schema_version,checksum,storage_kind,json_payload,byte_size,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,'SQLITE_JSON',?,?,?,?)",
          ).run(
            artifactId,
            reviewRevisionId,
            input.artifactType,
            artifactKey,
            artifactRevision,
            schemaVersion,
            checksum,
            serialized.text,
            serialized.bytes,
            idempotencyKey,
            now,
          );
        });
        return this.materializeArtifact(
          this.owner.db
            .prepare("SELECT * FROM review_artifacts WHERE artifact_id=?")
            .get(artifactId) as unknown as ArtifactRow,
        );
      }

      const jobId = randomUUID();
      const tempRelativePath = this.paths.relative(
        "library",
        "tmp",
        `artifact-${jobId}.partial`,
      );
      const finalRelativePath = this.paths.relative(
        "library",
        "artifacts",
        revision.review_id,
        reviewRevisionId,
        `${artifactId}.json.gz`,
      );
      const tempPath = this.ensureManagedParent(tempRelativePath, "tmp");
      const finalPath = this.ensureManagedParent(finalRelativePath, "artifacts");
      await this.owner.enqueueWrite((db) => {
        db.prepare(
          "INSERT INTO library_artifact_jobs(job_id,artifact_id,review_revision_id,artifact_type,artifact_key,artifact_revision,schema_version,checksum,idempotency_key,temp_relative_path,final_relative_path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'WRITING',?,?)",
        ).run(
          jobId,
          artifactId,
          reviewRevisionId,
          input.artifactType,
          artifactKey,
          artifactRevision,
          schemaVersion,
          checksum,
          idempotencyKey,
          tempRelativePath,
          finalRelativePath,
          now,
          now,
        );
      });
      this.activeJobIds.add(jobId);
      let recoverablePublish = false;
      try {
        const file = await open(tempPath, "wx", 0o600);
        try {
          const output = createWriteStream(tempPath, {
            fd: file.fd,
            autoClose: false,
          });
          await pipeline(Readable.from([serialized.text]), createGzip(), output);
          await file.sync();
        } finally {
          await file.close();
        }
        await chmod(tempPath, 0o600);
        await this.paths.fsyncDirectory(this.paths.tmpRoot);
        await this.owner.enqueueWrite((db) => {
          db.prepare(
            "UPDATE library_artifact_jobs SET status='PUBLISHING',updated_at=? WHERE job_id=?",
          ).run(this.iso(), jobId);
        });
        recoverablePublish = true;
        await link(tempPath, finalPath);
        await chmod(finalPath, 0o600);
        await this.paths.fsyncDirectory(dirname(finalPath));
        await unlinkMissingOkay(tempPath);
        await this.paths.fsyncDirectory(this.paths.tmpRoot);
        const storedSize = (await stat(finalPath)).size;
        await this.owner.enqueueWrite((db) => {
          db.prepare(
            "INSERT INTO review_artifacts(artifact_id,review_revision_id,artifact_type,artifact_key,artifact_revision,schema_version,checksum,storage_kind,relative_path,byte_size,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,'GZIP_FILE',?,?,?,?)",
          ).run(
            artifactId,
            reviewRevisionId,
            input.artifactType,
            artifactKey,
            artifactRevision,
            schemaVersion,
            checksum,
            finalRelativePath,
            storedSize,
            idempotencyKey,
            now,
          );
          db.prepare(
            "UPDATE library_artifact_jobs SET status='COMPLETED',error_code=NULL,updated_at=? WHERE job_id=?",
          ).run(this.iso(), jobId);
        });
        return this.artifactFromRow(
          this.owner.db
            .prepare("SELECT * FROM review_artifacts WHERE artifact_id=?")
            .get(artifactId) as unknown as ArtifactRow,
        );
      } catch (error) {
        if (!recoverablePublish)
          await unlinkMissingOkay(tempPath).catch(() => undefined);
        await this.owner.enqueueWrite((db) => {
          db.prepare(
            "UPDATE library_artifact_jobs SET status=?,error_code=?,updated_at=? WHERE job_id=?",
          ).run(
            recoverablePublish ? "PUBLISHING" : "FAILED",
            codeOf(error),
            this.iso(),
            jobId,
          );
        });
        throw error;
      } finally {
        this.activeJobIds.delete(jobId);
      }
    });
  }

  async commitRuntimeHead(input: CommitRuntimeHeadInput): Promise<ReviewRuntimeHead> {
    this.requireInitialized();
    const recoveryArtifactKey = text(input.recoveryArtifactKey, 240);
    const recoveryArtifactRevision = positive(input.recoveryArtifactRevision);
    const checkpoint = [
      input.checkpointThreadId,
      input.checkpointNamespace,
      input.checkpointId,
    ];
    const checkpointCount = checkpoint.filter((value) => value !== undefined).length;
    if (
      (checkpointCount !== 0 && checkpointCount !== 3) ||
      (input.recoveryBoundary !== "ROUTE_START" && checkpointCount !== 3)
    )
      throw new ReviewLibraryError("RUNTIME_HEAD_IDENTITY_MISMATCH");
    if (checkpointCount === 3) {
      try {
        const saver = new SqliteCheckpointSaver({ owner: this.owner });
        const tuple = await saver.getTuple({
          configurable: {
            thread_id: input.checkpointThreadId!,
            checkpoint_ns: input.checkpointNamespace!,
            checkpoint_id: input.checkpointId!,
          },
        });
        const agent = tuple?.checkpoint.channel_values.agent as
          | Record<string, unknown>
          | undefined;
        if (
          !tuple ||
          !agent ||
          agent.sessionId !== input.sessionId ||
          agent.runId !== input.runId ||
          agent.demoId !== input.demoId ||
          agent.demoContentHash !== input.demoContentHash ||
          agent.selectedPlayerId !== input.selectedPlayerId ||
          agent.routeId !== input.routeId ||
          agent.routeHash !== input.routeHash
        )
          throw new ReviewLibraryError("RUNTIME_HEAD_IDENTITY_MISMATCH");
      } catch (error) {
        if (error instanceof ReviewLibraryError) throw error;
        throw new ReviewLibraryError("RUNTIME_HEAD_IDENTITY_MISMATCH");
      }
    }
    const stable = json(input.stableProgress, this.smallJsonMaxBytes);
    const now = this.iso();
    await this.owner.enqueueWrite((db) => {
      const identity = db
        .prepare(
          "SELECT r.demo_id,r.selected_player_id,d.content_hash,rr.review_id,rr.route_id,rr.route_hash FROM reviews r JOIN demo_assets d ON d.demo_id=r.demo_id JOIN review_revisions rr ON rr.review_revision_id=? WHERE r.review_id=?",
        )
        .get(input.reviewRevisionId, input.reviewId) as
        | {
            demo_id: string;
            selected_player_id: string;
            content_hash: string;
            review_id: string;
            route_id: string | null;
            route_hash: string;
          }
        | undefined;
      if (
        !identity ||
        identity.review_id !== input.reviewId ||
        identity.demo_id !== input.demoId ||
        identity.content_hash !== input.demoContentHash ||
        identity.selected_player_id !== input.selectedPlayerId ||
        identity.route_hash !== input.routeHash ||
        (identity.route_id !== null && identity.route_id !== input.routeId)
      )
        throw new ReviewLibraryError("RUNTIME_HEAD_IDENTITY_MISMATCH");
      const recoveryArtifact = db
        .prepare(
          `SELECT artifact_id,artifact_key,artifact_revision,json_payload
           FROM review_artifacts
           WHERE review_revision_id=?
             AND artifact_type='SESSION_RECOVERY'
             AND artifact_key=?
             AND artifact_revision=?
             AND storage_kind='SQLITE_JSON'
           LIMIT 1`,
        )
        .get(input.reviewRevisionId, recoveryArtifactKey, recoveryArtifactRevision) as
        | {
            artifact_id: string;
            artifact_key: string;
            artifact_revision: number;
            json_payload: string;
          }
        | undefined;
      if (!recoveryArtifact) {
        throw new ReviewLibraryError("REVISION_ARTIFACTS_INCOMPLETE");
      }
      let recoveryPayload: JsonValue;
      try {
        recoveryPayload = JSON.parse(recoveryArtifact.json_payload) as JsonValue;
      } catch {
        throw new ReviewLibraryError("REVISION_ARTIFACTS_INCOMPLETE");
      }
      if (!recoveryArtifactMatchesHead(recoveryPayload, input)) {
        throw new ReviewLibraryError("RUNTIME_HEAD_IDENTITY_MISMATCH");
      }
      const criticalArtifacts = db
        .prepare(
          `SELECT COUNT(DISTINCT artifact_type) AS count
           FROM review_artifacts
           WHERE review_revision_id=? AND artifact_type IN (?,?,?,?)`,
        )
        .get(input.reviewRevisionId, ...REQUIRED_RUNTIME_ARTIFACTS) as { count: number };
      if (criticalArtifacts.count !== REQUIRED_RUNTIME_ARTIFACTS.length)
        throw new ReviewLibraryError("REVISION_ARTIFACTS_INCOMPLETE");
      const criticalPayloadRows = db
        .prepare(
          `SELECT artifact_type,json_payload
           FROM review_artifacts
           WHERE review_revision_id=?
             AND artifact_type='REVIEW_PLAN'
             AND storage_kind='SQLITE_JSON'
           ORDER BY created_at DESC,rowid DESC`,
        )
        .all(input.reviewRevisionId) as Array<{
          artifact_type: "REVIEW_PLAN";
          json_payload: string;
        }>;
      const reviewPlanRow = criticalPayloadRows.find(
        (row) => row.artifact_type === "REVIEW_PLAN",
      );
      if (!reviewPlanRow)
        throw new ReviewLibraryError("REVISION_ARTIFACTS_INCOMPLETE");
      const narrationRequirement = requiredNarrationCueIds(
        JSON.parse(reviewPlanRow.json_payload) as JsonValue,
        recoveryPayload,
      );
      const narrationKeys = new Set(
        (
          db
            .prepare(
              "SELECT DISTINCT artifact_key FROM review_artifacts WHERE review_revision_id=? AND artifact_type='NARRATION_BUNDLE'",
            )
            .all(input.reviewRevisionId) as Array<{ artifact_key: string }>
        ).map((row) => row.artifact_key),
      );
      if (
        narrationRequirement.invalidReference ||
        [...narrationRequirement.cueIds].some((cueId) => !narrationKeys.has(cueId))
      )
        throw new ReviewLibraryError("REVISION_ARTIFACTS_INCOMPLETE");
      if (checkpointCount === 3) {
        const stored = db
          .prepare(
            "SELECT completed FROM agent_checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?",
          )
          .get(
            input.checkpointThreadId!,
            input.checkpointNamespace!,
            input.checkpointId!,
          ) as { completed: number } | undefined;
        if (
          !stored ||
          (input.recoveryBoundary === "WRAP_UP"
            ? stored.completed !== 1
            : stored.completed !== 0)
        )
          throw new ReviewLibraryError("RUNTIME_HEAD_IDENTITY_MISMATCH");
      }
      const previous = db
        .prepare(
          "SELECT review_revision_id,session_id,run_id,route_id,route_hash,default_route_cursor,completed_cue_count,recovery_boundary FROM review_runtime_heads WHERE review_id=?",
        )
        .get(input.reviewId) as
        | {
            review_revision_id: string;
            session_id: string;
            run_id: string;
            route_id: string;
            route_hash: string;
            default_route_cursor: number;
            completed_cue_count: number;
            recovery_boundary: RecoveryBoundary;
          }
        | undefined;
      if (
        previous?.review_revision_id === input.reviewRevisionId &&
        (previous.session_id !== input.sessionId ||
          previous.run_id !== input.runId ||
          previous.route_id !== input.routeId ||
          previous.route_hash !== input.routeHash ||
          input.defaultRouteCursor < previous.default_route_cursor ||
          input.completedCueCount < previous.completed_cue_count ||
          (previous.recovery_boundary === "WRAP_UP" &&
            input.recoveryBoundary !== "WRAP_UP"))
      )
        throw new ReviewLibraryError("RUNTIME_HEAD_IDENTITY_MISMATCH");
      db.prepare(
        "INSERT INTO review_runtime_heads(review_id,review_revision_id,recovery_artifact_id,recovery_artifact_key,recovery_artifact_revision,session_id,run_id,demo_id,demo_content_hash,selected_player_id,route_id,route_hash,recovery_boundary,checkpoint_thread_id,checkpoint_namespace,checkpoint_id,current_cue_id,default_route_cursor,completed_cue_count,total_cue_count,last_playback_tick,stable_progress_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(review_id) DO UPDATE SET review_revision_id=excluded.review_revision_id,recovery_artifact_id=excluded.recovery_artifact_id,recovery_artifact_key=excluded.recovery_artifact_key,recovery_artifact_revision=excluded.recovery_artifact_revision,session_id=excluded.session_id,run_id=excluded.run_id,demo_id=excluded.demo_id,demo_content_hash=excluded.demo_content_hash,selected_player_id=excluded.selected_player_id,route_id=excluded.route_id,route_hash=excluded.route_hash,recovery_boundary=excluded.recovery_boundary,checkpoint_thread_id=excluded.checkpoint_thread_id,checkpoint_namespace=excluded.checkpoint_namespace,checkpoint_id=excluded.checkpoint_id,current_cue_id=excluded.current_cue_id,default_route_cursor=excluded.default_route_cursor,completed_cue_count=excluded.completed_cue_count,total_cue_count=excluded.total_cue_count,last_playback_tick=excluded.last_playback_tick,stable_progress_json=excluded.stable_progress_json,updated_at=excluded.updated_at",
      ).run(
        input.reviewId,
        input.reviewRevisionId,
        recoveryArtifact.artifact_id,
        recoveryArtifact.artifact_key,
        recoveryArtifact.artifact_revision,
        text(input.sessionId, 160),
        text(input.runId, 160),
        opaque(input.demoId),
        hash(input.demoContentHash),
        text(input.selectedPlayerId, 160),
        text(input.routeId, 160),
        text(input.routeHash, 160),
        input.recoveryBoundary,
        input.checkpointThreadId ? text(input.checkpointThreadId, 160) : null,
        input.checkpointNamespace !== undefined
          ? input.checkpointNamespace.slice(0, 160)
          : null,
        input.checkpointId ? text(input.checkpointId, 160) : null,
        input.currentCueId ? text(input.currentCueId, 160) : null,
        natural(input.defaultRouteCursor),
        natural(input.completedCueCount),
        natural(input.totalCueCount),
        input.lastPlaybackTick === undefined
          ? null
          : natural(input.lastPlaybackTick),
        stable.text,
        now,
      );
      db.prepare(
        "UPDATE review_revisions SET status='READY',route_id=COALESCE(route_id,?) WHERE review_revision_id=?",
      ).run(input.routeId, input.reviewRevisionId);
      db.prepare(
        "UPDATE reviews SET active_revision_id=?,status=?,current_cue_id=?,current_playback_tick=?,completed_cue_count=?,total_cue_count=?,last_opened_at=?,completed_at=? WHERE review_id=?",
      ).run(
        input.reviewRevisionId,
        input.reviewStatus ?? "IN_PROGRESS",
        input.currentCueId ?? null,
        input.lastPlaybackTick ?? null,
        natural(input.completedCueCount),
        natural(input.totalCueCount),
        now,
        input.completedAt ?? null,
        input.reviewId,
      );
    });
    return runtimeHeadFromRow(
      this.owner.db
        .prepare("SELECT * FROM review_runtime_heads WHERE review_id=?")
        .get(input.reviewId) as unknown as RuntimeHeadRow,
    );
  }

  async renameReview(reviewIdValue: string, titleValue: string): Promise<ReviewRecord> {
    this.requireInitialized();
    const reviewId = opaque(reviewIdValue);
    await this.owner.enqueueWrite((db) => {
      const result = db
        .prepare("UPDATE reviews SET title=? WHERE review_id=?")
        .run(text(titleValue, 200), reviewId);
      if (result.changes !== 1)
        throw new ReviewLibraryError("REVIEW_NOT_FOUND");
    });
    return this.reviewById(reviewId);
  }

  async updateReviewStatus(
    reviewIdValue: string,
    status: "PREPARING" | "FAILED" | "STALE",
  ): Promise<ReviewRecord> {
    this.requireInitialized();
    const reviewId = opaque(reviewIdValue);
    if (status !== "PREPARING" && status !== "FAILED" && status !== "STALE")
      throw new ReviewLibraryError("INVALID_ARGUMENT");
    await this.owner.enqueueWrite((db) => {
      const result = db
        .prepare("UPDATE reviews SET status=?,last_opened_at=? WHERE review_id=?")
        .run(status, this.iso(), reviewId);
      if (result.changes !== 1)
        throw new ReviewLibraryError("REVIEW_NOT_FOUND");
      if (status === "FAILED") {
        db.prepare(
          "UPDATE review_revisions SET status='FAILED' WHERE review_id=? AND status='PREPARING'",
        ).run(reviewId);
      }
    });
    return this.reviewById(reviewId);
  }

  private prepareDelete(
    db: DatabaseSync,
    targetKind: "REVIEW" | "DEMO",
    targetId: string,
    impactToken: string | undefined,
  ): { jobId: string; snapshot: DeleteSnapshot } {
    let reviewIds: string[];
    let demoRelativePath: string | undefined;
    let demoContentHash: string | undefined;
    if (targetKind === "REVIEW") {
      if (!db.prepare("SELECT 1 FROM reviews WHERE review_id=?").get(targetId))
        throw new ReviewLibraryError("REVIEW_NOT_FOUND");
      reviewIds = [targetId];
    } else {
      const demo = db
        .prepare("SELECT relative_path,content_hash FROM demo_assets WHERE demo_id=?")
        .get(targetId) as { relative_path: string; content_hash: string } | undefined;
      if (!demo) throw new ReviewLibraryError("DEMO_NOT_FOUND");
      reviewIds = (
        db.prepare("SELECT review_id FROM reviews WHERE demo_id=? ORDER BY review_id").all(targetId) as Array<{
          review_id: string;
        }>
      ).map((row) => row.review_id);
      if (
        reviewIds.length > 0 &&
        (!impactToken || deletionImpactToken(targetId, reviewIds) !== impactToken)
      )
        throw new ReviewLibraryError(
          impactToken ? "DELETION_IMPACT_CHANGED" : "DEMO_IN_USE",
        );
      demoRelativePath = demo.relative_path;
      demoContentHash = demo.content_hash;
    }
    const filePaths = reviewIds.flatMap((reviewId) =>
      (
        db
          .prepare(
            "SELECT a.relative_path FROM review_artifacts a JOIN review_revisions rr ON rr.review_revision_id=a.review_revision_id WHERE rr.review_id=? AND a.relative_path IS NOT NULL",
          )
          .all(reviewId) as Array<{ relative_path: string }>
      ).map((row) => row.relative_path),
    );
    if (demoRelativePath) filePaths.push(demoRelativePath);
    const checkpointThreadIds = reviewIds.flatMap((reviewId) =>
      [
        ...(
          db
            .prepare(
              "SELECT checkpoint_thread_id FROM review_runtime_heads WHERE review_id=? AND checkpoint_thread_id IS NOT NULL",
            )
            .all(reviewId) as Array<{ checkpoint_thread_id: string }>
        ).map((row) => row.checkpoint_thread_id),
        ...(
          db
            .prepare(
              `SELECT json_extract(a.json_payload,'$.sessionId') AS session_id
               FROM review_artifacts a
               JOIN review_revisions rr ON rr.review_revision_id=a.review_revision_id
               WHERE rr.review_id=?
                 AND a.artifact_type='SESSION_RECOVERY'
                 AND a.storage_kind='SQLITE_JSON'
                 AND json_type(a.json_payload,'$.sessionId')='text'`,
            )
            .all(reviewId) as Array<{ session_id: string }>
        )
          .filter((row) => row.session_id.length > 0 && row.session_id.length <= 160)
          .map((row) => checkpointThreadIdForSession(row.session_id)),
      ],
    );
    const snapshot: DeleteSnapshot = {
      reviewIds,
      ...(demoContentHash ? { demoContentHash } : {}),
      filePaths,
      checkpointThreadIds: [...new Set(checkpointThreadIds)],
      removedReviewCount: reviewIds.length,
      removedDemo: targetKind === "DEMO",
    };
    const jobId = randomUUID();
    const now = this.iso();
    db.prepare(
      "INSERT INTO library_delete_jobs(job_id,target_kind,target_id,status,snapshot_json,created_at,updated_at) VALUES(?,?,?,'PREPARED',?,?,?)",
    ).run(jobId, targetKind, targetId, JSON.stringify(snapshot), now, now);
    return { jobId, snapshot };
  }

  private tombstoneReviewEvidence(
    db: DatabaseSync,
    reviewIds: readonly string[],
    reason: string,
  ): void {
    const now = this.iso();
    for (const reviewId of reviewIds) {
      db.prepare(
        "INSERT INTO memory_evidence_tombstones(user_id,evidence_key,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code,source_review_id,source_review_revision_id,source_artifact_id,deleted_at,reason) SELECT user_id,evidence_key,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code,source_review_id,source_review_revision_id,source_artifact_id,?,? FROM memory_opportunity_evidence WHERE source_review_id=? ON CONFLICT(user_id,evidence_key) DO NOTHING",
      ).run(now, reason, reviewId);
      db.prepare(
        "UPDATE memory_opportunity_evidence SET availability='DELETED',updated_at=? WHERE source_review_id=?",
      ).run(now, reviewId);
    }
  }

  private tombstoneDemoEvidence(
    db: DatabaseSync,
    demoContentHash: string,
    reason: string,
  ): void {
    const now = this.iso();
    db.prepare(
      "INSERT INTO memory_evidence_tombstones(user_id,evidence_key,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code,source_review_id,source_review_revision_id,source_artifact_id,deleted_at,reason) SELECT user_id,evidence_key,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code,source_review_id,source_review_revision_id,source_artifact_id,?,? FROM memory_opportunity_evidence WHERE demo_content_hash=? ON CONFLICT(user_id,evidence_key) DO NOTHING",
    ).run(now, reason, demoContentHash);
    db.prepare(
      "UPDATE memory_opportunity_evidence SET availability='DELETED',updated_at=? WHERE demo_content_hash=?",
    ).run(now, demoContentHash);
  }

  private async executeDelete(
    jobId: string,
    targetKind: "REVIEW" | "DEMO",
    targetId: string,
    snapshot: DeleteSnapshot,
  ): Promise<DeleteResult> {
    try {
      for (const relativePath of snapshot.filePaths) {
        const kind = relativePath.startsWith("library/demos/")
          ? "demos"
          : "artifacts";
        const absolute = this.managedPath(relativePath, kind);
        await unlinkMissingOkay(absolute);
        try {
          await this.paths.fsyncDirectory(dirname(absolute));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await this.owner.enqueueWrite((db) => {
        db.prepare(
          "UPDATE library_delete_jobs SET status='FILES_DELETED',error_code=NULL,updated_at=? WHERE job_id=?",
        ).run(this.iso(), jobId);
      });
      await this.owner.enqueueWrite((db) => {
        if (targetKind === "DEMO" && snapshot.demoContentHash) {
          this.tombstoneDemoEvidence(db, snapshot.demoContentHash, "DEMO_DELETED");
        } else {
          this.tombstoneReviewEvidence(
            db,
            snapshot.reviewIds,
            targetKind === "DEMO" ? "DEMO_DELETED" : "REVIEW_DELETED",
          );
        }
        for (const threadId of snapshot.checkpointThreadIds)
          db.prepare("DELETE FROM agent_checkpoints WHERE thread_id=?").run(threadId);
        if (targetKind === "DEMO")
          db.prepare("DELETE FROM demo_assets WHERE demo_id=?").run(targetId);
        else
          db.prepare("DELETE FROM reviews WHERE review_id=?").run(targetId);
        db.prepare(
          "UPDATE library_delete_jobs SET status='COMPLETED',error_code=NULL,updated_at=? WHERE job_id=?",
        ).run(this.iso(), jobId);
      });
      return {
        deleted: true,
        targetId,
        removedReviewCount: snapshot.removedReviewCount,
        removedDemo: snapshot.removedDemo,
      };
    } catch (error) {
      await this.owner.enqueueWrite((db) => {
        db.prepare(
          "UPDATE library_delete_jobs SET status='FAILED',error_code=?,updated_at=? WHERE job_id=?",
        ).run(codeOf(error), this.iso(), jobId);
      });
      if (error instanceof ReviewLibraryError) throw error;
      throw new ReviewLibraryError("DELETE_FAILED");
    }
  }

  async deleteReview(reviewIdValue: string): Promise<DeleteResult> {
    this.requireInitialized();
    const reviewId = opaque(reviewIdValue);
    return this.critical(async () => {
      const prepared = await this.owner.enqueueWrite((db) =>
        this.prepareDelete(db, "REVIEW", reviewId, undefined),
      );
      return this.executeDelete(prepared.jobId, "REVIEW", reviewId, prepared.snapshot);
    });
  }

  async deleteDemo(
    demoIdValue: string,
    options: DeleteDemoOptions = {},
  ): Promise<DeleteResult> {
    this.requireInitialized();
    const demoId = opaque(demoIdValue);
    return this.critical(async () => {
      const prepared = await this.owner.enqueueWrite((db) =>
        this.prepareDelete(db, "DEMO", demoId, options.impactToken),
      );
      for (const [token, capability] of this.capabilities)
        if (capability.purpose === "VIEW" && capability.objectId === demoId)
          this.capabilities.delete(token);
      return this.executeDelete(prepared.jobId, "DEMO", demoId, prepared.snapshot);
    });
  }

  async previewDemoDeletion(demoIdValue: string): Promise<DemoDeletionImpact> {
    this.requireInitialized();
    const demoId = opaque(demoIdValue);
    const demo = this.owner.db
      .prepare(
        "SELECT original_filename FROM demo_assets WHERE demo_id=? AND NOT EXISTS (SELECT 1 FROM library_delete_jobs j WHERE j.target_kind='DEMO' AND j.target_id=? AND j.status!='COMPLETED')",
      )
      .get(demoId, demoId) as { original_filename: string } | undefined;
    if (!demo) throw new ReviewLibraryError("DEMO_NOT_FOUND");
    const count = this.owner.db
      .prepare("SELECT COUNT(*) AS count FROM reviews WHERE demo_id=?")
      .get(demoId) as { count: number };
    const rows = this.owner.db
      .prepare(
        `SELECT review_id,title,selected_player_name,status
         FROM reviews r
         WHERE demo_id=?
         ORDER BY last_opened_at DESC,review_id DESC
         LIMIT ?`,
      )
      .all(demoId, MAX_DELETION_IMPACT_REVIEWS) as unknown as Array<{
        review_id: string;
        title: string;
        selected_player_name: string;
        status: ReviewStatus;
      }>;
    return {
      schemaVersion: "review-library-demo-deletion-impact.v1",
      demoId,
      originalFilename: demo.original_filename,
      affectedReviewCount: count.count,
      affectedReviews: rows.map((row) => ({
        reviewId: row.review_id,
        title: row.title,
        selectedPlayerName: row.selected_player_name,
        status: row.status,
      })),
      truncated: count.count > MAX_DELETION_IMPACT_REVIEWS,
      impactToken: deletionImpactTokenFromRows(
        demoId,
        this.owner.db
          .prepare("SELECT review_id FROM reviews WHERE demo_id=? ORDER BY review_id")
          .iterate(demoId) as Iterable<{ review_id: string }>,
      ),
    };
  }

  async stats(): Promise<LibraryStats> {
    this.requireInitialized();
    const demos = this.owner.db
      .prepare("SELECT COUNT(*) count,COALESCE(SUM(byte_size),0) bytes FROM demo_assets")
      .get() as { count: number; bytes: number };
    const reviews = this.owner.db.prepare("SELECT COUNT(*) count FROM reviews").get() as {
      count: number;
    };
    const artifacts = this.owner.db
      .prepare("SELECT COALESCE(SUM(byte_size),0) bytes FROM review_artifacts")
      .get() as { bytes: number };
    const cacheBytes = 0;
    return {
      schemaVersion: "review-library-stats.v1",
      demoCount: demos.count,
      reviewCount: reviews.count,
      rawDemoBytes: demos.bytes,
      artifactBytes: artifacts.bytes,
      cacheBytes,
      totalBytes: demos.bytes + artifacts.bytes + cacheBytes,
    };
  }

  async verify(): Promise<LibraryVerificationResult> {
    this.requireInitialized();
    const issues: LibraryVerificationIssue[] = [];
    const demos = this.owner.db.prepare("SELECT * FROM demo_assets").all() as unknown as DemoRow[];
    for (const demo of demos) {
      let physicalStatus: "READY" | "MISSING" | "CORRUPT" = "READY";
      try {
        const absolute = this.managedPath(demo.relative_path, "demos");
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          issues.push({ kind: "SYMLINK_ESCAPE", objectId: demo.demo_id });
          physicalStatus = "CORRUPT";
        } else if (info.size !== demo.byte_size) {
          issues.push({ kind: "DEMO_SIZE_MISMATCH", objectId: demo.demo_id });
          physicalStatus = "CORRUPT";
        } else {
          const actual = await sha256File(absolute);
          if (actual.checksum !== demo.content_hash) {
            issues.push({ kind: "DEMO_CHECKSUM_MISMATCH", objectId: demo.demo_id });
            physicalStatus = "CORRUPT";
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          issues.push({ kind: "DEMO_MISSING", objectId: demo.demo_id });
          physicalStatus = "MISSING";
        } else if (error instanceof ReviewLibraryError) {
          issues.push({ kind: error.code === "SYMLINK_ESCAPE" ? "SYMLINK_ESCAPE" : "INVALID_RELATIVE_PATH", objectId: demo.demo_id });
          physicalStatus = "CORRUPT";
        } else throw error;
      }
      // Physical verification may degrade a parser-accepted Demo, but it is
      // never a parser substitute. Only finalizeDemoImport(valid=true) can
      // promote IMPORTING/CORRUPT/MISSING bytes to READY.
      const nextStatus = demo.status === "READY" ? physicalStatus : demo.status;
      await this.owner.enqueueWrite((db) => {
        db.prepare(
          "UPDATE demo_assets SET status=?,last_verified_at=? WHERE demo_id=?",
        ).run(nextStatus, this.iso(), demo.demo_id);
      });
    }
    const artifacts = this.owner.db
      .prepare("SELECT * FROM review_artifacts WHERE storage_kind='GZIP_FILE'")
      .all() as unknown as ArtifactRow[];
    for (const artifact of artifacts) {
      try {
        const absolute = this.managedPath(artifact.relative_path!, "artifacts");
        const actual = await sha256Gunzip(absolute, this.maxArtifactBytes);
        if (actual !== artifact.checksum)
          issues.push({
            kind: "ARTIFACT_CHECKSUM_MISMATCH",
            objectId: artifact.artifact_id,
          });
      } catch (error) {
        issues.push({
          kind:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "ARTIFACT_MISSING"
              : error instanceof ReviewLibraryError && error.code === "SYMLINK_ESCAPE"
                ? "SYMLINK_ESCAPE"
                : "ARTIFACT_CHECKSUM_MISMATCH",
          objectId: artifact.artifact_id,
        });
      }
    }
    return {
      schemaVersion: "review-library-verification.v1",
      checkedDemos: demos.length,
      checkedArtifacts: artifacts.length,
      issues,
    };
  }

  async clearRebuildableCache(): Promise<LibraryCacheCleanupResult> {
    this.requireInitialized();
    // v1 has no managed rebuildable cache. Demo bytes, immutable artifacts,
    // and active/recoverable tmp jobs are intentionally outside this action.
    return {
      schemaVersion: "review-library-cache-cleanup.v1",
      removedBytes: 0,
      cacheBytes: 0,
    };
  }

  async claimMemoryOpportunity(
    input: ClaimMemoryOpportunityInput,
  ): Promise<ClaimMemoryOpportunityResult> {
    this.requireInitialized();
    const userId = text(input.userId, 160);
    const demoContentHash = hash(input.demoContentHash);
    const selectedPlayerId = text(input.selectedPlayerId, 160);
    const stableCueSourceId = text(input.stableCueSourceId, 200);
    const taxonomyCode = text(input.taxonomyCode, 160);
    const analysisEvidenceRevision = text(input.analysisEvidenceRevision, 160);
    const evidenceKey = text(input.evidenceKey, 240);
    const evidence = json(input.evidence, this.smallJsonMaxBytes);
    const now = this.iso();
    return this.owner.enqueueWrite((db) => {
      if (
        db
          .prepare(
            "SELECT 1 FROM memory_evidence_tombstones WHERE user_id=? AND evidence_key=?",
          )
          .get(userId, evidenceKey)
      )
        return { claimed: false, evidenceUpdated: false };
      let sourceReviewId = input.sourceReviewId
        ? opaque(input.sourceReviewId)
        : null;
      let sourceReviewRevisionId = input.sourceReviewRevisionId
        ? opaque(input.sourceReviewRevisionId)
        : null;
      let sourceArtifactId = input.sourceArtifactId
        ? opaque(input.sourceArtifactId)
        : null;
      if (sourceReviewId) {
        const sourceReview = db
          .prepare(
            "SELECT r.active_revision_id,d.content_hash,r.selected_player_id FROM reviews r JOIN demo_assets d ON d.demo_id=r.demo_id WHERE r.review_id=?",
          )
          .get(sourceReviewId) as
          | {
              active_revision_id: string | null;
              content_hash: string;
              selected_player_id: string;
            }
          | undefined;
        if (
          !sourceReview ||
          sourceReview.content_hash !== demoContentHash ||
          sourceReview.selected_player_id !== selectedPlayerId
        )
          throw new ReviewLibraryError("EVIDENCE_CONFLICT");
        sourceReviewRevisionId ??= sourceReview.active_revision_id;
      }
      if (sourceArtifactId && !sourceReviewRevisionId) {
        const artifactSource = db
          .prepare(
            "SELECT rr.review_id,a.review_revision_id FROM review_artifacts a JOIN review_revisions rr ON rr.review_revision_id=a.review_revision_id WHERE a.artifact_id=?",
          )
          .get(sourceArtifactId) as
          | { review_id: string; review_revision_id: string }
          | undefined;
        if (!artifactSource)
          throw new ReviewLibraryError("EVIDENCE_CONFLICT");
        sourceReviewId ??= artifactSource.review_id;
        sourceReviewRevisionId = artifactSource.review_revision_id;
      }
      if (sourceReviewRevisionId) {
        const sourceRevision = db
          .prepare(
            "SELECT rr.review_id,rr.route_hash,d.content_hash,r.selected_player_id FROM review_revisions rr JOIN reviews r ON r.review_id=rr.review_id JOIN demo_assets d ON d.demo_id=r.demo_id WHERE rr.review_revision_id=?",
          )
          .get(sourceReviewRevisionId) as
          | {
              review_id: string;
              route_hash: string;
              content_hash: string;
              selected_player_id: string;
            }
          | undefined;
        if (
          !sourceRevision ||
          (sourceReviewId !== null && sourceRevision.review_id !== sourceReviewId) ||
          sourceRevision.content_hash !== demoContentHash ||
          sourceRevision.selected_player_id !== selectedPlayerId ||
          (analysisEvidenceRevision !== sourceReviewRevisionId &&
            analysisEvidenceRevision !== sourceRevision.route_hash)
        )
          throw new ReviewLibraryError("EVIDENCE_CONFLICT");
        sourceReviewId = sourceRevision.review_id;
      }
      if (sourceArtifactId) {
        const artifact = db
          .prepare(
            "SELECT review_revision_id FROM review_artifacts WHERE artifact_id=?",
          )
          .get(sourceArtifactId) as { review_revision_id: string } | undefined;
        if (
          !artifact ||
          !sourceReviewRevisionId ||
          artifact.review_revision_id !== sourceReviewRevisionId
        )
          throw new ReviewLibraryError("EVIDENCE_CONFLICT");
      }
      if (!sourceReviewId && !sourceReviewRevisionId && !sourceArtifactId) {
        const candidates = db
          .prepare(
            "SELECT r.review_id,rr.review_revision_id FROM reviews r JOIN demo_assets d ON d.demo_id=r.demo_id JOIN review_revisions rr ON rr.review_revision_id=r.active_revision_id WHERE d.content_hash=? AND r.selected_player_id=? AND rr.status='READY' AND (rr.review_revision_id=? OR rr.route_hash=?) ORDER BY r.last_opened_at DESC,r.review_id DESC LIMIT 2",
          )
          .all(
            demoContentHash,
            selectedPlayerId,
            analysisEvidenceRevision,
            analysisEvidenceRevision,
          ) as Array<{ review_id: string; review_revision_id: string }>;
        if (candidates.length === 1) {
          sourceReviewId = candidates[0].review_id;
          sourceReviewRevisionId = candidates[0].review_revision_id;
        }
      }
      const existingEvidence = db
        .prepare(
          "SELECT * FROM memory_opportunity_evidence WHERE user_id=? AND evidence_key=?",
        )
        .get(userId, evidenceKey) as
        | {
            demo_content_hash: string;
            selected_player_id: string;
            stable_cue_source_id: string;
            taxonomy_code: string;
            analysis_evidence_revision: string;
            evidence_json: string;
            source_review_id: string | null;
            source_review_revision_id: string | null;
            source_artifact_id: string | null;
            availability: "AVAILABLE" | "DELETED";
          }
        | undefined;
      if (
        existingEvidence &&
        (existingEvidence.demo_content_hash !== demoContentHash ||
          existingEvidence.selected_player_id !== selectedPlayerId ||
          existingEvidence.stable_cue_source_id !== stableCueSourceId ||
          existingEvidence.taxonomy_code !== taxonomyCode)
      )
        throw new ReviewLibraryError("EVIDENCE_CONFLICT");
      const claim = db
        .prepare(
          "INSERT INTO memory_opportunity_claims(user_id,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code,first_analysis_evidence_revision,latest_analysis_evidence_revision,claimed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code) DO NOTHING",
        )
        .run(
          userId,
          demoContentHash,
          selectedPlayerId,
          stableCueSourceId,
          taxonomyCode,
          analysisEvidenceRevision,
          analysisEvidenceRevision,
          now,
          now,
        );
      db.prepare(
        "UPDATE memory_opportunity_claims SET latest_analysis_evidence_revision=?,updated_at=? WHERE user_id=? AND demo_content_hash=? AND selected_player_id=? AND stable_cue_source_id=? AND taxonomy_code=?",
      ).run(
        analysisEvidenceRevision,
        now,
        userId,
        demoContentHash,
        selectedPlayerId,
        stableCueSourceId,
        taxonomyCode,
      );
      const retryableUnreceiptedFirstEvidence =
        claim.changes === 0 &&
        existingEvidence?.availability === "AVAILABLE" &&
        !db
          .prepare(
            "SELECT 1 FROM memory_write_receipts WHERE user_id=? AND idempotency_key=?",
          )
          .get(userId, evidenceKey) &&
        (
          db
            .prepare(
              "SELECT COUNT(*) count FROM memory_opportunity_evidence WHERE user_id=? AND demo_content_hash=? AND selected_player_id=? AND stable_cue_source_id=? AND taxonomy_code=? AND evidence_key!=?",
            )
            .get(
              userId,
              demoContentHash,
              selectedPlayerId,
              stableCueSourceId,
              taxonomyCode,
              evidenceKey,
            ) as { count: number }
        ).count === 0;
      const nextSources = [sourceReviewId, sourceReviewRevisionId, sourceArtifactId];
      const evidenceUpdated =
        !existingEvidence ||
        existingEvidence.analysis_evidence_revision !== analysisEvidenceRevision ||
        existingEvidence.evidence_json !== evidence.text ||
        existingEvidence.source_review_id !== nextSources[0] ||
        existingEvidence.source_review_revision_id !== nextSources[1] ||
        existingEvidence.source_artifact_id !== nextSources[2];
      if (!existingEvidence) {
        db.prepare(
          "INSERT INTO memory_opportunity_evidence(user_id,demo_content_hash,selected_player_id,stable_cue_source_id,taxonomy_code,evidence_key,analysis_evidence_revision,source_review_id,source_review_revision_id,source_artifact_id,evidence_json,availability,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'AVAILABLE',?,?)",
        ).run(
          userId,
          demoContentHash,
          selectedPlayerId,
          stableCueSourceId,
          taxonomyCode,
          evidenceKey,
          analysisEvidenceRevision,
          ...nextSources,
          evidence.text,
          now,
          now,
        );
      } else if (evidenceUpdated) {
        db.prepare(
          "UPDATE memory_opportunity_evidence SET analysis_evidence_revision=?,source_review_id=?,source_review_revision_id=?,source_artifact_id=?,evidence_json=?,availability='AVAILABLE',updated_at=? WHERE user_id=? AND evidence_key=?",
        ).run(
          analysisEvidenceRevision,
          ...nextSources,
          evidence.text,
          now,
          userId,
          evidenceKey,
        );
      }
      return {
        claimed: claim.changes === 1 || retryableUnreceiptedFirstEvidence,
        evidenceUpdated,
      };
    });
  }

  async cleanup(): Promise<LibraryReconcileResult> {
    this.requireInitialized();
    const result: LibraryReconcileResult = {
      removedPartialFiles: 0,
      recoveredImports: 0,
      failedImports: 0,
      recoveredDeletes: 0,
      failedDeletes: 0,
    };
    const mutable = { ...result };
    const imports = this.owner.db
      .prepare(
        "SELECT * FROM library_import_jobs WHERE status IN ('WRITING','PUBLISHING') ORDER BY created_at",
      )
      .all() as unknown as ImportJobRow[];
    for (const job of imports) {
      if (this.activeJobIds.has(job.job_id)) continue;
      if (job.status === "WRITING") {
        const tempPath = this.managedPath(job.temp_relative_path, "tmp");
        await unlinkMissingOkay(tempPath).catch(() => undefined);
        await this.owner.enqueueWrite((db) => {
          db.prepare(
            "UPDATE library_import_jobs SET status='FAILED',error_code='INTERRUPTED_WRITE',updated_at=? WHERE job_id=?",
          ).run(this.iso(), job.job_id);
        });
        mutable.failedImports += 1;
        mutable.removedPartialFiles += 1;
        continue;
      }
      try {
        await this.critical(() => this.publishImport(job));
        mutable.recoveredImports += 1;
      } catch (error) {
        const tempPath = this.managedPath(job.temp_relative_path, "tmp");
        let recoverable = false;
        for (const candidate of [
          tempPath,
          job.final_relative_path
            ? this.managedPath(job.final_relative_path, "demos")
            : undefined,
        ]) {
          if (!candidate) continue;
          try {
            await stat(candidate);
            recoverable = true;
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code !== "ENOENT")
              throw statError;
          }
        }
        await this.owner.enqueueWrite((db) => {
          db.prepare(
            "UPDATE library_import_jobs SET status=?,error_code=?,updated_at=? WHERE job_id=?",
          ).run(
            recoverable ? "PUBLISHING" : "FAILED",
            codeOf(error),
            this.iso(),
            job.job_id,
          );
        });
        mutable.failedImports += 1;
      }
    }

    // A process restart proves that no parser can still hold the in-memory
    // validation capability. Never promote an interrupted two-phase import.
    const interruptedValidations = await this.owner.enqueueWrite((db) =>
      db.prepare("UPDATE demo_assets SET status='CORRUPT',last_verified_at=? WHERE status='IMPORTING'")
        .run(this.iso()).changes,
    );
    mutable.failedImports += Number(interruptedValidations);

    const artifactJobs = this.owner.db
      .prepare(
        "SELECT * FROM library_artifact_jobs WHERE status IN ('WRITING','PUBLISHING')",
      )
      .all() as unknown as ArtifactJobRow[];
    for (const job of artifactJobs) {
      if (this.activeJobIds.has(job.job_id)) continue;
      const temp = this.managedPath(job.temp_relative_path, "tmp");
      if (job.status === "WRITING") {
        await unlinkMissingOkay(temp).catch(() => undefined);
        await this.owner.enqueueWrite((db) => {
          db.prepare(
            "UPDATE library_artifact_jobs SET status='FAILED',error_code='INTERRUPTED_ARTIFACT_WRITE',updated_at=? WHERE job_id=?",
          ).run(this.iso(), job.job_id);
        });
        mutable.removedPartialFiles += 1;
        continue;
      }
      try {
        await this.critical(async () => {
          const existing = this.owner.db
            .prepare("SELECT 1 FROM review_artifacts WHERE artifact_id=?")
            .get(job.artifact_id);
          if (existing) {
            await unlinkMissingOkay(temp);
            await this.owner.enqueueWrite((db) => {
              db.prepare(
                "UPDATE library_artifact_jobs SET status='COMPLETED',error_code=NULL,updated_at=? WHERE job_id=?",
              ).run(this.iso(), job.job_id);
            });
            return;
          }
          if (
            !this.owner.db
              .prepare(
                "SELECT 1 FROM review_revisions WHERE review_revision_id=?",
              )
              .get(job.review_revision_id)
          )
            throw new ReviewLibraryError("REVISION_NOT_FOUND");
          const final = this.ensureManagedParent(
            job.final_relative_path,
            "artifacts",
          );
          let finalExists = true;
          try {
            await stat(final);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            finalExists = false;
          }
          if (!finalExists) {
            if ((await sha256Gunzip(temp, this.maxArtifactBytes)) !== job.checksum)
              throw new ReviewLibraryError("ARTIFACT_CORRUPT");
            await link(temp, final);
            await chmod(final, 0o600);
            await this.paths.fsyncDirectory(dirname(final));
          }
          if ((await sha256Gunzip(final, this.maxArtifactBytes)) !== job.checksum)
            throw new ReviewLibraryError("ARTIFACT_CORRUPT");
          await unlinkMissingOkay(temp);
          await this.paths.fsyncDirectory(this.paths.tmpRoot);
          const storedSize = (await stat(final)).size;
          await this.owner.enqueueWrite((db) => {
            db.prepare(
              "INSERT INTO review_artifacts(artifact_id,review_revision_id,artifact_type,artifact_key,artifact_revision,schema_version,checksum,storage_kind,relative_path,byte_size,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,'GZIP_FILE',?,?,?,?)",
            ).run(
              job.artifact_id,
              job.review_revision_id,
              job.artifact_type,
              job.artifact_key,
              job.artifact_revision,
              job.schema_version,
              job.checksum,
              job.final_relative_path,
              storedSize,
              job.idempotency_key,
              job.created_at,
            );
            db.prepare(
              "UPDATE library_artifact_jobs SET status='COMPLETED',error_code=NULL,updated_at=? WHERE job_id=?",
            ).run(this.iso(), job.job_id);
          });
        });
        mutable.removedPartialFiles += 1;
      } catch (error) {
        await this.owner.enqueueWrite((db) => {
          db.prepare(
            "UPDATE library_artifact_jobs SET error_code=?,updated_at=? WHERE job_id=?",
          ).run(codeOf(error), this.iso(), job.job_id);
        });
      }
    }

    const deleteJobs = this.owner.db
      .prepare(
        "SELECT job_id,target_kind,target_id,status,snapshot_json FROM library_delete_jobs WHERE status IN ('PREPARED','FILES_DELETED','FAILED') ORDER BY created_at",
      )
      .all() as unknown as DeleteJobRow[];
    for (const job of deleteJobs) {
      try {
        const snapshot = JSON.parse(job.snapshot_json) as DeleteSnapshot;
        await this.critical(() =>
          this.executeDelete(job.job_id, job.target_kind, job.target_id, snapshot),
        );
        mutable.recoveredDeletes += 1;
      } catch {
        mutable.failedDeletes += 1;
      }
    }

    const cutoff = this.now().getTime() - this.partialMaxAgeMs;
    for (const entry of await readdir(this.paths.tmpRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !PARTIAL_NAME_PATTERN.test(entry.name)) continue;
      const relative = this.paths.relative("library", "tmp", entry.name);
      if (
        this.owner.db
          .prepare(
            "SELECT 1 FROM library_import_jobs WHERE temp_relative_path=? AND status IN ('WRITING','PUBLISHING') UNION ALL SELECT 1 FROM library_artifact_jobs WHERE temp_relative_path=? AND status IN ('WRITING','PUBLISHING') LIMIT 1",
          )
          .get(relative, relative)
      )
        continue;
      const absolute = this.managedPath(relative, "tmp");
      const info = await stat(absolute);
      if (info.mtimeMs > cutoff) continue;
      await unlinkMissingOkay(absolute);
      mutable.removedPartialFiles += 1;
    }
    return mutable;
  }
}
