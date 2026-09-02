import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import path from "node:path";
import { currentDesktopReviewLibrary } from "@cs-coach/review-library/server";
import { containsSessionCookie } from "./security";

export const VIEWER_LIBRARY_IMPORT_PATH = "/_desktop/library/import";
export const VIEWER_LIBRARY_FINALIZE_PATH = "/_desktop/library/import/finalize";
export const VIEWER_LIBRARY_DEMO_PREFIX = "/_desktop/library/demo/";
export const VIEWER_LIBRARY_IMPORT_ID_HEADER = "x-cs-agent-import-id";
export const VIEWER_LIBRARY_DEMO_ID_HEADER = "x-cs-agent-demo-id";
export const VIEWER_LIBRARY_PARSE_OUTCOME_HEADER = "x-cs-agent-parse-outcome";

export interface ViewerLibraryActivityGate {
  readonly isReady: () => boolean;
  readonly begin: (response: ServerResponse) => () => void;
}

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

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", encoded.byteLength);
  res.end(encoded);
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function opaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 160 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function authorization(req: IncomingMessage): string | undefined {
  return singleHeader(req.headers.authorization);
}

function libraryErrorStatus(error: unknown): number {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (code.includes("TOO_LARGE") || code.includes("SIZE")) return 413;
  if (code.includes("FORMAT") || code.includes("HEADER") || code.includes("FILENAME")) return 422;
  if (code.includes("NOT_FOUND") || code.includes("NOT_READY") || code.includes("MISSING") || code.includes("CORRUPT")) return 404;
  if (code.includes("CONFLICT") || code.includes("CONSUMED")) return 409;
  if (code.includes("CAPABILITY") || code.includes("AUTH")) return 403;
  return 400;
}

function publicImportErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (code === "INVALID_DEMO") return "INVALID_DEMO_FORMAT";
  if (code === "IMPORT_LENGTH_MISMATCH") return "DEMO_SIZE_MISMATCH";
  if (code.includes("CAPABILITY")) return "DEMO_IMPORT_AUTHORIZATION_REJECTED";
  return "DEMO_IMPORT_REJECTED";
}

async function handleLibraryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  activityGate?: ViewerLibraryActivityGate,
): Promise<boolean> {
  const rawUrl = req.url ?? "/";
  const queryIndex = rawUrl.indexOf("?");
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const hasQuery = queryIndex !== -1;
  const isImport = rawPath === VIEWER_LIBRARY_IMPORT_PATH;
  const isFinalize = rawPath === VIEWER_LIBRARY_FINALIZE_PATH;
  const isDemo = rawPath.startsWith(VIEWER_LIBRARY_DEMO_PREFIX);
  if (!isImport && !isFinalize && !isDemo) return false;

  // The dedicated raw-byte seam is stricter than static Viewer assets.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (activityGate && !activityGate.isReady()) {
    respondJson(res, 503, { code: "RUNTIME_DRAINING" });
    return true;
  }
  const finishActivity = activityGate?.begin(res);
  try {
  if (hasQuery) {
    respond(res, 400, "Query parameters forbidden");
    return true;
  }
  if (req.headers.cookie !== undefined) {
    respond(res, 400, "Cookies forbidden");
    return true;
  }
  const library = currentDesktopReviewLibrary();
  if (!library) {
    respond(res, 503, "Library unavailable");
    return true;
  }

  if (isFinalize) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      respond(res, 405, "Method not allowed");
      return true;
    }
    const demoId = singleHeader(req.headers[VIEWER_LIBRARY_DEMO_ID_HEADER]);
    const outcome = singleHeader(req.headers[VIEWER_LIBRARY_PARSE_OUTCOME_HEADER]);
    if (!opaqueId(demoId) || (outcome !== "READY" && outcome !== "CORRUPT")) {
      respond(res, 400, "Invalid parser validation");
      return true;
    }
    try {
      const demo = await library.finalizeDemoImport({
        authorization: authorization(req),
        demoId,
        valid: outcome === "READY",
      });
      respondJson(res, 200, {
        schemaVersion: "desktop-library-validation.v1",
        demoId: demo.demoId,
        status: demo.status,
      });
    } catch (error) {
      respondJson(res, libraryErrorStatus(error), { code: "DEMO_VALIDATION_REJECTED" });
    }
    return true;
  }

  if (isImport) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      respond(res, 405, "Method not allowed");
      return true;
    }
    if (req.headers["content-encoding"] !== undefined ||
        (req.headers["content-type"] !== undefined && singleHeader(req.headers["content-type"]) !== "application/octet-stream")) {
      respond(res, 415, "Raw Demo body required");
      return true;
    }
    const objectId = singleHeader(req.headers[VIEWER_LIBRARY_IMPORT_ID_HEADER]);
    if (!opaqueId(objectId)) {
      respond(res, 400, "Invalid import id");
      return true;
    }
    try {
      const result = await library.importDemo({ authorization: authorization(req), objectId, stream: req });
      respondJson(res, 201, {
        schemaVersion: "desktop-library-import.v1",
        demoId: result.demo.demoId,
        contentHash: result.demo.contentHash,
        originalFilename: result.demo.originalFilename,
        byteSize: result.demo.byteSize,
        deduplicated: result.deduplicated,
        ...(result.validationCapability
          ? { validationToken: result.validationCapability.authorization.slice("Bearer ".length) }
          : {}),
      });
    } catch (error) {
      respondJson(res, libraryErrorStatus(error), { code: publicImportErrorCode(error) });
    }
    return true;
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    respond(res, 405, "Method not allowed");
    return true;
  }
  let demoId: string;
  try {
    demoId = decodeURIComponent(rawPath.slice(VIEWER_LIBRARY_DEMO_PREFIX.length));
  } catch {
    respond(res, 400, "Invalid Demo id");
    return true;
  }
  if (!opaqueId(demoId)) {
    respond(res, 400, "Invalid Demo id");
    return true;
  }
  try {
    const source = await library.resolveViewerDemo({ authorization: authorization(req), demoId });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", source.byteSize);
    res.once("close", () => source.body.destroy());
    source.body.once("error", () => {
      if (!res.headersSent) respond(res, 500, "Read failed");
      else res.destroy();
    });
    source.body.pipe(res);
  } catch (error) {
    respondJson(res, libraryErrorStatus(error), { code: "DEMO_READ_REJECTED" });
  }
    return true;
  } finally {
    finishActivity?.();
  }
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
  activityGate?: ViewerLibraryActivityGate,
): Promise<RequestListener> {
  const canonicalRoot = await realpath(viewerRoot);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const allowedAppOrigin = appOrigin();
    const allowedViewerHost = viewerHost();
    if (!allowedAppOrigin || !allowedViewerHost) return respond(res, 503, "Not ready");
    if (req.headers.host !== allowedViewerHost) return respond(res, 421, "Host rejected");
    for (const [name, value] of Object.entries(viewerHeaders(allowedAppOrigin))) res.setHeader(name, value);
    if (await handleLibraryRequest(req, res, activityGate)) return;
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
