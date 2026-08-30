import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryMemoryRepository } from "@cs-coach/memory";
import { issueTestMemoryPrincipalCookie } from "../../../../lib/memory/principal";
import { resetMemoryRuntimeForTests, setMemoryRuntimeForTests } from "../../../../lib/memory/server";
import { GET, POST } from "./route";

afterEach(() => {
  resetMemoryRuntimeForTests();
  vi.unstubAllEnvs();
});

function request(init?: RequestInit): Request {
  return new Request("http://localhost/api/memory/profile", init);
}

function requestWithQuery(query: string, init?: RequestInit): Request {
  return new Request(`http://localhost/api/memory/profile?${query}`, init);
}

async function cookieFor(userId: string): Promise<string> {
  return (await issueTestMemoryPrincipalCookie(userId, { consent: "GRANTED", consentVersion: 1 })).split(";")[0];
}

describe("profile API", () => {
  it("keeps feature-off reads and writes side-effect free", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const repository = new InMemoryMemoryRepository();
    setMemoryRuntimeForTests({ repository, memoryEnabled: false, nodeEnv: "test", allowTestPrincipal: true });
    const read = await GET(request());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ featureFlag: false, enabled: false, profile: null });
    const write = await POST(request({ method: "POST", body: JSON.stringify({ profile: { role: "support" } }) }));
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ accepted: false, reason: "MEMORY_DISABLED" });
    expect(repository.calls).toEqual([]);
  });

  it("persists only for the signed principal and converges repeated writes", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const userId = "profile-api-user";
    const repository = new InMemoryMemoryRepository();
    const runtime = setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    await runtime.service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED", consentVersion: 1 });
    const ownCookie = await cookieFor(userId);
    const otherCookie = await cookieFor("profile-api-other");

    const first = await POST(request({
      method: "POST",
      headers: { cookie: ownCookie },
      body: JSON.stringify({ profile: { displayName: "小林", role: "support", yearsPlaying: 3 } }),
    }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ accepted: true, changed: true, idempotent: false, profile: { role: "support" } });
    expect(repository.events).toHaveLength(1);

    const repeated = await POST(request({
      method: "POST",
      headers: { cookie: ownCookie },
      body: JSON.stringify({ profile: { yearsPlaying: 3, role: "support", displayName: "小林" } }),
    }));
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ accepted: true, changed: false, idempotent: true });
    expect(repository.events).toHaveLength(1);

    const read = await GET(request({ headers: { cookie: ownCookie } }));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ profile: { displayName: "小林", role: "support", yearsPlaying: 3 } });

    const other = await GET(request({ headers: { cookie: otherCookie } }));
    expect(other.status).toBe(200);
    const otherPayload = await other.json();
    expect(otherPayload).toMatchObject({ profile: null });
    expect(JSON.stringify(otherPayload)).not.toContain(userId);
  });

  it("rejects identity injection and invalid bounded profiles before repository access", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const repository = new InMemoryMemoryRepository();
    setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    for (const value of [
      { profile: { role: "support" }, userId: "attacker" },
      { profile: { userId: "attacker" } },
      { profile: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field${index}`, "value"])) },
      { profile: {} },
    ]) {
      const response = await POST(request({ method: "POST", body: JSON.stringify(value) }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ accepted: false, reason: "INVALID_PROFILE" });
    }
    expect(repository.calls).toEqual([]);
  });

  it("rejects a query userId for both reads and writes", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const repository = new InMemoryMemoryRepository();
    setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });

    const read = await GET(requestWithQuery("userId=attacker"));
    expect(read.status).toBe(400);
    expect(await read.json()).toMatchObject({ error: "USER_ID_NOT_ACCEPTED" });

    const write = await POST(requestWithQuery("userId=attacker", {
      method: "POST",
      body: JSON.stringify({ profile: { role: "support" } }),
    }));
    expect(write.status).toBe(400);
    expect(await write.json()).toMatchObject({ accepted: false, reason: "USER_ID_NOT_ACCEPTED" });
    expect(repository.calls).toEqual([]);
  });
});
