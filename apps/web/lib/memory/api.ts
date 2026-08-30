import {
  MemoryConfirmationSchema,
  MemoryCorrectionInputSchema,
  MemoryDeleteInputSchema,
  MemoryEventSchema,
  MemoryIdSchema,
  type MemoryAuthorization,
  type MemoryConsentState,
  type MemoryEvent,
  type MemoryRecord,
  type UserMemoryBrief,
} from "@cs-coach/memory";
import {
  clearMemoryPrincipalCookie,
  constantTimeEqual,
  createAnonymousPrincipal,
  hmacSha256Base64Url,
  issueTestMemoryPrincipalCookie,
  memoryPrincipalSecret,
  resolveMemoryPrincipal,
  signMemoryPrincipalCookie,
  verifyHmacSha256Base64Url,
  type AnonymousPrincipal,
} from "./principal";
import {
  DESKTOP_APP_ORIGIN_HEADER,
  sameOriginRequest,
  validatedDesktopAppOrigin,
} from "../desktop/request-origin";
import { getMemoryRuntime, type MemoryRuntime } from "./server";

export const MEMORY_API_MAX_BODY_BYTES = 64 * 1024;
export const MEMORY_EVENT_MAX_BODY_BYTES = 32 * 1024;
export const MEMORY_LIST_MAX = 25;

type JsonHeaders = HeadersInit | undefined;

export function jsonResponse(body: unknown, status = 200, headers?: JsonHeaders): Response {
  const merged = new Headers(headers);
  merged.set("cache-control", "no-store");
  merged.set("content-type", "application/json; charset=utf-8");
  merged.set("vary", "Cookie");
  return Response.json(body, { status, headers: merged });
}

export function withCookie(response: Response, cookie?: string): Response {
  if (cookie) response.headers.append("set-cookie", cookie);
  return response;
}

export interface RequestPrincipal {
  readonly principal: AnonymousPrincipal;
  readonly setCookie?: string;
  readonly resolutionReason?: string;
  /** True only when this request is backed by a verifiable signed cookie. */
  readonly persistent: boolean;
}

export const DESKTOP_LOCAL_PRINCIPAL_ID = "desktop-local-principal.v1";

function desktopLoopbackPrincipal(request: Request): AnonymousPrincipal | undefined {
  if ((process.env.DEPLOY_TARGET ?? "").trim().toLowerCase() !== "desktop") return undefined;
  if (!validatedDesktopAppOrigin(request.headers.get(DESKTOP_APP_ORIGIN_HEADER))) return undefined;
  const cookie = request.headers.get("cookie") ?? "";
  const session = cookie.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("cs_agent_runtime="))?.slice("cs_agent_runtime=".length);
  if (!session || session.length !== 43 || !/^[A-Za-z0-9_-]+$/u.test(session)) return undefined;
  return {
    id: DESKTOP_LOCAL_PRINCIPAL_ID,
    type: "ANONYMOUS",
    consent: "UNKNOWN",
    consentVersion: 0,
    issuedAt: "1970-01-01T00:00:00.000Z",
  };
}

export async function ensureRequestPrincipal(request: Request): Promise<RequestPrincipal> {
  // The sidecar validates cs_agent_runtime before this request reaches Next.
  // DEPLOY_TARGET is process-owned, never a request header. This stable local
  // identity does not read cloud/env signing secrets and never sets a second cookie.
  const desktopPrincipal = desktopLoopbackPrincipal(request);
  if (desktopPrincipal) return { principal: desktopPrincipal, persistent: true };
  const resolved = await resolveMemoryPrincipal(request);
  if (resolved.principal) return { principal: resolved.principal, persistent: true };
  const principal = createAnonymousPrincipal();
  try {
    return {
      principal,
      setCookie: await signMemoryPrincipalCookie(principal),
      persistent: true,
      ...(resolved.reason ? { resolutionReason: resolved.reason } : {}),
    };
  } catch {
    // The caller can still return a controlled degraded response; no opaque
    // principal is ever sent in JSON when signing is unavailable.
    return {
      principal,
      persistent: false,
      ...(resolved.reason ? { resolutionReason: resolved.reason } : {}),
    };
  }
}

export function sameOrigin(request: Request): boolean {
  return sameOriginRequest(request);
}

export function hasBodyUserId(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "userId" in value);
}

export function boundedLimit(value: string | null, fallback = 3, max = MEMORY_LIST_MAX): number | undefined {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) return undefined;
  return parsed;
}

