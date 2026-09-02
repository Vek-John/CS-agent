import { noStoreJson, requireDesktopSameOrigin, reviewLibrary } from "../../../../lib/review-history/route-utils";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected; try { return noStoreJson(await reviewLibrary().verify()); } catch { return noStoreJson({ code: "VERIFY_FAILED" }, 500); } }
