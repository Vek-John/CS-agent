import { afterEach, describe, expect, it, vi } from "vitest";
import { CoachAgentDurableObject } from "./coach-agent-durable-object.mjs";
import { createRemoteCoachAgentDispatchEnvelope, CoachAgentEventSchema, ObserveSegmentEventSchema } from "../libs/coach-agent/src/index.ts";
import {
  fixtureIdentity,
  mapFocusCapability,
  resumeEvent,
  slowReplayCapability,
  startCueEvent,
} from "../libs/coach-agent/src/test-fixtures.ts";
import { InMemoryMemoryRepository, MemoryService } from "../libs/memory/src/index.ts";
import { hmacSha256Base64Url, verifyHmacSha256Base64Url } from "../apps/web/lib/memory/principal.ts";

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

function reflectionEvent(identity, eventId = "memory-reflection", type = "SUBMIT_REFLECTION", rawText = "我当时想拿信息") {
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type,
    eventId,
    identity,
    cueId: "cue-memory",
    outcomeGateStatus: "COMPLETE",
    input: {
      cueId: "cue-memory",
      cue: { id: "cue-memory", primary_focus_code: "POSITIONING", limitations: [] },
      // This is a memory/DO seam fixture, not parsed replay data. Keep the
      // fact arrays empty so synthetic numbers cannot be mistaken for Demo
      // ticks. Parser integration owns canonical timing fixtures.
      decisionFacts: [],
      playerActionFacts: [],
      outcomeFacts: [],
      focusCode: "POSITIONING",
      limitations: [],
    },
    reflection: {
      cueId: "cue-memory",
      rawText,
      selectedGoal: "GET_INFO",
      response: "ANSWERED",
      source: "USER",
      limitations: [],
    },
  });
}

function memoryHeaders(principal = "principal-memory", consent = "granted") {
  return {
    "content-type": "application/json",
    "x-cs-trusted-principal": principal,
    "x-cs-memory-consent": consent,
  };
}

function memoryBrief(limitation) {
  return {
    schemaVersion: "memory-brief.v1",
    generatedAt: "2026-08-28T00:00:00.000Z",
    activeThreads: [],
    memories: [],
    corrections: [],
    limitations: limitation ? [limitation] : [],
    source: "EMPTY",
    structuredStatus: "EMPTY",
    semanticStatus: "OPTIONAL",
  };
}

function request(envelope, headers = { "content-type": "application/json" }, url = "https://agent.test/api/coaching/agent") {
  return new Request(url, {
    method: "POST",
    headers,
    body: typeof envelope === "string" ? envelope : JSON.stringify(envelope),
  });
}

