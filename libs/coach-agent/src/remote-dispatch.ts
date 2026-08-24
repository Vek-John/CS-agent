import {
  assertJsonSerializable,
  CoachAgentEventSchema,
  CoachAgentResultSchema,
  type CoachAgentEvent,
  type CoachAgentResult,
} from "./types";
import { z } from "zod";

const RemoteDispatchSessionId = z.string().min(1).max(160);

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
  return JSON.stringify(assertJsonSerializable(RemoteCoachAgentDispatchEnvelopeSchema.parse(envelope)));
}

export function parseRemoteCoachAgentDispatchResponse(value: unknown): RemoteCoachAgentDispatchResponse {
  return CoachAgentResultSchema.parse(value) as RemoteCoachAgentDispatchResponse;
}
