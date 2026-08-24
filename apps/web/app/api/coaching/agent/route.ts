import {
  createCoachAgentRuntime,
  parseRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchResponse,
  type CoachAgentRuntime,
} from "@cs-coach/coach-agent";

export const dynamic = "force-dynamic";

const MAX_REMOTE_REQUEST_BYTES = 64 * 1024;
const runtimes = new Map<string, CoachAgentRuntime>();

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function runtimeFor(sessionId: string): CoachAgentRuntime {
  const existing = runtimes.get(sessionId);
  if (existing) return existing;
  const runtime = createCoachAgentRuntime();
  runtimes.set(sessionId, runtime);
  return runtime;
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "CROSS_ORIGIN" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "UNSUPPORTED_MEDIA_TYPE" }, 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > MAX_REMOTE_REQUEST_BYTES) {
      return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "REQUEST_TOO_LARGE" }, 413);
    }
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REMOTE_REQUEST_BYTES) {
    return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "REQUEST_TOO_LARGE" }, 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "INVALID_JSON" }, 400);
  }
  let envelope;
  try {
    envelope = parseRemoteCoachAgentDispatchEnvelope(value);
  } catch {
    return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "INVALID_ENVELOPE" }, 400);
  }
  try {
    const result = parseRemoteCoachAgentDispatchResponse(
      await runtimeFor(envelope.sessionId).dispatch(envelope.event),
    );
    if (result.checkpoint.backend !== "MEMORY" || result.checkpoint.recoverableAfterRefresh) {
      return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "LOCAL_BACKEND_CONTRACT" }, 500);
    }
    return json(result);
  } catch {
    return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "DISPATCH_FAILED" }, 500);
  }
}

export function GET(): Response {
  return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "METHOD_NOT_ALLOWED" }, 405);
}

export function PUT(): Response {
  return json({ schemaVersion: "coach-agent-remote-error.v1", reason: "METHOD_NOT_ALLOWED" }, 405);
}
