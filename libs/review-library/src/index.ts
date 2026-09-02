/** Browser-safe DTOs. Runtime and filesystem implementations live in ./server. */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type DemoAssetStatus = "IMPORTING" | "READY" | "MISSING" | "CORRUPT";
export interface DemoAsset {
  readonly demoId: string;
  readonly contentHash: string;
  readonly originalFilename: string;
  readonly byteSize: number;
  readonly mapName?: string;
  readonly matchStartedAt?: string;
  readonly matchDurationMs?: number;
  readonly status: DemoAssetStatus;
  readonly importedAt: string;
  readonly lastOpenedAt: string;
  readonly parserVersion?: string;
}

export type ReviewStatus =
  | "PREPARING"
  | "READY"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "STALE";
export interface ReviewSummary {
  readonly reviewId: string;
  readonly demoId: string;
  readonly originalFilename: string;
  readonly selectedPlayerId: string;
  readonly selectedPlayerName: string;
  readonly title: string;
  readonly mapName?: string;
  readonly scoreText?: string;
  readonly status: ReviewStatus;
  readonly activeRevisionId?: string;
  readonly currentCueId?: string;
  /** Non-authoritative UI summary. Stable recovery comes from runtimeHead. */
  readonly currentPlaybackTick?: number;
  readonly completedCueCount: number;
  readonly totalCueCount: number;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
  readonly completedAt?: string;
  readonly demoStatus: DemoAssetStatus;
}
export type ReviewRecord = ReviewSummary;

export type ReviewRevisionStatus = "PREPARING" | "READY" | "FAILED";
export interface ReviewRevision {
  readonly reviewRevisionId: string;
  readonly reviewId: string;
  readonly analysisVersion: string;
  readonly graphVersion: string;
  readonly promptVersion: string;
  readonly modelMetadata: JsonValue;
  readonly routeId?: string;
  readonly routeHash: string;
  readonly status: ReviewRevisionStatus;
  /** v1 allows CandidateSet embedded in AnalysisBundle; v2 requires its own Artifact. */
  readonly artifactContractVersion: 1 | 2;
  readonly createdAt: string;
}

export type ReviewArtifactType =
  | "ANALYSIS_BUNDLE"
  | "CANDIDATE_SET"
  | "REVIEW_PLAN"
  | "NARRATION_BUNDLE"
  | "CUE_CASE"
  | "DIAGNOSTIC_RESULT"
  | "TRANSFER_RULE"
  | "LEARNING_THREAD"
  | "SESSION_RECOVERY"
  | "SESSION_SUMMARY"
  | "TOOL_RESULT"
  | "USER_INTERACTION";
export type ReviewArtifactStorageKind = "SQLITE_JSON" | "GZIP_FILE";
export interface ReviewArtifact {
  readonly artifactId: string;
  readonly reviewRevisionId: string;
  readonly artifactType: ReviewArtifactType;
  readonly artifactKey: string;
  readonly artifactRevision: number;
  readonly schemaVersion: string;
  readonly checksum: string;
  readonly storageKind: ReviewArtifactStorageKind;
  readonly byteSize: number;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  /** Present only for bounded SQLite JSON. External AnalysisBundle bytes stay server-side. */
  readonly payload?: JsonValue;
}

export type RecoveryBoundary = "ROUTE_START" | "CUE_PAUSED" | "WRAP_UP";
export interface ReviewRuntimeHead {
  readonly reviewId: string;
  readonly reviewRevisionId: string;
  /** Exact persisted recovery snapshot selected by the atomic head commit. */
  readonly recoveryArtifactId?: string;
  readonly recoveryArtifactKey?: string;
  readonly recoveryArtifactRevision?: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly demoId: string;
  readonly demoContentHash: string;
  readonly selectedPlayerId: string;
  readonly routeId: string;
  readonly routeHash: string;
  readonly recoveryBoundary: RecoveryBoundary;
  readonly checkpointThreadId?: string;
  readonly checkpointNamespace?: string;
  readonly checkpointId?: string;
  readonly currentCueId?: string;
  readonly defaultRouteCursor: number;
  readonly completedCueCount: number;
  readonly totalCueCount: number;
  /** Non-authoritative playback summary; never substitutes for a stable boundary. */
  readonly lastPlaybackTick?: number;
  readonly stableProgress: JsonValue;
  readonly updatedAt: string;
}

export interface LibraryCapability {
  readonly authorization: string;
  readonly objectId: string;
  readonly purpose: "IMPORT" | "VIEW" | "VALIDATE";
  readonly expiresAt: string;
}
export interface ImportDemoResult {
  readonly demo: DemoAsset;
  readonly deduplicated: boolean;
  /** Present until a newly published/corrupt asset passes the real parser. */
  readonly validationCapability?: LibraryCapability;
}
export interface ListReviewsInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly search?: string;
}
export interface ReviewPage {
  readonly items: readonly ReviewSummary[];
  readonly nextCursor: string | null;
}
export interface LoadedReview {
  readonly demo: DemoAsset;
  readonly review: ReviewRecord;
  readonly revisions: readonly ReviewRevision[];
  readonly artifacts: readonly ReviewArtifact[];
  readonly artifactIssues: readonly ReviewArtifactIssue[];
  readonly runtimeHead?: ReviewRuntimeHead;
}
export interface ReviewArtifactIssue {
  readonly kind: ReviewArtifactType;
  readonly key: string;
  readonly code: "ARTIFACT_CORRUPT" | "ARTIFACT_LIMIT_EXCEEDED";
}
export interface LoadReviewOptions {
  /** Decompresses and checksum-verifies external AnalysisBundle JSON. */
  readonly materializeExternalArtifacts?: boolean;
  /** Internal detail/validation projection; must belong to the requested Review. */
  readonly reviewRevisionId?: string;
}

