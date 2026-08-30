import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";
import {
  createRemoteCoachAgentDispatchEnvelope,
  parseRemoteCoachAgentDispatchResponse,
} from "@cs-coach/coach-agent";
import { fixtureIdentity, resumeEvent, startCueEvent } from "../../../../../../libs/coach-agent/src/test-fixtures";
import { InMemoryMemoryRepository } from "@cs-coach/memory";
import { issueTestMemoryPrincipalCookie } from "../../../../lib/memory/principal";
import { setMemoryRuntimeForTests, resetMemoryRuntimeForTests } from "../../../../lib/memory/server";
import { afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSqliteDatabaseOwnersForTests } from "@cs-coach/memory-sqlite/server";
import { DESKTOP_APP_ORIGIN_HEADER } from "../../../../lib/desktop/request-origin";

afterEach(() => {
  resetMemoryRuntimeForTests();
  vi.unstubAllEnvs();
});

function post(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Request {
  return new Request("http://localhost/api/coaching/agent", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("local Coach Agent route", () => {
  it("uses the shared recoverable SQLite saver for desktop dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cs-agent-route-sqlite-"));
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    vi.stubEnv("CS_AGENT_DESKTOP_DB_PATH", join(directory, "desktop.sqlite3"));
    try {
      const identity = { ...fixtureIdentity, sessionId: "desktop-sqlite-route-session" };
      const started = parseRemoteCoachAgentDispatchResponse(await (await POST(post(
        createRemoteCoachAgentDispatchEnvelope(startCueEvent({ identity, eventId: "desktop-sqlite-start" })),
        {
          "content-type": "application/json",
          [DESKTOP_APP_ORIGIN_HEADER]: "http://127.0.0.1:43123",
        },
      ))).json());
      expect(started.checkpoint).toMatchObject({ backend: "SQLITE", recoverableAfterRefresh: true });
      expect(started.effects).toHaveLength(1);
    } finally {
      resetMemoryRuntimeForTests();
      await closeSqliteDatabaseOwnersForTests();
      await rm(directory, { recursive: true, force: true });
    }
  });
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

  it("strips a browser-supplied memory brief on the local baseline route", async () => {
    const identity = { ...fixtureIdentity, sessionId: "local-brief-untrusted" };
    const event = startCueEvent({
      identity,
      eventId: "local-brief-untrusted-start",
      memoryBrief: {
        schemaVersion: "memory-brief.v1",
        generatedAt: "2026-08-28T00:00:00.000Z",
        activeThreads: [],
        memories: [],
        corrections: [],
        limitations: ["client supplied"],
        source: "EMPTY",
      },
    });
    const result = parseRemoteCoachAgentDispatchResponse(await (await POST(post(createRemoteCoachAgentDispatchEnvelope(event)))).json());
    expect(result.state.memoryBrief).toBeUndefined();
  });

  it("uses a server-derived local brief only after feature flag and consent", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const userId = "local-memory-route-user";
    const runtime = setMemoryRuntimeForTests({ repository: new InMemoryMemoryRepository(), memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    await runtime.service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED" });
    await runtime.service.setPreference(userId, { key: "explanationDepth", value: "DEEP" });
    const cookie = (await issueTestMemoryPrincipalCookie(userId, { consent: "GRANTED", consentVersion: 1 })).split(";")[0];
    const event = startCueEvent({ identity: { ...fixtureIdentity, sessionId: "local-memory-route-session" }, eventId: "local-memory-route-start", memoryBrief: {
      schemaVersion: "memory-brief.v1", generatedAt: "2026-08-28T00:00:00.000Z", activeThreads: [], memories: [], corrections: [], limitations: ["untrusted"], source: "EMPTY",
    } });
    const response = await POST(post(createRemoteCoachAgentDispatchEnvelope(event), { cookie, "content-type": "application/json" }));
    const result = parseRemoteCoachAgentDispatchResponse(await response.json());
    expect(result.state.memoryBrief?.preferences?.explanationDepth).toBe("DEEP");
    expect(result.state.memoryBrief?.limitations).not.toContain("untrusted");
  });

  it("drops a local brief when consent changes while it is loading", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const userId = "local-memory-route-race";
    const runtime = setMemoryRuntimeForTests({ repository: new InMemoryMemoryRepository(), memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    await runtime.service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED", consentVersion: 1 });
    const cookie = (await issueTestMemoryPrincipalCookie(userId, { consent: "GRANTED", consentVersion: 1 })).split(";")[0];
    runtime.service.getBrief = async () => {
      await runtime.service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "REVOKED", consentVersion: 2 });
      return {
        schemaVersion: "memory-brief.v1",
        generatedAt: "2026-08-28T00:00:00.000Z",
        preferences: {},
        activeThreads: [],
        memories: [],
        corrections: [],
        limitations: ["STALE_LOCAL_BRIEF"],
        source: "STRUCTURED",
      };
    };
    const event = startCueEvent({ identity: { ...fixtureIdentity, sessionId: "local-memory-route-race-session" }, eventId: "local-memory-route-race-start" });
    const response = await POST(post(createRemoteCoachAgentDispatchEnvelope(event), { cookie, "content-type": "application/json" }));
    const result = parseRemoteCoachAgentDispatchResponse(await response.json());
    expect(result.state.memoryBrief).toBeUndefined();
  });
});
