import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_EVENT_VERSION,
  MEMORY_PROPOSAL_VERSION,
  type MemoryEvent,
  type MemoryProposal,
} from "@cs-coach/memory";
import {
  closeSqliteDatabaseOwnersForTests,
  type SqliteMemoryRepository,
} from "@cs-coach/memory-sqlite/server";
import {
  DESKTOP_LOCAL_PRINCIPAL_ID,
} from "../../../lib/memory/api";
import { DESKTOP_APP_ORIGIN_HEADER } from "../../../lib/desktop/request-origin";
import {
  createMemoryRuntime,
  resetMemoryRuntimeForTests,
  setMemoryRuntimeForTests,
} from "../../../lib/memory/server";
import { DELETE as deleteAllMemories } from "./route";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetMemoryRuntimeForTests();
  await closeSqliteDatabaseOwnersForTests();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function event(suffix: string): MemoryEvent {
  const sourceRef = {
    namespace: "USER_PREFERENCE" as const,
    refId: `ref-${suffix}`,
    demoContentHash: "demo-desktop-delete",
    sessionId: "session-desktop-delete",
    cueId: `cue-${suffix}`,
  };
  const proposal: MemoryProposal = {
    schemaVersion: MEMORY_PROPOSAL_VERSION,
    proposalId: `proposal-${suffix}`,
    userId: DESKTOP_LOCAL_PRINCIPAL_ID,
    operation: "CREATE",
    eventType: "USER_PREFERENCE_STATED",
    requestedScope: "CROSS_DEMO",
    kind: "COACHING_PREFERENCE",
    logicalKey: `preference-${suffix}`,
    claims: [],
    preference: {
      key: `preference-${suffix}`,
      value: suffix,
      source: "USER_EXPLICIT",
      refs: [sourceRef],
    },
    origin: {
      sessionId: sourceRef.sessionId,
      demoContentHash: sourceRef.demoContentHash,
      cueId: sourceRef.cueId,
      typedSourceRefs: [sourceRef],
    },
    lifecycle: "CONFIRMED",
    consentState: "GRANTED",
    producerVersion: "sqlite-api-test",
    idempotencyKey: `idempotency-${suffix}`,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
  return {
    schemaVersion: MEMORY_EVENT_VERSION,
    eventId: `event-${suffix}`,
    type: "USER_PREFERENCE_STATED",
    userId: DESKTOP_LOCAL_PRINCIPAL_ID,
    sessionId: sourceRef.sessionId,
    demoContentHash: sourceRef.demoContentHash,
    proposalId: proposal.proposalId,
    idempotencyKey: proposal.idempotencyKey,
    producerVersion: proposal.producerVersion,
    payload: proposal,
    createdAt: proposal.createdAt,
  };
}

async function harness(options?: { failPurge?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "cs-agent-memory-api-"));
  temporaryDirectories.push(directory);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEPLOY_TARGET", "desktop");
  vi.stubEnv("CS_AGENT_DESKTOP_DB_PATH", join(directory, "memory.sqlite"));
  const order: string[] = [];
  const notices: Array<{
    memoryId: string;
    sessionIds: readonly string[];
  }> = [];
  const runtime = createMemoryRuntime({
    memoryEnabled: true,
    nodeEnv: "test",
    allowTestPrincipal: false,
    onMemoryDeleted: async (notice) => {
      order.push("outbox");
      notices.push({
        memoryId: notice.memoryId,
        sessionIds: notice.sessionIds,
      });
    },
  });
  expect(runtime.storage).toBe("SQLITE");
  setMemoryRuntimeForTests(runtime);
  await runtime.service.setAuthorization(DESKTOP_LOCAL_PRINCIPAL_ID, {
    userId: DESKTOP_LOCAL_PRINCIPAL_ID,
    memoryEnabled: true,
    consent: "GRANTED",
  });
  const first = await runtime.service.ingestEvent(
    DESKTOP_LOCAL_PRINCIPAL_ID,
    event("one"),
  );
  const second = await runtime.service.ingestEvent(
    DESKTOP_LOCAL_PRINCIPAL_ID,
    event("two"),
  );
  const repository = runtime.repository as SqliteMemoryRepository;
  const originalPurge = repository.purgeUserMemoryResidue.bind(repository);
  const purge = vi.spyOn(repository, "purgeUserMemoryResidue");
  if (options?.failPurge) {
    purge.mockImplementation(async () => {
      order.push("purge");
      throw new Error("forced purge failure");
    });
  } else {
    purge.mockImplementation(async (userId) => {
      order.push("purge");
      return originalPurge(userId);
    });
  }
  const request = new Request("http://127.0.0.1:43123/api/memory", {
    method: "DELETE",
    headers: {
      cookie: `cs_agent_runtime=${"s".repeat(43)}`,
      [DESKTOP_APP_ORIGIN_HEADER]: "http://127.0.0.1:43123",
    },
  });
  return {
    request,
    runtime,
    repository,
    purge,
    order,
    notices,
    memoryIds: [first.record?.memoryId, second.record?.memoryId].filter(
      (value): value is string => Boolean(value),
    ),
  };
}

