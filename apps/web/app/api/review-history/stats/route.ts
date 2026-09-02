import { noStoreJson, requireDesktopSameOrigin, reviewLibrary } from "../../../../lib/review-history/route-utils";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { const rejected = requireDesktopSameOrigin(request); if (rejected) return rejected; try { return noStoreJson(await reviewLibrary().stats()); } catch { return noStoreJson({ code: "STATS_FAILED" }, 500); } }
