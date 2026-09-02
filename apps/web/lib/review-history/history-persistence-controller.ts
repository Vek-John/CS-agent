export type PersistedArtifactType = "ANALYSIS_BUNDLE" | "CANDIDATE_SET" | "REVIEW_PLAN" | "NARRATION_BUNDLE" | "CUE_CASE" | "DIAGNOSTIC_RESULT" | "TRANSFER_RULE" | "LEARNING_THREAD" | "SESSION_RECOVERY" | "SESSION_SUMMARY" | "TOOL_RESULT" | "USER_INTERACTION";

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
  commitRuntimeHead(reviewId: string, input: Record<string, unknown>): Promise<void>;
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
  constructor(private readonly deps: HistoryPersistenceDeps) {}
  get reviewId() { return this.#reviewId; }
  get revisionId() { return this.#revisionId; }
  reset(): void { this.#generation += 1; this.#reviewId = undefined; this.#revisionId = undefined; this.#demoId = undefined; this.#revisionMode = "REANALYZE"; this.#reviewPromise = undefined; this.#revisionPromise = undefined; }
  adopt(reviewId: string, revisionId: string | undefined, demoId: string, mode: "REANALYZE" | "SELECT_PLAYER" = "REANALYZE") { this.#generation += 1; this.#reviewId = reviewId; this.#revisionId = revisionId; this.#demoId = demoId; this.#revisionMode = mode; this.#reviewPromise = undefined; this.#revisionPromise = undefined; }
  async createForPlayer(input: { demoId: string; selectedPlayerId: string; selectedPlayerName: string; title: string; mapName?: string }): Promise<string> {
    const generation = ++this.#generation;
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
  async stableHead(input: Record<string, unknown>): Promise<void> {
    const generation = this.#generation; const reviewPromise = this.#reviewPromise; const revisionPromise = this.#revisionPromise;
    const reviewId = this.#reviewId ?? await reviewPromise; const revisionId = this.#revisionId ?? await revisionPromise;
    if (generation !== this.#generation || reviewPromise !== this.#reviewPromise || revisionPromise !== this.#revisionPromise) throw new Error("STALE_HISTORY_GENERATION");
    const demoId = this.#demoId;
    if (!reviewId || !revisionId || !demoId) return;
    // The DemoAsset identity is bound when the Review is created/adopted.
    // AnalysisBundle.demo_id is a separate parser artifact identifier and may
    // never override the managed-library UUID at this durability boundary.
    await this.deps.commitRuntimeHead(reviewId, { ...input, demoId, reviewRevisionId: revisionId });
    if (generation !== this.#generation || reviewId !== this.#reviewId || revisionId !== this.#revisionId) throw new Error("STALE_HISTORY_GENERATION");
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