describe("desktop SQLite memory delete-all API", () => {
  it("uses the local completion path in desktop production without a Cloudflare outbox", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cs-agent-memory-api-production-"));
    temporaryDirectories.push(directory);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    vi.stubEnv("CS_AGENT_DESKTOP_DB_PATH", join(directory, "memory.sqlite"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const runtime = createMemoryRuntime({
      memoryEnabled: true,
      nodeEnv: "production",
      allowTestPrincipal: false,
    });
    expect(runtime.storage).toBe("SQLITE");
    setMemoryRuntimeForTests(runtime);
    await runtime.service.setAuthorization(DESKTOP_LOCAL_PRINCIPAL_ID, {
      userId: DESKTOP_LOCAL_PRINCIPAL_ID,
      memoryEnabled: true,
      consent: "GRANTED",
    });
    await runtime.service.ingestEvent(
      DESKTOP_LOCAL_PRINCIPAL_ID,
      event("production-local-delete"),
    );
    const semantic = vi.spyOn(runtime.repository, "retrieveSemantic");
    await runtime.service.getBrief(DESKTOP_LOCAL_PRINCIPAL_ID, {
      semanticText: "等队友补枪再一起进点",
    });
    expect(semantic).toHaveBeenCalled();
    expect(semantic.mock.calls.at(-1)?.[1].embedding).toHaveLength(256);

    const response = await deleteAllMemories(
      new Request("http://127.0.0.1:43123/api/memory", {
        method: "DELETE",
        headers: {
          cookie: `cs_agent_runtime=${"s".repeat(43)}`,
          [DESKTOP_APP_ORIGIN_HEADER]: "http://127.0.0.1:43123",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, deleted: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the atomic purge once and invalidates outboxes only after commit", async () => {
    const h = await harness();
    const recordDelete = vi.spyOn(h.repository, "deleteMemory");

    const response = await deleteAllMemories(h.request);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accepted: true,
      deleted: 2,
      limited: false,
    });
    expect(h.purge).toHaveBeenCalledTimes(1);
    expect(recordDelete).not.toHaveBeenCalled();
    expect(h.order).toEqual(["purge", "outbox"]);
    expect(h.notices).toEqual([
      {
        memoryId: "*",
        sessionIds: ["session-desktop-delete"],
      },
    ]);
    for (const memoryId of h.memoryIds) {
      expect(
        (
          await h.repository.getRecordVersion(
            DESKTOP_LOCAL_PRINCIPAL_ID,
            memoryId,
            undefined,
            true,
          )
        )?.status,
      ).toBe("DELETED");
    }
  });

  it("reports zero deletion and leaves every record intact when purge fails", async () => {
    const h = await harness({ failPurge: true });
    const recordDelete = vi.spyOn(h.repository, "deleteMemory");

    const response = await deleteAllMemories(h.request);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      accepted: false,
      reason: "PERSISTENCE_UNAVAILABLE",
      deleted: 0,
    });
    expect(h.purge).toHaveBeenCalledTimes(1);
    expect(recordDelete).not.toHaveBeenCalled();
    expect(h.order).toEqual(["purge"]);
    for (const memoryId of h.memoryIds) {
      expect(
        (
          await h.repository.getRecordVersion(
            DESKTOP_LOCAL_PRINCIPAL_ID,
            memoryId,
            undefined,
            true,
          )
        )?.status,
      ).not.toBe("DELETED");
    }
  });
});
