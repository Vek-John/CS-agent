import type { CreateReviewInput } from "@cs-coach/review-library";
import { boundedJson, boundedText, noStoreJson, requireDesktopSameOrigin, reviewLibrary } from "../../../lib/review-history/route-utils";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "30") || 30));
  const search = url.searchParams.get("search")?.slice(0, 120) || undefined;
  const cursor = url.searchParams.get("cursor")?.slice(0, 240) || undefined;
  try { return noStoreJson(await reviewLibrary().listReviews({ limit, search, cursor })); }
  catch { return noStoreJson({ code: "LIST_FAILED" }, 500); }
}

export async function POST(request: Request) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const body = await boundedJson(request); if (!body) return noStoreJson({ code: "INVALID_REQUEST" }, 400);
  const demoId = boundedText(body.demoId); const selectedPlayerId = boundedText(body.selectedPlayerId); const selectedPlayerName = boundedText(body.selectedPlayerName);
  const title = boundedText(body.title); if (!demoId || !selectedPlayerId || !selectedPlayerName || !title) return noStoreJson({ code: "INVALID_REQUEST" }, 400);
  const input: CreateReviewInput = { demoId, selectedPlayerId, selectedPlayerName, title, ...(boundedText(body.mapName) ? { mapName: boundedText(body.mapName) } : {}), ...(boundedText(body.scoreText) ? { scoreText: boundedText(body.scoreText) } : {}), status: "PREPARING" };
  try { return noStoreJson(await reviewLibrary().createReview(input), 201); }
  catch { return noStoreJson({ code: "CREATE_FAILED" }, 500); }
}
