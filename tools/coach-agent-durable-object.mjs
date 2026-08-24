import "./cloudflare-async-context.mjs";
import {
  createCoachAgentRuntime,
  parseRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchResponse,
  DurableObjectCheckpointSaver,
} from "../libs/coach-agent/src/index.ts";
import { createDeepSeekCoachPolicyAdapter } from "../apps/web/lib/coaching/deepseek-coach-policy.ts";

const MAX_REMOTE_REQUEST_BYTES = 64 * 1024;
const POLICY_ROUTE_TIMEOUT_MS = 15_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(reason, status) {
  return json({ schemaVersion: "coach-agent-remote-error.v1", reason }, status);
}

function validJsonContentType(request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readEnvelope(request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > MAX_REMOTE_REQUEST_BYTES) {
      return { error: errorResponse("REQUEST_TOO_LARGE", 413) };
    }
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REMOTE_REQUEST_BYTES) {
    return { error: errorResponse("REQUEST_TOO_LARGE", 413) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: errorResponse("INVALID_JSON", 400) };
  }
  try {
    return { envelope: parseRemoteCoachAgentDispatchEnvelope(parsed) };
  } catch {
    return { error: errorResponse("INVALID_ENVELOPE", 400) };
  }
}

function policyEndpointFor(request) {
  try {
    const requestUrl = new URL(request.url);
    if (!/^https?:$/.test(requestUrl.protocol) || requestUrl.origin === "null") return null;
    const policyUrl = new URL("/api/coaching/policy", requestUrl);
    return { origin: policyUrl.origin, endpoint: policyUrl.href };
  } catch {
    return null;
  }
}

function fetchPolicyWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POLICY_ROUTE_TIMEOUT_MS);
  const upstreamSignal = init.signal;
  const abortUpstream = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener("abort", abortUpstream, { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abortUpstream);
  });
}

function runtimeWithPolicy(checkpointer, endpoint) {
  const policy = createDeepSeekCoachPolicyAdapter({
    endpoint,
    fetcher: fetchPolicyWithTimeout,
    // The graph already owns deterministic selection. Turning a provider
    // FALLBACK/DISABLED result into a rejected policy call preserves its
    // existing MODEL vs FALLBACK trace seam without changing graph state.
    onResult: (result) => {
      if (result.status !== "SUCCEEDED") {
        throw new Error(`COACH_POLICY_${result.status}_${result.manifest.reason ?? "FALLBACK"}`);
      }
    },
  });
  return createCoachAgentRuntime({
    checkpointer,
    checkpointBackend: "DURABLE_OBJECT",
    policy,
  });
}

function deterministicRuntime(checkpointer) {
  return createCoachAgentRuntime({
    checkpointer,
    checkpointBackend: "DURABLE_OBJECT",
  });
}

/**
 * One Durable Object owns one session's checkpoint namespace. The object only
 * receives the compact remote envelope; raw Replay, frames and prompts never
 * cross this boundary.
 */
export class CoachAgentDurableObject {
  constructor(state) {
    this.saver = new DurableObjectCheckpointSaver({
      storage: state.storage,
      retention: 20,
    });
    this.policyOrigin = null;
    this.policyEndpoint = null;
    this.policyRuntime = null;
    this.fallbackRuntime = null;
    this.dispatchTail = Promise.resolve();
  }

  runtimeFor(request) {
    const endpoint = policyEndpointFor(request);
    if (endpoint && (this.policyOrigin === null || this.policyOrigin === endpoint.origin)) {
      if (!this.policyRuntime) {
        this.policyOrigin = endpoint.origin;
        this.policyEndpoint = endpoint.endpoint;
        this.policyRuntime = runtimeWithPolicy(this.saver, endpoint.endpoint);
      }
      return this.policyRuntime;
    }
    if (!this.fallbackRuntime) this.fallbackRuntime = deterministicRuntime(this.saver);
    return this.fallbackRuntime;
  }

  dispatchSerial(task) {
    const next = this.dispatchTail.then(task, task);
    this.dispatchTail = next.then(() => undefined, () => undefined);
    return next;
  }

  async fetch(request) {
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405);
    if (!validJsonContentType(request)) return errorResponse("UNSUPPORTED_MEDIA_TYPE", 415);
    const parsed = await readEnvelope(request);
    if (parsed.error) return parsed.error;
    try {
      const result = await this.dispatchSerial(async () => parseRemoteCoachAgentDispatchResponse(
        await this.runtimeFor(request).dispatch(parsed.envelope.event),
      ));
      return json(result);
    } catch {
      return errorResponse("DISPATCH_FAILED", 500);
    }
  }
}
