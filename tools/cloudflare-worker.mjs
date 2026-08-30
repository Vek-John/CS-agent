// OpenNext owns the generated request router for every path except the compact
// Coach Agent Durable Object endpoint below. This entrypoint also owns the
// response headers for HTML, /cs2d/, Worker modules, WASM and model assets.
import "./cloudflare-async-context.mjs";
import { parseRemoteCoachAgentDispatchEnvelope } from "../libs/coach-agent/src/index.ts";
import { CoachAgentDurableObject } from "./coach-agent-durable-object.mjs";
import generatedWorker from "../apps/web/.open-next/worker.js";
import {
  createAnonymousPrincipal,
  hmacSha256Base64Url,
  resolveMemoryPrincipal,
  signMemoryPrincipalCookie,
  verifyHmacSha256Base64Url,
} from "../apps/web/lib/memory/principal.ts";

const MAX_REMOTE_REQUEST_BYTES = 64 * 1024;
const MAX_MEMORY_EVENT_BYTES = 32 * 1024;
const MAX_MEMORY_INVALIDATION_BYTES = 8 * 1024;
const AGENT_PATH = "/api/coaching/agent";
const MEMORY_EVENTS_PATH = "/api/memory/events";
const MEMORY_BRIEF_PATH = "/api/memory/brief";
const MEMORY_INVALIDATE_PATH = "/api/coaching/agent/memory-invalidate";
const MEMORY_PRINCIPAL_HEADER = "x-cs-trusted-principal";
const MEMORY_CONSENT_HEADER = "x-cs-memory-consent";
const MEMORY_CONSENT_VERSION_HEADER = "x-cs-memory-consent-version";
const MEMORY_INTERNAL_HEADER = "x-cs-memory-internal";
const MEMORY_INTERNAL_TOKEN_HEADER = "x-memory-internal-token";
const MEMORY_INTERNAL_SIGNATURE_HEADER = "x-memory-signature";
const MEMORY_INTERNAL_TIMESTAMP_HEADER = "x-memory-timestamp";
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function isolated(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(ISOLATION_HEADERS)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function agentError(reason, status) {
  return isolated(new Response(JSON.stringify({ schemaVersion: "coach-agent-remote-error.v1", reason }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  }));
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * Bound an untrusted request body before authentication or HMAC work. A
 * streaming reader avoids allocating an attacker-controlled body when the
 * request omits Content-Length; the returned UTF-8 text is the exact input
 * used for downstream JSON parsing and signature verification.
 */
async function readBoundedText(request, maxBytes) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) return { ok: false, tooLarge: true };
  }
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

function memoryFlagEnabled(env) {
  const value = env?.MEMORY_ENABLED;
  // Keep the deployment flag grammar identical across Worker, DO and the
  // local runtime. Consent values have a separate, deliberately wider parser.
  return value === true || (typeof value === "string" && ["true", "1", "on"].includes(value.trim().toLowerCase()));
}

function stripClientBriefFromEnvelopeValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.event || typeof value.event !== "object" || Array.isArray(value.event)) return value;
  const { memoryBrief: _clientBrief, ...event } = value.event;
  void _clientBrief;
  return { ...value, event };
}

function memorySecret(env) {
  const value = env?.MEMORY_PRINCIPAL_SECRET ?? env?.MEMORY_COOKIE_SECRET ?? env?.MEMORY_HMAC_SECRET;
  const normalized = typeof value === "string" ? value.trim() : "";
  // Match the Node principal boundary: a short deployment secret must not
  // create a durable anonymous identity that cannot be safely verified.
  return normalized.length >= 16 ? normalized : undefined;
}

