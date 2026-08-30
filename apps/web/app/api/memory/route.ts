import {
  boundedLimit,
  ensureRequestPrincipal,
  hasBodyUserId,
  jsonResponse,
  queryHasForbiddenUserId,
  readJsonBody,
  sameOrigin,
  toPublicBrief,
  toPublicMemoryRecord,
  withCookie,
} from "../../../lib/memory/api";
import { getMemoryRuntime, memoryPersistenceUnavailable } from "../../../lib/memory/server";
import { clearMemoryPrincipalCookie, signMemoryPrincipalCookie } from "../../../lib/memory/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (queryHasForbiddenUserId(request)) return jsonResponse({ error: "USER_ID_NOT_ACCEPTED" }, 400);
  const url = new URL(request.url);
  const limit = boundedLimit(url.searchParams.get("limit"), 25);
  const text = url.searchParams.get("q")?.trim() ?? "";
  if (limit === undefined) return jsonResponse({ error: "INVALID_LIMIT" }, 400);
  if (text.length > 240) return jsonResponse({ error: "QUERY_TOO_LONG" }, 400);

  const runtimeState = getMemoryRuntime();
  const requestPrincipal = await ensureRequestPrincipal(request);
  const brief = await runtimeState.service.getBrief(requestPrincipal.principal.id, text ? { semanticText: text } : undefined);
  const authorization = runtimeState.featureEnabled ? await runtimeState.getAuthorization(requestPrincipal.principal.id) : undefined;
  let records: readonly import("@cs-coach/memory").MemoryRecord[] = [];
  let listUnavailable = false;
  if (await runtimeState.isAuthorized(requestPrincipal.principal.id)) {
    try {
      records = await runtimeState.list(requestPrincipal.principal.id, { limit });
      if (text) {
        const query = text.toLocaleLowerCase();
        records = records.filter((record) => [record.summary, record.content, record.kind, record.source].filter(Boolean).join(" ").toLocaleLowerCase().includes(query));
      }
    } catch {
      records = [];
      listUnavailable = true;
    }
  }
  const response = jsonResponse({
    featureFlag: runtimeState.featureEnabled,
    consent: runtimeState.featureEnabled ? (authorization?.consent ?? requestPrincipal.principal.consent) : "UNKNOWN",
    principalType: "ANONYMOUS",
    records: records.slice(0, limit).map(toPublicMemoryRecord),
    brief: toPublicBrief(brief),
    limitations: [...new Set([...(brief.limitations ?? []), ...(listUnavailable ? ["Memory records unavailable; showing an empty management view."] : []), ...(runtimeState.degradedReason ? [runtimeState.degradedReason] : [])])].slice(0, 16),
  });
  return withCookie(response, requestPrincipal.setCookie);
}

