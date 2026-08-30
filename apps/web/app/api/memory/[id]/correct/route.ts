import {
  ensureRequestPrincipal,
  hasBodyUserId,
  jsonResponse,
  MemoryCorrectionInputSchema,
  MemoryIdSchema,
  readJsonBody,
  sameOrigin,
  toPublicMemoryRecord,
  withCookie,
} from "../../../../../lib/memory/api";
import { getMemoryRuntime, memoryPersistenceUnavailable } from "../../../../../lib/memory/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ accepted: false, reason: "CROSS_ORIGIN" }, 403);
  const { id } = await context.params;
  const idParse = MemoryIdSchema.safeParse(id);
  if (!idParse.success) return jsonResponse({ accepted: false, reason: "INVALID_MEMORY_ID" }, 400);
  const memoryId = idParse.data;
  const body = await readJsonBody(request, 16 * 1024);
  if (!body.ok) return jsonResponse({ accepted: false, reason: body.reason }, body.status);
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value) || hasBodyUserId(body.value)) {
    return jsonResponse({ accepted: false, reason: "INVALID_CORRECTION" }, 400);
  }
  const content = (body.value as { content?: unknown }).content;
  if (typeof content !== "string" || content.trim().length === 0 || content.trim().length > 800) {
    return jsonResponse({ accepted: false, reason: "CORRECTION_TOO_LONG" }, 400);
  }
  const parsed = MemoryCorrectionInputSchema.safeParse(body.value);
  if (!parsed.success) return jsonResponse({ accepted: false, reason: "INVALID_CORRECTION" }, 400);

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
  const record = await runtimeState.service.correct(requestPrincipal.principal.id, memoryId, parsed.data);
  if (!record) {
    let status = 404;
    try { await runtimeState.getRecord(requestPrincipal.principal.id, memoryId); } catch { status = 503; }
    const response = jsonResponse({ accepted: false, reason: status === 503 ? "PERSISTENCE_UNAVAILABLE" : "MEMORY_NOT_FOUND" }, status);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (record.status === "DELETED") {
    const response = jsonResponse({ accepted: false, reason: "DELETED_TOMBSTONE", record: toPublicMemoryRecord(record) }, 409);
    return withCookie(response, requestPrincipal.setCookie);
  }
  const response = jsonResponse({ accepted: true, record: toPublicMemoryRecord(record) });
  return withCookie(response, requestPrincipal.setCookie);
}
