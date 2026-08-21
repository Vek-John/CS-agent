import {
  directorLimits,
  directWithDeepSeek,
  parseDirectorRequest,
  type DeepSeekDirectorEnv
} from "../../../../lib/coaching/deepseek-director";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return origin === new URL(request.url).origin; } catch { return false; }
}

function serverEnv(): DeepSeekDirectorEnv {
  return { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL };
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ status: "FALLBACK", selected: [], reason: "CROSS_ORIGIN" }, 403);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > directorLimits.maxRequestBytes) return json({ status: "FALLBACK", selected: [], reason: "REQUEST_TOO_LARGE" }, 413);
  }
  try {
    const raw = await request.text();
    const byteLength = new TextEncoder().encode(raw).byteLength;
    if (byteLength > directorLimits.maxRequestBytes) return json({ status: "FALLBACK", selected: [], reason: "REQUEST_TOO_LARGE" }, 413);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return json({ status: "FALLBACK", selected: [], reason: "INVALID_REQUEST_JSON" }, 400); }
    const safeRequest = parseDirectorRequest(parsed, byteLength);
    return json(await directWithDeepSeek(safeRequest, serverEnv()));
  } catch (error) {
    if (error instanceof Error && error.name === "DirectorValidationError") return json({ status: "FALLBACK", selected: [], reason: "INVALID_REQUEST" }, 400);
    return json({ status: "FALLBACK", selected: [], reason: "REQUEST_FAILED" }, 500);
  }
}
