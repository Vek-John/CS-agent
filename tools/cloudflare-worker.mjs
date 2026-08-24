// OpenNext owns the generated request router for every path except the compact
// Coach Agent Durable Object endpoint below. This entrypoint also owns the
// response headers for HTML, /cs2d/, Worker modules, WASM and model assets.
import "./cloudflare-async-context.mjs";
import { parseRemoteCoachAgentDispatchEnvelope } from "../libs/coach-agent/src/index.ts";
import { CoachAgentDurableObject } from "./coach-agent-durable-object.mjs";
import generatedWorker from "../apps/web/.open-next/worker.js";

const MAX_REMOTE_REQUEST_BYTES = 64 * 1024;
const AGENT_PATH = "/api/coaching/agent";
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
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REMOTE_REQUEST_BYTES) return agentError("REQUEST_TOO_LARGE", 413);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return agentError("INVALID_JSON", 400);
  }
  let envelope;
  try {
    envelope = parseRemoteCoachAgentDispatchEnvelope(value);
  } catch {
    return agentError("INVALID_ENVELOPE", 400);
  }
  const id = env.COACH_AGENT.idFromName(envelope.sessionId);
  const stub = env.COACH_AGENT.get(id);
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: raw,
  });
  return isolated(await stub.fetch(forwarded));
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === AGENT_PATH) return dispatchAgent(request, env);
    return isolated(await generatedWorker.fetch(request, env, ctx));
  },
};

export { CoachAgentDurableObject };
