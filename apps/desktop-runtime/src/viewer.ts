import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import path from "node:path";
import { containsSessionCookie } from "./security";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const DISABLED_PWA_PATHS = new Set([
  "/service-worker.js",
  "/service-worker.mjs",
  "/sw.js",
  "/sw.mjs",
  "/manifest.webmanifest",
]);

function viewerHeaders(appOrigin: string): Readonly<Record<string, string>> {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' blob:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      `frame-ancestors ${appOrigin}`,
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function respond(res: ServerResponse, status: number, body = "Not found"): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function decodedRequestPath(rawUrl: string | undefined): string | undefined {
  const rawPath = (rawUrl ?? "/").split("?", 1)[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return undefined;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) return undefined;
  if (decoded === "/" || decoded === "/cs2d" || decoded === "/cs2d/") {
    return "/index.html";
  }
  // The controlled cs2d build uses /cs2d/ so the same immutable output can
  // serve Cloudflare and Desktop. Desktop strips only this exact prefix
  // after decoding and traversal rejection, then resolves inside viewerRoot.
  return decoded.startsWith("/cs2d/") ? decoded.slice("/cs2d".length) : decoded;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export async function createViewerHandler(
  viewerRoot: string,
  appOrigin: () => string | undefined,
  viewerHost: () => string | undefined,
): Promise<RequestListener> {
  const canonicalRoot = await realpath(viewerRoot);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const allowedAppOrigin = appOrigin();
    const allowedViewerHost = viewerHost();
    if (!allowedAppOrigin || !allowedViewerHost) return respond(res, 503, "Not ready");
    if (req.headers.host !== allowedViewerHost) return respond(res, 421, "Host rejected");
    for (const [name, value] of Object.entries(viewerHeaders(allowedAppOrigin))) res.setHeader(name, value);
    if (containsSessionCookie(req.headers.cookie)) return respond(res, 400, "Session cookie forbidden");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return respond(res, 405, "Method not allowed");
    }
    const requestPath = decodedRequestPath(req.url);
    if (!requestPath) return respond(res, 400, "Invalid path");
    if (DISABLED_PWA_PATHS.has(requestPath)) return respond(res, 404);
    const lexicalPath = path.resolve(canonicalRoot, `.${requestPath}`);
    if (!isInside(canonicalRoot, lexicalPath)) return respond(res, 400, "Invalid path");
    let canonicalFile: string;
    try {
      canonicalFile = await realpath(lexicalPath);
      if (!isInside(canonicalRoot, canonicalFile)) return respond(res, 400, "Invalid path");
      if (!(await stat(canonicalFile)).isFile()) return respond(res, 404);
    } catch {
      return respond(res, 404);
    }
    const fileStat = await stat(canonicalFile);
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME_TYPES[path.extname(canonicalFile).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Length", fileStat.size);
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(canonicalFile);
    stream.on("error", () => {
      if (!res.headersSent) respond(res, 500, "Read failed");
      else res.destroy();
    });
    stream.pipe(res);
  };
}
