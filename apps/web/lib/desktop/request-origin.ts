export const DESKTOP_APP_ORIGIN_HEADER = "x-cs-agent-app-origin";

function desktopRuntimeEnabled(): boolean {
  return (process.env.DEPLOY_TARGET ?? "").trim().toLowerCase() === "desktop";
}

export function validatedDesktopAppOrigin(raw: string | null | undefined): string | undefined {
  if (!raw || raw.length > 128) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) return undefined;
  const port = Number(parsed.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? parsed.origin : undefined;
}

export function sameOriginRequest(request: Request): boolean {
  let expectedOrigin: string;
  if (desktopRuntimeEnabled()) {
    const trusted = validatedDesktopAppOrigin(request.headers.get(DESKTOP_APP_ORIGIN_HEADER));
    if (!trusted) return false;
    expectedOrigin = trusted;
  } else {
    try {
      expectedOrigin = new URL(request.url).origin;
    } catch {
      return false;
    }
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== expectedOrigin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || !["cross-site", "none"].includes(fetchSite.toLowerCase());
}
