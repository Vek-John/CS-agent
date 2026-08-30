import { describe, expect, it } from "vitest";
import {
  MEMORY_EVENT_VERSION,
  MemoryEventSchema,
  MemoryService,
  buildMemoryProposal,
  type MemoryEvent,
  type MemoryProposal,
} from "@cs-coach/memory";
import { createPgSqlExecutor, runMemoryMigrations, PostgresMemoryRepository, PostgresMemoryAuthorizationStore } from "./index";
import { MemoryOutbox } from "../../../tools/memory-outbox.mjs";

const enabled = process.env.RUN_POSTGRES_TESTS === "1";

describe.skipIf(!enabled)("real PostgreSQL memory adapter (opt-in)", () => {
  it("runs migrations and a cross-Demo LearningThread write/recall flow", async () => {
    // The pg package is deliberately not a dependency of this package.  A
    // server test harness may inject a pg Pool through the dynamic module
    // boundary below, keeping browser bundles free of database drivers.
    const databaseUrl = process.env.MEMORY_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
    expect(databaseUrl, "MEMORY_DATABASE_URL or DATABASE_URL is required when RUN_POSTGRES_TESTS=1").toBeTruthy();
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    const pgModule = await dynamicImport("pg").catch(() => undefined);
    expect(pgModule, "install pg in the server test environment to run this opt-in suite").toBeTruthy();
    if (!pgModule || !databaseUrl) return;
    const Pool = (pgModule as { Pool: new (options: { connectionString: string }) => { connect: () => Promise<unknown>; query: (text: string, values?: readonly unknown[]) => Promise<unknown>; end: () => Promise<void> } }).Pool;
    const pool = new Pool({ connectionString: databaseUrl });
    const executor = createPgSqlExecutor(pool as never);
    const userId = `real-pg-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    try {
      await runMemoryMigrations(executor);
      const repository = new PostgresMemoryRepository({ executor, vectorAvailable: false });
      const authorizationStore = new PostgresMemoryAuthorizationStore(executor);
      const service = new MemoryService({ repository, authorizationStore, memoryEnabled: true });
      await expect(service.setAuthorization(userId, {
        userId,
        memoryEnabled: true,
        consent: "GRANTED",
        consentVersion: 1,
        updatedAt: "2026-08-28T00:00:00.000Z",
      })).resolves.toMatchObject({ userId, consent: "GRANTED" });

      const proposalFor = (suffix: string, demoContentHash: string): MemoryProposal => buildMemoryProposal({
        userId,
        sessionId: `real-pg-session-${suffix}`,
        demoContentHash,
        cueCase: {
          schemaVersion: "cue-case.v1",
          caseId: `real-pg-case-${suffix}`,
          cueId: `real-pg-cue-${suffix}`,
          pedagogyMode: "INTRODUCE",
          status: "AWAITING_CONFIRMATION",
          claims: [],
          capabilities: [],
          diagnosticResult: {
            resultId: `real-pg-diagnostic-${suffix}`,
            capabilityId: "VERIFY_TRADE_ASSUMPTION",
            cueId: `real-pg-cue-${suffix}`,
            hingeId: `real-pg-hinge-${suffix}`,
            status: "SUPPORTED",
            evidenceRefs: [],
            measurements: [],
            explanation: "已完成有界诊断",
            limitations: [],
          },
          verdict: {
            type: "BELIEF_INCORRECT",
            confidence: 0.8,
            hingeId: `real-pg-hinge-${suffix}`,
            diagnosticResultId: `real-pg-diagnostic-${suffix}`,
            claimIds: [],
            evidenceRefs: [],
            limitations: [],
            revision: 0,
            explanation: "已完成有界判断",
          },
          baselineNarrationAvailable: true,
          attemptBudget: { reflection: 0, diagnostic: 0, disagreement: 0, alternateDiagnostic: 0 },
          limitations: [],
        } as Parameters<typeof buildMemoryProposal>[0]["cueCase"],
        learningThread: {
          threadId: `real-pg-thread-${suffix}`,
          scope: "SESSION",
          hingeCode: "TRADE_TIMING",
          trigger: { situation: "队友可以补枪时", conditions: ["仍有交易窗口"] },
          userModel: { goal: "拿信息", belief: "必须马上继续打" },
          diagnosis: { type: "TIMING", summary: "先等补枪窗口", confidence: 0.8 },
          transferRule: { ruleId: `real-pg-rule-${suffix}`, when: "队友可以补枪时", do: "先保持可交易角度", refs: [], confidence: 0.75, limitations: [] },
          evidenceCueIds: [`real-pg-cue-${suffix}`],
          successfulCueIds: [],
          conflictingCueIds: [],
          status: "TAUGHT",
        } as Parameters<typeof buildMemoryProposal>[0]["learningThread"],
        outcomeGateStatus: "COMPLETE",
        createdAt: "2026-08-28T00:00:00.000Z",
      });
      const eventFor = (proposal: MemoryProposal, suffix: string): MemoryEvent => MemoryEventSchema.parse({
        schemaVersion: MEMORY_EVENT_VERSION,
        eventId: `real-pg-event-${suffix}`,
        type: "CUE_DIAGNOSED",
        eventType: "CUE_DIAGNOSED",
        userId,
        sessionId: proposal.origin.sessionId,
        demoContentHash: proposal.origin.demoContentHash,
        proposalId: proposal.proposalId,
        operation: proposal.operation,
        idempotencyKey: proposal.idempotencyKey,
        producerVersion: proposal.producerVersion,
        payload: proposal,
        createdAt: proposal.createdAt,
      }) as unknown as MemoryEvent;

      const outboxValues = new Map<string, unknown>();
      const outbox = new MemoryOutbox({
        storage: {
          get: async (key: string) => outboxValues.get(key),
          put: async (key: string, value: unknown) => { outboxValues.set(key, structuredClone(value)); },
          delete: async (key: string) => outboxValues.delete(key),
          list: async ({ prefix = "" }: { prefix?: string } = {}) => new Map([...outboxValues].filter(([key]) => key.startsWith(prefix))),
        },
        sink: async (event: MemoryEvent) => service.ingestEvent(userId, event),
      });
      await outbox.enqueue(eventFor(proposalFor("one", "real-demo-a"), "one"));
      const firstFlush = await outbox.flush({ force: true });
      expect(firstFlush.delivered).toBe(1);
      const candidate = (await repository.listMemories(userId, { includeDeleted: false }))[0];
      expect(candidate?.status).toBe("CANDIDATE");

      await outbox.enqueue(eventFor(proposalFor("two", "real-demo-b"), "two"));
      const secondFlush = await outbox.flush({ force: true });
      expect(secondFlush.delivered).toBe(1);
      const active = (await repository.listMemories(userId, { includeDeleted: false }))[0];
      expect(active?.active).toBe(true);
      expect(active?.demoContentHashes).toEqual(["real-demo-a", "real-demo-b"]);

      // A fresh service instance represents the next Session and proves the
      // brief comes from PostgreSQL rather than process-local state.
      const nextSessionService = new MemoryService({ repository, authorizationStore, memoryEnabled: true });
      const recalled = await nextSessionService.getBrief(userId);
      expect(recalled.activeThreads).toHaveLength(1);
      expect(recalled.memories[0]?.active).toBe(true);
      expect(recalled.memories[0]?.demoContentHashes).toEqual(["real-demo-a", "real-demo-b"]);
      await expect(repository.getMemoryVersion(userId)).resolves.toBeGreaterThanOrEqual(2);
    } finally {
      // The random principal is test-owned; cascading deletion keeps the
      // shared opt-in database free of durable test data.
      try {
        await pool.query("DELETE FROM app_users WHERE user_id = $1", [userId]);
      } catch {
        // If core migration itself failed there may be no app_users table yet;
        // preserve the original test failure rather than masking it here.
      }
      await pool.end();
    }
  });
});