async function requestPrincipal(request, env) {
  if (!memoryFlagEnabled(env)) return { principal: undefined };
  const secret = memorySecret(env);
  // A Cloudflare Worker must not fall back to the Node process environment;
  // without an edge secret there is no verifiable browser principal and the
  // Agent continues in baseline mode.
  const resolved = secret
    ? await resolveMemoryPrincipal(request, { secret })
    : { principal: undefined, reason: "SECRET_UNAVAILABLE" };
  if (resolved.principal) return { principal: resolved.principal };
  // An edge request without a stable signing secret has no durable identity.
  // Do not manufacture an ephemeral principal and forward it as trusted: a
  // caller could then opt in with a forged consent header and strand data that
  // can never be recovered or deleted. The DO receives no memory trust seam
  // and continues the baseline Agent path instead.
  if (!secret) return { principal: undefined, reason: "SECRET_UNAVAILABLE" };
  const principal = createAnonymousPrincipal({ consent: "UNKNOWN" });
  try {
    return {
      principal,
      setCookie: await signMemoryPrincipalCookie(principal, {
        secret,
        secure: new URL(request.url).protocol === "https:",
      }),
    };
  } catch {
    return { principal };
  }
}

function withSetCookie(response, cookie) {
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function forwardedAgentRequest(request, principal, env, sanitizedBody) {
  const headers = new Headers(request.headers);
  // Never forward browser-supplied trust headers. They are replaced only
  // with the principal resolved from the signed server cookie.
  headers.delete(MEMORY_PRINCIPAL_HEADER);
  headers.delete("x-cs-memory-principal");
  headers.delete("x-memory-principal");
  headers.delete("x-memory-user");
  headers.delete("x-internal-user-id");
  headers.delete(MEMORY_CONSENT_HEADER);
  headers.delete("x-memory-consent");
  headers.delete("x-trusted-memory-consent");
  // Consent version is a trusted claim from the signed principal cookie. A
  // browser-provided value must never cross the Worker/DO boundary: otherwise
  // it could manufacture a newer epoch and reopen a locally revoked session.
  headers.delete(MEMORY_CONSENT_VERSION_HEADER);
  headers.delete(MEMORY_INTERNAL_HEADER);
  headers.delete(MEMORY_INTERNAL_TOKEN_HEADER);
  headers.delete(MEMORY_INTERNAL_SIGNATURE_HEADER);
  headers.delete(MEMORY_INTERNAL_TIMESTAMP_HEADER);
  // The DO receives only the compact event plus server-derived trust headers;
  // browser cookies, bearer credentials and API keys must not cross into the
  // Agent/checkpoint boundary.
  for (const name of ["cookie", "authorization", "x-api-key", "x-cs-api-key"]) headers.delete(name);
  if (principal && memoryFlagEnabled(env)) {
    headers.set(MEMORY_PRINCIPAL_HEADER, principal.id);
    headers.set("x-memory-principal", principal.id);
    headers.set(MEMORY_CONSENT_HEADER, principal.consent);
    headers.set("x-memory-consent", principal.consent);
    if (Number.isSafeInteger(principal.consentVersion) && principal.consentVersion >= 0) {
      headers.set(MEMORY_CONSENT_VERSION_HEADER, String(principal.consentVersion));
    }
    headers.set(MEMORY_INTERNAL_HEADER, "1");
    if (typeof env?.MEMORY_INTERNAL_TOKEN === "string" && env.MEMORY_INTERNAL_TOKEN.trim().length >= 16) {
      headers.set(MEMORY_INTERNAL_TOKEN_HEADER, env.MEMORY_INTERNAL_TOKEN.trim());
    }
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD"
      ? undefined
      : (sanitizedBody === undefined ? request.body : JSON.stringify(sanitizedBody)),
  });
}

