import type { MemoryConsentState } from "@cs-coach/memory";

/** Opaque, signed cookie used by the anonymous memory management surface. */
export const MEMORY_PRINCIPAL_COOKIE = "cs_coach_memory_principal";
export const MEMORY_PRINCIPAL_VERSION = "memory-principal.v1";
export const MEMORY_PRINCIPAL_TTL_SECONDS = 60 * 60 * 24 * 365;

const MAX_PRINCIPAL_ID = 160;

export interface AnonymousPrincipal {
  /** Internal-only opaque identifier. Never serialize this in a response. */
  readonly id: string;
  readonly type: "ANONYMOUS";
  readonly consent: MemoryConsentState;
  readonly consentVersion: number;
  readonly issuedAt: string;
}

interface PrincipalCookiePayload {
  readonly v: typeof MEMORY_PRINCIPAL_VERSION;
  readonly p: string;
  readonly c: MemoryConsentState;
  readonly cv: number;
  readonly iat: string;
  readonly exp: number;
}

export interface PrincipalResolution {
  readonly principal?: AnonymousPrincipal;
  readonly reason?: "MISSING" | "INVALID" | "EXPIRED" | "SECRET_UNAVAILABLE";
}

export interface PrincipalCookieOptions {
  readonly secure?: boolean;
  readonly now?: Date;
  readonly secret?: string;
}

let ephemeralSecret: string | undefined;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function configuredSecret(): string | undefined {
  const context = (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] as { env?: Record<string, unknown> } | undefined;
  const contextSecret = context?.env?.MEMORY_PRINCIPAL_SECRET ?? context?.env?.MEMORY_COOKIE_SECRET ?? context?.env?.MEMORY_HMAC_SECRET;
  const value =
    process.env.MEMORY_PRINCIPAL_SECRET ??
    process.env.MEMORY_COOKIE_SECRET ??
    process.env.MEMORY_HMAC_SECRET ??
    (typeof contextSecret === "string" ? contextSecret : undefined);
  const normalized = value?.trim() || undefined;
  // A short production secret would make the signed anonymous principal
  // guessable. Local/test callers may still use the ephemeral fallback.
  if (isProduction() && normalized && normalized.length < 16) return undefined;
  return normalized;
}

/**
 * Local/test runs may use a process-ephemeral key. Production must configure a
 * stable secret so a restart cannot silently invalidate every principal.
 */
