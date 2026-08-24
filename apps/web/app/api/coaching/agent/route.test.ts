import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";
import {
  createRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchResponse,
} from "@cs-coach/coach-agent";
import { fixtureIdentity, resumeEvent, startCueEvent } from "../../../../../../libs/coach-agent/src/test-fixtures";

function post(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Request {
  return new Request("http://localhost/api/coaching/agent", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("local Coach Agent route", () => {
  it("keeps a process-local Memory backend and resumes idempotently", async () => {
    const identity = { ...fixtureIdentity, sessionId: "local-route-session" };
    const startEvent = startCueEvent({ identity, eventId: "local-start" });
    const envelope = createRemoteCoachAgentDispatchEnvelope(startEvent);
    const started = parseRemoteCoachAgentDispatchResponse(await (await POST(post(envelope))).json());
    expect(started).toMatchObject({
      status: "WAITING_TOOL",
      checkpoint: { backend: "MEMORY", recoverableAfterRefresh: false },
    });
    expect(started.effects).toHaveLength(1);

    const resumeEnvelope = createRemoteCoachAgentDispatchEnvelope(
      resumeEvent(started.effects[0], { identity, eventId: "local-resume" }),
    );
    const completed = parseRemoteCoachAgentDispatchResponse(await (await POST(post(resumeEnvelope))).json());
    expect(completed).toMatchObject({
      status: "COMPLETED",
      checkpoint: { backend: "MEMORY", recoverableAfterRefresh: false },
    });
    expect(completed.effects).toEqual([]);
    const duplicate = parseRemoteCoachAgentDispatchResponse(await (await POST(post(resumeEnvelope))).json());
    expect(duplicate.effects).toEqual([]);
  });

  it("returns deterministic 4xx responses for method, media, JSON and envelope violations", async () => {
    expect(GET().status).toBe(405);
    expect((await POST(post("{}", { "content-type": "text/plain" }))).status).toBe(415);
    expect((await POST(post("not-json"))).status).toBe(400);
    const event = startCueEvent({ identity: { ...fixtureIdentity, sessionId: "local-invalid-session" } });
    const envelope = createRemoteCoachAgentDispatchEnvelope(event);
    expect((await POST(post({ ...envelope, frames: [] }))).status).toBe(400);
    expect((await POST(post({ ...envelope, sessionId: "other-session" }))).status).toBe(400);
  });
});
