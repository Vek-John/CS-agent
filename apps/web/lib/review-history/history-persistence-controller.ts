export type PersistedArtifactType = "ANALYSIS_BUNDLE" | "CANDIDATE_SET" | "REVIEW_PLAN" | "NARRATION_BUNDLE" | "CUE_CASE" | "DIAGNOSTIC_RESULT" | "TRANSFER_RULE" | "LEARNING_THREAD" | "SESSION_RECOVERY" | "SESSION_SUMMARY" | "TOOL_RESULT" | "USER_INTERACTION";

export interface RuntimeHeadRetry {
  isCurrent(): boolean;
  /** False means the retained request was invalidated or already completed. */
  retry(): Promise<boolean>;
}

export interface HistoryPersistenceDeps {
  createReview(input: { demoId: string; selectedPlayerId: string; selectedPlayerName: string; title: string; mapName?: string }): Promise<{ reviewId: string }>;
  startRevision(reviewId: string, input: {
    mode: "REANALYZE" | "SELECT_PLAYER";
    routeId: string;
    routeHash: string;
    analysisVersion: string;
    graphVersion: string;
    promptVersion: string;
    modelMetadata: Record<string, unknown>;
  }): Promise<{ revisionId: string }>;
  appendArtifact(reviewId: string, input: { revisionId: string; artifactType: string; artifactKey: string; artifactRevision?: number; schemaVersion: string; payload: unknown; idempotencyKey: string }): Promise<void>;
  commitRuntimeHead(reviewId: string, input: Record<string, unknown>): Promise<{ recoveryArtifactId: string }>;
  markFailed(reviewId: string): Promise<void>;
}

