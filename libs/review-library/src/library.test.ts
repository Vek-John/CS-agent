import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteCheckpointSaver,
  SqliteDatabaseOwner,
} from "@cs-coach/memory-sqlite/server";
import {
  DesktopReviewLibrary,
  currentDesktopReviewLibrary,
  installDesktopReviewLibrary,
  type ImportDemoInput,
  type JsonValue,
} from "./server";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function demoBytes(size = 1024): Buffer {
  const value = Buffer.alloc(size, 0x5a);
  Buffer.from("PBDEMS2\0", "binary").copy(value, 0);
  return value;
}

async function* chunks(value: Uint8Array, size = 37): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < value.byteLength; offset += size)
    yield value.subarray(offset, Math.min(value.byteLength, offset + size));
}

async function bodyBytes(body: NodeJS.ReadableStream): Promise<Buffer> {
  const values: Buffer[] = [];
  for await (const chunk of body) values.push(Buffer.from(chunk));
  return Buffer.concat(values);
}

async function harness(options: { smallJsonMaxBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cs-agent-review-library-"));
  cleanup.push(root);
  const owner = new SqliteDatabaseOwner({ path: join(root, "cs-agent.sqlite3") });
  const library = new DesktopReviewLibrary({
    owner,
    dataRoot: root,
    smallJsonMaxBytes: options.smallJsonMaxBytes,
    partialMaxAgeMs: 1,
  });
  await library.initialize();
  return { root, owner, library };
}

async function importValue(
  library: DesktopReviewLibrary,
  value: Buffer,
  objectId: string,
  filename = "比赛 中文.dem",
) {
  const capability = library.issueImportCapability({
    objectId,
    originalFilename: filename,
    expectedByteLength: value.byteLength,
  });
  const imported = await library.importDemo({
    authorization: capability.authorization,
    objectId,
    stream: chunks(value),
  });
  if (!imported.validationCapability) return imported;
  const demo = await library.finalizeDemoImport({
    authorization: imported.validationCapability.authorization,
    demoId: imported.demo.demoId,
    valid: true,
    parserVersion: "test-parser.v1",
  });
  return { ...imported, demo };
}

async function appendCriticalArtifacts(
  library: DesktopReviewLibrary,
  reviewRevisionId: string,
  suffix: string,
  head: {
    readonly recoveryArtifactKey: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly demoContentHash: string;
    readonly selectedPlayerId: string;
    readonly routeId: string;
    readonly routeHash: string;
    readonly recoveryBoundary: "ROUTE_START" | "CUE_PAUSED" | "WRAP_UP";
    readonly checkpointId?: string;
    readonly currentCueId?: string;
    readonly defaultRouteCursor: number;
    readonly completedCueCount: number;
    readonly totalCueCount: number;
  },
  analysisPayload: JsonValue = { analysis: suffix },
) {
  const analysis = await library.appendArtifact({
    reviewRevisionId,
    artifactType: "ANALYSIS_BUNDLE",
    artifactKey: "analysis",
    artifactRevision: 1,
    schemaVersion: "analysis.v1",
    payload: analysisPayload,
    idempotencyKey: `analysis-${suffix}`,
  });
  await library.appendArtifact({
    reviewRevisionId,
    artifactType: "CANDIDATE_SET",
    artifactKey: "candidates",
    artifactRevision: 1,
    schemaVersion: "candidate-set.v1",
    payload: { candidateSet: suffix },
    idempotencyKey: `candidate-set-${suffix}`,
  });
  const cues = Array.from({ length: head.totalCueCount }, (_, index) => ({ id: `cue-${index}` }));
  await library.appendArtifact({
    reviewRevisionId,
    artifactType: "REVIEW_PLAN",
    artifactKey: "route",
    artifactRevision: 1,
    schemaVersion: "review-plan.v1",
    payload: { id: head.routeId, cues, route: suffix },
    idempotencyKey: `review-plan-${suffix}`,
  });
  await library.appendArtifact({
    reviewRevisionId,
    artifactType: "SESSION_RECOVERY",
    artifactKey: head.recoveryArtifactKey,
    artifactRevision: 1,
    schemaVersion: "session-recovery-record.v2",
    payload: {
      sessionId: head.sessionId,
      runId: head.runId,
      demoContentHash: head.demoContentHash,
      selectedPlayerId: head.selectedPlayerId,
      routeId: head.routeId,
      routeHash: head.routeHash,
      agentCheckpointId: head.checkpointId ?? null,
      frozenReviewPlan: { id: head.routeId, cues },
      boundary: {
        kind: head.recoveryBoundary,
        segmentIndex: head.defaultRouteCursor,
        ...(head.currentCueId ? { cueId: head.currentCueId } : {}),
      },
      cueProgress: {
        completedCueIds: Array.from({ length: head.completedCueCount }, (_, index) => `cue-${index}`),
      },
      routeReadiness: {},
      narrationArtifacts: [],
      suffix,
    },
    idempotencyKey: `session-recovery-${suffix}`,
  });
  return analysis;
}

function checkpointThreadId(sessionId: string): string {
  let value = 2_166_136_261;
  for (let index = 0; index < sessionId.length; index += 1) {
    value ^= sessionId.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return `coach-agent-v1-session-${(value >>> 0).toString(16).padStart(8, "0")}`;
}

describe("DesktopReviewLibrary import and viewer seam", () => {
  it("keeps a new Demo non-readable until parser validation and marks a rejected parse corrupt", async () => {
    const h = await harness();
    const value = demoBytes();
    const capability = h.library.issueImportCapability({
      objectId: "two-phase-import",
      originalFilename: "two-phase.dem",
      expectedByteLength: value.byteLength,
    });
    const imported = await h.library.importDemo({
      authorization: capability.authorization,
      objectId: "two-phase-import",
      stream: chunks(value),
    });
    expect(imported.demo.status).toBe("IMPORTING");
    expect(imported.validationCapability?.purpose).toBe("VALIDATE");
    await expect(h.library.verify()).resolves.toMatchObject({ issues: [] });
    expect(
      h.owner.db.prepare("SELECT status FROM demo_assets WHERE demo_id=?").get(imported.demo.demoId),
    ).toEqual({ status: "IMPORTING" });
    const readCapability = h.library.issueViewerCapability({ demoId: imported.demo.demoId });
    await expect(h.library.resolveViewerDemo({
      authorization: readCapability.authorization,
      demoId: imported.demo.demoId,
    })).rejects.toMatchObject({ code: "DEMO_NOT_READY" });
    const corrupt = await h.library.finalizeDemoImport({
      authorization: imported.validationCapability!.authorization,
      demoId: imported.demo.demoId,
      valid: false,
    });
    expect(corrupt.status).toBe("CORRUPT");
    await expect(h.library.verify()).resolves.toMatchObject({ issues: [] });
    expect(
      h.owner.db.prepare("SELECT status FROM demo_assets WHERE demo_id=?").get(imported.demo.demoId),
    ).toEqual({ status: "CORRUPT" });
    await expect(h.library.finalizeDemoImport({
      authorization: imported.validationCapability!.authorization,
      demoId: imported.demo.demoId,
      valid: true,
    })).rejects.toMatchObject({ code: "INVALID_CAPABILITY" });

    const retried = await importValue(h.library, value, "two-phase-retry", "renamed.dem");
    expect(retried.demo.demoId).toBe(imported.demo.demoId);
    expect(retried.demo.status).toBe("READY");
    expect(retried.deduplicated).toBe(true);
    await h.owner.close();
  });

  it("installs and removes the process-global server seam without owning SQLite shutdown", async () => {
    const h = await harness();
    installDesktopReviewLibrary(h.library);
    expect(currentDesktopReviewLibrary()).toBe(h.library);
    installDesktopReviewLibrary(undefined);
    expect(currentDesktopReviewLibrary()).toBeUndefined();
    expect(h.owner.isClosed).toBe(false);
    await h.owner.close();
  });

  it("supports an application data path containing spaces and Chinese characters", async () => {
    const base = await mkdtemp(join(tmpdir(), "cs-agent-review-unicode-"));
    cleanup.push(base);
    const dataRoot = join(base, "应用 数据");
    const owner = new SqliteDatabaseOwner({
      path: join(dataRoot, "database", "cs-agent.sqlite3"),
    });
    const library = new DesktopReviewLibrary({ owner, dataRoot });
    await library.initialize();
    const imported = await importValue(library, demoBytes(), "unicode-path");
    const capability = library.issueViewerCapability({
      demoId: imported.demo.demoId,
    });
    const source = await library.resolveViewerDemo({
      authorization: capability.authorization,
      demoId: imported.demo.demoId,
    });
    expect(await bodyBytes(source.body)).toEqual(demoBytes());
    await owner.close();
  });

  it("streams PBDEMS2 bytes into a 0600 content-addressed file and consumes capabilities", async () => {
    const h = await harness();
    const value = demoBytes(4096);
    const imported = await importValue(h.library, value, "import-a");
    expect(imported.deduplicated).toBe(false);
    expect(imported.demo.contentHash).toBe(
      createHash("sha256").update(value).digest("hex"),
    );
    expect(imported.demo).not.toHaveProperty("relativePath");
    const databaseRow = h.owner.db
      .prepare("SELECT relative_path FROM demo_assets WHERE demo_id=?")
      .get(imported.demo.demoId) as { relative_path: string };
    expect(databaseRow.relative_path).toMatch(
      /^library\/demos\/[0-9a-f]{2}\/[0-9a-f]{64}\.dem$/u,
    );
    const managed = join(h.root, ...databaseRow.relative_path.split("/"));
    expect((await stat(managed)).mode & 0o777).toBe(0o600);

    const capability = h.library.issueViewerCapability({
      demoId: imported.demo.demoId,
    });
    const source = await h.library.resolveViewerDemo({
      authorization: capability.authorization,
      demoId: imported.demo.demoId,
    });
    expect(await bodyBytes(source.body)).toEqual(value);
    await expect(
      h.library.resolveViewerDemo({
        authorization: capability.authorization,
        demoId: imported.demo.demoId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CAPABILITY" });
    await h.owner.close();
  });

  it("deduplicates same content across names and concurrent imports without a second file", async () => {
    const h = await harness();
    const value = demoBytes(256 * 1024);
    const first = await importValue(h.library, value, "first", "first.dem");
    const [second, third] = await Promise.all([
      importValue(h.library, value, "second", "不同.dem"),
      importValue(h.library, value, "third", "third.dem"),
    ]);
    expect(second.demo.demoId).toBe(first.demo.demoId);
    expect(third.demo.demoId).toBe(first.demo.demoId);
    expect(second.deduplicated).toBe(true);
    expect(third.deduplicated).toBe(true);
    expect(
      h.owner.db.prepare("SELECT COUNT(*) count FROM demo_assets").get(),
    ).toEqual({ count: 1 });
    const prefix = first.demo.contentHash.slice(0, 2);
    expect(await readdir(join(h.root, "library", "demos", prefix))).toEqual([
      `${first.demo.contentHash}.dem`,
    ]);
    await h.owner.close();
  });

  it("imports a generated multi-megabyte stream while the producer retains only bounded chunks", async () => {
    const h = await harness();
    const chunkSize = 64 * 1024;
    const chunkCount = 64;
    const first = Buffer.alloc(chunkSize, 0x11);
    Buffer.from("PBDEMS2\0", "binary").copy(first);
    const remaining = Buffer.alloc(chunkSize, 0x22);
    const expected = createHash("sha256").update(first);
    for (let index = 1; index < chunkCount; index += 1)
      expected.update(remaining);
    async function* generated() {
      yield first;
      for (let index = 1; index < chunkCount; index += 1) yield remaining;
    }
    const capability = h.library.issueImportCapability({
      objectId: "generated-stream",
      originalFilename: "generated.dem",
      expectedByteLength: chunkSize * chunkCount,
    });
    const imported = await h.library.importDemo({
      authorization: capability.authorization,
      objectId: "generated-stream",
      stream: generated(),
    });
    expect(imported.demo.byteSize).toBe(chunkSize * chunkCount);
    expect(imported.demo.contentHash).toBe(expected.digest("hex"));
    await h.owner.close();
  });

  it("rejects invalid headers and length mismatches without leaving a valid asset or partial", async () => {
    const h = await harness();
    const invalid = Buffer.alloc(32, 1);
    const invalidCapability = h.library.issueImportCapability({
      objectId: "invalid",
      originalFilename: "invalid.dem",
      expectedByteLength: invalid.byteLength,
    });
    const invalidInput: ImportDemoInput = {
      authorization: invalidCapability.authorization,
      objectId: "invalid",
      stream: chunks(invalid),
    };
    await expect(h.library.importDemo(invalidInput)).rejects.toMatchObject({
      code: "INVALID_DEMO",
    });
    await expect(
      h.library.importDemo({ ...invalidInput, stream: chunks(invalid) }),
    ).rejects.toMatchObject({ code: "INVALID_CAPABILITY" });
    const valid = demoBytes(32);
    const capability = h.library.issueImportCapability({
      objectId: "short",
      originalFilename: "short.dem",
      expectedByteLength: valid.byteLength + 1,
    });
    await expect(
      h.library.importDemo({
        authorization: capability.authorization,
        objectId: "short",
        stream: chunks(valid),
      }),
    ).rejects.toMatchObject({ code: "IMPORT_LENGTH_MISMATCH" });
    expect(await readdir(join(h.root, "library", "tmp"))).toEqual([]);
    expect(
      h.owner.db.prepare("SELECT COUNT(*) count FROM demo_assets").get(),
    ).toEqual({ count: 0 });
    const missingViewer = h.library.issueViewerCapability({ demoId: "missing" });
    await expect(
      h.library.resolveViewerDemo({
        authorization: missingViewer.authorization,
        demoId: "missing",
      }),
    ).rejects.toMatchObject({ code: "DEMO_NOT_FOUND" });
    await expect(
      h.library.resolveViewerDemo({
        authorization: missingViewer.authorization,
        demoId: "missing",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CAPABILITY" });
    await h.owner.close();
  });

  it("recovers a publish-window import and only cleans exact stale partial names", async () => {
    const h = await harness();
    const value = demoBytes(2048);
    const digest = createHash("sha256").update(value).digest("hex");
    const jobId = "11111111-1111-4111-8111-111111111111";
    const tempRelative = `library/tmp/import-${jobId}.partial`;
    const finalRelative = `library/demos/${digest.slice(0, 2)}/${digest}.dem`;
    await writeFile(join(h.root, ...tempRelative.split("/")), value, { mode: 0o600 });
    h.owner.db
      .prepare(
        "INSERT INTO library_import_jobs(job_id,object_id,candidate_demo_id,original_filename,expected_byte_length,temp_relative_path,final_relative_path,content_hash,byte_size,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'PUBLISHING',?,?)",
      )
      .run(
        jobId,
        "crash",
        "22222222-2222-4222-8222-222222222222",
        "crash.dem",
        value.byteLength,
        tempRelative,
        finalRelative,
        digest,
        value.byteLength,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    const stale = join(
      h.root,
      "library",
      "tmp",
      "artifact-33333333-3333-4333-8333-333333333333.partial",
    );
    const unrelated = join(h.root, "library", "tmp", "keep-me.partial");
    await writeFile(stale, "stale");
    await writeFile(unrelated, "unrelated");
    await utimes(stale, new Date(0), new Date(0));
    const result = await h.library.cleanup();
    expect(result.recoveredImports).toBe(1);
    expect(await readFile(join(h.root, ...finalRelative.split("/")))).toEqual(value);
    expect(await readFile(unrelated, "utf8")).toBe("unrelated");
    expect(
      h.owner.db.prepare("SELECT status FROM library_import_jobs WHERE job_id=?").get(jobId),
    ).toEqual({ status: "COMPLETED" });
    await h.owner.close();
  });

  it("commits a final-only PUBLISHING import after a crash removed its temp link", async () => {
    const h = await harness();
    const value = demoBytes(2048);
    const digest = createHash("sha256").update(value).digest("hex");
    const jobId = "44444444-4444-4444-8444-444444444444";
    const demoId = "55555555-5555-4555-8555-555555555555";
    const tempRelative = `library/tmp/import-${jobId}.partial`;
    const finalRelative = `library/demos/${digest.slice(0, 2)}/${digest}.dem`;
    const finalPath = join(h.root, ...finalRelative.split("/"));
    await mkdir(join(h.root, "library", "demos", digest.slice(0, 2)), { recursive: true });
    await writeFile(finalPath, value, { mode: 0o600 });
    h.owner.db
      .prepare(
        "INSERT INTO library_import_jobs(job_id,object_id,candidate_demo_id,original_filename,expected_byte_length,temp_relative_path,final_relative_path,content_hash,byte_size,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'PUBLISHING',?,?)",
      )
      .run(
        jobId,
        "final-only-crash",
        demoId,
        "final-only.dem",
        value.byteLength,
        tempRelative,
        finalRelative,
        digest,
        value.byteLength,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

    const result = await h.library.cleanup();

    expect(result.recoveredImports).toBe(1);
    expect(await readFile(finalPath)).toEqual(value);
    expect(
      h.owner.db.prepare("SELECT status FROM library_import_jobs WHERE job_id=?").get(jobId),
    ).toEqual({ status: "COMPLETED" });
    // A restart has no in-memory one-shot parser validation capability, so the
    // recovered physical asset is preserved but fails closed until reimported.
    expect(
      h.owner.db.prepare("SELECT status FROM demo_assets WHERE demo_id=?").get(demoId),
    ).toEqual({ status: "CORRUPT" });
    await h.owner.close();
  });
});

describe("DesktopReviewLibrary revisions, artifacts, recovery, and deletion", () => {
  it("SQL-selects and materializes only the active Revision artifacts", async () => {
    const h = await harness({ smallJsonMaxBytes: 1024 });
    const imported = await importValue(h.library, demoBytes(), "active-only-demo");
    const review = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "A",
      title: "Active only",
    });
    const staleRevision = await h.library.startRevision({
      reviewId: review.reviewId,
      analysisVersion: "a0",
      graphVersion: "g0",
      promptVersion: "p0",
      modelMetadata: {},
      routeId: "route-old",
      routeHash: "route-hash-old",
    });
    const staleArtifact = await h.library.appendArtifact({
      reviewRevisionId: staleRevision.reviewRevisionId,
      artifactType: "ANALYSIS_BUNDLE",
      artifactKey: "analysis",
      artifactRevision: 1,
      schemaVersion: "analysis.v1",
      payload: { data: "old".repeat(1024) },
      idempotencyKey: "old-analysis",
    });
    const stalePath = h.owner.db
      .prepare("SELECT relative_path FROM review_artifacts WHERE artifact_id=?")
      .get(staleArtifact.artifactId) as { relative_path: string };
    await writeFile(join(h.root, ...stalePath.relative_path.split("/")), "corrupt");

    const activeRevision = await h.library.startRevision({
      reviewId: review.reviewId,
      analysisVersion: "a1",
      graphVersion: "g1",
      promptVersion: "p1",
      modelMetadata: {},
      routeId: "route-current",
      routeHash: "route-hash-current",
    });
    expect(activeRevision.artifactContractVersion).toBe(2);
    const activeHead = {
      recoveryArtifactKey: "route-start-active",
      recoveryArtifactRevision: 1,
      sessionId: "session-active",
      runId: "run-active",
      demoContentHash: imported.demo.contentHash,
      selectedPlayerId: "player-a",
      routeId: "route-current",
      routeHash: "route-hash-current",
      recoveryBoundary: "ROUTE_START" as const,
      defaultRouteCursor: 0,
      completedCueCount: 0,
      totalCueCount: 0,
    };
    await appendCriticalArtifacts(h.library, activeRevision.reviewRevisionId, "active", activeHead);
    await h.library.commitRuntimeHead({
      reviewId: review.reviewId,
      reviewRevisionId: activeRevision.reviewRevisionId,
      demoId: imported.demo.demoId,
      ...activeHead,
      stableProgress: { phase: "ROUTE_START" },
    });

    const loaded = await h.library.loadReview(review.reviewId, {
      materializeExternalArtifacts: true,
    });
    expect(loaded.artifacts).toHaveLength(4);
    expect(
      new Set(loaded.artifacts.map((artifact) => artifact.reviewRevisionId)),
    ).toEqual(new Set([activeRevision.reviewRevisionId]));
    expect(loaded.artifactIssues).toEqual([]);
    await h.owner.close();
  });

  it("omits a corrupt active external artifact and reports a bounded issue", async () => {
    const h = await harness({ smallJsonMaxBytes: 1024 });
    const imported = await importValue(h.library, demoBytes(), "corrupt-active-demo");
    const review = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "A",
      title: "Corrupt active artifact",
    });
    const revision = await h.library.startRevision({
      reviewId: review.reviewId,
      analysisVersion: "a1",
      graphVersion: "g1",
      promptVersion: "p1",
      modelMetadata: {},
      routeId: "route-a",
      routeHash: "route-hash",
    });
    const corruptHead = {
      recoveryArtifactKey: "route-start-corrupt",
      recoveryArtifactRevision: 1,
      sessionId: "session-a",
      runId: "run-a",
      demoContentHash: imported.demo.contentHash,
      selectedPlayerId: "player-a",
      routeId: "route-a",
      routeHash: "route-hash",
      recoveryBoundary: "ROUTE_START" as const,
      defaultRouteCursor: 0,
      completedCueCount: 0,
      totalCueCount: 0,
    };
    const analysis = await appendCriticalArtifacts(
      h.library,
      revision.reviewRevisionId,
      "corrupt-active",
      corruptHead,
      { data: "large".repeat(1024) },
    );
    await h.library.commitRuntimeHead({
      reviewId: review.reviewId,
      reviewRevisionId: revision.reviewRevisionId,
      demoId: imported.demo.demoId,
      ...corruptHead,
      stableProgress: { phase: "ROUTE_START" },
    });
    const artifactPath = h.owner.db
      .prepare("SELECT relative_path FROM review_artifacts WHERE artifact_id=?")
      .get(analysis.artifactId) as { relative_path: string };
    await writeFile(join(h.root, ...artifactPath.relative_path.split("/")), "corrupt");

    const loaded = await h.library.loadReview(review.reviewId, {
      materializeExternalArtifacts: true,
    });
    expect(loaded.review.reviewId).toBe(review.reviewId);
    expect(loaded.revisions).toContainEqual(expect.objectContaining({
      reviewRevisionId: revision.reviewRevisionId,
    }));
    expect(loaded.artifacts.some((artifact) => artifact.artifactId === analysis.artifactId)).toBe(false);
    expect(loaded.artifactIssues).toEqual([
      { kind: "ANALYSIS_BUNDLE", key: "analysis", code: "ARTIFACT_CORRUPT" },
    ]);
    await h.owner.close();
  });

  it("guards READY runtime heads until all critical active artifacts exist", async () => {
    const h = await harness();
    const imported = await importValue(h.library, demoBytes(), "head-guard-demo");
    const review = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "A",
      title: "Head guard",
    });
    const revision = await h.library.startRevision({
      reviewId: review.reviewId,
      analysisVersion: "a1",
      graphVersion: "g1",
      promptVersion: "p1",
      modelMetadata: {},
      routeId: "route-a",
      routeHash: "route-hash",
    });
    const input = {
      reviewId: review.reviewId,
      reviewRevisionId: revision.reviewRevisionId,
      recoveryArtifactKey: "route-start-guard",
      recoveryArtifactRevision: 1,
      sessionId: "session-a",
      runId: "run-a",
      demoId: imported.demo.demoId,
      demoContentHash: imported.demo.contentHash,
      selectedPlayerId: "player-a",
      routeId: "route-a",
      routeHash: "route-hash",
      recoveryBoundary: "ROUTE_START" as const,
      defaultRouteCursor: 0,
      completedCueCount: 0,
      totalCueCount: 1,
      stableProgress: { phase: "ROUTE_START" },
    };
    await expect(h.library.commitRuntimeHead(input)).rejects.toMatchObject({
      code: "REVISION_ARTIFACTS_INCOMPLETE",
    });
    expect(
      h.owner.db.prepare("SELECT status FROM review_revisions WHERE review_revision_id=?").get(revision.reviewRevisionId),
    ).toEqual({ status: "PREPARING" });
    expect(
      h.owner.db.prepare("SELECT 1 FROM review_runtime_heads WHERE review_id=?").get(review.reviewId),
    ).toBeUndefined();
    await appendCriticalArtifacts(h.library, revision.reviewRevisionId, "guard", input);
    await expect(h.library.commitRuntimeHead({
      ...input,
      recoveryArtifactKey: "another-recovery",
    })).rejects.toMatchObject({ code: "REVISION_ARTIFACTS_INCOMPLETE" });
    await expect(h.library.commitRuntimeHead({
      ...input,
      runId: "another-run",
    })).rejects.toMatchObject({ code: "RUNTIME_HEAD_IDENTITY_MISMATCH" });
    await expect(h.library.commitRuntimeHead(input)).resolves.toMatchObject({
      reviewRevisionId: revision.reviewRevisionId,
    });
    await h.owner.close();
  });

  it("requires Narration only for READY/FALLBACK route cues and not CueCase", async () => {
    const h = await harness();
    const imported = await importValue(h.library, demoBytes(), "narration-guard-demo");
    const review = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "A",
      title: "Narration guard",
    });
    const revision = await h.library.startRevision({
      reviewId: review.reviewId,
      analysisVersion: "a1",
      graphVersion: "g1",
      promptVersion: "p1",
      modelMetadata: {},
      routeId: "route-a",
      routeHash: "route-hash",
    });
    await h.library.appendArtifact({
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "ANALYSIS_BUNDLE",
      artifactKey: "analysis",
      artifactRevision: 1,
      schemaVersion: "analysis.v1",
      payload: { ready: true },
      idempotencyKey: "narration-guard-analysis",
    });
    await h.library.appendArtifact({
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "CANDIDATE_SET",
      artifactKey: "candidates",
      artifactRevision: 1,
      schemaVersion: "candidate-set.v1",
      payload: { ready: true },
      idempotencyKey: "narration-guard-candidates",
    });
    await h.library.appendArtifact({
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "REVIEW_PLAN",
      artifactKey: "route-a",
      artifactRevision: 1,
      schemaVersion: "review-plan.v1",
      payload: {
        id: "route-a",
        cues: [
          { id: "cue-ready" },
          { id: "cue-fallback" },
          { id: "cue-pending" },
        ],
      },
      idempotencyKey: "narration-guard-plan",
    });
    await h.library.appendArtifact({
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "SESSION_RECOVERY",
      artifactKey: "route-start",
      artifactRevision: 1,
      schemaVersion: "session-recovery-record.v2",
      payload: {
        sessionId: "session-a",
        runId: "run-a",
        demoContentHash: imported.demo.contentHash,
        selectedPlayerId: "player-a",
        routeId: "route-a",
        routeHash: "route-hash",
        agentCheckpointId: null,
        frozenReviewPlan: {
          id: "route-a",
          cues: [
            { id: "cue-ready" },
            { id: "cue-fallback" },
            { id: "cue-pending" },
          ],
        },
        boundary: { kind: "ROUTE_START", segmentIndex: 0 },
        cueProgress: { completedCueIds: [] },
        routeReadiness: {
          "cue-ready": "READY",
          "cue-fallback": "FALLBACK",
          "cue-pending": "PENDING",
        },
      },
      idempotencyKey: "narration-guard-recovery",
    });
    await h.library.appendArtifact({
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "NARRATION_BUNDLE",
      artifactKey: "cue-ready",
      artifactRevision: 1,
      schemaVersion: "narration.v1",
      payload: { readiness: "READY" },
      idempotencyKey: "narration-guard-ready",
    });
    const input = {
      reviewId: review.reviewId,
      reviewRevisionId: revision.reviewRevisionId,
      recoveryArtifactKey: "route-start",
      recoveryArtifactRevision: 1,
      sessionId: "session-a",
      runId: "run-a",
      demoId: imported.demo.demoId,
      demoContentHash: imported.demo.contentHash,
      selectedPlayerId: "player-a",
      routeId: "route-a",
      routeHash: "route-hash",
      recoveryBoundary: "ROUTE_START" as const,
      defaultRouteCursor: 0,
      completedCueCount: 0,
      totalCueCount: 3,
      stableProgress: { phase: "ROUTE_START" },
    };
    await expect(h.library.commitRuntimeHead(input)).rejects.toMatchObject({
      code: "REVISION_ARTIFACTS_INCOMPLETE",
    });
    await h.library.appendArtifact({
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "NARRATION_BUNDLE",
      artifactKey: "cue-fallback",
      artifactRevision: 1,
      schemaVersion: "narration.v1",
      payload: { readiness: "FALLBACK" },
      idempotencyKey: "narration-guard-fallback",
    });
    await expect(h.library.commitRuntimeHead(input)).resolves.toMatchObject({
      reviewRevisionId: revision.reviewRevisionId,
    });
    expect(
      h.owner.db
        .prepare("SELECT COUNT(*) count FROM review_artifacts WHERE review_revision_id=? AND artifact_type='CUE_CASE'")
        .get(revision.reviewRevisionId),
    ).toEqual({ count: 0 });
    await h.owner.close();
  });

  it("enumerates bounded Demo deletion impact and rejects a stale confirmation", async () => {
    const h = await harness();
    const imported = await importValue(h.library, demoBytes(), "impact-demo");
    const storedDemo = h.owner.db
      .prepare("SELECT relative_path FROM demo_assets WHERE demo_id=?")
      .get(imported.demo.demoId) as { relative_path: string };
    const storedDemoPath = join(h.root, ...storedDemo.relative_path.split("/"));
    await expect(stat(storedDemoPath)).resolves.toMatchObject({
      size: imported.demo.byteSize,
    });
    const first = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "A",
      title: "First affected review",
    });
    const second = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-b",
      selectedPlayerName: "B",
      title: "Second affected review",
    });
    const impact = await h.library.previewDemoDeletion(imported.demo.demoId);
    expect(impact).toMatchObject({
      schemaVersion: "review-library-demo-deletion-impact.v1",
      demoId: imported.demo.demoId,
      affectedReviewCount: 2,
      truncated: false,
    });
    expect(new Set(impact.affectedReviews.map((item) => item.reviewId))).toEqual(
      new Set([first.reviewId, second.reviewId]),
    );
    expect(impact.affectedReviews.every((item) => !("path" in item))).toBe(true);
    await expect(
      h.library.deleteDemo(imported.demo.demoId, { impactToken: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "DELETION_IMPACT_CHANGED" });
    await expect(
      h.library.deleteDemo(imported.demo.demoId, { impactToken: impact.impactToken }),
    ).resolves.toMatchObject({ removedReviewCount: 2, removedDemo: true });
    await expect(stat(storedDemoPath)).rejects.toMatchObject({ code: "ENOENT" });
    await h.owner.close();
  });

  it("caps Settings entries and Demo impact rows while counting every affected Review", async () => {
    const h = await harness();
    const imported = await importValue(h.library, demoBytes(), "bounded-impact-demo");
    for (let index = 0; index < 55; index += 1) {
      await h.library.createReview({
        demoId: imported.demo.demoId,
        selectedPlayerId: `player-${index}`,
        selectedPlayerName: `Player ${index}`,
        title: `Review ${index}`,
      });
    }
    const entries = await h.library.listLibraryEntries({ limit: 10_000 });
    expect(entries.reviews).toHaveLength(50);
    expect(entries.demos).toHaveLength(1);
    expect(entries.demos[0]?.reviewCount).toBe(55);
    const impact = await h.library.previewDemoDeletion(imported.demo.demoId);
    expect(impact.affectedReviewCount).toBe(55);
    expect(impact.affectedReviews).toHaveLength(50);
    expect(impact.truncated).toBe(true);
    expect(impact.impactToken).toMatch(/^[0-9a-f]{64}$/u);
    await h.owner.close();
  });

  it("keeps revisions/artifacts immutable and restores a checksum-verified external bundle", async () => {
    const h = await harness({ smallJsonMaxBytes: 64 });
    const imported = await importValue(h.library, demoBytes(), "review-demo");
    const review = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "玩家 A",
      title: "Mirage 复盘",
      mapName: "Mirage",
    });
    const revision = await h.library.startRevision({
      reviewId: review.reviewId,
      analysisVersion: "analysis.v1",
      graphVersion: "graph.v1",
      promptVersion: "prompt.v1",
      modelMetadata: { provider: "fake" },
      routeId: "route-a",
      routeHash: "route-hash-a",
    });
    const small = await h.library.appendArtifact({
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "NARRATION_BUNDLE",
      artifactKey: "cue-a",
      artifactRevision: 1,
      schemaVersion: "narration.v1",
      payload: { text: "保留讲解" },
      idempotencyKey: "narration-cue-a-v1",
    });
    expect(small.storageKind).toBe("SQLITE_JSON");
    const largeInput = {
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "ANALYSIS_BUNDLE" as const,
      artifactKey: "analysis",
      artifactRevision: 1,
      schemaVersion: "analysis.v1",
      payload: { data: "x".repeat(4096) },
      idempotencyKey: "analysis-v1",
    };
    const large = await h.library.appendArtifact(largeInput);
    expect(large.storageKind).toBe("GZIP_FILE");
    expect(large).not.toHaveProperty("payload");
    expect((await h.library.appendArtifact(largeInput)).artifactId).toBe(
      large.artifactId,
    );
    await expect(
      h.library.appendArtifact({ ...largeInput, payload: { data: "changed" } }),
    ).rejects.toMatchObject({ code: "ARTIFACT_CONFLICT" });

    const metadataOnly = await h.library.loadReview(review.reviewId);
    expect(metadataOnly.artifacts.find((item) => item.artifactId === large.artifactId)).not.toHaveProperty("payload");
    const materialized = await h.library.loadReview(review.reviewId, {
      materializeExternalArtifacts: true,
    });
    expect(
      materialized.artifacts.find((item) => item.artifactId === large.artifactId)?.payload,
    ).toEqual(largeInput.payload);
    const secondRevision = await h.library.startRevision({
      reviewId: review.reviewId,
      analysisVersion: "analysis.v2",
      graphVersion: "graph.v2",
      promptVersion: "prompt.v2",
      modelMetadata: { provider: "fake-v2" },
      routeId: "route-b",
      routeHash: "route-hash-b",
    });
    const afterReanalysis = await h.library.loadReview(review.reviewId, {
      materializeExternalArtifacts: true,
    });
    expect(
      new Set(afterReanalysis.revisions.map((item) => item.reviewRevisionId)),
    ).toEqual(new Set([revision.reviewRevisionId, secondRevision.reviewRevisionId]));
    expect(afterReanalysis.artifacts).toEqual([]);
    expect(afterReanalysis.artifactIssues).toEqual([]);
    await h.owner.close();
  });

  it("recovers a fsynced external artifact from the publish crash window", async () => {
    const h = await harness({ smallJsonMaxBytes: 32 });
    const imported = await importValue(h.library, demoBytes(), "artifact-crash-demo");
    const review = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "A",
      title: "Artifact recovery",
    });
    const revision = await h.library.startRevision({
      reviewId: review.reviewId,
      analysisVersion: "a1",
      graphVersion: "g1",
      promptVersion: "p1",
      modelMetadata: {},
      routeId: "route-a",
      routeHash: "route-hash",
    });
    const payload = JSON.stringify({ data: "recover-me".repeat(64) });
    const checksum = createHash("sha256").update(payload).digest("hex");
    const jobId = "44444444-4444-4444-8444-444444444444";
    const artifactId = "55555555-5555-4555-8555-555555555555";
    const tempRelative = `library/tmp/artifact-${jobId}.partial`;
    const finalRelative = `library/artifacts/${review.reviewId}/${revision.reviewRevisionId}/${artifactId}.json.gz`;
    await writeFile(
      join(h.root, ...tempRelative.split("/")),
      gzipSync(Buffer.from(payload)),
      { mode: 0o600 },
    );
    h.owner.db
      .prepare(
        "INSERT INTO library_artifact_jobs(job_id,artifact_id,review_revision_id,artifact_type,artifact_key,artifact_revision,schema_version,checksum,idempotency_key,temp_relative_path,final_relative_path,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'PUBLISHING',?,?)",
      )
      .run(
        jobId,
        artifactId,
        revision.reviewRevisionId,
        "ANALYSIS_BUNDLE",
        "analysis",
        1,
        "analysis.v1",
        checksum,
        "analysis-crash-v1",
        tempRelative,
        finalRelative,
        "2026-09-02T00:00:00.000Z",
        "2026-09-02T00:00:00.000Z",
      );
    await h.library.cleanup();
    expect(
      h.owner.db
        .prepare("SELECT status FROM library_artifact_jobs WHERE job_id=?")
        .get(jobId),
    ).toEqual({ status: "COMPLETED" });
    expect(
      (
        await h.library.loadReview(review.reviewId, {
          materializeExternalArtifacts: true,
        })
      ).artifacts.find((artifact) => artifact.artifactId === artifactId)?.payload,
    ).toEqual(JSON.parse(payload));
    await h.owner.close();
  });

  it("stores complete stable identity, permits checkpoint-free ROUTE_START, and paginates summaries", async () => {
    const h = await harness();
    const imported = await importValue(h.library, demoBytes(), "head-demo");
    const review = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "Player A",
      title: "First Review",
    });
    await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-b",
      selectedPlayerName: "Player B",
      title: "Second Review",
    });
    const revision = await h.library.startRevision({
      reviewId: review.reviewId,
      analysisVersion: "a1",
      graphVersion: "g1",
      promptVersion: "p1",
      modelMetadata: {},
      routeId: "route-a",
      routeHash: "route-hash",
    });
    const routeStartInput = {
      reviewId: review.reviewId,
      reviewRevisionId: revision.reviewRevisionId,
      recoveryArtifactKey: "route-start-stable",
      recoveryArtifactRevision: 1,
      sessionId: "session-a",
      runId: "run-a",
      demoId: imported.demo.demoId,
      demoContentHash: imported.demo.contentHash,
      selectedPlayerId: "player-a",
      routeId: "route-a",
      routeHash: "route-hash",
      recoveryBoundary: "ROUTE_START",
      defaultRouteCursor: 0,
      completedCueCount: 0,
      totalCueCount: 4,
      stableProgress: { phase: "ROUTE_START" },
    } as const;
    await appendCriticalArtifacts(h.library, revision.reviewRevisionId, "stable-head", routeStartInput);
    const routeStart = await h.library.commitRuntimeHead(routeStartInput);
    expect(routeStart.checkpointId).toBeUndefined();
    expect(routeStart).toMatchObject({
      recoveryArtifactKey: "route-start-stable",
      recoveryArtifactRevision: 1,
      recoveryArtifactId: expect.any(String),
    });
    const committedRecoveryArtifactId = routeStart.recoveryArtifactId;
    await h.library.appendArtifact({
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "SESSION_RECOVERY",
      artifactKey: "route-start-stable",
      artifactRevision: 2,
      schemaVersion: "session-recovery-record.v2",
      payload: {
        sessionId: "session-a",
        runId: "run-a",
        demoContentHash: imported.demo.contentHash,
        selectedPlayerId: "player-a",
        routeId: "route-a",
        routeHash: "route-hash",
        agentCheckpointId: null,
        frozenReviewPlan: {
          id: "route-a",
          cues: Array.from({ length: 4 }, (_, index) => ({ id: `cue-${index}` })),
        },
        boundary: { kind: "ROUTE_START", segmentIndex: 0 },
        cueProgress: { completedCueIds: [] },
        routeReadiness: {},
        narrationArtifacts: [],
        marker: "not-committed",
      },
      idempotencyKey: "route-start-stable-v2-not-committed",
    });
    expect((await h.library.loadReview(review.reviewId)).runtimeHead).toMatchObject({
      recoveryArtifactId: committedRecoveryArtifactId,
      recoveryArtifactKey: "route-start-stable",
      recoveryArtifactRevision: 1,
    });
    await expect(
      h.library.commitRuntimeHead({
        ...routeStart,
        recoveryArtifactKey: "cue-paused-without-checkpoint",
        recoveryArtifactRevision: 1,
        recoveryBoundary: "CUE_PAUSED",
        currentCueId: "cue-a",
        defaultRouteCursor: 1,
        completedCueCount: 1,
        stableProgress: { phase: "CUE_PAUSED" },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_HEAD_IDENTITY_MISMATCH" });
    const saver = new SqliteCheckpointSaver({ owner: h.owner });
    await saver.put(
      { configurable: { thread_id: "thread-a", checkpoint_ns: "cue" } },
      {
        v: 4,
        id: "checkpoint-a",
        ts: "2026-09-02T00:00:00.000Z",
        channel_values: {
          agent: {
            sessionId: "session-a",
            runId: "run-a",
            demoId: imported.demo.demoId,
            demoContentHash: imported.demo.contentHash,
            selectedPlayerId: "player-a",
            routeId: "route-a",
            routeHash: "route-hash",
          },
        },
        channel_versions: {},
        versions_seen: {},
      },
      { source: "input", step: 0, parents: {} },
      {},
    );
    await expect(
      h.library.commitRuntimeHead({
        ...routeStart,
        recoveryArtifactKey: "cue-paused-missing-checkpoint",
        recoveryArtifactRevision: 1,
        recoveryBoundary: "CUE_PAUSED",
        checkpointThreadId: "thread-a",
        checkpointNamespace: "cue",
        checkpointId: "missing-checkpoint",
        currentCueId: "cue-a",
        defaultRouteCursor: 1,
        completedCueCount: 1,
        stableProgress: { phase: "CUE_PAUSED" },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_HEAD_IDENTITY_MISMATCH" });
    await h.library.appendArtifact({
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "SESSION_RECOVERY",
      artifactKey: "cue-paused-checkpoint-a",
      artifactRevision: 1,
      schemaVersion: "session-recovery-record.v2",
      payload: {
        sessionId: "session-a",
        runId: "run-a",
        demoContentHash: imported.demo.contentHash,
        selectedPlayerId: "player-a",
        routeId: "route-a",
        routeHash: "route-hash",
        agentCheckpointId: "checkpoint-a",
        frozenReviewPlan: {
          id: "route-a",
          cues: Array.from({ length: 4 }, (_, index) => ({ id: `cue-${index}` })),
        },
        boundary: { kind: "CUE_PAUSED", segmentIndex: 1, cueId: "cue-a" },
        cueProgress: { completedCueIds: ["cue-0"] },
        routeReadiness: {},
        narrationArtifacts: [],
      },
      idempotencyKey: "cue-paused-checkpoint-a",
    });
    const paused = await h.library.commitRuntimeHead({
      ...routeStart,
      recoveryArtifactKey: "cue-paused-checkpoint-a",
      recoveryArtifactRevision: 1,
      recoveryBoundary: "CUE_PAUSED",
      checkpointThreadId: "thread-a",
      checkpointNamespace: "cue",
      checkpointId: "checkpoint-a",
      currentCueId: "cue-a",
      defaultRouteCursor: 1,
      completedCueCount: 1,
      lastPlaybackTick: 123,
      stableProgress: { phase: "CUE_PAUSED" },
    });
    expect(paused.lastPlaybackTick).toBe(123);
    await h.library.claimMemoryOpportunity({
      userId: "user-a",
      demoContentHash: imported.demo.contentHash,
      selectedPlayerId: "player-a",
      stableCueSourceId: "round-1-cue",
      taxonomyCode: "TRADE_TIMING",
      analysisEvidenceRevision: "route-hash",
      evidenceKey: "auto-source",
      evidence: { cue: "cue-a" },
    });
    expect(
      h.owner.db
        .prepare(
          "SELECT source_review_id,source_review_revision_id FROM memory_opportunity_evidence WHERE evidence_key='auto-source'",
        )
        .get(),
    ).toEqual({
      source_review_id: review.reviewId,
      source_review_revision_id: revision.reviewRevisionId,
    });
    const page = await h.library.listReviews({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect((await h.library.listReviews({ cursor: page.nextCursor!, limit: 1 })).items).toHaveLength(1);
    expect((await h.library.listReviews({ search: "Player A" })).items).toHaveLength(1);
    await h.owner.close();
  });

  it("separates Review/Demo deletion and retains stable opportunity plus evidence tombstone", async () => {
    const h = await harness();
    const imported = await importValue(h.library, demoBytes(), "delete-demo");
    const first = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "A",
      title: "A review",
    });
    const second = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-b",
      selectedPlayerName: "B",
      title: "B review",
    });
    const saver = new SqliteCheckpointSaver({ owner: h.owner });
    for (const [index, sessionId] of ["old-session", "new-session"].entries()) {
      const revision = await h.library.startRevision({
        reviewId: first.reviewId,
        analysisVersion: `a${index}`,
        graphVersion: `g${index}`,
        promptVersion: `p${index}`,
        modelMetadata: {},
        routeHash: `route-${index}`,
      });
      await h.library.appendArtifact({
        reviewRevisionId: revision.reviewRevisionId,
        artifactType: "SESSION_RECOVERY",
        artifactKey: `recovery-${index}`,
        artifactRevision: 1,
        schemaVersion: "session-recovery.v2",
        payload: { sessionId },
        idempotencyKey: `recovery-${index}`,
      });
      await saver.put(
        { configurable: { thread_id: checkpointThreadId(sessionId), checkpoint_ns: "" } },
        {
          v: 4,
          id: `checkpoint-${index}`,
          ts: "2026-09-02T00:00:00.000Z",
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: "input", step: index, parents: {} },
        {},
      );
    }
    const firstClaimInput = {
      userId: "user-a",
      demoContentHash: imported.demo.contentHash,
      selectedPlayerId: "player-a",
      stableCueSourceId: "round-1-decision-a",
      taxonomyCode: "TRADE_TIMING",
      analysisEvidenceRevision: "analysis.v1",
      evidenceKey: "evidence-a",
      evidence: { cue: "cue-a" },
      sourceReviewId: first.reviewId,
    } as const;
    const firstClaim = await h.library.claimMemoryOpportunity(firstClaimInput);
    expect(firstClaim).toEqual({ claimed: true, evidenceUpdated: true });
    expect(await h.library.claimMemoryOpportunity(firstClaimInput)).toEqual({
      claimed: true,
      evidenceUpdated: false,
    });
    h.owner.db
      .prepare(
        "INSERT INTO app_users(user_id,updated_at) VALUES('user-a','2026-09-02T00:00:00.000Z')",
      )
      .run();
    h.owner.db
      .prepare(
        "INSERT INTO memory_write_receipts(user_id,idempotency_key,created_at) VALUES('user-a','evidence-a','2026-09-02T00:00:00.000Z')",
      )
      .run();
    expect(await h.library.claimMemoryOpportunity(firstClaimInput)).toEqual({
      claimed: false,
      evidenceUpdated: false,
    });
    const revisedClaim = await h.library.claimMemoryOpportunity({
      userId: "user-a",
      demoContentHash: imported.demo.contentHash,
      selectedPlayerId: "player-a",
      stableCueSourceId: "round-1-decision-a",
      taxonomyCode: "TRADE_TIMING",
      analysisEvidenceRevision: "analysis.v2",
      evidenceKey: "evidence-b",
      evidence: { cue: "cue-a", revision: 2 },
      sourceReviewId: first.reviewId,
    });
    expect(revisedClaim.claimed).toBe(false);
    await h.library.claimMemoryOpportunity({
      userId: "user-a",
      demoContentHash: imported.demo.contentHash,
      selectedPlayerId: "player-b",
      stableCueSourceId: "unbound-source",
      taxonomyCode: "POSITIONING",
      analysisEvidenceRevision: "analysis-unbound.v1",
      evidenceKey: "evidence-unbound",
      evidence: { cue: "unbound" },
    });
    expect(
      h.owner.db.prepare(
        "SELECT source_review_id,availability FROM memory_opportunity_evidence WHERE evidence_key='evidence-unbound'",
      ).get(),
    ).toEqual({ source_review_id: null, availability: "AVAILABLE" });
    await h.library.deleteReview(first.reviewId);
    expect(
      h.owner.db
        .prepare("SELECT COUNT(*) count FROM agent_checkpoints WHERE thread_id LIKE 'coach-agent-v1-session-%'")
        .get(),
    ).toEqual({ count: 0 });
    expect((await h.library.stats()).demoCount).toBe(1);
    expect((await h.library.loadReview(second.reviewId)).review.reviewId).toBe(
      second.reviewId,
    );
    expect(
      h.owner.db
        .prepare("SELECT COUNT(*) count FROM memory_opportunity_claims")
        .get(),
    ).toEqual({ count: 2 });
    expect(
      h.owner.db
        .prepare("SELECT COUNT(*) count FROM memory_evidence_tombstones")
        .get(),
    ).toEqual({ count: 2 });
    await expect(h.library.deleteDemo(imported.demo.demoId)).rejects.toMatchObject({
      code: "DEMO_IN_USE",
    });
    const impact = await h.library.previewDemoDeletion(imported.demo.demoId);
    await h.library.deleteDemo(imported.demo.demoId, {
      impactToken: impact.impactToken,
    });
    expect(
      h.owner.db.prepare(
        "SELECT availability FROM memory_opportunity_evidence WHERE evidence_key='evidence-unbound'",
      ).get(),
    ).toEqual({ availability: "DELETED" });
    expect(
      h.owner.db.prepare(
        "SELECT reason FROM memory_evidence_tombstones WHERE evidence_key='evidence-unbound'",
      ).get(),
    ).toEqual({ reason: "DEMO_DELETED" });
    expect(await h.library.stats()).toMatchObject({
      schemaVersion: "review-library-stats.v1",
      demoCount: 0,
      reviewCount: 0,
      rawDemoBytes: 0,
    });
    expect(await h.library.clearRebuildableCache()).toEqual({
      schemaVersion: "review-library-cache-cleanup.v1",
      removedBytes: 0,
      cacheBytes: 0,
    });
    await h.owner.close();
  });

  it("keeps a failed deletion hidden and retries its persisted Saga", async () => {
    const h = await harness({ smallJsonMaxBytes: 32 });
    const imported = await importValue(h.library, demoBytes(), "delete-retry-demo");
    const review = await h.library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: "player-a",
      selectedPlayerName: "A",
      title: "Delete retry",
    });
    const revision = await h.library.startRevision({
      reviewId: review.reviewId,
      analysisVersion: "a1",
      graphVersion: "g1",
      promptVersion: "p1",
      modelMetadata: {},
      routeId: "route-a",
      routeHash: "route-hash",
    });
    await h.library.appendArtifact({
      reviewRevisionId: revision.reviewRevisionId,
      artifactType: "ANALYSIS_BUNDLE",
      artifactKey: "analysis",
      artifactRevision: 1,
      schemaVersion: "analysis.v1",
      payload: { data: "cannot-rebuild".repeat(64) },
      idempotencyKey: "delete-retry-analysis",
    });
    h.owner.db.exec(
      `CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON reviews WHEN OLD.review_id='${review.reviewId}' BEGIN SELECT RAISE(ABORT,'fixture-delete-failure'); END`,
    );
    await expect(h.library.deleteReview(review.reviewId)).rejects.toMatchObject({
      code: "DELETE_FAILED",
    });
    expect((await h.library.listReviews()).items).toHaveLength(0);
    await expect(h.library.loadReview(review.reviewId)).rejects.toMatchObject({
      code: "DELETE_FAILED",
    });
    expect(
      h.owner.db
        .prepare("SELECT status FROM library_delete_jobs WHERE target_id=?")
        .get(review.reviewId),
    ).toEqual({ status: "FAILED" });
    h.owner.db.exec("DROP TRIGGER fixture_delete_failure");
    const recovered = await h.library.cleanup();
    expect(recovered.recoveredDeletes).toBe(1);
    expect(
      h.owner.db.prepare("SELECT 1 FROM reviews WHERE review_id=?").get(review.reviewId),
    ).toBeUndefined();
    await h.owner.close();
  });

  it("marks tampered Demo corrupt and rejects symlink escape", async () => {
    const h = await harness();
    expect(() =>
      h.owner.db
        .prepare(
          "INSERT INTO demo_assets(demo_id,content_hash,relative_path,original_filename,byte_size,status,imported_at,last_opened_at) VALUES('bad-hash',?,'library/demos/bad.dem','bad.dem',8,'READY','now','now')",
        )
        .run("A".repeat(64)),
    ).toThrow();
    const imported = await importValue(h.library, demoBytes(), "verify-demo");
    const row = h.owner.db
      .prepare("SELECT relative_path FROM demo_assets WHERE demo_id=?")
      .get(imported.demo.demoId) as { relative_path: string };
    const absolute = join(h.root, ...row.relative_path.split("/"));
    await writeFile(absolute, demoBytes(2048));
    const verification = await h.library.verify();
    expect(verification.schemaVersion).toBe("review-library-verification.v1");
    expect(verification.issues[0]?.kind).toBe("DEMO_SIZE_MISMATCH");
    expect(
      h.owner.db.prepare("SELECT status FROM demo_assets WHERE demo_id=?").get(imported.demo.demoId),
    ).toEqual({ status: "CORRUPT" });

    h.owner.db
      .prepare("UPDATE demo_assets SET relative_path=? WHERE demo_id=?")
      .run("/tmp/escape.dem", imported.demo.demoId);
    const absoluteEscape = await h.library.verify();
    expect(absoluteEscape.issues[0]?.kind).toBe("INVALID_RELATIVE_PATH");

    const outside = join(h.root, "outside");
    await mkdir(outside);
    const evil = join(h.root, "library", "demos", "evil");
    await symlink(outside, evil);
    h.owner.db
      .prepare("UPDATE demo_assets SET relative_path=? WHERE demo_id=?")
      .run("library/demos/evil/demo.dem", imported.demo.demoId);
    const symlinked = await h.library.verify();
    expect(symlinked.issues[0]?.kind).toBe("SYMLINK_ESCAPE");
    await h.owner.close();
  });
});
