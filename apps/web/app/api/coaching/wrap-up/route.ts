import {
  directSessionWrapUp,
  parseSessionWrapUpRequest,
  sessionWrapUpLimits,
  type DeepSeekWrapUpEnv,
} from "../../../../lib/coaching/deepseek-wrap-up";
import { coachingProviderEnv } from "../../../../lib/desktop/provider";
import { sameOriginRequest } from "../../../../lib/desktop/request-origin";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function serverEnv(): DeepSeekWrapUpEnv {
  return coachingProviderEnv();
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOriginRequest(request)) return json({ status: "FALLBACK", reason: "CROSS_ORIGIN" }, 403);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > sessionWrapUpLimits.maxRequestBytes) {
      return json({ status: "FALLBACK", reason: "REQUEST_TOO_LARGE" }, 413);
    }
  }
  try {
    const raw = await request.text();
    const byteLength = new TextEncoder().encode(raw).byteLength;
    if (byteLength > sessionWrapUpLimits.maxRequestBytes) return json({ status: "FALLBACK", reason: "REQUEST_TOO_LARGE" }, 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ status: "FALLBACK", reason: "INVALID_REQUEST_JSON" }, 400);
    }
    const input = parseSessionWrapUpRequest(parsed, byteLength);
    return json(await directSessionWrapUp(input, serverEnv()));
  } catch (error) {
    if (error instanceof Error && error.name === "SessionWrapUpProviderValidationError") {
      return json({ status: "FALLBACK", reason: "INVALID_REQUEST" }, 400);
    }
    return json({ status: "FALLBACK", reason: "REQUEST_FAILED" }, 500);
  }
}