async function dispatchAgent(request, env) {
  if (request.method !== "POST") return agentError("METHOD_NOT_ALLOWED", 405);
  if (!sameOrigin(request)) return agentError("CROSS_ORIGIN", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return agentError("UNSUPPORTED_MEDIA_TYPE", 415);
  }
  if (!env.COACH_AGENT) return agentError("DURABLE_OBJECT_BINDING_MISSING", 500);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > MAX_REMOTE_REQUEST_BYTES) {
      return agentError("REQUEST_TOO_LARGE", 413);
    }
  }
  const boundedBody = await readBoundedText(request, MAX_REMOTE_REQUEST_BYTES);
  if (!boundedBody.ok) return agentError(boundedBody.tooLarge ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST_BODY", boundedBody.tooLarge ? 413 : 400);
  const raw = boundedBody.text;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return agentError("INVALID_JSON", 400);
  }
  let envelope;
  try {
    envelope = parseRemoteCoachAgentDispatchEnvelope(stripClientBriefFromEnvelopeValue(value));
  } catch {
    return agentError("INVALID_ENVELOPE", 400);
  }
  const principalState = await requestPrincipal(request, env);
  const id = env.COACH_AGENT.idFromName(envelope.sessionId);
  const stub = env.COACH_AGENT.get(id);
  const sanitizedEnvelope = {
    ...envelope,
    event: (() => {
      const { memoryBrief: _clientBrief, ...eventWithoutBrief } = envelope.event;
      void _clientBrief;
      return eventWithoutBrief;
    })(),
  };
  const forwarded = forwardedAgentRequest(new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: raw,
  }), principalState.principal, env, sanitizedEnvelope);
  return withSetCookie(isolated(await stub.fetch(forwarded)), principalState.setCookie);
}

function memoryBinding(env) {
  return env?.MEMORY_SERVICE ?? env?.MEMORY_API ?? (typeof env?.MEMORY_EVENTS === "object" ? env.MEMORY_EVENTS : undefined);
}

async function internalAuthHeaders(env, rawBody = "", base = {}) {
  const headers = new Headers(base);
  const token = typeof env?.MEMORY_INTERNAL_TOKEN === "string" ? env.MEMORY_INTERNAL_TOKEN.trim() : "";
  if (token.length >= 16) {
    headers.set(MEMORY_INTERNAL_TOKEN_HEADER, token);
    return headers;
  }
  const secret = typeof env?.MEMORY_INTERNAL_HMAC_SECRET === "string" ? env.MEMORY_INTERNAL_HMAC_SECRET.trim() : "";
  if (secret.length >= 16) {
    const timestamp = String(Date.now());
    headers.set(MEMORY_INTERNAL_TIMESTAMP_HEADER, timestamp);
    headers.set(MEMORY_INTERNAL_SIGNATURE_HEADER, await hmacSha256Base64Url(`${timestamp}.${rawBody}`, secret));
  }
  return headers;
}

async function validInternalMemoryRequest(request, env, rawBody = "") {
  if (request.headers.get(MEMORY_INTERNAL_HEADER) !== "1") return false;
  const principal = request.headers.get("x-memory-principal") ?? request.headers.get(MEMORY_PRINCIPAL_HEADER);
  if (!principal || principal.length > 160) return false;
  const configuredToken = typeof env?.MEMORY_INTERNAL_TOKEN === "string" ? env.MEMORY_INTERNAL_TOKEN.trim() : "";
  if (configuredToken.length >= 16) return request.headers.get(MEMORY_INTERNAL_TOKEN_HEADER) === configuredToken;
  const hmacSecret = typeof env?.MEMORY_INTERNAL_HMAC_SECRET === "string" ? env.MEMORY_INTERNAL_HMAC_SECRET.trim() : "";
  if (hmacSecret.length >= 16) {
    const timestamp = request.headers.get(MEMORY_INTERNAL_TIMESTAMP_HEADER);
    const signature = request.headers.get(MEMORY_INTERNAL_SIGNATURE_HEADER);
    if (!timestamp || !signature) return false;
    const numericTimestamp = Number(timestamp);
    const timestampMs = Number.isFinite(numericTimestamp)
      ? (numericTimestamp < 10_000_000_000 ? numericTimestamp * 1_000 : numericTimestamp)
      : Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false;
    try {
      return await verifyHmacSha256Base64Url(`${timestamp}.${rawBody}`, signature, hmacSecret);
    } catch {
      return false;
    }
  }
  return env?.NODE_ENV === "test" && request.headers.get("x-memory-test-principal") === principal;
}

