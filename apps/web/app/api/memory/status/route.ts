import { authenticateInternalRequest, ensureRequestPrincipal, jsonResponse, queryHasForbiddenUserId, withCookie } from "../../../../lib/memory/api";
import { getMemoryRuntime } from "../../../../lib/memory/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (queryHasForbiddenUserId(request)) return jsonResponse({ error: "USER_ID_NOT_ACCEPTED" }, 400);
  const runtimeState = getMemoryRuntime();
  const internal = await authenticateInternalRequest(request, "", runtimeState);
  const requestPrincipal = internal ? undefined : await ensureRequestPrincipal(request);
  const principalId = internal?.principalId ?? requestPrincipal?.principal.id;
  const authorization = runtimeState.featureEnabled && principalId
    ? await runtimeState.getAuthorization(principalId)
    : undefined;
  const consent = authorization?.consent ?? requestPrincipal?.principal.consent ?? "UNKNOWN";
  const granted = runtimeState.featureEnabled && consent === "GRANTED" && Boolean(authorization?.memoryEnabled ?? authorization?.featureFlag);
  const response = jsonResponse({
    featureFlag: runtimeState.featureEnabled,
    enabled: granted,
    consent: runtimeState.featureEnabled ? consent : "UNKNOWN",
    ...(authorization?.consentVersion !== undefined ? { consentVersion: authorization.consentVersion } : {}),
    principalType: "ANONYMOUS",
    storage: runtimeState.storage,
    durable: runtimeState.durable,
    ...(runtimeState.featureEnabled && runtimeState.degradedReason ? { degradedReason: runtimeState.degradedReason } : {}),
    ...(requestPrincipal?.resolutionReason === "SECRET_UNAVAILABLE" ? { principalCookie: "UNAVAILABLE" } : {}),
  });
  return withCookie(response, requestPrincipal?.setCookie);
}
