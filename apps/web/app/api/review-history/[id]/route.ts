import type { ReviewArtifact, ReviewRevision } from "@cs-coach/review-library";
import { boundedId, boundedJson, boundedText, noStoreJson, requireDesktopSameOrigin, reviewLibrary } from "../../../../lib/review-history/route-utils";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

function safeArtifact(artifact: ReviewArtifact) {
  return artifact.payload === undefined ? null : ({
    id: artifact.artifactId,
    kind: artifact.artifactType,
    key: artifact.artifactKey,
    revision: artifact.artifactRevision,
    createdAt: artifact.createdAt,
    payload: artifact.payload,
  });
}

export async function GET(request: Request, context: Context) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const id = boundedId((await context.params).id); if (!id) return noStoreJson({ code: "INVALID_ID" }, 400);
  try {
    const loaded = await reviewLibrary().loadReview(id, { materializeExternalArtifacts: true });
    const revisions: readonly ReviewRevision[] = loaded.revisions;
    const artifactsInput: readonly ReviewArtifact[] = loaded.artifacts;
    const revision = revisions.find((item) => item.reviewRevisionId === loaded.review.activeRevisionId) ?? revisions.at(-1) ?? null;
    const artifacts = revision ? artifactsInput.filter((item) => item.reviewRevisionId === revision.reviewRevisionId).flatMap((item) => { const safe = safeArtifact(item); return safe ? [safe] : []; }) : [];
    return noStoreJson({
      review: {
        id: loaded.review.reviewId,
        demoId: loaded.review.demoId,
        title: loaded.review.title,
        status: loaded.review.status,
        selectedPlayerId: loaded.review.selectedPlayerId,
        selectedPlayerName: loaded.review.selectedPlayerName,
        ...(loaded.review.mapName ? { mapName: loaded.review.mapName } : {}),
        ...(loaded.review.scoreText ? { scoreText: loaded.review.scoreText } : {}),
      },
      revision: revision ? {
        id: revision.reviewRevisionId,
        status: revision.status,
        artifactContractVersion: revision.artifactContractVersion,
        routeId: revision.routeId,
        routeHash: revision.routeHash,
      } : null,
      artifacts,
      artifactIssues: loaded.artifactIssues,
      runtimeHead: loaded.runtimeHead ?? null,
    });
  } catch { return noStoreJson({ code: "NOT_FOUND" }, 404); }
}

export async function PATCH(request: Request, context: Context) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const id = boundedId((await context.params).id); const body = await boundedJson(request); const title = boundedText(body?.title); const status = body?.status;
  if (!id || !body || (Boolean(title) === (status === "PREPARING" || status === "FAILED" || status === "STALE"))) return noStoreJson({ code: "INVALID_REQUEST" }, 400);
  try { return noStoreJson(title ? await reviewLibrary().renameReview(id, title) : await reviewLibrary().updateReviewStatus(id, status as "PREPARING" | "FAILED" | "STALE")); }
  catch { return noStoreJson({ code: "RENAME_FAILED" }, 500); }
}

export async function DELETE(request: Request, context: Context) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const id = boundedId((await context.params).id); if (!id) return noStoreJson({ code: "INVALID_ID" }, 400);
  try { return noStoreJson(await reviewLibrary().deleteReview(id)); }
  catch { return noStoreJson({ code: "DELETE_FAILED" }, 500); }
}
