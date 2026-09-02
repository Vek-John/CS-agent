import type { CommitRuntimeHeadInput, JsonValue } from "@cs-coach/review-library";
import { boundedId, boundedJson, boundedText, noStoreJson, requireDesktopSameOrigin, reviewLibrary } from "../../../../../lib/review-history/route-utils";
import { validateReadyRevisionArtifacts } from "../../../../../lib/review-history/artifact-validation";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function PUT(request: Request, context: Context) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const reviewId = boundedId((await context.params).id); const body = await boundedJson(request, 128_000);
  const revisionId = boundedText(body?.reviewRevisionId); const sessionId = boundedText(body?.sessionId); const runId = boundedText(body?.runId); const demoId = boundedText(body?.demoId); const hash = boundedText(body?.demoContentHash, 64); const player = boundedText(body?.selectedPlayerId); const routeId = boundedText(body?.routeId); const routeHash = boundedText(body?.routeHash); const boundary = body?.recoveryBoundary;
  const recoveryArtifactKey = boundedText(body?.recoveryArtifactKey, 240);
  if (!body || !reviewId || !revisionId || !sessionId || !runId || !demoId || !hash || !player || !routeId || !routeHash || !recoveryArtifactKey || (boundary !== "ROUTE_START" && boundary !== "CUE_PAUSED" && boundary !== "WRAP_UP")) return noStoreJson({ code: "INVALID_REQUEST" }, 400);
  const checkpointNamespace = typeof body.checkpointNamespace === "string" && body.checkpointNamespace.length <= 160 && !body.checkpointNamespace.includes("\0") ? body.checkpointNamespace : undefined;
  const checkpoint = [boundedText(body.checkpointThreadId), checkpointNamespace, boundedText(body.checkpointId)];
  const checkpointCount = checkpoint.filter((value) => value !== undefined).length;
  if ((checkpointCount !== 0 && checkpointCount !== 3) || (boundary !== "ROUTE_START" && checkpointCount !== 3)) return noStoreJson({ code: "INVALID_REQUEST" }, 400);
  const inputBase = { reviewId, reviewRevisionId: revisionId, recoveryArtifactKey, sessionId, runId, demoId, demoContentHash: hash, selectedPlayerId: player, routeId, routeHash, recoveryBoundary: boundary as CommitRuntimeHeadInput["recoveryBoundary"], ...(checkpoint[0] ? { checkpointThreadId: checkpoint[0], checkpointNamespace: checkpoint[1]!, checkpointId: checkpoint[2]! } : {}), ...(boundedText(body.currentCueId) ? { currentCueId: boundedText(body.currentCueId) } : {}), defaultRouteCursor: Number.isInteger(body.defaultRouteCursor) ? body.defaultRouteCursor as number : 0, completedCueCount: Number.isInteger(body.completedCueCount) ? body.completedCueCount as number : 0, totalCueCount: Number.isInteger(body.totalCueCount) ? body.totalCueCount as number : 0, ...(Number.isInteger(body.lastPlaybackTick) ? { lastPlaybackTick: body.lastPlaybackTick as number } : {}), stableProgress: (body.stableProgress ?? {}) as JsonValue, ...(body.reviewStatus === "PREPARING" || body.reviewStatus === "READY" || body.reviewStatus === "IN_PROGRESS" || body.reviewStatus === "COMPLETED" || body.reviewStatus === "FAILED" || body.reviewStatus === "STALE" ? { reviewStatus: body.reviewStatus as CommitRuntimeHeadInput["reviewStatus"] } : {}), ...(boundedText(body.completedAt) ? { completedAt: boundedText(body.completedAt) } : {}) };
  try {
    const library = reviewLibrary();
    const loaded = await library.loadReview(reviewId, {
      materializeExternalArtifacts: true,
      reviewRevisionId: revisionId,
    });
    const recoveryArtifact = loaded.artifacts
      .filter((artifact) => artifact.reviewRevisionId === revisionId &&
        artifact.artifactType === "SESSION_RECOVERY" &&
        artifact.artifactKey === recoveryArtifactKey &&
        artifact.payload !== undefined)
      .sort((left, right) => left.artifactRevision - right.artifactRevision)
      .at(-1);
    if (!recoveryArtifact) return noStoreJson({ code: "REVISION_ARTIFACTS_INCOMPLETE" }, 409);
    const input: CommitRuntimeHeadInput = {
      ...inputBase,
      recoveryArtifactRevision: recoveryArtifact.artifactRevision,
    };
    validateReadyRevisionArtifacts(loaded, input);
    return noStoreJson(await library.commitRuntimeHead(input));
  }
  catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
    return noStoreJson(
      { code: code === "REVISION_ARTIFACTS_INCOMPLETE" ? code : "RUNTIME_HEAD_FAILED" },
      code === "REVISION_ARTIFACTS_INCOMPLETE" ? 409 : 500,
    );
  }
}