export function queryHasForbiddenUserId(request: Request): boolean {
  try {
    return new URL(request.url).searchParams.has("userId");
  } catch {
    return true;
  }
}

export async function readBodyText(request: Request, maxBytes = MEMORY_API_MAX_BODY_BYTES): Promise<{ ok: true; text: string } | { ok: false; status: number; reason: string }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) return { ok: false, status: 413, reason: "REQUEST_TOO_LARGE" };
  }
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) return { ok: false, status: 413, reason: "REQUEST_TOO_LARGE" };
    return { ok: true, text };
  } catch {
    return { ok: false, status: 400, reason: "REQUEST_BODY_UNREADABLE" };
  }
}

export async function readJsonBody(request: Request, maxBytes = MEMORY_API_MAX_BODY_BYTES): Promise<{ ok: true; value: unknown; text: string } | { ok: false; status: number; reason: string }> {
  const body = await readBodyText(request, maxBytes);
  if (!body.ok) return body;
  if (!body.text.trim()) return { ok: true, value: undefined, text: body.text };
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown, text: body.text };
  } catch {
    return { ok: false, status: 400, reason: "INVALID_REQUEST_JSON" };
  }
}

export function publicConsent(authorization: MemoryAuthorization | undefined, fallback: MemoryConsentState): MemoryConsentState {
  return authorization?.consent ?? fallback;
}

function sourceCategory(source: MemoryRecord["source"]): "USER" | "INFERENCE" | "EVIDENCE" {
  if (["USER", "USER_EXPLICIT", "USER_CONFIRMED", "USER_CORRECTION"].includes(source)) return "USER";
  if (["AGENT_INFERRED", "COACH_RULE_DERIVED", "COACH"].includes(source)) return "INFERENCE";
  return "EVIDENCE";
}

function sourceLabel(source: MemoryRecord["source"]): string {
  switch (source) {
    case "USER":
    case "USER_EXPLICIT":
    case "USER_CONFIRMED":
    case "USER_CORRECTION":
      return "用户提供 / 已确认";
    case "AGENT_INFERRED":
      return "教练推断";
    case "COACH_RULE_DERIVED":
    case "COACH":
      return "教练规则";
    case "DEMO_OBSERVED":
    case "DEMO":
      return "Demo 事实";
    default:
      return "系统来源";
  }
}

