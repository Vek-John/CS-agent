export const DESKTOP_VIEWER_ORIGIN_HEADER = "x-cs-agent-viewer-origin";

export function validatedDesktopViewerOrigin(raw: string | null | undefined): string | undefined {
  if (!raw || raw.length > 128) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:"
    || parsed.hostname !== "localhost"
    || !parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) {
    return undefined;
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return parsed.origin;
}

export function desktopViewerOriginFromHeaders(headers: Pick<Headers, "get">): string | undefined {
  return validatedDesktopViewerOrigin(headers.get(DESKTOP_VIEWER_ORIGIN_HEADER));
}

export function isDesktopRuntimeRequest(headers: Pick<Headers, "get">): boolean {
  return desktopViewerOriginFromHeaders(headers) !== undefined;
}
