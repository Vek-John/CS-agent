import {
  clearMemoryPrincipalCookie,
  DESKTOP_LOCAL_PRINCIPAL_ID,
  ensureRequestPrincipal,
  hasBodyUserId,
  jsonResponse,
  readJsonBody,
  sameOrigin,
  withCookie,
} from "../../../../lib/memory/api";
import { getMemoryRuntime, memoryPersistenceUnavailable } from "../../../../lib/memory/server";
import { signMemoryPrincipalCookie } from "../../../../lib/memory/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validConsentBody(value: unknown): value is { enabled: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasBodyUserId(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "enabled" && typeof (value as { enabled?: unknown }).enabled === "boolean";
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ accepted: false, reason: "CROSS_ORIGIN" }, 403);
  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok || !validConsentBody(body.value)) {
    return jsonResponse({ accepted: false, reason: body.ok ? "INVALID_CONSENT" : body.reason }, body.ok ? 400 : body.status);
  }

  const runtimeState = getMemoryRuntime();
  const requestPrincipal = await ensureRequestPrincipal(request);
  const enabled = body.value.enabled;
  // In production a short/missing signing secret yields an ephemeral random
  // principal with no durable cookie. Never persist consent for an identity
  // the browser cannot subsequently prove; doing so would strand the row and
  // make privacy deletion impossible.
  if (runtimeState.featureEnabled && !requestPrincipal.persistent) {
    const response = jsonResponse({ accepted: false, featureFlag: true, enabled: false, consent: "UNKNOWN", reason: "PRINCIPAL_UNAVAILABLE" }, 503);
    return withCookie(response, enabled ? requestPrincipal.setCookie : clearMemoryPrincipalCookie());
  }
  if (!runtimeState.featureEnabled) {
    const response = jsonResponse({ accepted: false, featureFlag: false, enabled: false, consent: "UNKNOWN", reason: "MEMORY_DISABLED" });
    // Keep an already verified principal cookie (including REVOKED) so a
    // later privacy-deletion request remains possible while the teaching
    // feature is disabled. No consent row or memory read/write occurs here.
    return withCookie(response, requestPrincipal.setCookie);
  }

  const prior = await runtimeState.getAuthorization(requestPrincipal.principal.id);
  const requestedConsent = enabled ? "GRANTED" : "REVOKED";
  const priorVersion = Math.max(prior?.consentVersion ?? 0, requestPrincipal.principal.consentVersion ?? 0);
  // Repeating the same consent state is an idempotent management operation;
  // only a state transition advances the version. A GRANTED request after a
  // REVOKED state therefore still receives the strictly newer version needed
  // to reopen a DO, while duplicate revokes do not make the DO marker outrun
  // the PostgreSQL authority.
  const consentVersion = prior?.consent === requestedConsent
    ? priorVersion
    : priorVersion + 1;
  let authorization;
  try {
    authorization = await runtimeState.setAuthorization(requestPrincipal.principal.id, {
      userId: requestPrincipal.principal.id,
      memoryEnabled: true,
      consent: requestedConsent,
      consentVersion,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "MEMORY_AUTHORIZATION_CONFLICT") {
      const response = jsonResponse({ accepted: false, featureFlag: true, enabled: false, consent: prior?.consent ?? "UNKNOWN", reason: "AUTHORIZATION_CONFLICT" }, 409);
      return withCookie(response, requestPrincipal.setCookie);
    }
    authorization = undefined;
  }
  if (!authorization) {
    const response = jsonResponse({ accepted: false, featureFlag: true, enabled: false, consent: "UNKNOWN", reason: "AUTHORIZATION_UNAVAILABLE" }, 503);
    // Keep the previously verified cookie on a failed revoke; clearing it
    // would strand the still-present durable records from the privacy delete
    // channel. A newly created principal may still receive its signed cookie.
    return withCookie(response, requestPrincipal.setCookie);
  }
  // A production runtime without a configured Postgres executor must never
  // claim durable consent/memory success. Local volatile storage is explicit.
  if (memoryPersistenceUnavailable(runtimeState)) {
    const response = jsonResponse({ accepted: false, featureFlag: true, enabled: false, consent: authorization.consent, reason: "PERSISTENCE_UNAVAILABLE" }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }
  const response = jsonResponse({
    accepted: true,
    featureFlag: true,
    enabled,
    consent: authorization.consent,
    consentVersion: authorization.consentVersion,
    principalType: "ANONYMOUS",
    storage: runtimeState.storage,
    ...(runtimeState.degradedReason ? { degradedReason: runtimeState.degradedReason } : {}),
  });
  if (requestPrincipal.principal.id === DESKTOP_LOCAL_PRINCIPAL_ID) {
    // The sidecar session cookie remains the sole desktop browser credential;
    // consent is durable in local SQLite under the stable single-user ID.
    return response;
  }
  if (!enabled) {
    // Keep the same signed principal (now explicitly REVOKED) so the user can
    // still issue a privacy deletion after withdrawal. The revoked cookie is
    // never accepted for recall, preference writes, proposals or embeddings.
    try {
      const revokedCookie = await signMemoryPrincipalCookie({
        id: requestPrincipal.principal.id,
        type: "ANONYMOUS",
        consent: "REVOKED",
        consentVersion: authorization.consentVersion ?? requestPrincipal.principal.consentVersion + 1,
        issuedAt: requestPrincipal.principal.issuedAt,
      });
      return withCookie(response, revokedCookie);
    } catch {
      return withCookie(response, requestPrincipal.setCookie ?? clearMemoryPrincipalCookie());
    }
  }
  const cookie = await signMemoryPrincipalCookie({
    id: requestPrincipal.principal.id,
    type: "ANONYMOUS",
    consent: "GRANTED",
    consentVersion: authorization.consentVersion ?? requestPrincipal.principal.consentVersion + 1,
    issuedAt: requestPrincipal.principal.issuedAt,
  });
  return withCookie(response, cookie);
}