async function dispatchMemoryEndpoint(request, env, ctx) {
  if (!sameOrigin(request)) return agentError("CROSS_ORIGIN", 403);
  const pathname = new URL(request.url).pathname;
  // A disabled deployment must not forward even a read to a configured
  // memory binding: doing so could leak a previously persisted brief and
  // would make the feature flag observable only after a database round trip.
  if (!memoryFlagEnabled(env) && pathname === MEMORY_BRIEF_PATH && request.method === "GET") {
    return isolated(new Response(JSON.stringify({
      ok: true,
      featureFlag: false,
      enabled: false,
      consent: "UNKNOWN",
      principalType: "ANONYMOUS",
      brief: {
        schemaVersion: "memory-brief.v1",
        generatedAt: new Date().toISOString(),
        preferences: {},
        activeThreads: [],
        memories: [],
        corrections: [],
        limitations: ["Memory is disabled."],
        source: "EMPTY",
        structuredStatus: "EMPTY",
        semanticStatus: "OPTIONAL",
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    }));
  }
  // Keep read-only status/brief routes reachable when the deployment flag is
  // off so the management UI can explain the disabled state. Mutating event
  // ingestion remains hidden behind the flag and internal authentication.
  if (!memoryFlagEnabled(env) && request.method === "POST") return agentError("MEMORY_DISABLED", 404);
  let eventBodyForAuth = "";
  if (request.method === "POST" && pathname === MEMORY_EVENTS_PATH) {
    const bounded = await readBoundedText(request.clone(), MAX_MEMORY_EVENT_BYTES);
    if (!bounded.ok) {
      return agentError(bounded.tooLarge ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST_BODY", bounded.tooLarge ? 413 : 400);
    }
    eventBodyForAuth = bounded.text;
  }
  if (request.method === "POST" && pathname === MEMORY_EVENTS_PATH && !(await validInternalMemoryRequest(request, env, eventBodyForAuth))) {
    return agentError("INVALID_INTERNAL_MEMORY_AUTH", 401);
  }
  const binding = memoryBinding(env);
  if (binding && typeof binding.fetch === "function") {
    // A browser may call the read-only brief route directly. Resolve its
    // signed cookie here and replace all trust headers before forwarding to a
    // service binding; never let a caller choose another principal by header.
    if (pathname === MEMORY_BRIEF_PATH && request.method === "GET" && !(await validInternalMemoryRequest(request, env))) {
      const principalState = await requestPrincipal(request, env);
      const headers = new Headers(request.headers);
      for (const name of [
        MEMORY_PRINCIPAL_HEADER,
        "x-cs-memory-principal",
        "x-memory-principal",
        "x-memory-user",
        "x-internal-user-id",
        MEMORY_CONSENT_HEADER,
        "x-memory-consent",
        "x-trusted-memory-consent",
        MEMORY_CONSENT_VERSION_HEADER,
        MEMORY_INTERNAL_HEADER,
        MEMORY_INTERNAL_TOKEN_HEADER,
        MEMORY_INTERNAL_SIGNATURE_HEADER,
        MEMORY_INTERNAL_TIMESTAMP_HEADER,
        "cookie",
        "authorization",
        "x-api-key",
        "x-cs-api-key",
      ]) headers.delete(name);
      if (principalState.principal) {
        headers.set(MEMORY_PRINCIPAL_HEADER, principalState.principal.id);
        headers.set("x-memory-principal", principalState.principal.id);
        headers.set(MEMORY_CONSENT_HEADER, principalState.principal.consent);
        headers.set("x-memory-consent", principalState.principal.consent);
        if (Number.isSafeInteger(principalState.principal.consentVersion) && principalState.principal.consentVersion >= 0) {
          headers.set(MEMORY_CONSENT_VERSION_HEADER, String(principalState.principal.consentVersion));
        }
        headers.set(MEMORY_INTERNAL_HEADER, "1");
        if (typeof env?.MEMORY_INTERNAL_TOKEN === "string" && env.MEMORY_INTERNAL_TOKEN.trim().length >= 16) {
          headers.set(MEMORY_INTERNAL_TOKEN_HEADER, env.MEMORY_INTERNAL_TOKEN.trim());
        }
      }
      const forwarded = new Request(request.url, { method: "GET", headers: await internalAuthHeaders(env, "", headers) });
      return withSetCookie(isolated(await binding.fetch(forwarded)), principalState.setCookie);
    }
    return isolated(await binding.fetch(request));
  }
  // The generated Next route remains the local/monolith fallback. It owns
  // the MemoryService authorization and repository boundary; this worker only
  // adds the trusted routing seam and never touches SQL.
  return isolated(await generatedWorker.fetch(request, env, ctx));
}

async function dispatchMemoryInvalidation(request, env) {
  if (request.method !== "POST") return agentError("METHOD_NOT_ALLOWED", 405);
  if (!sameOrigin(request)) return agentError("CROSS_ORIGIN", 403);
  if (!env.COACH_AGENT) return agentError("INVALID_INTERNAL_MEMORY_AUTH", 401);
  let body;
  const bounded = await readBoundedText(request, MAX_MEMORY_INVALIDATION_BYTES);
  if (!bounded.ok) return agentError(bounded.tooLarge ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST_BODY", bounded.tooLarge ? 413 : 400);
  const raw = bounded.text;
  try {
    body = JSON.parse(raw);
  } catch {
    return agentError("INVALID_JSON", 400);
  }
  if (!(await validInternalMemoryRequest(request, env, raw))) return agentError("INVALID_INTERNAL_MEMORY_AUTH", 401);
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.sessionId !== "string" || body.sessionId.length === 0 || body.sessionId.length > 160 ||
    (body.all !== true && (typeof body.memoryId !== "string" || body.memoryId.length === 0 || body.memoryId.length > 160)) ||
    (body.logicalKey !== undefined && (typeof body.logicalKey !== "string" || body.logicalKey.length === 0 || body.logicalKey.length > 160))) {
    return agentError("INVALID_MEMORY_INVALIDATION", 400);
  }
  const id = env.COACH_AGENT.idFromName(body.sessionId);
  const stub = env.COACH_AGENT.get(id);
  const headers = new Headers({
    "content-type": "application/json",
    "x-cs-memory-internal": "1",
    "x-cs-trusted-principal": request.headers.get(MEMORY_PRINCIPAL_HEADER) ?? "",
    "x-memory-test-principal": request.headers.get(MEMORY_PRINCIPAL_HEADER) ?? "",
  });
  const forwardedBody = JSON.stringify(body.all === true
    ? { all: true }
    : { memoryId: body.memoryId, ...(body.logicalKey ? { logicalKey: body.logicalKey } : {}) });
  const forwarded = await stub.fetch(new Request(new URL(MEMORY_INVALIDATE_PATH, request.url), {
    method: "POST",
    headers: await internalAuthHeaders(env, forwardedBody, headers),
    body: forwardedBody,
  }));
  return isolated(forwarded);
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === AGENT_PATH) return dispatchAgent(request, env);
    if (path === MEMORY_INVALIDATE_PATH) return dispatchMemoryInvalidation(request, env);
    if (path === MEMORY_EVENTS_PATH || path === MEMORY_BRIEF_PATH) return dispatchMemoryEndpoint(request, env, ctx);
    return isolated(await generatedWorker.fetch(request, env, ctx));
  },
};

export { CoachAgentDurableObject };
