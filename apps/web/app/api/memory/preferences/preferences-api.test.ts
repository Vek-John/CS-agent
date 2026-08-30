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
  return new Request("http://localhost/api/memory/preferences", init);
}

async function cookieFor(userId: string): Promise<string> {
  return (await issueTestMemoryPrincipalCookie(userId, { consent: "GRANTED", consentVersion: 1 })).split(";")[0];
}

describe("teaching preferences API", () => {
  it("keeps feature-off and consent-off writes side-effect free", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const disabledRepository = new InMemoryMemoryRepository();
    setMemoryRuntimeForTests({ repository: disabledRepository, memoryEnabled: false, nodeEnv: "test", allowTestPrincipal: true });
    const disabled = await POST(request({ method: "POST", body: JSON.stringify({ key: "explanationDepth", value: "DEEP" }) }));
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toMatchObject({ accepted: false, reason: "MEMORY_DISABLED" });
    expect(disabledRepository.calls).toEqual([]);

    resetMemoryRuntimeForTests();
    const noConsentRepository = new InMemoryMemoryRepository();
    setMemoryRuntimeForTests({ repository: noConsentRepository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    const noConsent = await POST(request({ method: "POST", body: JSON.stringify({ key: "explanationDepth", value: "DEEP" }) }));
    expect(noConsent.status).toBe(403);
    expect(await noConsent.json()).toMatchObject({ accepted: false, reason: "CONSENT_REQUIRED" });
    expect(noConsentRepository.calls).toEqual([]);
  });

  it("validates the strict request shape before memory access", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const repository = new InMemoryMemoryRepository();
    setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    for (const body of [
      { key: "explanationDepth", value: "DEEP", userId: "attacker" },
      { key: "explanationDepth", value: "DEEP", extra: true },
      { key: "preferredEvidence", value: "VIDEO" },
      { key: "reflectionFrequency", value: "NORMAL", label: "" },
    ]) {
      const response = await POST(request({ method: "POST", body: JSON.stringify(body) }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ accepted: false, reason: "INVALID_PREFERENCE" });
    }
    expect(repository.calls).toEqual([]);
  });

  it("writes only for the signed principal and exposes no user identity", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const userId = "preference-api-user";
    const repository = new InMemoryMemoryRepository();
    const runtime = setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    await runtime.service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED" });
    const ownCookie = await cookieFor(userId);
    const otherCookie = await cookieFor("other-preference-user");

    const first = await POST(request({
      method: "POST",
      headers: { cookie: ownCookie },
      body: JSON.stringify({ key: "explanationDepth", value: "DEEP", label: "解释深度" }),
    }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ accepted: true, changed: true, idempotent: false, preference: { preference: { key: "explanationDepth", value: "DEEP" } } });
    expect(repository.events).toHaveLength(1);
    expect(repository.events[0]).toMatchObject({ type: "USER_PREFERENCE_STATED", userId, operation: "CREATE" });

    const repeated = await POST(request({
      method: "POST",
      headers: { cookie: ownCookie },
      body: JSON.stringify({ key: "explanationDepth", value: "DEEP", label: "解释深度" }),
    }));
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ accepted: true, changed: false, idempotent: true });
    expect(repository.events).toHaveLength(1);

    const own = await GET(new Request("http://localhost/api/memory/preferences", { headers: { cookie: ownCookie } }));
    const ownPayload = await own.json();
    expect(own.status).toBe(200);
    expect(ownPayload.preferences).toHaveLength(1);
    expect(ownPayload.preferences[0].preference).toMatchObject({ key: "explanationDepth", value: "DEEP", label: "解释深度" });
    expect(JSON.stringify(ownPayload)).not.toContain("userId");

    const other = await GET(new Request("http://localhost/api/memory/preferences", { headers: { cookie: otherCookie } }));
    expect((await other.json()).preferences).toHaveLength(0);

    await runtime.service.setAuthorization(userId, {
      userId,
      memoryEnabled: true,
      consent: "REVOKED",
      consentVersion: 2,
    });
    const revokedSettings = await GET(new Request("http://localhost/api/memory/preferences", { headers: { cookie: ownCookie } }));
    expect(revokedSettings.status).toBe(200);
    expect((await revokedSettings.json()).consent).toBe("REVOKED");
  });
});
