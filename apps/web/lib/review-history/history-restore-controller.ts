/**
 * The history path is deliberately a two-stage control-plane restore. It has
 * no imports from Director, Narrator, Reflection, Adaptive, Embedding, or
 * Policy modules: loading an existing revision must never regenerate it.
 */

export type StoredArtifactKind =
  | "ANALYSIS_BUNDLE"
  | "CANDIDATE_SET"
  | "REVIEW_PLAN"
  | "NARRATION_BUNDLE"
  | "CUE_CASE"
  | "DIAGNOSTIC_RESULT"
  | "TRANSFER_RULE"
  | "LEARNING_THREAD"
  | "TOOL_RESULT"
  | "USER_INTERACTION"
  | "SESSION_SUMMARY"
  | "SESSION_RECOVERY";

export interface StoredArtifact {
  readonly id?: string;
  readonly kind: StoredArtifactKind;
  readonly key: string;
  readonly revision?: number;
  readonly createdAt?: string;
  readonly payload: unknown;
}

export interface ReviewHistoryDetail {
  readonly review: {
    readonly id: string;
    readonly demoId: string;
    readonly title: string;
    readonly status: string;
    readonly selectedPlayerId: string;
    readonly selectedPlayerName?: string;
    readonly mapName?: string;
    readonly scoreText?: string;
  };
  readonly revision: {
    readonly id: string;
    readonly status: string;
    readonly artifactContractVersion: 1 | 2;
    readonly routeId?: string;
    readonly routeHash?: string;
  } | null;
  readonly artifacts: readonly StoredArtifact[];
  readonly artifactIssues?: readonly {
    readonly kind: StoredArtifactKind;
    readonly key: string;
    readonly code: string;
  }[];
  readonly runtimeHead: unknown | null;
}

export interface ManagedDemoSource {
  readonly requestId: string;
  readonly demoId: string;
  readonly capabilityToken: string;
  readonly originalFilename: string;
  readonly byteSize: number;
  readonly contentHash: string;
}

export interface RestoredHistoryControlPlane {
  readonly detail: ReviewHistoryDetail;
  readonly analysis: unknown | null;
  readonly candidateSet: unknown | null;
  readonly plan: unknown;
  readonly narrationByCue: Readonly<Record<string, unknown>>;
  readonly cueCases: Readonly<Record<string, unknown>>;
  readonly toolResultsByCall: Readonly<Record<string, unknown>>;
  readonly learningThreads: readonly unknown[];
  readonly summary: unknown | null;
  readonly recoverySnapshot: unknown | null;
  readonly missingArtifacts: readonly StoredArtifactKind[];
  readonly managedSource?: ManagedDemoSource;
}

export interface HistoryRestoreDeps {
  readonly loadDetail: (reviewId: string, signal?: AbortSignal) => Promise<ReviewHistoryDetail>;
  readonly requestViewerSource: (reviewId: string, signal?: AbortSignal) => Promise<ManagedDemoSource>;
  readonly loadManagedDemo: (source: ManagedDemoSource, mode: "RESTORE" | "REANALYZE" | "SELECT_PLAYER") => void;
}

