import {
  ensureRequestPrincipal,
  hasBodyUserId,
  jsonResponse,
  queryHasForbiddenUserId,
  readJsonBody,
  sameOrigin,
  toPublicMemoryRecord,
  withCookie,
} from "../../../../lib/memory/api";
import { getMemoryRuntime, memoryPersistenceUnavailable } from "../../../../lib/memory/server";
import { MemoryProfileSchema } from "@cs-coach/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROFILE_BODY_BYTES = 8 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The public endpoint accepts either `{ profile: {...} }` (the documented
 * shape) or the profile object itself for a small amount of client
 * compatibility. In both forms the user id is taken only from the signed
 * request principal; it can never be supplied by the caller.
 */
function profileInput(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value) || hasBodyUserId(value)) return undefined;
  if ("profile" in value) {
    if (Object.keys(value).length !== 1 || !isPlainObject(value.profile) || hasBodyUserId(value.profile)) return undefined;
    return value.profile;
  }
  return value;
}

export async function GET(request: Request): Promise<Response> {
  if (queryHasForbiddenUserId(request)) return jsonResponse({ error: "USER_ID_NOT_ACCEPTED" }, 400);
  const runtimeState = getMemoryRuntime();
  const requestPrincipal = await ensureRequestPrincipal(request);
  const userId = requestPrincipal.principal.id;
  // Profile recall follows the teaching feature flag. The privacy-only
  // authorization read is intentionally not used here, so a disabled flag
  // keeps this UI endpoint free of database/persistence side effects.
  const authorization = runtimeState.featureEnabled
    ? await runtimeState.getAuthorization(userId)
    : undefined;

  if (runtimeState.featureEnabled && memoryPersistenceUnavailable(runtimeState)) {
    const response = jsonResponse({
      featureFlag: true,
      enabled: false,
      consent: authorization?.consent ?? "UNKNOWN",
      profile: null,
      reason: "PERSISTENCE_UNAVAILABLE",
    }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }

  if (!runtimeState.featureEnabled || !(await runtimeState.isAuthorized(userId))) {
    const response = jsonResponse({
      featureFlag: runtimeState.featureEnabled,
      enabled: false,
      consent: runtimeState.featureEnabled ? authorization?.consent ?? "UNKNOWN" : "UNKNOWN",
      principalType: "ANONYMOUS",
      profile: null,
      ...(runtimeState.degradedReason ? { degradedReason: runtimeState.degradedReason } : {}),
    });
    return withCookie(response, requestPrincipal.setCookie);
  }

  try {
    const profile = await runtimeState.service.getProfile(userId);
    const response = jsonResponse({
      featureFlag: true,
      enabled: true,
      consent: authorization?.consent ?? "GRANTED",
      principalType: "ANONYMOUS",
      profile: profile ?? null,
    });
    return withCookie(response, requestPrincipal.setCookie);
  } catch {
    const response = jsonResponse({ accepted: false, reason: "PERSISTENCE_UNAVAILABLE", profile: null }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ accepted: false, reason: "CROSS_ORIGIN" }, 403);
  if (queryHasForbiddenUserId(request)) return jsonResponse({ accepted: false, reason: "USER_ID_NOT_ACCEPTED" }, 400);
  const body = await readJsonBody(request, MAX_PROFILE_BODY_BYTES);
  if (!body.ok) return jsonResponse({ accepted: false, reason: body.reason }, body.status);
  const profile = profileInput(body.value);
  if (!profile) return jsonResponse({ accepted: false, reason: "INVALID_PROFILE" }, 400);
  const parsedProfile = MemoryProfileSchema.safeParse(profile);
  if (!parsedProfile.success) return jsonResponse({ accepted: false, reason: "INVALID_PROFILE" }, 400);

  const runtimeState = getMemoryRuntime();
  const requestPrincipal = await ensureRequestPrincipal(request);
  const userId = requestPrincipal.principal.id;
  if (!runtimeState.featureEnabled) {
    const response = jsonResponse({ accepted: false, reason: "MEMORY_DISABLED" }, 403);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (!(await runtimeState.isAuthorized(userId))) {
    const response = jsonResponse({ accepted: false, reason: "CONSENT_REQUIRED" }, 403);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (memoryPersistenceUnavailable(runtimeState)) {
    const response = jsonResponse({ accepted: false, reason: "PERSISTENCE_UNAVAILABLE" }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }

  const result = await runtimeState.service.setProfile(userId, { profile: parsedProfile.data });
  if (result.errorCode === "MEMORY_DISABLED" || result.decision.reason === "CONSENT_REQUIRED") {
    const response = jsonResponse({ accepted: false, reason: "CONSENT_REQUIRED" }, 403);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (result.errorCode === "INVALID_EVENT" || result.decision.reason === "INVALID_PROPOSAL") {
    const response = jsonResponse({ accepted: false, reason: "INVALID_PROFILE" }, 400);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (result.errorCode || memoryPersistenceUnavailable(runtimeState)) {
    const response = jsonResponse({ accepted: false, reason: "PERSISTENCE_UNAVAILABLE" }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (!result.record) {
    const idempotent = result.decision.reason === "DUPLICATE_IDEMPOTENCY";
    const response = jsonResponse({ accepted: idempotent, changed: false, idempotent, reason: idempotent ? undefined : "PROFILE_NOT_SAVED" }, idempotent ? 200 : 503);
    return withCookie(response, requestPrincipal.setCookie);
  }
  const idempotent = result.decision.reason === "DUPLICATE_IDEMPOTENCY";
  const response = jsonResponse({
    accepted: result.accepted || idempotent,
    changed: result.accepted,
    idempotent,
    profile: result.record.profile ?? profile,
    record: toPublicMemoryRecord(result.record),
  });
  return withCookie(response, requestPrincipal.setCookie);
}
