import { describe, expect, it } from "vitest";
import { InMemoryMemoryRepository } from "./in-memory";
import { MemoryService } from "./service";

const userId = "preference-test-user";

function makeService(options?: { enabled?: boolean; consent?: "GRANTED" | "REVOKED" | "UNKNOWN" }) {
  const repository = new InMemoryMemoryRepository({ now: () => "2026-08-28T00:00:00.000Z" });
  const service = new MemoryService({
    repository,
    memoryEnabled: options?.enabled ?? true,
    authorization: {
      userId,
      memoryEnabled: true,
      consent: options?.consent ?? "GRANTED",
    },
    now: () => "2026-08-28T00:00:00.000Z",
  });
  return { repository, service };
}

describe("MemoryService teaching preferences", () => {
  it("writes an explicit preference event and keeps repeated values idempotent", async () => {
    const { repository, service } = makeService();

    const first = await service.setPreference(userId, {
      key: "explanationDepth",
      value: "BRIEF",
      label: "  解释深度  ",
    });
    expect(first.accepted).toBe(true);
    expect(first.record?.preference).toMatchObject({
      key: "explanationDepth",
      value: "BRIEF",
      label: "解释深度",
      source: "USER_EXPLICIT",
    });
    expect(repository.events).toHaveLength(1);
    expect(repository.events[0]).toMatchObject({
      type: "USER_PREFERENCE_STATED",
      eventType: "USER_PREFERENCE_STATED",
      userId,
      operation: "CREATE",
      proposalId: expect.stringContaining("memory-preference-proposal-"),
    });
    expect(repository.events[0].payload).toMatchObject({
      key: "explanationDepth",
      value: "BRIEF",
      source: "USER_EXPLICIT",
      refs: [{ namespace: "USER_PREFERENCE", sessionId: "memory-preferences", cueId: "preference" }],
    });

    const repeated = await service.setPreference(userId, {
      key: "explanationDepth",
      value: "BRIEF",
      label: "解释深度",
    });
    expect(repeated.accepted).toBe(false);
    expect(repeated.decision.reason).toBe("DUPLICATE_IDEMPOTENCY");
    expect(repeated.record?.revision).toBe(1);
    expect(repository.events).toHaveLength(1);

    const changed = await service.setPreference(userId, { key: "explanationDepth", value: "DEEP" });
    expect(changed.accepted).toBe(true);
    expect(changed.record?.revision).toBe(2);
    expect(changed.record?.preference?.value).toBe("DEEP");
    expect(repository.events).toHaveLength(2);
  });

  it("accepts only the supported teaching preference values", async () => {
    const { repository, service } = makeService();
    for (const input of [
      { key: "preferredEvidence", value: "MAP" },
      { key: "preferredEvidence", value: "TIMELINE" },
      { key: "reflectionFrequency", value: "HIGH_AMBIGUITY_ONLY" },
    ]) {
      const result = await service.setPreference(userId, input);
      expect(result.accepted).toBe(true);
    }
    const invalid = await service.setPreference(userId, { key: "preferredEvidence", value: "VIDEO" });
    expect(invalid.accepted).toBe(false);
    expect(invalid.errorCode).toBe("INVALID_EVENT");
    expect(repository.events).toHaveLength(3);
  });

  it("treats a rebuilt idempotent event with a new producer timestamp as the same write", async () => {
    const repository = new InMemoryMemoryRepository({ now: () => "2026-08-28T00:00:00.000Z" });
    let clockTick = 0;
    const service = new MemoryService({
      repository,
      memoryEnabled: true,
      authorization: { userId, memoryEnabled: true, consent: "GRANTED" },
      now: () => clockTick++ === 0 ? "2026-08-28T00:00:01.000Z" : "2026-08-28T00:00:02.000Z",
    });
    const first = await service.setPreference(userId, { key: "explanationDepth", value: "NORMAL" });
    const replay = await service.setPreference(userId, { key: "explanationDepth", value: "NORMAL" });

    expect(first.accepted).toBe(true);
    expect(replay.errorCode).toBeUndefined();
    expect(replay.decision.reason).toBe("DUPLICATE_IDEMPOTENCY");
    expect(replay.record?.preference?.value).toBe("NORMAL");
    expect(repository.events).toHaveLength(1);
  });

  it("does not write when the feature or consent gate is off", async () => {
    const disabled = makeService({ enabled: false });
    const disabledResult = await disabled.service.setPreference(userId, { key: "explanationDepth", value: "NORMAL" });
    expect(disabledResult.errorCode).toBe("MEMORY_DISABLED");
    expect(disabled.repository.calls).toEqual([]);
    expect(disabled.repository.events).toEqual([]);

    const notConsented = makeService({ consent: "UNKNOWN" });
    const notConsentedResult = await notConsented.service.setPreference(userId, { key: "explanationDepth", value: "NORMAL" });
    expect(notConsentedResult.errorCode).toBe("MEMORY_DISABLED");
    expect(notConsented.repository.calls).toEqual([]);
    expect(notConsented.repository.events).toEqual([]);
  });

  it("does not even read durable authorization while the feature flag is off", async () => {
    let reads = 0;
    const service = new MemoryService({
      repository: new InMemoryMemoryRepository(),
      memoryEnabled: false,
      authorizationStore: {
        getAuthorization: async () => { reads += 1; return { userId, memoryEnabled: true, consent: "GRANTED" }; },
        setAuthorization: async () => undefined,
      },
    });
    await service.getPreferences(userId);
    await service.setPreference(userId, { key: "explanationDepth", value: "DEEP" });
    expect(reads).toBe(0);
  });
});
