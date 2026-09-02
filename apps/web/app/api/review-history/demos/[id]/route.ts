import { boundedId, boundedJson, noStoreJson, requireDesktopSameOrigin, reviewLibrary } from "../../../../../lib/review-history/route-utils";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
export async function GET(request: Request, context: Context) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const demoId = boundedId((await context.params).id); if (!demoId) return noStoreJson({ code: "INVALID_ID" }, 400);
  try {
    const impact = await reviewLibrary().previewDemoDeletion(demoId);
    return noStoreJson({
      demoId: impact.demoId,
      originalFilename: impact.originalFilename,
      reviews: impact.affectedReviews.map((review) => ({
        id: review.reviewId,
        title: review.title,
        selectedPlayerName: review.selectedPlayerName,
        status: review.status,
      })),
      reviewCount: impact.affectedReviewCount,
      truncated: impact.truncated,
      impactToken: impact.impactToken,
    });
  } catch (error) {
    return noStoreJson({ code: errorCode(error) ?? "IMPACT_FAILED" }, errorCode(error) === "DEMO_NOT_FOUND" ? 404 : 500);
  }
}
export async function DELETE(request: Request, context: Context) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const demoId = boundedId((await context.params).id); if (!demoId) return noStoreJson({ code: "INVALID_ID" }, 400);
  const body = await boundedJson(request);
  if (
    !body ||
    Object.keys(body).length !== 1 ||
    typeof body.impactToken !== "string" ||
    !/^[0-9a-f]{64}$/u.test(body.impactToken)
  ) return noStoreJson({ code: "INVALID_REQUEST" }, 400);
  try { return noStoreJson(await reviewLibrary().deleteDemo(demoId, { impactToken: body.impactToken })); }
  catch (error) {
    const code = errorCode(error);
    return noStoreJson(
      { code: code ?? "DELETE_FAILED" },
      code === "DELETION_IMPACT_CHANGED" ? 409 : code === "DEMO_NOT_FOUND" ? 404 : 500,
    );
  }
}