/** Delete all currently listed memories through the normal tombstone path. */
export async function DELETE(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ accepted: false, reason: "CROSS_ORIGIN" }, 403);
  if (queryHasForbiddenUserId(request)) return jsonResponse({ accepted: false, reason: "USER_ID_NOT_ACCEPTED" }, 400);
  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok) return jsonResponse({ accepted: false, reason: body.reason }, body.status);
  if (body.value !== undefined && hasBodyUserId(body.value)) return jsonResponse({ accepted: false, reason: "USER_ID_NOT_ACCEPTED" }, 400);
  if (body.value !== undefined && (typeof body.value !== "object" || Array.isArray(body.value) || Object.keys(body.value as object).length > 0)) {
    return jsonResponse({ accepted: false, reason: "INVALID_DELETE_ALL" }, 400);
  }
  const runtimeState = getMemoryRuntime();
  const requestPrincipal = await ensureRequestPrincipal(request);
  const userId = requestPrincipal.principal.id;
  if (!(await runtimeState.canDelete(userId))) {
    const response = jsonResponse({ accepted: false, reason: "CONSENT_REQUIRED" }, 403);
    return withCookie(response, requestPrincipal.setCookie);
  }
  if (memoryPersistenceUnavailable(runtimeState)) {
    const response = jsonResponse({ accepted: false, reason: "PERSISTENCE_UNAVAILABLE" }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }
  let deleted = 0;
  const maxDeletes = 10_000;
  const batchSize = 100;
  let limited = false;
  let globallyPurged = false;
  try {
    const atomicResult = await runtimeState.deleteAllAtomic(userId);
    if (atomicResult) {
      // SQLite owns the complete erase transaction. No record-level delete
      // is allowed on this branch: a failed purge must report zero committed
      // deletions, and outbox invalidation runs only after the commit.
      deleted = atomicResult.deletedMemoryIds.length;
      limited = atomicResult.idListLimited;
      globallyPurged = true;
    }
    while (!globallyPurged && deleted < maxDeletes) {
      // Always enumerate opaque IDs for a delete-all operation. This remains
      // valid if consent changes from GRANTED to REVOKED during the loop and
      // never recalls memory content into the management process.
      const memoryIds = await runtimeState.listMemoryIdsForDeletion(userId, batchSize);
      if (memoryIds.length === 0) break;
      for (const memoryId of memoryIds) {
        const tombstone = await runtimeState.delete(userId, memoryId, { reason: "用户请求清除全部长期记忆" });
        if (!tombstone || tombstone.status !== "DELETED") {
          const response = jsonResponse({ accepted: false, reason: "PERSISTENCE_UNAVAILABLE", deleted }, 503);
          return withCookie(response, requestPrincipal.setCookie);
        }
        deleted += 1;
      }
      if (memoryIds.length < batchSize) break;
    }
    if (!globallyPurged && deleted >= maxDeletes) {
      const remaining = await runtimeState.listMemoryIdsForDeletion(userId, 1);
      limited = remaining.length > 0;
      if (limited) {
        // The count limit is only a response bound, never a privacy boundary.
        // Once the cap is reached, install the user-wide REVOKED/deletion
        // marker and purge every remaining aggregate before returning. This
        // prevents a "limited" response from leaving a live write channel or
        // an unknown DO able to resurrect an unlisted event.
        await runtimeState.service.purgeUserMemoryResidue(userId);
        globallyPurged = true;
      }
    }
    if (!globallyPurged) {
      await runtimeState.service.purgeUserMemoryResidue(userId);
      // The global revoke above linearizes future writes, but a writer that
      // held the principal lock before the revoke may have committed after
      // the first opaque-ID enumeration. Drain that post-revoke tail while
      // deletion remains the only permitted operation, then run the residue
      // purge once more so no newly materialized row survives re-opt-in.
      let tailDeleted = 0;
      while (tailDeleted < maxDeletes) {
        const tailIds = await runtimeState.listMemoryIdsForDeletion(userId, batchSize);
        if (tailIds.length === 0) break;
        for (const memoryId of tailIds) {
          const tombstone = await runtimeState.delete(userId, memoryId, { reason: "用户请求清除全部长期记忆" });
          if (!tombstone || tombstone.status !== "DELETED") throw new Error("MEMORY_DELETE_RACE");
          deleted += 1;
          tailDeleted += 1;
        }
        if (tailIds.length < batchSize) break;
      }
      if (tailDeleted > 0) await runtimeState.service.purgeUserMemoryResidue(userId);
    }
  } catch {
    const response = jsonResponse({ accepted: false, reason: "PERSISTENCE_UNAVAILABLE", deleted }, 503);
    return withCookie(response, requestPrincipal.setCookie);
  }
  const response = jsonResponse({ accepted: true, deleted, limited });
  let cookie = requestPrincipal.setCookie;
  // The normal authorization read is intentionally disabled when the memory
  // feature flag is off. Deletion is the privacy exception, so use its
  // dedicated durable read to ensure a successful erase never returns an old
  // GRANTED cookie that could reopen the channel later.
  const postDeleteAuthorization = await runtimeState.getAuthorizationForDeletion(userId);
  if (!postDeleteAuthorization && requestPrincipal.persistent) {
    // Never leave a previously verified GRANTED cookie in the browser when
    // the post-purge durable read is unavailable. Clearing it is safer than
    // returning a token that could reopen a stale DO channel.
    cookie = clearMemoryPrincipalCookie();
  } else if (postDeleteAuthorization?.consent === "REVOKED" && requestPrincipal.persistent) {
    try {
      cookie = await signMemoryPrincipalCookie({
        id: userId,
        type: "ANONYMOUS",
        consent: "REVOKED",
        consentVersion: postDeleteAuthorization.consentVersion ?? requestPrincipal.principal.consentVersion + 1,
        issuedAt: requestPrincipal.principal.issuedAt,
      });
    } catch {
      // The existing verified cookie remains usable for the deletion channel.
    }
  } else if (requestPrincipal.persistent) {
    cookie = clearMemoryPrincipalCookie();
  }
  return withCookie(response, cookie);
}
