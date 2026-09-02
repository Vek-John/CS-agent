import { boundedJson, boundedText, noStoreJson, requireDesktopSameOrigin, reviewLibrary } from "../../../../lib/review-history/route-utils";
import { bridgeCapabilityToken } from "../../../../lib/review-history/capability-token";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected;
  const body = await boundedJson(request); const requestId = boundedText(body?.requestId); const originalFilename = boundedText(body?.originalFilename); const byteSize = typeof body?.byteSize === "number" ? body.byteSize : undefined;
  if (!requestId || !originalFilename || byteSize === undefined || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > 8 * 1024 * 1024 * 1024) return noStoreJson({ code: "INVALID_REQUEST" }, 400);
  const expectedByteLength = byteSize as number;
  try { const capability = await reviewLibrary().issueImportCapability({ objectId: requestId, originalFilename, expectedByteLength }); const token = bridgeCapabilityToken(capability.authorization); if (!token) return noStoreJson({ code: "CAPABILITY_FAILED" }, 500); return noStoreJson({ requestId, capabilityToken: token }); }
  catch { return noStoreJson({ code: "CAPABILITY_FAILED" }, 500); }
}
