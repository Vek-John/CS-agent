import type { AppendArtifactInput, JsonValue, ReviewArtifactType } from "@cs-coach/review-library";
import { boundedId, boundedJson, boundedText, noStoreJson, requireDesktopSameOrigin, reviewLibrary } from "../../../../../lib/review-history/route-utils";
import { validateReviewArtifactAppend } from "../../../../../lib/review-history/artifact-validation";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const kinds = new Set<ReviewArtifactType>(["ANALYSIS_BUNDLE", "CANDIDATE_SET", "REVIEW_PLAN", "NARRATION_BUNDLE", "CUE_CASE", "DIAGNOSTIC_RESULT", "TRANSFER_RULE", "LEARNING_THREAD", "SESSION_RECOVERY", "SESSION_SUMMARY", "TOOL_RESULT", "USER_INTERACTION"]);
export async function POST(request: Request, context: Context) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  // AnalysisBundle is a whitelist payload that the server DAL may externalize
  // as gzip; keep a fixed upper bound while allowing a full match control plane.
  const reviewId = boundedId((await context.params).id); const body = await boundedJson(request, 8 * 1024 * 1024);
  const revisionId = boundedText(body?.revisionId); const artifactKey = boundedText(body?.artifactKey); const idempotencyKey = boundedText(body?.idempotencyKey, 160); const kind = body?.artifactType;
  const schemaVersion = boundedText(body?.schemaVersion);
  const artifactRevision = Number.isInteger(body?.artifactRevision) ? body!.artifactRevision as number : 1;
  if (!reviewId || !revisionId || !artifactKey || !idempotencyKey || !schemaVersion || artifactRevision <= 0 || artifactRevision > 1_000_000 || typeof kind !== "string" || !kinds.has(kind as ReviewArtifactType) || body?.payload === undefined) return noStoreJson({ code: "INVALID_REQUEST" }, 400);
  const input: AppendArtifactInput = { reviewRevisionId: revisionId, artifactType: kind as ReviewArtifactType, artifactKey, artifactRevision, schemaVersion, payload: body.payload as JsonValue, idempotencyKey };
  try {
    const loaded = await reviewLibrary().loadReview(reviewId, {
      materializeExternalArtifacts: true,
      reviewRevisionId: revisionId,
    });
    if (!loaded.revisions.some((revision) => revision.reviewRevisionId === revisionId && revision.reviewId === reviewId)) return noStoreJson({ code: "REVISION_NOT_FOUND" }, 404);
    validateReviewArtifactAppend(loaded, input);
    return noStoreJson(await reviewLibrary().appendArtifact(input), 201);
  } catch { return noStoreJson({ code: "ARTIFACT_INVALID" }, 400); }
}
