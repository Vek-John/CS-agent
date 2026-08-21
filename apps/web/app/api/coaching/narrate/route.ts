import {
  narrationLimits,
  narrateWithDeepSeek,
  parseNarrationRequest,
  type DeepSeekNarratorEnv
} from "../../../../lib/coaching/deepseek-narrator";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
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

function serverEnv(): DeepSeekNarratorEnv {
  // This route is server-only. Never expose this object to a client module or
  // include the secret in an error/result body.
  return {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL
  };
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) {
    return json({ status: "FALLBACK", reason: "CROSS_ORIGIN" }, 403);
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > narrationLimits.maxRequestBytes) {
      return json({ status: "FALLBACK", reason: "REQUEST_TOO_LARGE" }, 413);
    }
  }

  try {
    const raw = await request.text();
    const byteLength = new TextEncoder().encode(raw).byteLength;
    if (byteLength > narrationLimits.maxRequestBytes) {
      return json({ status: "FALLBACK", reason: "REQUEST_TOO_LARGE" }, 413);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ status: "FALLBACK", reason: "INVALID_REQUEST_JSON" }, 400);
    }
    const narrationRequest = parseNarrationRequest(parsed, byteLength);
    const result = await narrateWithDeepSeek(narrationRequest, serverEnv());
    return json(result);
  } catch (error) {
    if (error instanceof Error && error.name === "NarratorValidationError") {
      return json({ status: "FALLBACK", reason: "INVALID_REQUEST" }, 400);
    }
    return json({ status: "FALLBACK", reason: "REQUEST_FAILED" }, 500);
  }
}
