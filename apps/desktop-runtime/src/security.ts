import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const SESSION_COOKIE_NAME = "cs_agent_runtime";
export const DESKTOP_VIEWER_ORIGIN_HEADER = "x-cs-agent-viewer-origin";
export const DESKTOP_APP_ORIGIN_HEADER = "x-cs-agent-app-origin";
export const NEXT_NONCE_HEADER = "x-nonce";

export function createRuntimeToken(): string {
  return randomBytes(32).toString("base64url");
}

function fixedDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function constantTimeTokenEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(fixedDigest(actual), fixedDigest(expected));
}

function sessionCookieValue(rawCookie: string | undefined): string | undefined {
  if (!rawCookie || rawCookie.length > 8192) return undefined;
  const values: string[] = [];
  for (const part of rawCookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined;
    values.push(value);
  }
  return values.length === 1 ? values[0] : undefined;
}

export function containsSessionCookie(rawCookie: string | undefined): boolean {
  if (!rawCookie) return false;
  // An oversized Cookie header is malformed for this private transport. Fail
  // closed so a session cookie cannot be hidden beyond the parsing budget.
  if (rawCookie.length > 8192) return true;
  return rawCookie.split(";").some((part) => {
    const separator = part.indexOf("=");
    return separator >= 0 && part.slice(0, separator).trim() === SESSION_COOKIE_NAME;
  });
}

export function hasValidSessionCookie(req: IncomingMessage, sessionToken: string): boolean {
  const value = sessionCookieValue(req.headers.cookie);
  return value !== undefined && constantTimeTokenEqual(value, sessionToken);
}

export function hasValidAdminAuthorization(req: IncomingMessage, adminToken: string): boolean {
  if (req.headers.origin !== undefined) return false;
  const raw = req.headers.authorization;
  if (!raw || raw.length > 256 || !raw.startsWith("Bearer ")) return false;
  const token = raw.slice("Bearer ".length);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) && constantTimeTokenEqual(token, adminToken);
}

export function createAppCsp(nonce: string, viewerOrigin: string): string {
  const viewer = new URL(viewerOrigin);
  if (viewer.protocol !== "http:"
    || viewer.hostname !== "localhost"
    || !viewer.port
    || viewer.pathname !== "/"
    || viewer.search
    || viewer.hash
    || viewer.username
    || viewer.password) throw new Error("VIEWER_ORIGIN_INVALID");
  return [
    "default-src 'self'",
    // WKWebView must execute Next's same-origin entry chunks and their
    // webpack-loaded descendants. Inline scripts still require the
    // per-response nonce; eval and unsafe-inline remain forbidden.
    `script-src 'self' 'nonce-${nonce}'`,
    // Existing guided timeline geometry uses bounded React style attributes.
    // Nonces cannot authorize style attributes; keep this exception scoped to
    // styles while scripts remain strict nonce-only.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${viewer.origin}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function appSecurityHeaders(nonce: string, viewerOrigin: string): Readonly<Record<string, string>> {
  return {
    "Content-Security-Policy": createAppCsp(nonce, viewerOrigin),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

const LOCKED_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "referrer-policy",
  "x-content-type-options",
]);

/** Prevent downstream handlers from weakening the desktop response boundary. */
export function lockResponseSecurityHeaders(
  res: ServerResponse,
  headers: Readonly<Record<string, string>>,
): void {
  const setHeader = res.setHeader.bind(res);
  const removeHeader = res.removeHeader.bind(res);
  for (const [name, value] of Object.entries(headers)) setHeader(name, value);

  res.setHeader = ((name: string, value: string | number | readonly string[]) => {
    const normalized = name.toLowerCase();
    if (normalized.startsWith("access-control-")) return res;
    if (LOCKED_RESPONSE_HEADERS.has(normalized)) return res;
    return setHeader(name, value);
  }) as ServerResponse["setHeader"];
  res.removeHeader = ((name: string) => {
    const normalized = name.toLowerCase();
    if (LOCKED_RESPONSE_HEADERS.has(normalized)) return;
    removeHeader(name);
  }) as ServerResponse["removeHeader"];

  const writeHead = res.writeHead.bind(res);
  const sanitize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      const clean: unknown[] = [];
      for (let index = 0; index < input.length; index += 2) {
        const name = String(input[index] ?? "");
        const normalized = name.toLowerCase();
        if (normalized.startsWith("access-control-") || LOCKED_RESPONSE_HEADERS.has(normalized)) continue;
        clean.push(input[index], input[index + 1]);
      }
      return clean;
    }
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).filter(([name]) => {
        const normalized = name.toLowerCase();
        return !normalized.startsWith("access-control-") && !LOCKED_RESPONSE_HEADERS.has(normalized);
      }));
    }
    return input;
  };
  res.writeHead = ((statusCode: number, statusMessageOrHeaders?: string | object | unknown[], headersArg?: object | unknown[]) => {
    if (typeof statusMessageOrHeaders === "string") {
      return writeHead(statusCode, statusMessageOrHeaders, sanitize(headersArg) as never);
    }
    return writeHead(statusCode, sanitize(statusMessageOrHeaders) as never);
  }) as ServerResponse["writeHead"];
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(encoded));
  res.end(encoded);
}
