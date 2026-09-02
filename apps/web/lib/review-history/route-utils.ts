import "server-only";

import { currentDesktopReviewLibrary } from "@cs-coach/review-library/server";
import { sameOriginRequest } from "../desktop/request-origin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function requireDesktopSameOrigin(request: Request): Response | undefined {
  if (!sameOriginRequest(request)) return noStoreJson({ code: "CROSS_ORIGIN" }, 403);
  if (!currentDesktopReviewLibrary()) return noStoreJson({ code: "DESKTOP_ONLY" }, 403);
  return undefined;
}

export function reviewLibrary() {
  const library = currentDesktopReviewLibrary();
  if (!library) throw new Error("DESKTOP_LIBRARY_UNAVAILABLE");
  return library;
}

export async function boundedJson(request: Request, maximumBytes = 16_384): Promise<Record<string, unknown> | undefined> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > maximumBytes) return undefined;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) return undefined;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function boundedId(value: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : undefined;
}

export function boundedText(value: unknown, maximum = 160): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum ? value.trim() : undefined;
}
