import {
  commandEnvelope,
  isPlaybackEventEnvelope,
  type PlaybackCommand,
  type PlaybackEventEnvelope
} from "@cs-coach/contracts";

export const DEFAULT_CS2D_HOST_URL = "http://localhost:5174/?host=1";

export interface Cs2dHostConfig {
  url: string;
  origin: string;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function cs2dHostConfig(
  raw = process.env.NEXT_PUBLIC_CS2D_HOST_URL,
  parentOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN || "http://localhost:3000"
): Cs2dHostConfig {
  const parsed = new URL(raw?.trim() || DEFAULT_CS2D_HOST_URL);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("cs2d host URL must use http or https.");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error("cs2d host must remain on localhost until the upstream license is clarified.");
  }
  const parent = new URL(parentOrigin);
  if (parent.protocol !== "http:" && parent.protocol !== "https:") {
    throw new Error("parent origin must use http or https.");
  }
  parsed.searchParams.set("host", "1");
  parsed.searchParams.set("parentOrigin", parent.origin);
  return { url: parsed.toString(), origin: parsed.origin };
}

export function acceptedPlaybackEvent(input: {
  data: unknown;
  eventOrigin: string;
  expectedOrigin: string;
  sourceMatches: boolean;
}): PlaybackEventEnvelope | undefined {
  if (!input.sourceMatches || input.eventOrigin !== input.expectedOrigin) return undefined;
  return isPlaybackEventEnvelope(input.data) ? input.data : undefined;
}

export function playbackCommandMessage(command: PlaybackCommand) {
  return commandEnvelope(command);
}
