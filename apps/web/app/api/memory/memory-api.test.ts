import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_EVENT_VERSION,
  MEMORY_PROPOSAL_VERSION,
  InMemoryMemoryRepository,
  type MemoryEvent,
  type MemoryProposal,
} from "@cs-coach/memory";
import type { SqlExecutor } from "@cs-coach/memory-postgres/server";
import { issueTestMemoryPrincipalCookie, resolveMemoryPrincipal } from "../../../lib/memory/principal";
import { getMemoryRuntime, resetMemoryRuntimeForTests, setMemoryRuntimeForTests } from "../../../lib/memory/server";
import { GET as getStatus } from "./status/route";
import { POST as postConsent } from "./consent/route";
import { DELETE as deleteAllMemories, GET as getMemories } from "./route";
import { GET as getBrief } from "./brief/route";
import { POST as postEvents } from "./events/route";
import { POST as confirmMemory } from "./[id]/confirm/route";
import { POST as correctMemory } from "./[id]/correct/route";
import { DELETE as deleteMemory } from "./[id]/route";

afterEach(() => {
  resetMemoryRuntimeForTests();
  Reflect.deleteProperty(globalThis as unknown as Record<PropertyKey, unknown>, Symbol.for("__cloudflare-context__"));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function ref(userId: string, suffix: string) {
  return {
    namespace: "USER_PREFERENCE" as const,
    refId: `${userId}-${suffix}`,
    demoContentHash: `demo-${userId}`,
    sessionId: `session-${userId}`,
    cueId: "preference",
  };
}

function preferenceEvent(userId: string, suffix: string): MemoryEvent {
  const sourceRef = ref(userId, suffix);
  const proposal: MemoryProposal = {
    schemaVersion: MEMORY_PROPOSAL_VERSION,
    proposalId: `proposal-${userId}-${suffix}`,
    userId,
    operation: "CREATE",
    eventType: "USER_PREFERENCE_STATED",
    requestedScope: "CROSS_DEMO",
    kind: "COACHING_PREFERENCE",
    logicalKey: `preference-${userId}-${suffix}`,
    claims: [],
    preference: { key: "role", value: "support", source: "USER_EXPLICIT", refs: [sourceRef] },
    origin: { sessionId: sourceRef.sessionId, demoContentHash: sourceRef.demoContentHash, cueId: sourceRef.cueId, typedSourceRefs: [sourceRef] },
    lifecycle: "CONFIRMED",
    consentState: "GRANTED",
    producerVersion: "api-test",
    idempotencyKey: `idem-${userId}-${suffix}`,
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  return {
    schemaVersion: MEMORY_EVENT_VERSION,
    eventId: `event-${userId}-${suffix}`,
    type: "USER_PREFERENCE_STATED",
    userId,
    sessionId: sourceRef.sessionId,
    demoContentHash: sourceRef.demoContentHash,
    proposalId: proposal.proposalId,
    idempotencyKey: proposal.idempotencyKey,
    producerVersion: proposal.producerVersion,
    payload: proposal,
    createdAt: proposal.createdAt,
  };
}

function cookieFor(userId: string): Promise<string> {
  return issueTestMemoryPrincipalCookie(userId, { consent: "GRANTED", consentVersion: 1 });
}

function request(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

function unusedDurableExecutor(): SqlExecutor {
  const executor: SqlExecutor = {
    query: async () => { throw new Error("UNEXPECTED_SQL_QUERY"); },
    transaction: async (work) => work(executor),
  };
  return executor;
}

async function seedDurableMemory(userId: string, suffix: string): Promise<{ memoryId: string; cookie: string }> {
  const repository = new InMemoryMemoryRepository();
  const runtime = setMemoryRuntimeForTests({
    repository,
    executor: unusedDurableExecutor(),
    memoryEnabled: true,
    allowTestPrincipal: true,
  });
  await runtime.service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED" });
  const seeded = await runtime.service.ingestEvent(userId, preferenceEvent(userId, suffix));
  return {
    memoryId: seeded.record?.memoryId as string,
    cookie: (await cookieFor(userId)).split(";")[0],
  };
}

describe("memory management API", () => {
  it("keeps the feature-off path side-effect free", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const repository = new InMemoryMemoryRepository();
    setMemoryRuntimeForTests({ repository, memoryEnabled: false, nodeEnv: "test", allowTestPrincipal: true });
    const status = await getStatus(request("/api/memory/status"));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ featureFlag: false, enabled: false, consent: "UNKNOWN", principalType: "ANONYMOUS" });
    const consent = await postConsent(request("/api/memory/consent", { method: "POST", body: JSON.stringify({ enabled: true }) }));
    expect(consent.status).toBe(200);
    await getMemories(request("/api/memory"));
    expect(repository.calls).toEqual([]);
  });

  it("uses a server-issued principal for consent and rejects body userId", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const repository = new InMemoryMemoryRepository();
    setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    const response = await postConsent(request("/api/memory/consent", { method: "POST", body: JSON.stringify({ enabled: true, userId: "attacker" }) }));
    expect(response.status).toBe(400);
    expect(repository.calls).toEqual([]);
    const enabled = await postConsent(request("/api/memory/consent", { method: "POST", body: JSON.stringify({ enabled: true }) }));
    expect(enabled.status).toBe(200);
    expect(enabled.headers.get("set-cookie")).toContain("HttpOnly");
    expect(enabled.headers.get("set-cookie")).toContain("SameSite=Lax");
    const disabled = await postConsent(request("/api/memory/consent", { method: "POST", body: JSON.stringify({ enabled: false }), headers: { cookie: enabled.headers.get("set-cookie")?.split(";")[0] ?? "" } }));
    expect(disabled.headers.get("set-cookie")).not.toContain("Max-Age=0");
    expect(disabled.headers.get("set-cookie")).toContain("HttpOnly");
    const revokedCookie = disabled.headers.get("set-cookie")?.split(";")[0] ?? "";
    const repeated = await postConsent(request("/api/memory/consent", { method: "POST", headers: { cookie: revokedCookie }, body: JSON.stringify({ enabled: false }) }));
    expect(repeated.status).toBe(200);
    expect(repeated.headers.get("set-cookie")).not.toContain("Max-Age=0");
    expect(await repeated.json()).toMatchObject({ consent: "REVOKED", consentVersion: 2 });
  });

  it("keeps a revoked principal able to perform privacy deletion without recall", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const userId = "principal-revoked-delete";
    const repository = new InMemoryMemoryRepository();
    const runtime = setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    await runtime.service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED" });
    await runtime.service.ingestEvent(userId, preferenceEvent(userId, "before-revoke"));
    const grantedCookie = (await cookieFor(userId)).split(";")[0];
    const revoked = await postConsent(request("/api/memory/consent", { method: "POST", headers: { cookie: grantedCookie }, body: JSON.stringify({ enabled: false }) }));
    const revokedCookie = revoked.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(revoked.status).toBe(200);
    expect(revokedCookie).not.toBe("");
    expect(revokedCookie).not.toContain("Max-Age=0");

    const beforeCalls = [...repository.calls];
    const brief = await getBrief(request("/api/memory/brief", { headers: { cookie: revokedCookie } }));
    expect(brief.status).toBe(200);
    expect((await brief.json()).brief.source).toBe("EMPTY");
    expect(repository.calls.slice(beforeCalls.length)).toEqual([]);

    const deleted = await deleteAllMemories(request("/api/memory", { method: "DELETE", headers: { cookie: revokedCookie } }));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ accepted: true, deleted: 1 });
    expect((await repository.findByLogicalKey(userId, `preference-${userId}-before-revoke`))?.status).toBe("DELETED");
  });

  it("returns a revoked cookie after delete-all while the feature flag is off", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const userId = "principal-feature-off-delete";
    const repository = new InMemoryMemoryRepository();
    let authorization = { userId, memoryEnabled: true, consent: "GRANTED" as const, consentVersion: 1 };
    setMemoryRuntimeForTests({
      repository,
      memoryEnabled: false,
      nodeEnv: "test",
      allowTestPrincipal: true,
      authorizationStore: {
        getAuthorization: async (requestedUserId) => requestedUserId === userId ? authorization : undefined,
        setAuthorization: async (_requestedUserId, next) => { authorization = next as typeof authorization; },
      },
    });
    const grantedCookie = (await cookieFor(userId)).split(";")[0];
    const response = await deleteAllMemories(request("/api/memory", { method: "DELETE", headers: { cookie: grantedCookie } }));
    expect(response.status).toBe(200);
    const responseCookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(responseCookie).not.toBe("");
    const resolved = await resolveMemoryPrincipal(request("/api/memory/status", { headers: { cookie: responseCookie } }));
    expect(resolved.principal).toMatchObject({ id: userId, consent: "REVOKED", consentVersion: 2 });
  });

  it("isolates records by signed principal and supports management lifecycle", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const repository = new InMemoryMemoryRepository();
    const runtime = setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    await runtime.service.setAuthorization("principal-a", { userId: "principal-a", memoryEnabled: true, consent: "GRANTED" });
    await runtime.service.setAuthorization("principal-b", { userId: "principal-b", memoryEnabled: true, consent: "GRANTED" });
    const seed = await runtime.service.ingestEvent("principal-a", preferenceEvent("principal-a", "one"));
    const memoryId = seed.record?.memoryId as string;
    const ownCookie = (await cookieFor("principal-a")).split(";")[0];
    const otherCookie = (await cookieFor("principal-b")).split(";")[0];
    const own = await getMemories(request("/api/memory?limit=25", { headers: { cookie: ownCookie } }));
    const ownPayload = await own.json();
    expect(ownPayload.records).toHaveLength(1);
    const other = await getMemories(request("/api/memory", { headers: { cookie: otherCookie } }));
    expect((await other.json()).records).toHaveLength(0);
    expect(ownPayload.records?.[0]?.userId).toBeUndefined();

    const confirmed = await confirmMemory(request(`/api/memory/${memoryId}/confirm`, { method: "POST", headers: { cookie: ownCookie }, body: JSON.stringify({ source: "USER" }) }), { params: Promise.resolve({ id: memoryId }) });
    expect(confirmed.status).toBe(200);
    const corrected = await correctMemory(request(`/api/memory/${memoryId}/correct`, { method: "POST", headers: { cookie: ownCookie }, body: JSON.stringify({ content: "我会先等补枪", userId: "attacker" }) }), { params: Promise.resolve({ id: memoryId }) });
    expect(corrected.status).toBe(400);
    const validCorrection = await correctMemory(request(`/api/memory/${memoryId}/correct`, { method: "POST", headers: { cookie: ownCookie }, body: JSON.stringify({ content: "我会先等补枪" }) }), { params: Promise.resolve({ id: memoryId }) });
    expect(validCorrection.status).toBe(200);
    const deleted = await deleteMemory(request(`/api/memory/${memoryId}`, { method: "DELETE", headers: { cookie: ownCookie }, body: JSON.stringify({ reason: "不再适用" }) }), { params: Promise.resolve({ id: memoryId }) });
    expect(deleted.status).toBe(200);
    const repeatedDelete = await deleteMemory(request(`/api/memory/${memoryId}`, { method: "DELETE", headers: { cookie: ownCookie } }), { params: Promise.resolve({ id: memoryId }) });
    expect(repeatedDelete.status).toBe(200);
  });

  it("requires internal auth and binds event identity to the trusted principal", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MEMORY_INTERNAL_TOKEN", "internal-test-token");
    const repository = new InMemoryMemoryRepository();
    const runtime = setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    await runtime.service.setAuthorization("principal-a", { userId: "principal-a", memoryEnabled: true, consent: "GRANTED" });
    const event = preferenceEvent("principal-a", "event");
    const body = JSON.stringify(event);
    const base = { "content-type": "application/json", "x-memory-principal": "principal-a", "x-memory-internal-token": "internal-test-token" };
    expect((await postEvents(request("/api/memory/events", { method: "POST", headers: base, body }))).status).toBe(200);
    const mismatch = { ...event, userId: "principal-b" };
    const mismatchResponse = await postEvents(request("/api/memory/events", { method: "POST", headers: base, body: JSON.stringify(mismatch) }));
    expect(mismatchResponse.status).toBe(403);
    const noToken = await postEvents(request("/api/memory/events", { method: "POST", headers: { "x-memory-principal": "principal-a" }, body }));
    expect(noToken.status).toBe(401);

    const internalBrief = await getBrief(request("/api/memory/brief", { headers: {
      "x-cs-trusted-principal": "principal-a",
      "x-cs-memory-internal": "1",
      "x-memory-internal-token": "internal-test-token",
    } }));
    expect(internalBrief.status).toBe(200);
    expect((await internalBrief.json()).principalType).toBe("ANONYMOUS");
    const untrustedBrief = await getBrief(request("/api/memory/brief", { headers: { "x-cs-trusted-principal": "principal-a" } }));
    expect(untrustedBrief.status).toBe(200);
    expect(untrustedBrief.headers.get("set-cookie")).toContain("cs_coach_memory_principal=");
  });

  it("deletes all records through tombstones", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const userId = "principal-delete-all";
    const repository = new InMemoryMemoryRepository();
    const runtime = setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    await runtime.service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED" });
    await runtime.service.ingestEvent(userId, preferenceEvent(userId, "one"));
    await runtime.service.ingestEvent(userId, preferenceEvent(userId, "two"));
    const cookie = (await cookieFor(userId)).split(";")[0];

    const response = await deleteAllMemories(request("/api/memory", { method: "DELETE", headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, deleted: 2, limited: false });
    expect(await repository.listMemories(userId)).toHaveLength(0);
    expect((await repository.findByLogicalKey(userId, `preference-${userId}-one`))?.status).toBe("DELETED");
  });

  it("reports retryable cleanup when an individual tombstone fan-out fails", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const userId = "principal-delete-host-failure";
    const repository = new InMemoryMemoryRepository();
    const runtime = setMemoryRuntimeForTests({
      repository,
      memoryEnabled: true,
      nodeEnv: "test",
      allowTestPrincipal: true,
      onMemoryDeleted: async () => { throw new Error("host unavailable"); },
    });
    await runtime.service.setAuthorization(userId, { userId, memoryEnabled: true, consent: "GRANTED" });
    const seeded = await runtime.service.ingestEvent(userId, preferenceEvent(userId, "host-failure"));
    const memoryId = seeded.record?.memoryId as string;
    const cookie = (await cookieFor(userId)).split(";")[0];

    const response = await deleteMemory(request(`/api/memory/${memoryId}`, {
      method: "DELETE",
      headers: { cookie },
    }), { params: Promise.resolve({ id: memoryId }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "OUTBOX_INVALIDATION_PENDING", deleted: true });
  });

  it("accepts an idempotent localhost delete when PostgreSQL is durable but no DO outbox channel exists", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOY_TARGET", "localhost");
    vi.stubEnv("NEXT_PUBLIC_DEPLOY_TARGET", "cloudflare");
    vi.stubEnv("MEMORY_PRINCIPAL_SECRET", "localhost-postgres-test-secret");
    (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] = { env: {} };
    const userId = "principal-localhost-postgres-delete";
    const { memoryId, cookie } = await seedDurableMemory(userId, "localhost-postgres");

    const response = await deleteMemory(request(`/api/memory/${memoryId}`, {
      method: "DELETE",
      headers: { cookie },
    }), { params: Promise.resolve({ id: memoryId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, deleted: true });

    const repeated = await deleteMemory(request(`/api/memory/${memoryId}`, {
      method: "DELETE",
      headers: { cookie },
    }), { params: Promise.resolve({ id: memoryId }) });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ accepted: true, deleted: true });
  });

  it("keeps a missing outbox channel fail-closed for an unknown production target", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOY_TARGET", "");
    vi.stubEnv("NEXT_PUBLIC_DEPLOY_TARGET", "localhost");
    vi.stubEnv("MEMORY_PRINCIPAL_SECRET", "unknown-production-test-secret");
    (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] = { env: {} };
    const { memoryId, cookie } = await seedDurableMemory("principal-unknown-production", "unknown-production");

    const response = await deleteMemory(request(`/api/memory/${memoryId}`, { method: "DELETE", headers: { cookie } }), {
      params: Promise.resolve({ id: memoryId }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "OUTBOX_INVALIDATION_PENDING", deleted: true });
  });

  it("keeps a Cloudflare deployment marker fail-closed without an invalidation channel", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOY_TARGET", "localhost");
    vi.stubEnv("NEXT_PUBLIC_DEPLOY_TARGET", "localhost");
    vi.stubEnv("MEMORY_PRINCIPAL_SECRET", "cloudflare-target-test-secret");
    (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] = {
      env: { DEPLOY_TARGET: "cloudflare" },
    };
    const { memoryId, cookie } = await seedDurableMemory("principal-cloudflare-target", "cloudflare-target");

    const response = await deleteMemory(request(`/api/memory/${memoryId}`, { method: "DELETE", headers: { cookie } }), {
      params: Promise.resolve({ id: memoryId }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "OUTBOX_INVALIDATION_PENDING", deleted: true });
  });

  it("keeps a failing Durable Object binding retryable on localhost", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOY_TARGET", "localhost");
    vi.stubEnv("NEXT_PUBLIC_DEPLOY_TARGET", "localhost");
    vi.stubEnv("MEMORY_PRINCIPAL_SECRET", "cloudflare-binding-test-secret");
    (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] = {
      env: {
        COACH_AGENT: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
        },
      },
    };
    const { memoryId, cookie } = await seedDurableMemory("principal-cloudflare-binding", "cloudflare-binding");

    const response = await deleteMemory(request(`/api/memory/${memoryId}`, { method: "DELETE", headers: { cookie } }), {
      params: Promise.resolve({ id: memoryId }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "OUTBOX_INVALIDATION_PENDING", deleted: true });
  });

  it("keeps a failing HTTP invalidator endpoint retryable on localhost", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOY_TARGET", "localhost");
    vi.stubEnv("NEXT_PUBLIC_DEPLOY_TARGET", "localhost");
    vi.stubEnv("MEMORY_PRINCIPAL_SECRET", "http-invalidator-test-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    (globalThis as unknown as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] = {
      env: { MEMORY_OUTBOX_INVALIDATOR_URL: "https://invalidator.example.test/memory" },
    };
    const { memoryId, cookie } = await seedDurableMemory("principal-http-invalidator", "http-invalidator");

    const response = await deleteMemory(request(`/api/memory/${memoryId}`, { method: "DELETE", headers: { cookie } }), {
      params: Promise.resolve({ id: memoryId }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "OUTBOX_INVALIDATION_PENDING", deleted: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("enforces origin, query and body bounds before touching memory", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const repository = new InMemoryMemoryRepository();
    setMemoryRuntimeForTests({ repository, memoryEnabled: true, nodeEnv: "test", allowTestPrincipal: true });
    expect((await getStatus(request("/api/memory/status?userId=forbidden"))).status).toBe(400);
    expect((await getMemories(request(`/api/memory?q=${"x".repeat(241)}`))).status).toBe(400);
    expect((await postConsent(request("/api/memory/consent", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ enabled: true }) }))).status).toBe(403);
    expect((await postConsent(request("/api/memory/consent", { method: "POST", body: "{" }))).status).toBe(400);
    expect(repository.calls).toEqual([]);
  });

  it("reports a controlled degraded state when production has no Postgres executor", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEMORY_ENABLED", "true");
    vi.stubEnv("MEMORY_PRINCIPAL_SECRET", "production-test-secret");
    resetMemoryRuntimeForTests();
    expect(getMemoryRuntime().storage).toBe("UNAVAILABLE");
    const response = await getStatus(request("/api/memory/status"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ featureFlag: true, enabled: false, storage: "UNAVAILABLE", degradedReason: "POSTGRES_EXECUTOR_NOT_CONFIGURED" });
  });
});
