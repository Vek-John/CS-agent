import type { MemoryPreferenceInput } from "@cs-coach/memory";
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
import { MEMORY_PREFERENCE_VALUES } from "@cs-coach/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isPreferenceBody(value: unknown): value is MemoryPreferenceInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasBodyUserId(value)) return false;
  const candidate = value as { key?: unknown; value?: unknown; label?: unknown };
  if (typeof candidate.key !== "string" || typeof candidate.value !== "string") return false;
  const key = candidate.key as keyof typeof MEMORY_PREFERENCE_VALUES;
  const allowed = MEMORY_PREFERENCE_VALUES[key];
  if (!allowed || !allowed.includes(candidate.value as never)) return false;
  if (candidate.label !== undefined && (typeof candidate.label !== "string" || candidate.label.trim().length === 0 || candidate.label.trim().length > 240)) return false;
  const keys = Object.keys(value);
  return keys.every((entry) => entry === "key" || entry === "value" || entry === "label");
}

function publicPreference(record: import("@cs-coach/memory").MemoryRecord): Record<string, unknown> {
  return {
    ...toPublicMemoryRecord(record),
    ...(record.preference ? {
      preference: {
        key: record.preference.key,
        value: record.preference.value,
        ...(record.preference.label ? { label: record.preference.label } : {}),
      },
    } : {}),
  };
}

export async function GET(request: Request): Promise<Response> {
  if (queryHasForbiddenUserId(request)) return jsonResponse({ error: "USER_ID_NOT_ACCEPTED" }, 400);
  const runtimeState = getMemoryRuntime();
  const requestPrincipal = await ensureRequestPrincipal(request);
  const records = await runtimeState.service.getPreferences(requestPrincipal.principal.id);
  // The cookie is only an authentication hint.  Reflect the durable consent
  // row when the teaching feature is enabled so a stale GRANTED cookie cannot
  // make the settings UI claim that preferences are active after a revoke.
  const authorization = runtimeState.featureEnabled
    ? await runtimeState.getAuthorization(requestPrincipal.principal.id)
    : undefined;
  const response = jsonResponse({
    featureFlag: runtimeState.featureEnabled,
    consent: runtimeState.featureEnabled ? authorization?.consent ?? "UNKNOWN" : "UNKNOWN",
    principalType: "ANONYMOUS",
    preferences: records.filter((record) => record.status !== "DELETED").slice(0, 25).map(publicPreference),
    ...(runtimeState.degradedReason ? { degradedReason: runtimeState.degradedReason } : {}),
  });
  return withCookie(response, requestPrincipal.setCookie);
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ accepted: false, reason: "CROSS_ORIGIN" }, 403);
  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok) return jsonResponse({ accepted: false, reason: body.reason }, body.status);
  if (!isPreferenceBody(body.value)) return jsonResponse({ accepted: false, reason: "INVALID_PREFERENCE" }, 400);
  const runtimeState = getMemoryRuntime();
  const requestPrincipal = await ensureRequestPrincipal(request);
  const authorized = await runtimeState.isAuthorized(requestPrincipal.principal.id);
  if (runtimeState.featureEnabled && memoryPersistenceUnavailable(runtimeState)) {
    const response = jsonResponse({ accepted: false, reason: "PERSISTENCE_UNAVAILABLE" }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (!runtimeState.featureEnabled || !authorized) {
    const response = jsonResponse({ accepted: false, reason: runtimeState.featureEnabled ? "CONSENT_REQUIRED" : "MEMORY_DISABLED" }, 403);
    return withCookie(response, requestPrincipal.setCookie);
  }
  const result = await runtimeState.service.setPreference(requestPrincipal.principal.id, body.value);
  if (result.errorCode === "REPOSITORY_ERROR" || memoryPersistenceUnavailable(runtimeState)) {
    const response = jsonResponse({ accepted: false, reason: "PERSISTENCE_UNAVAILABLE" }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (result.errorCode === "MEMORY_DISABLED") {
    const response = jsonResponse({ accepted: false, reason: "CONSENT_REQUIRED" }, 403);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (!result.record) {
    const response = jsonResponse({ accepted: false, reason: "PREFERENCE_NOT_SAVED" }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }
  const idempotent = result.decision.reason === "DUPLICATE_IDEMPOTENCY";
  const response = jsonResponse({
    accepted: result.accepted || idempotent,
    changed: result.accepted,
    idempotent,
    preference: publicPreference(result.record),
  });
  return withCookie(response, requestPrincipal.setCookie);
}
