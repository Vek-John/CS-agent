import type { StartRevisionInput } from "@cs-coach/review-library";
import { COACH_AGENT_GRAPH_VERSION } from "@cs-coach/coach-agent/client";
import { CS2D_ADAPTER_VERSION } from "@cs-coach/cs2d-analysis-adapter";
import { boundedId, boundedJson, boundedText, noStoreJson, requireDesktopSameOrigin, reviewLibrary } from "../../../../../lib/review-history/route-utils";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const reviewId = boundedId((await context.params).id); const body = await boundedJson(request);
  const routeId = boundedText(body?.routeId); const routeHash = boundedText(body?.routeHash);
  const promptVersion = boundedText(body?.promptVersion);
  const metadata = body?.modelMetadata;
  if (
    !reviewId || !body ||
    (body.mode !== "REANALYZE" && body.mode !== "SELECT_PLAYER") ||
    !routeId || !routeHash || !promptVersion ||
    body.analysisVersion !== CS2D_ADAPTER_VERSION ||
    body.graphVersion !== COACH_AGENT_GRAPH_VERSION ||
    !metadata || typeof metadata !== "object" || Array.isArray(metadata)
  ) return noStoreJson({ code: "INVALID_REQUEST" }, 400);
  const input: StartRevisionInput = {
    reviewId,
    analysisVersion: CS2D_ADAPTER_VERSION,
    graphVersion: COACH_AGENT_GRAPH_VERSION,
    promptVersion,
    modelMetadata: { ...metadata, mode: body.mode },
    routeId,
    routeHash,
  };
  try { const revision = await reviewLibrary().startRevision(input); return noStoreJson({ revisionId: revision.reviewRevisionId }, 201); }
  catch { return noStoreJson({ code: "REVISION_FAILED" }, 500); }
}
