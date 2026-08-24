import { describe, expect, it } from "vitest";
import {
  createRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchResponse,
  serializeRemoteCoachAgentDispatchEnvelope,
} from "./remote-dispatch";
import { createCoachAgentRuntime } from "./runtime";
import { startCueEvent } from "./test-fixtures";

describe("remote CoachAgent dispatch envelope", () => {
  it("round-trips strict JSON and keeps sessionId bound to the event identity", async () => {
    const event = startCueEvent();
    const envelope = createRemoteCoachAgentDispatchEnvelope(event);
    const decoded = parseRemoteCoachAgentDispatchEnvelope(JSON.parse(serializeRemoteCoachAgentDispatchEnvelope(envelope)));
    expect(decoded.sessionId).toBe(event.identity.sessionId);
    expect(decoded.event).toEqual(event);

    const result = await createCoachAgentRuntime().dispatch(decoded.event);
    expect(parseRemoteCoachAgentDispatchResponse(result)).toEqual(result);
  });

  it("rejects extra fields and session mismatches", () => {
    const event = startCueEvent();
    expect(() => parseRemoteCoachAgentDispatchEnvelope({
      ...createRemoteCoachAgentDispatchEnvelope(event),
      frames: [],
    })).toThrow();
    expect(() => parseRemoteCoachAgentDispatchEnvelope({
      ...createRemoteCoachAgentDispatchEnvelope(event),
      sessionId: "other-session",
    })).toThrow();
  });
});