function confidence(record: MemoryRecord): number | null {
  const values = [
    record.thread?.diagnosis.confidence,
    record.thread?.transferRule.confidence,
    record.verdict?.confidence,
    ...record.inferences.map((value) => value.confidence),
    ...record.advice.map((value) => value.confidence),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? Math.max(0, Math.min(1, Math.max(...values))) : null;
}

/**
 * Management DTO: omit userId and raw provenance identifiers while retaining
 * enough source metadata for a user to understand USER vs INFERENCE.
 */
export function toPublicMemoryRecord(record: MemoryRecord): Record<string, unknown> {
  return {
    memoryId: record.memoryId,
    kind: record.kind,
    source: record.source,
    sourceCategory: sourceCategory(record.source),
    sourceLabel: sourceLabel(record.source),
    scope: record.scope,
    status: record.status,
    active: record.active,
    revision: record.revision,
    ...(record.content ? { content: record.content } : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.profile ? { profile: Object.fromEntries(Object.entries(record.profile).slice(0, 8)) } : {}),
    confidence: confidence(record),
    limitations: record.limitations.slice(0, 16),
    sources: [...record.sourceRefs]
      .slice(0, 16)
      .map((ref) => ({ namespace: ref.namespace, source: ref.source ?? undefined, label: ref.label ?? undefined }))
      .map((ref) => Object.fromEntries(Object.entries(ref).filter(([, value]) => value !== undefined))),
    counterEvidence: [...(record.counterEvidenceRefs ?? [])]
      .slice(0, 16)
      .map((ref) => ({ namespace: ref.namespace, source: ref.source ?? undefined, label: ref.label ?? undefined }))
      .map((ref) => Object.fromEntries(Object.entries(ref).filter(([, value]) => value !== undefined))),
    corrections: record.corrections.slice(-8).map((correction) => ({
      correctionId: correction.correctionId,
      content: correction.content,
      createdAt: correction.createdAt,
      revision: correction.revision,
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.confirmedAt ? { confirmedAt: record.confirmedAt } : {}),
    ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
    ...(record.tombstone ? { tombstone: record.tombstone } : {}),
  };
}

export function toPublicBrief(brief: UserMemoryBrief): Record<string, unknown> {
  return {
    schemaVersion: brief.schemaVersion,
    generatedAt: brief.generatedAt,
    preferences: brief.preferences ?? {},
    activeThreads: brief.activeThreads,
    memories: brief.memories.map(toPublicMemoryRecord),
    corrections: brief.corrections.map((correction) => ({
      correctionId: correction.correctionId,
      memoryId: correction.memoryId,
      content: correction.content,
      createdAt: correction.createdAt,
      revision: correction.revision,
    })),
    limitations: brief.limitations,
    source: brief.source,
    structuredStatus: brief.structuredStatus,
    semanticStatus: brief.semanticStatus,
  };
}

export interface InternalPrincipalAuthentication {
  readonly principalId: string;
  readonly mechanism: "TOKEN" | "HMAC" | "TEST_INJECTION";
}

function internalPrincipalHeader(request: Request): string | undefined {
  const value = request.headers.get("x-memory-principal") ?? request.headers.get("x-memory-user") ?? request.headers.get("x-cs-trusted-principal");
  if (!value || !MemoryIdSchema.safeParse(value).success) return undefined;
  return value.trim();
}

function internalToken(): string | undefined {
  const context = (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] as { env?: Record<string, unknown> } | undefined;
  const value = process.env.MEMORY_INTERNAL_TOKEN ?? context?.env?.MEMORY_INTERNAL_TOKEN;
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length >= 16 ? normalized : undefined;
}

/** Authenticate the Outbox consumer without accepting a body principal. */
export async function authenticateInternalRequest(
  request: Request,
  rawBody: string,
  runtime: MemoryRuntime = getMemoryRuntime(),
): Promise<InternalPrincipalAuthentication | undefined> {
  const principalId = internalPrincipalHeader(request) ?? (
    process.env.NODE_ENV === "test" && runtime.allowTestPrincipal
      ? request.headers.get("x-memory-test-principal")?.trim()
      : undefined
  );
  if (!principalId) return undefined;
  const configuredToken = internalToken();
  if (configuredToken) {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "");
    const presented = request.headers.get("x-memory-internal-token") ?? request.headers.get("x-cs-memory-internal") ?? bearer;
    if (presented && constantTimeEqual(presented, configuredToken)) return { principalId, mechanism: "TOKEN" };
    return undefined;
  }
  const context = (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] as { env?: Record<string, unknown> } | undefined;
  const contextHmac = context?.env?.MEMORY_INTERNAL_HMAC_SECRET;
  const hmacSecret = typeof process.env.MEMORY_INTERNAL_HMAC_SECRET === "string"
    ? process.env.MEMORY_INTERNAL_HMAC_SECRET.trim()
    : typeof contextHmac === "string"
      ? contextHmac.trim()
      : "";
  const signature = request.headers.get("x-memory-signature");
  const timestamp = request.headers.get("x-memory-timestamp");
  // Keep the inbound boundary aligned with Worker/DO outbound signing and
  // the deployment contract: short HMAC secrets are configuration errors,
  // never usable authentication material.
  if (hmacSecret.length >= 16 && signature && timestamp) {
    const numericTimestamp = Number(timestamp);
    const timestampMs = Number.isFinite(numericTimestamp)
      ? (numericTimestamp < 10_000_000_000 ? numericTimestamp * 1_000 : numericTimestamp)
      : Date.parse(timestamp);
    if (Number.isFinite(timestampMs) && Math.abs(Date.now() - timestampMs) <= 5 * 60 * 1000) {
      const expectedInput = `${timestamp}.${rawBody}`;
      if (await verifyHmacSha256Base64Url(expectedInput, signature, hmacSecret)) return { principalId, mechanism: "HMAC" };
    }
    return undefined;
  }
  if (process.env.NODE_ENV === "test" && runtime.allowTestPrincipal) {
    const injected = request.headers.get("x-memory-test-principal");
    if (injected && injected === principalId && MemoryIdSchema.safeParse(injected).success) {
      return { principalId, mechanism: "TEST_INJECTION" };
    }
  }
  return undefined;
}

export async function makeInternalSignature(rawBody: string, timestamp: string, secret: string): Promise<string> {
  return hmacSha256Base64Url(`${timestamp}.${rawBody}`, secret);
}

export {
  MemoryConfirmationSchema,
  MemoryCorrectionInputSchema,
  MemoryDeleteInputSchema,
  MemoryEventSchema,
  MemoryIdSchema,
  clearMemoryPrincipalCookie,
  issueTestMemoryPrincipalCookie,
  memoryPrincipalSecret,
};