export function memoryPrincipalSecret(): string | undefined {
  const configured = configuredSecret();
  if (configured) return configured;
  if (isProduction()) return undefined;
  if (!ephemeralSecret) {
    if (!globalThis.crypto?.getRandomValues) return undefined;
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    ephemeralSecret = encodeBase64Url(bytes);
  }
  return ephemeralSecret;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  try {
    // Reject alternate spellings/padding before decoding. This keeps the
    // signed cookie and internal HMAC headers canonical and avoids accepting
    // values that decode to the same bytes through ambiguous syntax.
    if (!value || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return undefined;
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (encodeBase64Url(bytes) !== value) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    bufferSource(utf8(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, bufferSource(utf8(value))));
}

async function verifyHmac(value: string, signature: Uint8Array, secret: string): Promise<boolean> {
  if (signature.byteLength !== 32) return false;
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    bufferSource(utf8(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return globalThis.crypto.subtle.verify("HMAC", key, bufferSource(signature), bufferSource(utf8(value)));
}

function isConsent(value: unknown): value is MemoryConsentState {
  return value === "GRANTED" || value === "REVOKED" || value === "UNKNOWN";
}

function validPayload(value: unknown): value is PrincipalCookiePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const expectedKeys = new Set(["v", "p", "c", "cv", "iat", "exp"]);
  if (Object.keys(payload).some((key) => !expectedKeys.has(key))) return false;
  return (
    payload.v === MEMORY_PRINCIPAL_VERSION &&
    typeof payload.p === "string" &&
    payload.p.trim().length > 0 &&
    payload.p.length <= MAX_PRINCIPAL_ID &&
    isConsent(payload.c) &&
    typeof payload.cv === "number" &&
    Number.isInteger(payload.cv) &&
    payload.cv >= 0 &&
    payload.cv <= 10_000 &&
    typeof payload.iat === "string" &&
    payload.iat.length <= 80 &&
    typeof payload.exp === "number" &&
    Number.isSafeInteger(payload.exp)
  );
}

function cookieHeaderValue(name: string, token: string, options?: PrincipalCookieOptions): string {
  const secure = options?.secure ?? isProduction();
  return [
    `${name}=${token}`,
    "Path=/",
    `Max-Age=${MEMORY_PRINCIPAL_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearMemoryPrincipalCookie(options?: PrincipalCookieOptions): string {
  const secure = options?.secure ?? isProduction();
  return [
    `${MEMORY_PRINCIPAL_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function cookieValue(request: Request): string | undefined {
  const raw = request.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === MEMORY_PRINCIPAL_COOKIE) return rest.join("=") || undefined;
  }
  return undefined;
}

function randomPrincipalId(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `anon-${encodeBase64Url(bytes)}`;
}

export function createAnonymousPrincipal(options?: { now?: Date; consent?: MemoryConsentState; consentVersion?: number }): AnonymousPrincipal {
  const now = options?.now ?? new Date();
  return {
    id: randomPrincipalId(),
    type: "ANONYMOUS",
    consent: options?.consent ?? "UNKNOWN",
    consentVersion: options?.consentVersion ?? 0,
    issuedAt: now.toISOString(),
  };
}

export async function signMemoryPrincipalCookie(
  principal: AnonymousPrincipal,
  options?: PrincipalCookieOptions,
): Promise<string> {
  const secret = options?.secret ?? memoryPrincipalSecret();
  if (!secret) throw new Error("MEMORY_PRINCIPAL_SECRET_UNAVAILABLE");
  const now = options?.now ?? new Date();
  const payload: PrincipalCookiePayload = {
    v: MEMORY_PRINCIPAL_VERSION,
    p: principal.id,
    c: principal.consent,
    cv: principal.consentVersion,
    iat: principal.issuedAt,
    exp: now.getTime() + MEMORY_PRINCIPAL_TTL_SECONDS * 1000,
  };
  const encoded = encodeBase64Url(utf8(JSON.stringify(payload)));
  const signature = encodeBase64Url(await hmac(encoded, secret));
  return cookieHeaderValue(MEMORY_PRINCIPAL_COOKIE, `${encoded}.${signature}`, options);
}

/** Verify the signed cookie without exposing its opaque principal ID. */
export async function resolveMemoryPrincipal(request: Request, options?: { now?: Date; secret?: string }): Promise<PrincipalResolution> {
  const value = cookieValue(request);
  if (!value) return { reason: "MISSING" };
  const [encoded, signatureText, ...extra] = value.split(".");
  if (!encoded || !signatureText || extra.length > 0 || encoded.length > 4096 || signatureText.length > 128) return { reason: "INVALID" };
  const signature = decodeBase64Url(signatureText);
  const bytes = decodeBase64Url(encoded);
  const secret = options?.secret ?? memoryPrincipalSecret();
  if (!signature || !bytes) return { reason: "INVALID" };
  if (!secret) return { reason: "SECRET_UNAVAILABLE" };
  try {
    if (!(await verifyHmac(encoded, signature, secret))) return { reason: "INVALID" };
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!validPayload(parsed)) return { reason: "INVALID" };
    const now = (options?.now ?? new Date()).getTime();
    if (parsed.exp <= now) return { reason: "EXPIRED" };
    return {
      principal: {
        id: parsed.p,
        type: "ANONYMOUS",
        consent: parsed.c,
        consentVersion: parsed.cv,
        issuedAt: parsed.iat,
      },
    };
  } catch {
    return { reason: "INVALID" };
  }
}

/**
 * Test helper: deterministic IDs are intentionally available only to tests;
 * production callers should use createAnonymousPrincipal instead.
 */
export async function issueTestMemoryPrincipalCookie(
  principalId = "test-anonymous-principal",
  options?: Omit<PrincipalCookieOptions, "secret"> & { consent?: MemoryConsentState; consentVersion?: number },
): Promise<string> {
  if (!principalId.trim() || principalId.length > MAX_PRINCIPAL_ID) throw new Error("INVALID_TEST_PRINCIPAL_ID");
  const principal = createAnonymousPrincipal({
    now: options?.now,
    consent: options?.consent,
    consentVersion: options?.consentVersion,
  });
  const deterministic: AnonymousPrincipal = { ...principal, id: principalId };
  return signMemoryPrincipalCookie(deterministic, options);
}

export async function hmacSha256Base64Url(value: string, secret: string): Promise<string> {
  return encodeBase64Url(await hmac(value, secret));
}

export async function verifyHmacSha256Base64Url(value: string, signature: string, secret: string): Promise<boolean> {
  const bytes = decodeBase64Url(signature.replace(/^sha256=/u, ""));
  if (!bytes) return false;
  try {
    return await verifyHmac(value, bytes, secret);
  } catch {
    return false;
  }
}

// Short aliases keep server integrations readable while retaining the
// explicit names above for callers that want to emphasize the cookie scope.
export const resolvePrincipal = resolveMemoryPrincipal;
export const signPrincipalCookie = signMemoryPrincipalCookie;
export const issueTestPrincipalCookie = issueTestMemoryPrincipalCookie;
export const clearPrincipalCookie = clearMemoryPrincipalCookie;
export const MEMORY_COOKIE_NAME = MEMORY_PRINCIPAL_COOKIE;

/** Constant-time comparison for the short internal bearer-token path. */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = utf8(left);
  const b = utf8(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}
