import {
  authenticateInternalRequest,
  jsonResponse,
  MemoryEventSchema,
  readBodyText,
  sameOrigin,
} from "../../../../lib/memory/api";
import type { MemoryIngestResult } from "@cs-coach/memory";
import { getMemoryRuntime, memoryPersistenceUnavailable } from "../../../../lib/memory/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function decisionSummary(result: MemoryIngestResult) {
  return {
    action: result.decision.action,
    reason: result.decision.reason,
    status: result.decision.status,
    revision: result.decision.revision,
  };
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ accepted: false, reason: "CROSS_ORIGIN" }, 403);
  const body = await readBodyText(request, 32 * 1024);
  if (!body.ok) return jsonResponse({ accepted: false, reason: body.reason }, body.status);
  const runtimeState = getMemoryRuntime();
  const auth = await authenticateInternalRequest(request, body.text, runtimeState);
  if (!auth) return jsonResponse({ accepted: false, reason: "INVALID_INTERNAL_AUTH" }, 401);
  let rawEvent: unknown;
  try {
    rawEvent = JSON.parse(body.text) as unknown;
  } catch {
    return jsonResponse({ accepted: false, reason: "INVALID_EVENT" }, 400);
  }
  // Preserve the authenticated-principal semantics for a well-formed request
  // that tries to carry a different nested proposal owner: this is an
  // authorization failure (403), not merely a schema failure (400).
  if (rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent)) {
    if (typeof (rawEvent as { userId?: unknown }).userId === "string" &&
      (rawEvent as { userId: string }).userId !== auth.principalId) {
      return jsonResponse({ accepted: false, reason: "USER_MISMATCH" }, 403);
    }
    const payload = (rawEvent as { payload?: unknown }).payload;
    const proposal = payload && typeof payload === "object" && !Array.isArray(payload) && "proposal" in payload
      ? (payload as { proposal?: unknown }).proposal
      : payload;
    if (proposal && typeof proposal === "object" && !Array.isArray(proposal) &&
      typeof (proposal as { userId?: unknown }).userId === "string" &&
      (proposal as { userId: string }).userId !== auth.principalId) {
      return jsonResponse({ accepted: false, reason: "USER_MISMATCH" }, 403);
    }
  }
  let event: import("@cs-coach/memory").MemoryEvent;
  try {
    event = MemoryEventSchema.parse(rawEvent) as import("@cs-coach/memory").MemoryEvent;
  } catch {
    return jsonResponse({ accepted: false, reason: "INVALID_EVENT" }, 400);
  }
  if (event.userId !== auth.principalId) return jsonResponse({ accepted: false, reason: "USER_MISMATCH" }, 403);
  if (memoryPersistenceUnavailable(runtimeState) && runtimeState.featureEnabled) return jsonResponse({ accepted: false, reason: "PERSISTENCE_UNAVAILABLE" }, 503);
  const result = await runtimeState.service.ingestEvent(auth.principalId, event);
  const unavailable = runtimeState.featureEnabled && memoryPersistenceUnavailable(runtimeState);
  const status = result.errorCode === "REPOSITORY_ERROR" || unavailable ? 503 : 200;
  const idempotent = !result.errorCode && (
    result.decision.reason === "DUPLICATE_IDEMPOTENCY" ||
    result.decision.reason === "DELETED_TOMBSTONE" ||
    (!result.accepted && result.decision.action === "DELETE" && result.decision.status === "DELETED")
  );
  return jsonResponse({
    accepted: result.accepted,
    ...(idempotent ? { idempotent: true } : {}),
    decision: decisionSummary(result),
    ...(unavailable ? { reason: "PERSISTENCE_UNAVAILABLE" } : result.errorCode ? { reason: result.errorCode } : {}),
  }, status);
}