export class HistoryRestoreError extends Error {
  readonly code: "INVALID_DETAIL" | "MISSING_ARTIFACT" | "STALE_REQUEST";
  constructor(code: HistoryRestoreError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function artifactMap(artifacts: readonly StoredArtifact[]): Map<StoredArtifactKind, StoredArtifact[]> {
  const map = new Map<StoredArtifactKind, StoredArtifact[]>();
  for (const artifact of artifacts) map.set(artifact.kind, [...(map.get(artifact.kind) ?? []), artifact]);
  for (const artifactsForKind of map.values()) {
    artifactsForKind.sort((left, right) =>
      (left.revision ?? 1) - (right.revision ?? 1) ||
      (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
      left.key.localeCompare(right.key));
  }
  return map;
}

function recoveryMatchesRuntimeHead(payload: unknown, runtimeHead: unknown): boolean {
  const record = object(payload);
  const head = object(runtimeHead);
  const boundary = object(record?.boundary);
  const frozenPlan = object(record?.frozenReviewPlan);
  const cueProgress = object(record?.cueProgress);
  const completedCueIds = cueProgress?.completedCueIds;
  const cues = frozenPlan?.cues;
  if (!record || !head || !boundary || !Array.isArray(completedCueIds) || !Array.isArray(cues)) return false;
  return record.sessionId === head.sessionId &&
    record.runId === head.runId &&
    record.demoContentHash === head.demoContentHash &&
    record.selectedPlayerId === head.selectedPlayerId &&
    record.routeId === head.routeId &&
    record.routeHash === head.routeHash &&
    record.agentCheckpointId === (head.checkpointId ?? null) &&
    boundary.kind === head.recoveryBoundary &&
    boundary.segmentIndex === head.defaultRouteCursor &&
    completedCueIds.length === head.completedCueCount &&
    cues.length === head.totalCueCount &&
    (boundary.kind !== "CUE_PAUSED" || boundary.cueId === head.currentCueId);
}

/** Validates only persisted, user-facing shapes. It never rebuilds artifacts. */
export function restoreHistoryControlPlane(detail: ReviewHistoryDetail): RestoredHistoryControlPlane {
  if (!detail.review?.id || !detail.review.demoId || !Array.isArray(detail.artifacts)) {
    throw new HistoryRestoreError("INVALID_DETAIL", "历史记录格式无效。");
  }
  const byKind = artifactMap(detail.artifacts);
  const latest = (kind: StoredArtifactKind) => byKind.get(kind)?.at(-1);
  const analysis = latest("ANALYSIS_BUNDLE")?.payload ?? null;
  const explicitCandidateSet = latest("CANDIDATE_SET")?.payload;
  // Contract v1 predates the independent CANDIDATE_SET artifact, but its
  // checksummed AnalysisBundle already contains the exact set. Preserve those
  // completed Reviews without weakening the v2 write/READY invariant.
  const legacyEmbeddedCandidateSet = detail.revision?.artifactContractVersion === 1 && detail.revision.status === "READY"
    ? object(analysis)?.candidate_set
    : undefined;
  const candidateSet = explicitCandidateSet ?? legacyEmbeddedCandidateSet ?? null;
  const plan = latest("REVIEW_PLAN")?.payload ?? object(analysis)?.review_plan;
  const missing: StoredArtifactKind[] = [];
  if (!analysis) missing.push("ANALYSIS_BUNDLE");
  if (!candidateSet) missing.push("CANDIDATE_SET");
  if (!plan) missing.push("REVIEW_PLAN");
  const narrationByCue = Object.fromEntries((byKind.get("NARRATION_BUNDLE") ?? []).flatMap((artifact) => {
    const payload = object(artifact.payload);
    const cueId = typeof payload?.cueId === "string" ? payload.cueId : artifact.key;
    return cueId ? [[cueId, artifact.payload]] : [];
  }));
  const cueCases = Object.fromEntries((byKind.get("CUE_CASE") ?? []).flatMap((artifact) => {
    const cueId = object(artifact.payload)?.cueId;
    return typeof cueId === "string" && cueId ? [[cueId, artifact.payload]] : [];
  }));
  const toolResultsByCall = Object.fromEntries((byKind.get("TOOL_RESULT") ?? []).map((artifact) => [
    artifact.key,
    artifact.payload,
  ]));
  const threadById = new Map<string, unknown>();
  for (const artifact of byKind.get("LEARNING_THREAD") ?? []) {
    const threadId = object(artifact.payload)?.threadId;
    if (typeof threadId === "string" && threadId) threadById.set(threadId, artifact.payload);
  }
  const learningThreads = [...threadById.values()];
  const summary = latest("SESSION_SUMMARY")?.payload ?? null;
  const recoveryArtifacts = byKind.get("SESSION_RECOVERY") ?? [];
  const head = object(detail.runtimeHead);
  const recoveryArtifact = head &&
    typeof head.recoveryArtifactId === "string" &&
    typeof head.recoveryArtifactKey === "string" &&
    Number.isInteger(head.recoveryArtifactRevision)
    ? recoveryArtifacts.find((artifact) =>
      artifact.id === head.recoveryArtifactId &&
      artifact.key === head.recoveryArtifactKey &&
      artifact.revision === head.recoveryArtifactRevision &&
      recoveryMatchesRuntimeHead(artifact.payload, detail.runtimeHead))?.payload
    : undefined;
  if (!recoveryArtifact) missing.push("SESSION_RECOVERY");
  const recoverySnapshot = recoveryArtifact ?? null;
  return { detail, analysis, candidateSet, plan, narrationByCue, cueCases, toolResultsByCall, learningThreads, summary, recoverySnapshot, missingArtifacts: missing };
}

/** Latest request wins; prevents a slow earlier history click from mutating the active Viewer. */
export class HistoryRestoreController {
  #generation = 0;
  #abort?: AbortController;
  readonly #requests = new WeakMap<RestoredHistoryControlPlane, {
    readonly generation: number;
    readonly abort: AbortController;
  }>();
  constructor(private readonly deps: HistoryRestoreDeps) {}

  cancel(): void {
    this.#generation += 1;
    this.#abort?.abort();
    this.#abort = undefined;
  }

  async open(reviewId: string, mode: "RESTORE" | "REANALYZE" | "SELECT_PLAYER" = "RESTORE"): Promise<RestoredHistoryControlPlane> {
    if (!reviewId || reviewId.length > 160) throw new HistoryRestoreError("INVALID_DETAIL", "复盘标识无效。");
    this.cancel();
    const generation = this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    const detail = await this.deps.loadDetail(reviewId, abort.signal);
    if (generation !== this.#generation) throw new HistoryRestoreError("STALE_REQUEST", "已切换到另一条复盘。");
    const controlPlane = restoreHistoryControlPlane(detail);
    this.#requests.set(controlPlane, { generation, abort });
    return controlPlane;
  }

  /** Starts only after the caller has rendered the saved SQLite control plane. */
  async attachViewerSource(
    controlPlane: RestoredHistoryControlPlane,
    mode: "RESTORE" | "REANALYZE" | "SELECT_PLAYER" = "RESTORE",
  ): Promise<RestoredHistoryControlPlane> {
    const request = this.#requests.get(controlPlane);
    if (!request || request.generation !== this.#generation) {
      throw new HistoryRestoreError("STALE_REQUEST", "已切换到另一条复盘。");
    }
    if (controlPlane.missingArtifacts.length > 0 && mode === "RESTORE") return controlPlane;
    const source = await this.deps.requestViewerSource(
      controlPlane.detail.review.id,
      request.abort.signal,
    );
    if (request.generation !== this.#generation) throw new HistoryRestoreError("STALE_REQUEST", "已切换到另一条复盘。");
    const withViewer = { ...controlPlane, managedSource: source };
    this.#requests.set(withViewer, request);
    return withViewer;
  }

  activate(
    restored: RestoredHistoryControlPlane,
    mode: "RESTORE" | "REANALYZE" | "SELECT_PLAYER" = "RESTORE",
  ): void {
    const request = this.#requests.get(restored);
    if (!request || request.generation !== this.#generation || request.abort.signal.aborted) {
      throw new HistoryRestoreError("STALE_REQUEST", "已切换到另一条复盘。");
    }
    if (!restored.managedSource) {
      throw new HistoryRestoreError("MISSING_ARTIFACT", "托管 Demo source 不可用。");
    }
    this.deps.loadManagedDemo(restored.managedSource, mode);
  }
}
