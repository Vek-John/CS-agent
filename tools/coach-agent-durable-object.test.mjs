import { afterEach, describe, expect, it, vi } from "vitest";
import { CoachAgentDurableObject } from "./coach-agent-durable-object.mjs";
import { createRemoteCoachAgentDispatchEnvelope } from "../libs/coach-agent/src/index.ts";
import {
  fixtureIdentity,
  mapFocusCapability,
  resumeEvent,
  slowReplayCapability,
  startCueEvent,
} from "../libs/coach-agent/src/test-fixtures.ts";

class FakeStorage {
  values = new Map();

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    return this.values.delete(key);
  }

  async list(options = {}) {
    const prefix = options.prefix ?? "";
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)));
  }
}

function request(envelope, headers = { "content-type": "application/json" }, url = "https://agent.test/api/coaching/agent") {
  return new Request(url, {
    method: "POST",
    headers,
    body: typeof envelope === "string" ? envelope : JSON.stringify(envelope),
  });
}

function policyResponse(output) {
  return new Response(JSON.stringify({
    status: "SUCCEEDED",
    output,
    manifest: {
      status: "SUCCEEDED",
      provider: "DEEPSEEK",
      model: "deepseek-v4-flash",
      limitations: [],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CoachAgentDurableObject HTTP seam", () => {
  it("persists START/RESUME across a new DO instance and deduplicates resume", async () => {
    const storage = new FakeStorage();
    const state = { storage };
    const identity = { ...fixtureIdentity, sessionId: "do-http-session" };
    const startEnvelope = createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "do-http-start" }));
    const first = new CoachAgentDurableObject(state);
    const startedResponse = await first.fetch(request(startEnvelope));
    expect(startedResponse.status).toBe(200);
    const started = await startedResponse.json();
    expect(started).toMatchObject({ status: "WAITING_TOOL", checkpoint: { backend: "DURABLE_OBJECT", recoverableAfterRefresh: true } });
    expect(started.effects).toHaveLength(1);

    const second = new CoachAgentDurableObject(state);
    const resumeEnvelope = createRemoteCoachAgentDispatchEnvelope(resumeEvent(started.effects[0], { identity, eventId: "do-http-resume" }));
    const completedResponse = await second.fetch(request(resumeEnvelope));
    const completed = await completedResponse.json();
    expect(completedResponse.status).toBe(200);
    expect(completed).toMatchObject({ status: "COMPLETED", checkpoint: { backend: "DURABLE_OBJECT", recoverableAfterRefresh: true } });
    expect(completed.effects).toEqual([]);

    const duplicate = await (await second.fetch(request(resumeEnvelope))).json();
    expect(duplicate.effects).toEqual([]);
  });

  it("runs the v2 HTTP START/interrupt/resume/duplicate path and keeps completed DO state compact", async () => {
    const storage = new FakeStorage();
    const identity = { ...fixtureIdentity, sessionId: "do-v2-completion-smoke" };
    const startEvent = { ...startCueEvent({ identity, eventId: "do-v2-start" }), version: "coach-agent-event.v2" };
    const startEnvelope = createRemoteCoachAgentDispatchEnvelope(startEvent);
    const first = new CoachAgentDurableObject({ storage });
    const startedResponse = await first.fetch(request(startEnvelope));
    const started = await startedResponse.json();
    expect(startedResponse.status).toBe(200);
    expect(started).toMatchObject({ status: "WAITING_TOOL", checkpoint: { backend: "DURABLE_OBJECT", recoverableAfterRefresh: true } });

    const resumeEventV2 = { ...resumeEvent(started.effects[0], { identity, eventId: "do-v2-resume" }), version: "coach-agent-event.v2" };
    const second = new CoachAgentDurableObject({ storage });
    const resumed = await (await second.fetch(request(createRemoteCoachAgentDispatchEnvelope(resumeEventV2)))).json();
    const duplicateResume = await (await second.fetch(request(createRemoteCoachAgentDispatchEnvelope(resumeEventV2)))).json();
    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.effects).toEqual([]);
    expect(duplicateResume.effects).toEqual([]);

    const completion = {
      version: "coach-agent-event.v2",
      type: "COMPLETE_SESSION",
      eventId: "do-v2-complete",
      identity,
    };
    const completed = await (await second.fetch(request(createRemoteCoachAgentDispatchEnvelope(completion)))).json();
    expect(completed.status).toBe("COMPLETED");
    expect(completed.state.sessionStatus).toBe("COMPLETED");
    expect(completed.state.sessionSummaryInput).toBeTruthy();

    const restored = await (await new CoachAgentDurableObject({ storage }).fetch(
      request(createRemoteCoachAgentDispatchEnvelope({ ...completion, eventId: "do-v2-complete-duplicate" })),
    )).json();
    expect(restored.status).toBe("COMPLETED");
    expect(restored.state.completedCueIds).toEqual(completed.state.completedCueIds);
    expect([...storage.values.keys()].filter((key) => key.startsWith("coach-agent:checkpoint:")).length).toBeLessThanOrEqual(3);
  });

  it("rejects method, media type and strict envelope violations", async () => {
    const durableObject = new CoachAgentDurableObject({ storage: new FakeStorage() });
    expect((await durableObject.fetch(new Request("https://agent.test/api/coaching/agent"))).status).toBe(405);
    expect((await durableObject.fetch(request("{}", { "content-type": "text/plain" }))).status).toBe(415);
    const envelope = createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity: { ...fixtureIdentity, sessionId: "do-invalid" } }));
    expect((await durableObject.fetch(request({ ...envelope, frames: [] }))).status).toBe(400);
    expect((await durableObject.fetch(request({ ...envelope, sessionId: "other" }))).status).toBe(400);
  });

  it("uses the same-origin Policy route for multiple capabilities and binds that origin", async () => {
    const fetcher = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://agent.test/api/coaching/policy");
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body));
      expect(body.capabilities[0]).not.toHaveProperty("boundArgs");
      expect(body).not.toHaveProperty("identity");
      return policyResponse({
        action: "SELECT_CAPABILITY",
        capabilityId: "cap-cue17-map-focus",
        evidenceRefs: ["annotation-a1"],
        rationaleCode: "POSITION_NEEDS_MAP_FOCUS",
        confidence: 0.91,
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const storage = new FakeStorage();
    const durableObject = new CoachAgentDurableObject({ storage });
    const identity = { ...fixtureIdentity, sessionId: "do-policy-session" };
    const event = startCueEvent({
      identity,
      capabilities: [slowReplayCapability, mapFocusCapability],
    });
    const started = await (await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(event)))).json();

    expect(started.status).toBe("WAITING_TOOL");
    expect(started.state.selectedTeachingMove).toMatchObject({
      capabilityId: "cap-cue17-map-focus",
      source: "MODEL",
    });
    expect(started.effects).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const otherOriginIdentity = { ...fixtureIdentity, sessionId: "do-other-origin" };
    const otherOriginEvent = startCueEvent({
      identity: otherOriginIdentity,
      capabilities: [slowReplayCapability, mapFocusCapability],
      eventId: "do-other-origin-start",
    });
    const otherOrigin = await (await durableObject.fetch(
      request(createRemoteCoachAgentDispatchEnvelope(otherOriginEvent), undefined, "https://other.test/api/coaching/agent"),
    )).json();
    expect(otherOrigin.status).toBe("WAITING_TOOL");
    expect(otherOrigin.effects).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("short-circuits the Policy route for zero or one capability", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const durableObject = new CoachAgentDurableObject({ storage: new FakeStorage() });

    const noCapability = startCueEvent({
      identity: { ...fixtureIdentity, sessionId: "do-no-capability" },
      capabilities: [],
      eventId: "do-no-capability-start",
    });
    const oneCapability = startCueEvent({
      identity: { ...fixtureIdentity, sessionId: "do-one-capability" },
      capabilities: [slowReplayCapability],
      eventId: "do-one-capability-start",
    });
    const noCapabilityResult = await (await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(noCapability)))).json();
    const oneCapabilityResult = await (await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(oneCapability)))).json();

    expect(noCapabilityResult.status).toBe("COMPLETED");
    expect(oneCapabilityResult.status).toBe("WAITING_TOOL");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a legal provider FINISH response inside the graph", async () => {
    const fetcher = vi.fn(async () => policyResponse({
      action: "FINISH_CUE",
      evidenceRefs: [],
      rationaleCode: "NO_EXTRA_VISUAL_VALUE",
      confidence: 0.9,
    }));
    vi.stubGlobal("fetch", fetcher);
    const durableObject = new CoachAgentDurableObject({ storage: new FakeStorage() });
    const event = startCueEvent({
      identity: { ...fixtureIdentity, sessionId: "do-policy-finish" },
      capabilities: [slowReplayCapability, mapFocusCapability],
      eventId: "do-policy-finish-start",
    });
    const result = await (await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(event)))).json();

    expect(result.status).toBe("COMPLETED");
    expect(result.effects).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["http-4xx", async () => new Response("", { status: 429 })],
    ["http-5xx", async () => new Response("", { status: 503 })],
    ["invalid-json", async () => new Response("{", { status: 200 })],
    ["timeout", async () => { throw new DOMException("timed out", "AbortError"); }],
  ])("maps Policy route %s to a deterministic legal move without breaking dispatch", async (_label, responseFor) => {
    const fetcher = vi.fn(responseFor);
    vi.stubGlobal("fetch", fetcher);
    const durableObject = new CoachAgentDurableObject({ storage: new FakeStorage() });
    const event = startCueEvent({
      identity: { ...fixtureIdentity, sessionId: `do-policy-${String(_label)}` },
      capabilities: [slowReplayCapability, mapFocusCapability],
      eventId: `do-policy-${String(_label)}-start`,
    });
    const result = await (await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(event)))).json();

    expect(result.status).toBe("WAITING_TOOL");
    expect(result.effects).toHaveLength(1);
    expect(result.state.selectedTeachingMove?.capabilityId).toBe(mapFocusCapability.capabilityId);
    expect(result.state.selectedTeachingMove?.source).toBe("FALLBACK");
    expect(result.state.fallbackReasons).toContain("POLICY_FAILED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
