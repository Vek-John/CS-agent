import {
  ensureRequestPrincipal,
  hasBodyUserId,
  jsonResponse,
  MemoryDeleteInputSchema,
  MemoryIdSchema,
  readJsonBody,
  sameOrigin,
  toPublicMemoryRecord,
  withCookie,
} from "../../../../lib/memory/api";
import { getMemoryRuntime, memoryPersistenceUnavailable } from "../../../../lib/memory/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: Context): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ accepted: false, reason: "CROSS_ORIGIN" }, 403);
  const { id } = await context.params;
  const idParse = MemoryIdSchema.safeParse(id);
  if (!idParse.success) return jsonResponse({ accepted: false, reason: "INVALID_MEMORY_ID" }, 400);
  const memoryId = idParse.data;
  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok) return jsonResponse({ accepted: false, reason: body.reason }, body.status);
  if (body.value !== undefined && hasBodyUserId(body.value)) return jsonResponse({ accepted: false, reason: "USER_ID_NOT_ACCEPTED" }, 400);
  const parsed = body.value === undefined ? undefined : MemoryDeleteInputSchema.safeParse(body.value);
  if (parsed && !parsed.success) return jsonResponse({ accepted: false, reason: "INVALID_DELETE" }, 400);

  const runtimeState = getMemoryRuntime();
  const requestPrincipal = await ensureRequestPrincipal(request);
  const canDelete = await runtimeState.canDelete(requestPrincipal.principal.id);
  if (memoryPersistenceUnavailable(runtimeState)) {
    const response = jsonResponse({ accepted: false, reason: "PERSISTENCE_UNAVAILABLE" }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (!canDelete) {
    const response = jsonResponse({ accepted: false, reason: "CONSENT_REQUIRED" }, 403);
    return withCookie(response, requestPrincipal.setCookie);
  }
  const record = await runtimeState.delete(requestPrincipal.principal.id, memoryId, parsed?.success ? parsed.data : undefined);
  if (!record) {
    let status = 404;
    let existing: import("@cs-coach/memory").MemoryRecord | undefined;
    try { existing = await runtimeState.getRecord(requestPrincipal.principal.id, memoryId); } catch { status = 503; }
    // The tombstone may have committed before a DO/host invalidation failed.
    // Surface a retryable cleanup signal instead of misreporting a known
    // deleted aggregate as 404; a subsequent DELETE retries the fan-out.
    if (existing?.status === "DELETED") status = 503;
    const response = jsonResponse({
      accepted: false,
      reason: status === 503
        ? existing?.status === "DELETED" ? "OUTBOX_INVALIDATION_PENDING" : "PERSISTENCE_UNAVAILABLE"
          : "MEMORY_NOT_FOUND",
      ...(existing?.status === "DELETED" ? { deleted: true } : {}),
    }, status);
    return withCookie(response, requestPrincipal.setCookie);
  }
  const response = jsonResponse({ accepted: true, record: toPublicMemoryRecord(record), deleted: record.status === "DELETED" });
  return withCookie(response, requestPrincipal.setCookie);
}
