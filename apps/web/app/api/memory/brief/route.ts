import {
  ensureRequestPrincipal,
  authenticateInternalRequest,
  jsonResponse,
  queryHasForbiddenUserId,
  toPublicBrief,
  withCookie,
} from "../../../../lib/memory/api";
import { getMemoryRuntime } from "../../../../lib/memory/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (queryHasForbiddenUserId(request)) return jsonResponse({ error: "USER_ID_NOT_ACCEPTED" }, 400);
  const url = new URL(request.url);
  const text = url.searchParams.get("q")?.trim() ?? "";
  if (text.length > 240) return jsonResponse({ error: "QUERY_TOO_LONG" }, 400);
  const runtimeState = getMemoryRuntime();
  const internal = await authenticateInternalRequest(request, "", runtimeState);
  const requestPrincipal = internal ? undefined : await ensureRequestPrincipal(request);
  const principalId = internal?.principalId ?? requestPrincipal?.principal.id;
  if (!principalId) return jsonResponse({ ok: false, reason: "PRINCIPAL_UNAVAILABLE", brief: { source: "EMPTY", memories: [], activeThreads: [], corrections: [], limitations: ["Memory brief unavailable."] } }, 503);
  try {
    const brief = await runtimeState.service.getBrief(principalId, text ? { semanticText: text } : undefined);
    const response = jsonResponse({
      ok: true,
      featureFlag: runtimeState.featureEnabled,
      principalType: "ANONYMOUS",
      // The DO calls this route through an authenticated internal seam. Keep
      // the complete domain brief on that seam so it can validate and then
      // strip internal identity/provenance before passing it to the Agent;
      // browser callers receive the redacted management projection below.
      brief: internal ? brief : toPublicBrief(brief),
      ...(runtimeState.degradedReason ? { degradedReason: runtimeState.degradedReason } : {}),
    });
    return withCookie(response, requestPrincipal?.setCookie);
  } catch {
    const response = jsonResponse({ ok: false, brief: { source: "EMPTY", memories: [], activeThreads: [], corrections: [], limitations: ["Memory brief unavailable."] }, reason: "BRIEF_UNAVAILABLE" }, 200);
    return withCookie(response, requestPrincipal?.setCookie);
  }
}