export interface DemoLibraryEntry {
  readonly demoId: string;
  readonly originalFilename: string;
  readonly byteSize: number;
  readonly mapName?: string;
  readonly status: DemoAssetStatus;
  readonly importedAt: string;
  readonly lastOpenedAt: string;
  readonly reviewCount: number;
}
export interface ReviewLibraryEntries {
  readonly schemaVersion: "review-library-entries.v1";
  readonly reviews: readonly ReviewSummary[];
  readonly demos: readonly DemoLibraryEntry[];
}
export interface DemoDeletionAffectedReview {
  readonly reviewId: string;
  readonly title: string;
  readonly selectedPlayerName: string;
  readonly status: ReviewStatus;
}
export interface DemoDeletionImpact {
  readonly schemaVersion: "review-library-demo-deletion-impact.v1";
  readonly demoId: string;
  readonly originalFilename: string;
  readonly affectedReviewCount: number;
  readonly affectedReviews: readonly DemoDeletionAffectedReview[];
  readonly truncated: boolean;
  /** Optimistic concurrency token over the complete affected Review id set. */
  readonly impactToken: string;
}

export interface CreateReviewInput {
  readonly demoId: string;
  readonly selectedPlayerId: string;
  readonly selectedPlayerName: string;
  readonly title: string;
  readonly mapName?: string;
  readonly scoreText?: string;
  readonly status?: ReviewStatus;
}
export interface StartRevisionInput {
  readonly reviewId: string;
  readonly analysisVersion: string;
  readonly graphVersion: string;
  readonly promptVersion: string;
  readonly modelMetadata: JsonValue;
  readonly routeId?: string;
  readonly routeHash: string;
}
export interface AppendArtifactInput {
  readonly reviewRevisionId: string;
  readonly artifactType: ReviewArtifactType;
  readonly artifactKey: string;
  readonly artifactRevision: number;
  readonly schemaVersion: string;
  readonly payload: JsonValue;
  readonly idempotencyKey: string;
}
export type CommitRuntimeHeadInput = Omit<
  ReviewRuntimeHead,
  "updatedAt" | "recoveryArtifactId" | "recoveryArtifactKey" | "recoveryArtifactRevision"
> & {
  /** Exact SESSION_RECOVERY artifact that must match this head in the commit transaction. */
  readonly recoveryArtifactKey: string;
  /** Revision selected by the application validator; prevents validation/commit races. */
  readonly recoveryArtifactRevision: number;
  readonly reviewStatus?: ReviewStatus;
  readonly completedAt?: string;
};

export interface DeleteResult {
  readonly deleted: true;
  readonly targetId: string;
  readonly removedReviewCount: number;
  readonly removedDemo: boolean;
}
export interface LibraryStats {
  readonly schemaVersion: "review-library-stats.v1";
  readonly demoCount: number;
  readonly reviewCount: number;
  readonly rawDemoBytes: number;
  readonly artifactBytes: number;
  readonly cacheBytes: number;
  readonly totalBytes: number;
}
export interface LibraryVerificationIssue {
  readonly kind:
    | "DEMO_MISSING"
    | "DEMO_SIZE_MISMATCH"
    | "DEMO_CHECKSUM_MISMATCH"
    | "ARTIFACT_MISSING"
    | "ARTIFACT_CHECKSUM_MISMATCH"
    | "INVALID_RELATIVE_PATH"
    | "SYMLINK_ESCAPE";
  readonly objectId: string;
}
export interface LibraryVerificationResult {
  readonly schemaVersion: "review-library-verification.v1";
  readonly checkedDemos: number;
  readonly checkedArtifacts: number;
  readonly issues: readonly LibraryVerificationIssue[];
}
export interface LibraryCacheCleanupResult {
  readonly schemaVersion: "review-library-cache-cleanup.v1";
  readonly removedBytes: number;
  readonly cacheBytes: number;
}
export interface LibraryReconcileResult {
  readonly removedPartialFiles: number;
  readonly recoveredImports: number;
  readonly failedImports: number;
  readonly recoveredDeletes: number;
  readonly failedDeletes: number;
}

export interface ClaimMemoryOpportunityInput {
  readonly userId: string;
  readonly demoContentHash: string;
  readonly selectedPlayerId: string;
  readonly stableCueSourceId: string;
  readonly taxonomyCode: string;
  readonly analysisEvidenceRevision: string;
  readonly evidenceKey: string;
  readonly evidence: JsonValue;
  readonly sourceReviewId?: string;
  readonly sourceReviewRevisionId?: string;
  readonly sourceArtifactId?: string;
}
export interface ClaimMemoryOpportunityResult {
  /** True only for the first stable opportunity, independent of analysis revision. */
  readonly claimed: boolean;
  readonly evidenceUpdated: boolean;
}
