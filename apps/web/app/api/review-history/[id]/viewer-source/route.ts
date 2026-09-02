import { boundedId, noStoreJson, requireDesktopSameOrigin, reviewLibrary } from "../../../../../lib/review-history/route-utils";
import { bridgeCapabilityToken } from "../../../../../lib/review-history/capability-token";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const reviewId = boundedId((await context.params).id); if (!reviewId) return noStoreJson({ code: "INVALID_ID" }, 400);
  try {
    const loaded = await reviewLibrary().loadReview(reviewId);
    const capability = await reviewLibrary().issueViewerCapability({ demoId: loaded.demo.demoId });
    const token = bridgeCapabilityToken(capability.authorization);
    if (!token) return noStoreJson({ code: "SOURCE_UNAVAILABLE" }, 500);
    return noStoreJson({ requestId: crypto.randomUUID(), demoId: loaded.demo.demoId, capabilityToken: token, originalFilename: loaded.demo.originalFilename, byteSize: loaded.demo.byteSize, contentHash: loaded.demo.contentHash });
  } catch { return noStoreJson({ code: "SOURCE_UNAVAILABLE" }, 409); }
}
