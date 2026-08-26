import {
  assertJsonSerializable,
  CoachAgentEventSchema,
  CoachAgentResultSchema,
  type CoachAgentEvent,
  type CoachAgentResult,
} from "./types";
import { z } from "zod";

const RemoteDispatchSessionId = z.string().min(1).max(160);
export const MAX_REMOTE_COACH_AGENT_DISPATCH_BYTES = 64 * 1024;

function serializedByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("coach-agent remote envelope is not JSON serializable");
  return new TextEncoder().encode(encoded).byteLength;
}

export const RemoteCoachAgentDispatchEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("coach-agent-remote-dispatch.v1"),
    sessionId: RemoteDispatchSessionId,
    event: CoachAgentEventSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.sessionId !== envelope.event.identity.sessionId) {
      context.addIssue({ code: "custom", message: "sessionId must match event.identity.sessionId" });
    }
    if (serializedByteLength(envelope) > MAX_REMOTE_COACH_AGENT_DISPATCH_BYTES) {
      context.addIssue({ code: "custom", message: "remote CoachAgent dispatch exceeds the 64KiB envelope bound." });
    }
  });
export type RemoteCoachAgentDispatchEnvelope = z.infer<typeof RemoteCoachAgentDispatchEnvelopeSchema>;

export type RemoteCoachAgentDispatchResponse = CoachAgentResult;

export function createRemoteCoachAgentDispatchEnvelope(
  event: CoachAgentEvent,
): RemoteCoachAgentDispatchEnvelope {
  return RemoteCoachAgentDispatchEnvelopeSchema.parse({
    schemaVersion: "coach-agent-remote-dispatch.v1",
    sessionId: event.identity.sessionId,
    event,
  });
}

export function parseRemoteCoachAgentDispatchEnvelope(
  value: unknown,
): RemoteCoachAgentDispatchEnvelope {
  return RemoteCoachAgentDispatchEnvelopeSchema.parse(value);
}

export function serializeRemoteCoachAgentDispatchEnvelope(
  envelope: RemoteCoachAgentDispatchEnvelope,
): string {
  const parsed = RemoteCoachAgentDispatchEnvelopeSchema.parse(envelope);
  const serialized = JSON.stringify(assertJsonSerializable(parsed));
  if (new TextEncoder().encode(serialized).byteLength > MAX_REMOTE_COACH_AGENT_DISPATCH_BYTES) {
    throw new Error("remote CoachAgent dispatch exceeds the 64KiB envelope bound.");
  }
  return serialized;
}

export function parseRemoteCoachAgentDispatchResponse(value: unknown): RemoteCoachAgentDispatchResponse {
  return CoachAgentResultSchema.parse(value) as RemoteCoachAgentDispatchResponse;
}
