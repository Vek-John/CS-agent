import type { MemoryEvent, MemoryRecord, MemoryUserDataExport } from "@cs-coach/memory";
import {
  ensureRequestPrincipal,
  jsonResponse,
  queryHasForbiddenUserId,
  sameOrigin,
  toPublicMemoryRecord,
  withCookie,
} from "../../../../lib/memory/api";
import {
  getMemoryRuntime,
  memoryPersistenceUnavailable,
} from "../../../../lib/memory/server";
import { MEMORY_EXPORT_MAX_BYTES } from "../../../../lib/memory/export-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function eventType(event: MemoryEvent): string {
  return String(event.type ?? event.eventType ?? "UNKNOWN");
}

function isStrictlyScoped(
  exported: MemoryUserDataExport,
  userId: string,
): boolean {
  if (exported.schemaVersion !== "memory-export.v1") return false;
  if (
    exported.authorization &&
    exported.authorization.userId !== userId
  ) {
    return false;
  }
  return (
    exported.records.every((record) => record.userId === userId) &&
    exported.events.every((event) => event.userId === userId)
  );
}

function publicExport(exported: MemoryUserDataExport): Record<string, unknown> {
  return {
    schemaVersion: "memory-export.v1",
    exportedAt: exported.exportedAt,
    ...(exported.authorization
      ? {
          authorization: {
            consent: exported.authorization.consent,
            memoryEnabled: Boolean(
              exported.authorization.memoryEnabled ??
                exported.authorization.featureFlag,
            ),
            consentVersion: exported.authorization.consentVersion ?? 0,
            ...(exported.authorization.updatedAt
              ? { updatedAt: exported.authorization.updatedAt }
              : {}),
          },
        }
      : {}),
    records: exported.records.map((record: MemoryRecord) => ({
      ...toPublicMemoryRecord(record),
      ...(record.preference
        ? {
            preference: {
              key: record.preference.key,
              value: record.preference.value,
              ...(record.preference.label
                ? { label: record.preference.label }
                : {}),
            },
          }
        : {}),
    })),
    // Event payloads contain producer/idempotency/provenance internals. The
    // export exposes only the user-meaningful lifecycle and timestamp; record
    // content and evidence are already represented by the public record DTO.
    events: exported.events.map((event) => ({
      type: eventType(event),
      createdAt: event.createdAt,
    })),
  };
}

function exportFilename(exportedAt: string): string {
  const parsed = new Date(exportedAt);
  const date = Number.isFinite(parsed.getTime())
    ? parsed.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return `cs-agent-memory-export-${date}.json`;
}

export async function GET(request: Request): Promise<Response> {
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "CROSS_ORIGIN" }, 403);
  }
  if (queryHasForbiddenUserId(request)) {
    return jsonResponse({ error: "USER_ID_NOT_ACCEPTED" }, 400);
  }

  const runtimeState = getMemoryRuntime();
  const requestPrincipal = await ensureRequestPrincipal(request);
  const userId = requestPrincipal.principal.id;
  if (!(await runtimeState.canDelete(userId))) {
    return withCookie(
      jsonResponse({ error: "CONSENT_REQUIRED" }, 403),
      requestPrincipal.setCookie,
    );
  }
  if (memoryPersistenceUnavailable(runtimeState)) {
    return withCookie(
      jsonResponse({ error: "PERSISTENCE_UNAVAILABLE" }, 503),
      requestPrincipal.setCookie,
    );
  }
  if (!runtimeState.repository.exportUserData) {
    return withCookie(
      jsonResponse({ error: "EXPORT_NOT_SUPPORTED" }, 501),
      requestPrincipal.setCookie,
    );
  }

  try {
    const exported = await runtimeState.exportUserData(userId);
    if (!exported || !isStrictlyScoped(exported, userId)) {
      return withCookie(
        jsonResponse({ error: "EXPORT_SCOPE_INVALID" }, 503),
        requestPrincipal.setCookie,
      );
    }
    const json = JSON.stringify(publicExport(exported));
    if (new TextEncoder().encode(json).byteLength > MEMORY_EXPORT_MAX_BYTES) {
      return withCookie(
        jsonResponse({ error: "EXPORT_TOO_LARGE" }, 413),
        requestPrincipal.setCookie,
      );
    }
    const headers = new Headers({
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${exportFilename(exported.exportedAt)}"`,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      vary: "Cookie",
    });
    const response = new Response(json, { status: 200, headers });
    return withCookie(response, requestPrincipal.setCookie);
  } catch {
    return withCookie(
      jsonResponse({ error: "EXPORT_UNAVAILABLE" }, 503),
      requestPrincipal.setCookie,
    );
  }
}
