import type { CoachAgentIdentity } from "./types";

function fnv1a(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

export function identityFingerprint(identity: CoachAgentIdentity): string {
  return fnv1a(
    [
      identity.runId,
      identity.sessionId,
      identity.demoContentHash,
      identity.selectedPlayerId,
      identity.routeHash,
    ].join("\u001f"),
  );
}

/** Hashes the actual compact node input, not just run identity. */
export function stableInputHash(value: unknown): string {
  return fnv1a(stableSerialize(value));
}

export function checkpointThreadIdForSession(sessionId: string): string {
  // A session is the stable checkpoint owner. The checkpoint payload still
  // validates every run/content/player/route field before any resume.
  return `coach-agent-v1-session-${fnv1a(sessionId)}`;
}

export function threadIdForIdentity(identity: CoachAgentIdentity): string {
  return checkpointThreadIdForSession(identity.sessionId);
}

export function playbackCallId(
  identity: CoachAgentIdentity,
  cueId: string,
  capabilityId: string,
  graphStep = "tool-1",
): string {
  return `playback-${fnv1a(
    [identity.runId, cueId, graphStep, capabilityId].join("\u001f"),
  )}`;
}

export function moveId(
  identity: CoachAgentIdentity,
  cueId: string,
  capabilityId: string,
  graphStep = "tool-1",
): string {
  return `move-${fnv1a(
    [identity.runId, cueId, graphStep, capabilityId].join("\u001f"),
  )}`;
}
