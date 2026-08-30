import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export const IPV4_LOOPBACK = "127.0.0.1" as const;
export const APP_BROWSER_HOST = "127.0.0.1" as const;
export const VIEWER_BROWSER_HOST = "localhost" as const;

export interface DesktopOriginPair {
  readonly appOrigin: `http://${typeof APP_BROWSER_HOST}:${number}`;
  readonly viewerOrigin: `http://${typeof VIEWER_BROWSER_HOST}:${number}`;
  readonly appHost: `${typeof APP_BROWSER_HOST}:${number}`;
  readonly viewerHost: `${typeof VIEWER_BROWSER_HOST}:${number}`;
}

export class DesktopOriginBindError extends Error {
  constructor(readonly stage: "APP" | "VIEWER" | "PAIR") {
    super(`DESKTOP_ORIGIN_${stage}_INVALID`);
  }
}

function listenIPv4(server: Server, stage: "APP" | "VIEWER"): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new DesktopOriginBindError(stage));
    server.once("error", onError);
    try {
      server.listen(0, IPV4_LOOPBACK, () => {
        server.removeListener("error", onError);
        resolve();
      });
    } catch {
      server.removeListener("error", onError);
      reject(new DesktopOriginBindError(stage));
    }
  });
}

async function closeBoundServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function boundPort(server: Server, stage: "APP" | "VIEWER"): number {
  const address = server.address() as AddressInfo | null;
  if (!address
    || address.family !== "IPv4"
    || address.address !== IPV4_LOOPBACK
    || !Number.isInteger(address.port)
    || address.port < 1
    || address.port > 65535) {
    throw new DesktopOriginBindError(stage);
  }
  return address.port;
}

/**
 * Binds both HTTP surfaces to literal IPv4 while assigning cookie-isolated
 * browser authorities. Callers receive one immutable pair and never derive an
 * origin from an untrusted request Host header.
 */
export async function bindDesktopOriginPair(
  appServer: Server,
  viewerServer: Server,
): Promise<DesktopOriginPair> {
  try {
    await listenIPv4(viewerServer, "VIEWER");
    await listenIPv4(appServer, "APP");
    const appPort = boundPort(appServer, "APP");
    const viewerPort = boundPort(viewerServer, "VIEWER");
    if (appPort === viewerPort) throw new DesktopOriginBindError("PAIR");
    return Object.freeze({
      appOrigin: `http://${APP_BROWSER_HOST}:${appPort}`,
      viewerOrigin: `http://${VIEWER_BROWSER_HOST}:${viewerPort}`,
      appHost: `${APP_BROWSER_HOST}:${appPort}`,
      viewerHost: `${VIEWER_BROWSER_HOST}:${viewerPort}`,
    });
  } catch (error) {
    await Promise.all([closeBoundServer(appServer), closeBoundServer(viewerServer)]);
    if (error instanceof DesktopOriginBindError) throw error;
    throw new DesktopOriginBindError("PAIR");
  }
}