export class HistoryPersistenceController {
  #generation = 0;
  #reviewId?: string;
  #revisionId?: string;
  #demoId?: string;
  #revisionMode: "REANALYZE" | "SELECT_PLAYER" = "REANALYZE";
  #revisionPromise?: Promise<string | undefined>;
  #reviewPromise?: Promise<string>;
  #expectedRecoveryArtifactId: string | null = null;
  #headTail: Promise<unknown> = Promise.resolve();
  #headIntent = 0;
  constructor(private readonly deps: HistoryPersistenceDeps) {}
  /** Read-only ownership epoch; identity can initialize without changing this epoch. */
  get ownershipGeneration() { return this.#generation; }
  get reviewId() { return this.#reviewId; }
  get revisionId() { return this.#revisionId; }
  reset(): void { this.#generation += 1; this.#reviewId = undefined; this.#revisionId = undefined; this.#demoId = undefined; this.#revisionMode = "REANALYZE"; this.#reviewPromise = undefined; this.#revisionPromise = undefined; this.#expectedRecoveryArtifactId = null; this.#headTail = Promise.resolve(); }
  adopt(reviewId: string, revisionId: string | undefined, demoId: string, mode: "REANALYZE" | "SELECT_PLAYER" = "REANALYZE", runtimeHead: unknown = null) {
    const expected = storedHeadExpectation(runtimeHead, reviewId, demoId);
    this.#generation += 1; this.#reviewId = reviewId; this.#revisionId = revisionId; this.#demoId = demoId; this.#revisionMode = mode; this.#reviewPromise = undefined; this.#revisionPromise = undefined;
    this.#expectedRecoveryArtifactId = expected; this.#headTail = Promise.resolve();
  }
  async createForPlayer(input: { demoId: string; selectedPlayerId: string; selectedPlayerName: string; title: string; mapName?: string }): Promise<string> {
    const generation = ++this.#generation;
    this.#expectedRecoveryArtifactId = null; this.#headTail = Promise.resolve();
    this.#reviewId = undefined; this.#revisionId = undefined; this.#demoId = input.demoId; this.#revisionMode = "SELECT_PLAYER"; this.#revisionPromise = undefined;
    const pending = this.deps.createReview(input).then((review) => review.reviewId);
    this.#reviewPromise = pending;
    const reviewId = await pending;
    if (generation !== this.#generation) throw new Error("STALE_HISTORY_GENERATION");
    this.#reviewId = reviewId;
    return reviewId;
  }
  async beginRevision(input: {
    routeId: string;
    routeHash: string;
    analysisVersion: string;
    graphVersion: string;
    promptVersion: string;
    modelMetadata: Record<string, unknown>;
  }): Promise<string | undefined> {
    const generation = this.#generation;
    if (this.#revisionId) return this.#revisionId;
    if (this.#revisionPromise) return this.#revisionPromise;
    // Publish one promise before waiting for Review creation so RouteFrozen's
    // immediately-following artifacts join this same revision rather than
    // observing an undefined revision slot.
    const pending = (async () => {
      const reviewId = this.#reviewId ?? await this.#reviewPromise;
      if (!reviewId || generation !== this.#generation) throw new Error("STALE_HISTORY_GENERATION");
      const revision = await this.deps.startRevision(reviewId, { mode: this.#revisionMode, ...input });
      if (generation !== this.#generation) throw new Error("STALE_HISTORY_GENERATION");
      return revision.revisionId;
    })();
    this.#revisionPromise = pending;
    const revisionId = await pending;
    if (generation !== this.#generation) throw new Error("STALE_HISTORY_GENERATION");
    this.#revisionId = revisionId;
    return revisionId;
  }
  async artifact(
    type: PersistedArtifactType,
    key: string,
    payload: unknown,
    schemaVersion: string,
    artifactRevision = 1,
  ): Promise<void> {
    this.#headIntent += 1; // New saved content invalidates any retained head retry.
    const generation = this.#generation; const reviewPromise = this.#reviewPromise; const revisionPromise = this.#revisionPromise;
    const reviewId = this.#reviewId ?? await reviewPromise; const revisionId = this.#revisionId ?? await revisionPromise;
    if (generation !== this.#generation || reviewPromise !== this.#reviewPromise || revisionPromise !== this.#revisionPromise) throw new Error("STALE_HISTORY_GENERATION");
    if (!reviewId || !revisionId) return;
    await this.deps.appendArtifact(reviewId, {
      revisionId,
      artifactType: type,
      artifactKey: key,
      artifactRevision,
      schemaVersion,
      payload,
      idempotencyKey: `${revisionId}:${type}:${key}:v${artifactRevision}`.slice(0, 160),
    });
    if (generation !== this.#generation || reviewId !== this.#reviewId || revisionId !== this.#revisionId) throw new Error("STALE_HISTORY_GENERATION");
  }
  stableHead(input: Record<string, unknown>, onRetry?: (retry: RuntimeHeadRetry) => void): Promise<void> {
    const intent = ++this.#headIntent;
    const generation = this.#generation;
    const snapshot = structuredClone(input);
    const pending = this.#headTail.then(() => this.commitStableHead(snapshot, generation, intent, onRetry));
    this.#headTail = pending.catch(() => undefined);
    return pending;
  }
  private async commitStableHead(input: Record<string, unknown>, requestedGeneration: number, intent: number, onRetry?: (retry: RuntimeHeadRetry) => void): Promise<void> {
    if (requestedGeneration !== this.#generation) throw new Error("STALE_HISTORY_GENERATION");
    const generation = this.#generation; const reviewPromise = this.#reviewPromise; const revisionPromise = this.#revisionPromise;
    const reviewId = this.#reviewId ?? await reviewPromise; const revisionId = this.#revisionId ?? await revisionPromise;
    if (generation !== this.#generation || reviewPromise !== this.#reviewPromise || revisionPromise !== this.#revisionPromise) throw new Error("STALE_HISTORY_GENERATION");
    const demoId = this.#demoId;
    if (!reviewId || !revisionId || !demoId) return;
    // The DemoAsset identity is bound when the Review is created/adopted.
    // AnalysisBundle.demo_id is a separate parser artifact identifier and may
    // never override the managed-library UUID at this durability boundary.
    const request = { ...input, demoId, reviewRevisionId: revisionId, expectedRecoveryArtifactId: this.#expectedRecoveryArtifactId };
    const ownerCurrent = () => generation === this.#generation && reviewId === this.#reviewId && revisionId === this.#revisionId;
    const current = () => ownerCurrent() && intent === this.#headIntent;
    const send = async () => {
      const committed = await this.deps.commitRuntimeHead(reviewId, structuredClone(request));
      if (!ownerCurrent()) throw new Error("STALE_HISTORY_GENERATION");
      if (!committed) throw new Error("INVALID_RUNTIME_HEAD_ACK");
      this.#expectedRecoveryArtifactId = recoveryArtifactIdFromHead(committed);
    };
    try { await send(); }
    catch (error) {
      if (onRetry && current() && isRetryableRuntimeHeadFailure(error)) {
        let finished = false;
        let blocked = false;
        let inFlight: Promise<boolean> | undefined;
        const isCurrent = current;
        onRetry({ isCurrent, retry: () => {
          if (inFlight) return inFlight;
          if (!isCurrent() || finished || blocked) return Promise.resolve(false);
          const pending = this.#headTail.then(async () => {
            if (!isCurrent() || finished || blocked) return false;
            try { await send(); finished = true; return isCurrent(); }
            catch (retryError) { if (!isRetryableRuntimeHeadFailure(retryError)) blocked = true; throw retryError; }
          });
          this.#headTail = pending.catch(() => undefined);
          inFlight = pending.finally(() => { inFlight = undefined; });
          return inFlight;
        } });
      }
      throw error;
    }
  }

  async markFailed(): Promise<void> {
    const generation = this.#generation;
    const reviewPromise = this.#reviewPromise;
    const reviewId = this.#reviewId ?? await reviewPromise;
    if (generation !== this.#generation || reviewPromise !== this.#reviewPromise)
      throw new Error("STALE_HISTORY_GENERATION");
    if (!reviewId) return;
    await this.deps.markFailed(reviewId);
  }
}

/** Missing stored head is distinct from a malformed acknowledgement or corrupt stored head. */
export function recoveryArtifactIdFromHead(head: unknown): string | null {
  if (head === null) return null;
  const id = head && typeof head === "object" && "recoveryArtifactId" in head ? head.recoveryArtifactId : undefined;
  if (typeof id !== "string" || !id.trim() || id.length > 240 || id.includes("\0")) throw new Error("INVALID_RUNTIME_HEAD_ACK");
  return id;
}

function storedHeadExpectation(head: unknown, reviewId: string, demoId: string): string | null {
  // Pre-binding history rows can still be explicitly reanalyzed. They cannot be
  // used for exact recovery, and must never qualify as a new save acknowledgement.
  if (head && typeof head === "object") {
    const stored = head as Record<string, unknown>;
    if (stored.recoveryArtifactId === undefined && stored.recoveryArtifactKey === undefined && stored.recoveryArtifactRevision === undefined
      && stored.reviewId === reviewId && stored.demoId === demoId
      && [stored.reviewRevisionId, stored.sessionId, stored.runId].every(value => typeof value === "string" && value.trim())) return null;
  }
  return recoveryArtifactIdFromHead(head);
}

export function isRetryableRuntimeHeadFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === undefined || code === "CHECKPOINT_SAVE_TIMEOUT" || code === "INVALID_RUNTIME_HEAD_ACK" || code === "REQUEST_FAILED";
}