async function primeCompletedCue(durableObject, identity, principal = "principal-memory") {
  const response = await durableObject.fetch(request(
    createRemoteCoachAgentDispatchEnvelope(startCueEvent({
      identity,
      cueId: "cue-memory",
      eventId: `memory-prime-${identity.sessionId}`,
      capabilities: [],
    })),
    memoryHeaders(principal),
  ));
  expect(response.status).toBe(200);
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

  it("keeps memory side effects behind the flag and trusted consent gates", async () => {
    const sink = vi.fn(async () => undefined);
    const identity = { ...fixtureIdentity, sessionId: "do-memory-gates" };
    const event = reflectionEvent(identity, "memory-gate-off");

    const disabledStorage = new FakeStorage();
    const disabled = new CoachAgentDurableObject(
      { storage: disabledStorage },
      { MEMORY_ENABLED: "false", MEMORY_SINK: sink },
    );
    expect((await disabled.fetch(request(createRemoteCoachAgentDispatchEnvelope(event), memoryHeaders()))).status).toBe(200);
    await Promise.resolve();
    expect([...disabledStorage.values.keys()].filter((key) => key.startsWith("coach-agent:memory-outbox:")).length).toBe(0);
    expect([...disabledStorage.values.keys()].some((key) => key.includes("memory-brief-refresh"))).toBe(false);

    const noConsentStorage = new FakeStorage();
    const noConsent = new CoachAgentDurableObject(
      { storage: noConsentStorage },
      { MEMORY_ENABLED: "true", MEMORY_SINK: sink },
    );
    expect((await noConsent.fetch(request(createRemoteCoachAgentDispatchEnvelope({ ...event, eventId: "memory-gate-no-consent" }), memoryHeaders("principal-no-consent", "revoked")))).status).toBe(200);
    expect([...noConsentStorage.values.keys()].filter((key) => key.startsWith("coach-agent:memory-outbox:")).length).toBe(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it("allows a persisted grant to recover when the feature flag is toggled off and on", async () => {
    const storage = new FakeStorage();
    const env = { MEMORY_ENABLED: "true", MEMORY_SINK: vi.fn() };
    const durableObject = new CoachAgentDurableObject({ storage }, env);
    const identity = { ...fixtureIdentity, sessionId: "do-memory-flag-toggle" };
    const first = await durableObject.authorizeMemory(request(
      createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "flag-toggle-first" })),
      memoryHeaders("flag-toggle-principal", "granted"),
    ));
    expect(first.enabled).toBe(true);

    env.MEMORY_ENABLED = "false";
    const disabled = await durableObject.authorizeMemory(request(
      createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "flag-toggle-off" })),
      memoryHeaders("flag-toggle-principal", "granted"),
    ));
    expect(disabled.enabled).toBe(false);

    env.MEMORY_ENABLED = "true";
    const recovered = await durableObject.authorizeMemory(request(
      createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "flag-toggle-recover" })),
      memoryHeaders("flag-toggle-principal", "granted"),
    ));
    expect(recovered.enabled).toBe(true);
  });

  it("enqueues verified reflection and user correction without changing user claims into Demo facts", async () => {
    const storage = new FakeStorage();
    const delivered = [];
    const waits = [];
    const sink = vi.fn(async (value) => { delivered.push(value); });
    const identity = { ...fixtureIdentity, sessionId: "do-memory-diagnosis" };
    const durableObject = new CoachAgentDurableObject(
      { storage, waitUntil: (promise) => waits.push(promise) },
      { MEMORY_ENABLED: "true", MEMORY_SINK: sink },
    );

    const reflection = reflectionEvent(identity, "memory-reflection");
    await primeCompletedCue(durableObject, identity);
    const first = await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(reflection), memoryHeaders()));
    expect(first.status).toBe(200);
    await Promise.all(waits.splice(0));
    const reflectionEntry = delivered[0];
    expect(reflectionEntry.type).toBe("CUE_DIAGNOSED");
    expect(reflectionEntry.payload.claims[0].source).toBe("USER");
    expect(reflectionEntry.payload).not.toHaveProperty("decisionFacts");
    expect(delivered).toHaveLength(1);

    const disagreement = reflectionEvent(identity, "memory-disagreement", "SUBMIT_DISAGREEMENT", "我当时确实听到了队友报点");
    const second = await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(disagreement), memoryHeaders()));
    expect(second.status).toBe(200);
    await Promise.all(waits.splice(0));
    const correctionEntry = delivered[1];
    expect(correctionEntry).toBeTruthy();
    expect(correctionEntry.type).toBe("USER_CORRECTED_COACH");
    expect(correctionEntry.payload.operation).toBe("CORRECT");
    expect(correctionEntry.payload.correction).toMatchObject({ source: "USER" });
    expect(delivered.map((value) => value.type)).toEqual(["CUE_DIAGNOSED", "USER_CORRECTED_COACH"]);
  });

  it("enqueues only completion metadata after a completed Agent session", async () => {
    const storage = new FakeStorage();
    const delivered = [];
    const waits = [];
    const sink = vi.fn(async (value) => { delivered.push(value); });
    const identity = { ...fixtureIdentity, sessionId: "do-memory-complete" };
    const state = { storage, waitUntil: (promise) => waits.push(promise) };
    const durableObject = new CoachAgentDurableObject(state, { MEMORY_ENABLED: "true", MEMORY_SINK: sink });
    const start = startCueEvent({ identity, eventId: "memory-complete-start" });
    const started = await (await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(start), memoryHeaders()))).json();
    await Promise.all(waits.splice(0));
    const resumed = resumeEvent(started.effects[0], { identity, eventId: "memory-complete-resume" });
    await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(resumed), memoryHeaders()));
    await Promise.all(waits.splice(0));
    const complete = {
      version: "coach-agent-event.v2",
      type: "COMPLETE_SESSION",
      eventId: "memory-complete-finish",
      identity,
    };
    expect((await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(complete), memoryHeaders()))).status).toBe(200);
    await Promise.all(waits.splice(0));
    const completion = delivered.find((value) => value.type === "SESSION_COMPLETED");
    expect(completion).toBeTruthy();
    expect(completion.payload).toEqual({ reason: "SESSION_COMPLETED" });
    expect(completion.payload).not.toHaveProperty("completedCueIds");
  });

  it("rejects a different trusted principal while preserving owner isolation", async () => {
    const storage = new FakeStorage();
    const identity = { ...fixtureIdentity, sessionId: "do-memory-owner" };
    const durableObject = new CoachAgentDurableObject({ storage }, { MEMORY_ENABLED: "true", MEMORY_SINK: vi.fn() });
    const event = startCueEvent({ identity, eventId: "memory-owner-start" });
    expect((await durableObject.fetch(request(createRemoteCoachAgentDispatchEnvelope(event), memoryHeaders("principal-a")))).status).toBe(200);
    const mismatch = await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope({ ...event, eventId: "memory-owner-mismatch" }),
      memoryHeaders("principal-b"),
    ));
    expect(mismatch.status).toBe(403);
    expect((await mismatch.json()).reason).toBe("TRUSTED_PRINCIPAL_MISMATCH");
  });

  it("injects a bounded brief when available and uses empty brief on provider failure", async () => {
    const identity = { ...fixtureIdentity, sessionId: "do-memory-brief" };
    const first = new CoachAgentDurableObject(
      { storage: new FakeStorage() },
      { MEMORY_ENABLED: "true", MEMORY_BRIEF: memoryBrief(), MEMORY_SINK: vi.fn() },
    );
    const result = await (await first.fetch(request(createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "memory-brief-start" })), memoryHeaders()))).json();
    expect(result.state.memoryBrief.source).toBe("EMPTY");

    const waits = [];
    const failingProvider = new CoachAgentDurableObject(
      { storage: new FakeStorage(), waitUntil: (promise) => waits.push(promise) },
      { MEMORY_ENABLED: "true", MEMORY_BRIEF_PROVIDER: async () => ({ nope: true }), MEMORY_SINK: vi.fn() },
    );
    const fallback = await (await failingProvider.fetch(request(createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity: { ...identity, sessionId: "do-memory-brief-failed" }, eventId: "memory-brief-failed" })), memoryHeaders()))).json();
    expect(fallback.state.memoryBrief.source).toBe("EMPTY");
    expect(fallback.state.memoryBrief.limitations.join(" ")).toContain("Memory");
    await Promise.all(waits);
  });

  it("loads a server brief before START_CUE and ignores a client-supplied brief", async () => {
    const identity = { ...fixtureIdentity, sessionId: "do-memory-brief-provider" };
    const provider = vi.fn(async () => memoryBrief("来自服务端 provider"));
    const durableObject = new CoachAgentDurableObject(
      { storage: new FakeStorage() },
      { MEMORY_ENABLED: "true", MEMORY_BRIEF_PROVIDER: provider, MEMORY_SINK: vi.fn() },
    );
    const clientBrief = memoryBrief("来自不可信浏览器");
    const event = { ...startCueEvent({ identity, eventId: "memory-brief-provider-start" }), memoryBrief: clientBrief };
    const result = await (await durableObject.fetch(
      request(createRemoteCoachAgentDispatchEnvelope(event), memoryHeaders()),
    )).json();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result.state.memoryBrief.limitations).toEqual(["来自服务端 provider"]);
    expect(result.state.memoryBrief.limitations).not.toContain("来自不可信浏览器");
  });

  it("does not let a later client brief replace the cached server brief", async () => {
    const identity = { ...fixtureIdentity, sessionId: "do-memory-brief-cache" };
    const provider = vi.fn(async () => memoryBrief("可信 brief"));
    const storage = new FakeStorage();
    const durableObject = new CoachAgentDurableObject(
      { storage },
      { MEMORY_ENABLED: "true", MEMORY_BRIEF_PROVIDER: provider, MEMORY_SINK: vi.fn() },
    );
    const first = await (await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "brief-cache-first" })),
      memoryHeaders(),
    ))).json();
    expect(first.state.memoryBrief.limitations).toEqual(["可信 brief"]);
    const second = await (await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(startCueEvent({
        identity,
        eventId: "brief-cache-second",
        memoryBrief: memoryBrief("不可信 later brief"),
      })),
      memoryHeaders(),
    ))).json();
    expect(second.state.memoryBrief.limitations).toEqual(["可信 brief"]);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("does not re-inject a configured brief after aggregate invalidation", async () => {
    const identity = { ...fixtureIdentity, sessionId: "do-memory-brief-invalidation" };
    const storage = new FakeStorage();
    const durableObject = new CoachAgentDurableObject(
      { storage },
      { MEMORY_ENABLED: "true", MEMORY_BRIEF: memoryBrief("STALE_CONFIGURED_BRIEF"), MEMORY_SINK: vi.fn() },
    );
    const first = await (await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "brief-invalidation-first" })),
      memoryHeaders("brief-invalidation-principal"),
    ))).json();
    expect(first.state.memoryBrief.limitations).toContain("STALE_CONFIGURED_BRIEF");

    const invalidated = await durableObject.invalidateMemoryEndpoint(new Request(
      "https://agent.test/api/coaching/agent/memory-invalidate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cs-memory-internal": "1",
          "x-cs-trusted-principal": "brief-invalidation-principal",
          "x-memory-test-principal": "brief-invalidation-principal",
        },
        body: JSON.stringify({ memoryId: "memory-stale" }),
      },
    ));
    expect(invalidated.status).toBe(200);
    const second = await (await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "brief-invalidation-second" })),
      memoryHeaders("brief-invalidation-principal"),
    ))).json();
    expect(second.state.memoryBrief?.limitations ?? []).not.toContain("STALE_CONFIGURED_BRIEF");
  });

  it("does not recall a cached brief after the live consent authority revokes", async () => {
    let consent = true;
    const identity = { ...fixtureIdentity, sessionId: "do-memory-live-revoke" };
    const durableObject = new CoachAgentDurableObject(
      { storage: new FakeStorage() },
      {
        MEMORY_ENABLED: "true",
        MEMORY_BRIEF_PROVIDER: async () => memoryBrief("STALE_PROVIDER_MARKER"),
        MEMORY_CONSENT_PROVIDER: async () => consent,
        MEMORY_SINK: vi.fn(),
      },
    );
    const first = await (await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "live-revoke-first" })),
      memoryHeaders("principal-live-revoke", "granted"),
    ))).json();
    expect(first.state.memoryBrief.limitations).toContain("STALE_PROVIDER_MARKER");
    consent = false;
    const revoked = await (await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "live-revoke-second" })),
      memoryHeaders("principal-live-revoke", "granted"),
    ))).json();
    expect(revoked.state.memoryBrief?.limitations ?? []).not.toContain("STALE_PROVIDER_MARKER");
    const observedEvent = ObserveSegmentEventSchema.parse({
      version: "coach-agent-event.v2",
      type: "OBSERVE_SEGMENT",
      eventId: "live-revoke-observe",
      identity,
      segmentId: "segment-1",
      segmentIndex: 0,
      mode: "OBSERVE",
      currentSessionPhase: "PAUSED_FOR_COACHING",
    });
    const observed = await (await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(observedEvent),
      memoryHeaders("principal-live-revoke", "granted"),
    ))).json();
    expect(JSON.stringify(observed)).not.toContain("STALE_PROVIDER_MARKER");
  });

  it("runs a cross-Demo cue → outbox → MemoryService → next-session brief flow", async () => {
    const principal = "e2e-memory-principal";
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId: principal, memoryEnabled: true, consent: "GRANTED" },
    });
    const sink = vi.fn(async (event) => service.ingestEvent(event.userId, event));

    for (const [suffix, demoContentHash] of [["one", "demo-e2e-a"], ["two", "demo-e2e-b"]]) {
      const waits = [];
      const identity = {
        ...fixtureIdentity,
        sessionId: `e2e-session-${suffix}`,
        demoContentHash,
      };
      const durableObject = new CoachAgentDurableObject(
        { storage: new FakeStorage(), waitUntil: (promise) => waits.push(promise) },
        { MEMORY_ENABLED: "true", MEMORY_SINK: sink },
      );
      const event = reflectionEvent(identity, `e2e-reflection-${suffix}`);
      await primeCompletedCue(durableObject, identity, principal);
      const response = await durableObject.fetch(
        request(createRemoteCoachAgentDispatchEnvelope(event), memoryHeaders(principal)),
      );
      expect(response.status).toBe(200);
      await Promise.all(waits);
    }

    expect(sink).toHaveBeenCalledTimes(2);
    const stored = await repository.listMemories(principal, { includeDeleted: false });
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("EMERGING");
    expect(stored[0].demoContentHashes).toEqual(["demo-e2e-a", "demo-e2e-b"]);

    const brief = await service.getBrief(principal);
    expect(brief.activeThreads).toHaveLength(1);
    expect(brief.memories[0]?.status).toBe("EMERGING");

    const nextSession = new CoachAgentDurableObject(
      { storage: new FakeStorage() },
      { MEMORY_ENABLED: "true", MEMORY_BRIEF_PROVIDER: async () => brief, MEMORY_SINK: vi.fn() },
    );
    const next = await (await nextSession.fetch(
      request(createRemoteCoachAgentDispatchEnvelope(startCueEvent({
        identity: { ...fixtureIdentity, sessionId: "e2e-session-three", demoContentHash: "demo-e2e-c" },
        eventId: "e2e-next-start",
      })), memoryHeaders(principal)),
    )).json();
    expect(next.state.memoryBrief.source).toBe("STRUCTURED");
    expect(next.state.memoryBrief.activeThreads).toHaveLength(1);
  });

  it("stops and dead-letters queued events after consent is revoked", async () => {
    const storage = new FakeStorage();
    const waits = [];
    const identity = { ...fixtureIdentity, sessionId: "do-memory-revoke" };
    const durableObject = new CoachAgentDurableObject(
      { storage, waitUntil: (promise) => waits.push(promise) },
      { MEMORY_ENABLED: "true", MEMORY_SINK: vi.fn() },
    );
    const start = startCueEvent({ identity, eventId: "memory-revoke-start" });
    expect((await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(start),
      memoryHeaders("principal-revoke", "granted"),
    ))).status).toBe(200);
    // Drain the request's background flush before inserting the deliberately
    // pending row.  This makes the test assert the revoke boundary rather
    // than an unrelated scheduling race with the prior request.
    await Promise.all(waits.splice(0));
    await durableObject.outbox.enqueue({
      schemaVersion: "memory-event.v1",
      eventId: "memory-revoke-pending",
      type: "SESSION_COMPLETED",
      userId: "principal-revoke",
      sessionId: identity.sessionId,
      idempotencyKey: "memory-revoke-pending-idem",
      producerVersion: "test",
      payload: { reason: "SESSION_COMPLETED" },
      createdAt: "2026-08-28T00:00:00.000Z",
    });

    const revoked = await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope({ ...start, eventId: "memory-revoke-after" }),
      memoryHeaders("principal-revoke", "revoked"),
    ));
    expect(revoked.status).toBe(200);
    await Promise.all(waits.splice(0));
    expect((await durableObject.outbox.get("memory-revoke-pending")).status).toBe("DEAD_LETTER");
    expect((await durableObject.alarm()).attempted).toBe(0);
  });

  it("does not poll legacy outbox rows while the memory feature is disabled", async () => {
    const storage = new FakeStorage();
    let alarmCalls = 0;
    storage.setAlarm = async () => { alarmCalls += 1; };
    const durableObject = new CoachAgentDurableObject(
      { storage },
      { MEMORY_ENABLED: "false", MEMORY_SINK: vi.fn() },
    );
    await durableObject.outbox.enqueue({
      schemaVersion: "memory-event.v1",
      eventId: "flag-off-pending",
      type: "SESSION_COMPLETED",
      userId: "flag-off-principal",
      sessionId: "flag-off-session",
      idempotencyKey: "flag-off-pending-idem",
      producerVersion: "test",
      payload: { reason: "SESSION_COMPLETED" },
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    expect((await durableObject.alarm()).attempted).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(alarmCalls).toBe(0);
  });

  it("does not restart an alarm loop for pending rows under persisted revoked consent", async () => {
    const storage = new FakeStorage();
    let alarmCalls = 0;
    storage.setAlarm = async () => { alarmCalls += 1; };
    await storage.put("coach-agent:memory-owner:v1", {
      schemaVersion: "memory-owner.v1",
      principal: "restart-revoked-principal",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    await storage.put("coach-agent:memory-consent:v1", {
      schemaVersion: "memory-consent.v1",
      principal: "restart-revoked-principal",
      consent: "REVOKED",
      consentVersion: 3,
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    const durableObject = new CoachAgentDurableObject(
      { storage },
      { MEMORY_ENABLED: "true", MEMORY_SINK: vi.fn() },
    );
    await durableObject.outbox.enqueue({
      schemaVersion: "memory-event.v1",
      eventId: "restart-revoked-pending",
      type: "SESSION_COMPLETED",
      userId: "restart-revoked-principal",
      sessionId: "restart-revoked-session",
      idempotencyKey: "restart-revoked-pending-idem",
      producerVersion: "test",
      payload: { reason: "SESSION_COMPLETED" },
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    expect((await durableObject.alarm()).attempted).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(alarmCalls).toBe(0);
  });

  it("uses the same-origin brief route when no explicit provider is configured", async () => {
    const fetched = vi.fn(async (input) => {
      expect(input.url ?? String(input)).toBe("https://agent.test/api/memory/brief");
      return new Response(JSON.stringify({ ok: true, brief: memoryBrief("默认 brief 路由") }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetched);
    const durableObject = new CoachAgentDurableObject(
      { storage: new FakeStorage() },
      { MEMORY_ENABLED: "true", MEMORY_DEFAULT_BRIEF: "true", MEMORY_SINK: vi.fn() },
    );
    const result = await (await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(startCueEvent({
        identity: { ...fixtureIdentity, sessionId: "do-memory-brief-default" },
        eventId: "memory-brief-default-start",
      })),
      memoryHeaders("principal-default"),
    ))).json();
    expect(result.state.memoryBrief.limitations).toEqual(["默认 brief 路由"]);
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("signs HMAC authority requests over the canonical body and accepts HMAC invalidation", async () => {
    const secret = "memory-internal-hmac-secret";
    const fetched = vi.fn(async (input) => {
      expect(input.headers.get("x-cs-memory-internal")).toBe("1");
      const timestamp = input.headers.get("x-memory-timestamp");
      const signature = input.headers.get("x-memory-signature");
      expect(timestamp).toBeTruthy();
      expect(signature).toBeTruthy();
      expect(await verifyHmacSha256Base64Url(`${timestamp}.`, signature, secret)).toBe(true);
      return new Response(JSON.stringify({ enabled: true, consent: "GRANTED", consentVersion: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetched);
    const storage = new FakeStorage();
    const durableObject = new CoachAgentDurableObject({ storage }, {
      MEMORY_ENABLED: "true",
      MEMORY_STATUS_URL: "https://memory.test/api/memory/status",
      MEMORY_INTERNAL_HMAC_SECRET: secret,
      MEMORY_BRIEF: memoryBrief(),
      MEMORY_SINK: vi.fn(),
    });
    const identity = { ...fixtureIdentity, sessionId: "do-hmac-authority" };
    const start = startCueEvent({ identity, eventId: "hmac-authority-start" });
    const response = await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(start),
      memoryHeaders("hmac-principal", "granted"),
    ));
    expect(response.status).toBe(200);
    expect(fetched).toHaveBeenCalled();

    const body = JSON.stringify({ all: true });
    const timestamp = String(Date.now());
    const invalidated = await durableObject.invalidateMemoryEndpoint(new Request(
      "https://agent.test/api/coaching/agent/memory-invalidate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cs-memory-internal": "1",
          "x-cs-trusted-principal": "hmac-principal",
          "x-memory-timestamp": timestamp,
          "x-memory-signature": await hmacSha256Base64Url(`${timestamp}.${body}`, secret),
        },
        body,
      },
    ));
    expect(invalidated.status).toBe(200);
    expect((await storage.get("coach-agent:memory-consent:v1")).consent).toBe("REVOKED");
  });

  it("does not lower a durable consent version from a stale signed request", async () => {
    const storage = new FakeStorage();
    const durableObject = new CoachAgentDurableObject(
      { storage },
      { MEMORY_ENABLED: "true", MEMORY_SINK: vi.fn() },
    );
    const identity = { ...fixtureIdentity, sessionId: "do-monotonic-consent-version" };
    const first = startCueEvent({ identity, eventId: "consent-version-five" });
    const highVersionHeaders = {
      ...memoryHeaders("monotonic-principal"),
      "x-cs-memory-consent-version": "5",
    };
    expect((await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(first),
      highVersionHeaders,
    ))).status).toBe(200);
    expect((await storage.get("coach-agent:memory-consent:v1")).consentVersion).toBe(5);

    const stale = startCueEvent({ identity, eventId: "consent-version-four" });
    const staleResponse = await durableObject.fetch(request(
      createRemoteCoachAgentDispatchEnvelope(stale),
      { ...memoryHeaders("monotonic-principal"), "x-cs-memory-consent-version": "4" },
    ));
    expect(staleResponse.status).toBe(200);
    expect((await storage.get("coach-agent:memory-consent:v1")).consentVersion).toBe(5);
  });

  it("does not replay old outbox rows after an offline revoke and newer re-grant", async () => {
    const storage = new FakeStorage();
    const principal = "offline-version-principal";
    const durableObject = new CoachAgentDurableObject({ storage }, { MEMORY_ENABLED: "true" });
    await storage.put("coach-agent:memory-owner:v1", { schemaVersion: "memory-owner.v1", principal });
    await storage.put("coach-agent:memory-consent:v1", {
      schemaVersion: "memory-consent.v1",
      principal,
      consent: "GRANTED",
      consentVersion: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    await durableObject.outbox.enqueue({
      schemaVersion: "memory-event.v1",
      eventId: "offline-old-pending",
      type: "SESSION_COMPLETED",
      userId: principal,
      sessionId: "offline-version-session",
      idempotencyKey: "offline-old-pending-idem",
      producerVersion: "test",
      payload: { reason: "SESSION_COMPLETED" },
      createdAt: "2026-08-28T00:00:00.000Z",
    });

    const reopened = await durableObject.authorizeMemory(new Request("https://agent.test/api/coaching/agent", {
      method: "POST",
      headers: {
        ...memoryHeaders(principal),
        "x-cs-memory-consent-version": "3",
      },
    }));
    expect(reopened.enabled).toBe(true);
    const oldEntry = await durableObject.outbox.get("offline-old-pending");
    expect(oldEntry.status).toBe("DEAD_LETTER");
    expect(oldEntry.event.payload).toEqual({ reason: "SESSION_COMPLETED" });
  });

  it("does not let a stale sink-side authority false overwrite a newer grant", async () => {
    const storage = new FakeStorage();
    const principal = "sink-race-principal";
    let resolveAuthority;
    const authority = new Promise((resolve) => { resolveAuthority = resolve; });
    const sink = vi.fn(async () => undefined);
    const durableObject = new CoachAgentDurableObject({ storage }, {
      MEMORY_ENABLED: "true",
      MEMORY_CONSENT_PROVIDER: async () => authority,
      MEMORY_SINK: sink,
    });
    await storage.put("coach-agent:memory-owner:v1", { schemaVersion: "memory-owner.v1", principal });
    await storage.put("coach-agent:memory-consent:v1", {
      schemaVersion: "memory-consent.v1", principal, consent: "GRANTED", consentVersion: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    const event = {
      schemaVersion: "memory-event.v1",
      eventId: "sink-race-event",
      type: "SESSION_COMPLETED",
      userId: principal,
      sessionId: "sink-race-session",
      idempotencyKey: "sink-race-idem",
      producerVersion: "test",
      payload: { reason: "SESSION_COMPLETED" },
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    const requestUrl = new Request("https://agent.test/api/coaching/agent");
    const sinkAttempt = durableObject.memorySinkFor(requestUrl, principal, durableObject.memoryConsentEpoch)(event, { entryId: event.eventId });
    // Let the local-consent read and provider call reach the pending promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const grant = await durableObject.authorizeMemory(new Request(requestUrl.url, {
      method: "POST",
      headers: { ...memoryHeaders(principal), "x-cs-memory-consent-version": "2" },
    }));
    expect(grant.enabled).toBe(true);
    await durableObject.outbox.enqueue({
      ...event,
      eventId: "sink-race-new-grant-event",
      idempotencyKey: "sink-race-new-grant-idem",
    });
    resolveAuthority(false);
    await expect(sinkAttempt).rejects.toMatchObject({ code: "CONSENT_REVOKED" });
    expect(await storage.get("coach-agent:memory-consent:v1")).toMatchObject({ consent: "GRANTED", consentVersion: 2 });
    expect(durableObject.memoryRevokedLatch).toBe(false);
    expect(sink).not.toHaveBeenCalled();
    expect((await durableObject.outbox.get("sink-race-new-grant-event")).status).toBe("PENDING");
  });

  it("does not deadlock provider revoke against an in-flight memory sink flush", async () => {
    const storage = new FakeStorage();
    const waits = [];
    const principal = "flush-sink-race-principal";
    let resolveSinkStarted;
    let releaseSink;
    const sinkStarted = new Promise((resolve) => { resolveSinkStarted = resolve; });
    const sinkGate = new Promise((resolve) => { releaseSink = resolve; });
    let authorization;
    const sink = vi.fn(async () => {
      resolveSinkStarted();
      await sinkGate;
      // The watchdog only breaks the old deadlock so this regression can fail
      // cleanly; a completed authorization must veto the in-flight delivery.
      const authorized = await Promise.race([
        authorization.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 200)),
      ]);
      if (authorized) throw Object.assign(new Error("CONSENT_REVOKED"), { code: "CONSENT_REVOKED" });
    });
    let providerCalls = 0;
    const provider = vi.fn(async () => {
      providerCalls += 1;
      return providerCalls === 1;
    });
    const durableObject = new CoachAgentDurableObject(
      { storage, waitUntil: (promise) => waits.push(promise) },
      { MEMORY_ENABLED: "true", MEMORY_CONSENT_PROVIDER: provider, MEMORY_SINK: sink },
    );
    await storage.put("coach-agent:memory-owner:v1", { schemaVersion: "memory-owner.v1", principal });
    await storage.put("coach-agent:memory-consent:v1", {
      schemaVersion: "memory-consent.v1",
      principal,
      consent: "GRANTED",
      consentVersion: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    const event = {
      schemaVersion: "memory-event.v1",
      eventId: "flush-sink-race-event",
      type: "SESSION_COMPLETED",
      userId: principal,
      sessionId: "flush-sink-race-session",
      idempotencyKey: "flush-sink-race-idem",
      producerVersion: "test",
      payload: { reason: "SESSION_COMPLETED" },
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    const requestUrl = new Request("https://agent.test/api/coaching/agent");
    const expectedEpoch = durableObject.memoryConsentEpoch;
    const sinkForFlush = durableObject.memorySinkFor(requestUrl, principal, expectedEpoch);
    durableObject.outbox.setSink(sinkForFlush);
    await durableObject.outbox.enqueue(event);
    const flush = durableObject.outbox.flush({
      force: true,
      beforeSend: () => durableObject.memoryOutboxBeforeSend(principal, expectedEpoch),
    });
    await sinkStarted;
    authorization = durableObject.authorizeMemoryFlush(requestUrl, principal, expectedEpoch);
    releaseSink();

    let timeout;
    const result = await Promise.race([
      authorization,
      new Promise((resolve) => { timeout = setTimeout(() => resolve("TIMEOUT"), 100); }),
    ]);
    clearTimeout(timeout);
    expect(result).toBe(false);
    await Promise.all([flush, authorization, ...waits]);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledTimes(1);
    expect((await durableObject.outbox.get(event.eventId)).status).toBe("DEAD_LETTER");
  });

  it("releases the authorization tail before waiting for grant-transition cleanup", async () => {
    const storage = new FakeStorage();
    const principal = "grant-cleanup-race-principal";
    let releaseAuthority;
    const authority = new Promise((resolve) => { releaseAuthority = resolve; });
    const provider = vi.fn(async () => authority);
    const sink = vi.fn(async () => undefined);
    const durableObject = new CoachAgentDurableObject({ storage }, {
      MEMORY_ENABLED: "true",
      MEMORY_CONSENT_PROVIDER: provider,
      MEMORY_SINK: sink,
    });
    await storage.put("coach-agent:memory-owner:v1", { schemaVersion: "memory-owner.v1", principal });
    await storage.put("coach-agent:memory-consent:v1", {
      schemaVersion: "memory-consent.v1",
      principal,
      consent: "GRANTED",
      consentVersion: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    const event = {
      schemaVersion: "memory-event.v1",
      eventId: "grant-cleanup-race-event",
      type: "SESSION_COMPLETED",
      userId: principal,
      sessionId: "grant-cleanup-race-session",
      idempotencyKey: "grant-cleanup-race-idem",
      producerVersion: "test",
      payload: { reason: "SESSION_COMPLETED" },
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    const requestUrl = new Request("https://agent.test/api/coaching/agent");
    const expectedEpoch = durableObject.memoryConsentEpoch;
    durableObject.outbox.setSink(durableObject.memorySinkFor(requestUrl, principal, expectedEpoch));
    await durableObject.outbox.enqueue(event);
    const flush = durableObject.outbox.flush({
      force: true,
      beforeSend: () => durableObject.memoryOutboxBeforeSend(principal, expectedEpoch),
    });
    // Ensure the Outbox owns its serialized tail and the sink is waiting on
    // the remote authority before starting the newer grant transition.
    for (let attempt = 0; attempt < 20 && provider.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(provider).toHaveBeenCalledTimes(1);
    const grant = durableObject.authorizeMemory(new Request(requestUrl.url, {
      method: "POST",
      headers: { ...memoryHeaders(principal), "x-cs-memory-consent-version": "2" },
    }));
    releaseAuthority(false);

    const result = await Promise.race([
      Promise.all([flush, grant]),
      new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 500)),
    ]);
    expect(result).not.toBe("TIMEOUT");
    const [flushResult, grantResult] = result;
    expect(grantResult.enabled).toBe(true);
    expect(flushResult.deadLettered).toBe(1);
    expect(sink).not.toHaveBeenCalled();
    expect((await durableObject.outbox.get(event.eventId)).status).toBe("DEAD_LETTER");
  });

  it.each([
    ["UNKNOWN consent", { featureFlag: true, enabled: false, consent: "UNKNOWN", principalType: "ANONYMOUS", storage: "POSTGRES", durable: true, consentVersion: 99 }],
    ["degraded status", { featureFlag: true, enabled: true, consent: "GRANTED", principalType: "ANONYMOUS", storage: "POSTGRES", durable: true, degradedReason: "POSTGRES_UNAVAILABLE", consentVersion: 99 }],
    ["unavailable storage", { featureFlag: true, enabled: true, consent: "GRANTED", principalType: "ANONYMOUS", storage: "UNAVAILABLE", durable: false, consentVersion: 99 }],
    ["missing status field", { featureFlag: true, enabled: true, principalType: "ANONYMOUS", storage: "POSTGRES", durable: true, consentVersion: 99 }],
  ])("treats a 2xx authority %s response as unavailable without revoking local state", async (_label, status) => {
    const principal = "authority-outage-principal";
    const storage = new FakeStorage();
    await storage.put("coach-agent:memory-owner:v1", { schemaVersion: "memory-owner.v1", principal });
    await storage.put("coach-agent:memory-consent:v1", {
      schemaVersion: "memory-consent.v1",
      principal,
      consent: "GRANTED",
      consentVersion: 7,
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    const fetched = vi.fn(async () => new Response(JSON.stringify(status), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetched);
    const durableObject = new CoachAgentDurableObject({ storage }, {
      MEMORY_ENABLED: "true",
      MEMORY_STATUS_URL: "https://memory.test/api/memory/status",
      MEMORY_INTERNAL_TOKEN: "authority-test-token",
      MEMORY_SINK: vi.fn(),
    });
    await durableObject.outbox.enqueue({
      schemaVersion: "memory-event.v1",
      eventId: "authority-outage-event",
      type: "SESSION_COMPLETED",
      userId: principal,
      sessionId: "authority-outage-session",
      idempotencyKey: "authority-outage-idem",
      producerVersion: "test",
      payload: { reason: "SESSION_COMPLETED" },
      createdAt: "2026-08-28T00:00:00.000Z",
    });

    const result = await durableObject.authorizeMemoryAuthority(
      new Request("https://agent.test/api/coaching/agent"),
      { enabled: true, userId: principal, consent: "GRANTED" },
    );
    expect(result).toMatchObject({ enabled: false, reason: "MEMORY_AUTHORITY_UNAVAILABLE" });
    expect(await storage.get("coach-agent:memory-consent:v1")).toMatchObject({ consent: "GRANTED", consentVersion: 7 });
    expect((await durableObject.outbox.get("authority-outage-event")).status).toBe("PENDING");
    expect(durableObject.memoryRevokedLatch).toBe(false);
    expect(durableObject.memoryAuthorityVersion).toBeUndefined();
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["GRANTED", { featureFlag: true, enabled: true, consent: "GRANTED", principalType: "ANONYMOUS", storage: "POSTGRES", durable: true }, true],
    ["REVOKED", { featureFlag: true, enabled: false, consent: "REVOKED", principalType: "ANONYMOUS", storage: "POSTGRES", durable: true }, false],
  ])("keeps an explicit %s authority status distinguishable", async (_label, status, expected) => {
    const durableObject = new CoachAgentDurableObject({ storage: new FakeStorage() }, {
      MEMORY_ENABLED: "true",
      MEMORY_CONSENT_PROVIDER: async () => status,
    });
    await expect(durableObject.consentFromProvider(
      new Request("https://agent.test/api/coaching/agent"),
      "explicit-status-principal",
    )).resolves.toBe(expected);
  });
});
