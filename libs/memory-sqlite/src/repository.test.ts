import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryService,
  buildMemoryProposal,
  type MemoryEvent,
} from "@cs-coach/memory";
import {
  atomicReplaceSqliteFromStaging,
  createSqliteBackup,
  stageSqliteRestore,
  verifySqliteDatabase,
} from "./backup";
import { getSqliteDatabaseOwner, SqliteDatabaseOwner } from "./database";
import { DESKTOP_MIGRATIONS } from "./migrations";
import { SqliteMemoryRepository } from "./repository";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "cs-agent-memory-sqlite-"));
  cleanup.push(directory);
  const path = join(directory, "memory.sqlite3");
  const owner = new SqliteDatabaseOwner({ path });
  const repository = new SqliteMemoryRepository({
    owner,
    now: () => "2026-08-30T00:00:10.000Z",
  });
  const service = new MemoryService({
    repository,
    authorizationStore: repository,
    memoryEnabled: true,
    now: () => "2026-08-30T00:00:10.000Z",
  });
  await service.setAuthorization("user-1", {
    userId: "user-1",
    memoryEnabled: true,
    consent: "GRANTED",
    consentVersion: 1,
    updatedAt: "2026-08-30T00:00:00.000Z",
  });
  return { directory, path, owner, repository, service };
}
function proposal(
  suffix: string,
  options: {
    session?: string;
    cue?: string;
    demo?: string;
    producer?: string;
  } = {},
) {
  const cue = options.cue ?? `cue-${suffix}`;
  return buildMemoryProposal({
    userId: "user-1",
    sessionId: options.session ?? `session-${suffix}`,
    demoContentHash: options.demo ?? `demo-${suffix}`,
    cueCase: {
      schemaVersion: "cue-case.v1",
      caseId: `case-${suffix}`,
      cueId: cue,
      pedagogyMode: "INTRODUCE",
      status: "AWAITING_CONFIRMATION",
      claims: [],
      capabilities: [],
      diagnosticResult: {
        resultId: `diagnostic-${suffix}`,
        capabilityId: "VERIFY_TRADE_ASSUMPTION",
        cueId: cue,
        hingeId: `hinge-${suffix}`,
        status: "SUPPORTED",
        evidenceRefs: [],
        measurements: [],
        explanation: "bounded",
        limitations: [],
      },
      verdict: {
        type: "BELIEF_INCORRECT",
        confidence: 0.8,
        hingeId: `hinge-${suffix}`,
        diagnosticResultId: `diagnostic-${suffix}`,
        claimIds: [],
        evidenceRefs: [],
        limitations: [],
        revision: 0,
        explanation: "bounded",
      },
      baselineNarrationAvailable: true,
      attemptBudget: {
        reflection: 0,
        diagnostic: 0,
        disagreement: 0,
        alternateDiagnostic: 0,
      },
      limitations: [],
    } as Parameters<typeof buildMemoryProposal>[0]["cueCase"],
    learningThread: {
      threadId: `thread-${suffix}`,
      scope: "SESSION",
      hingeCode: "TRADE_TIMING",
      trigger: { situation: "trade", conditions: ["near"] },
      userModel: { goal: "win", belief: "swing" },
      diagnosis: { type: "TIMING", summary: "wait trade", confidence: 0.8 },
      transferRule: {
        ruleId: `rule-${suffix}`,
        when: "teammate near",
        do: "hold trade",
        refs: [],
        confidence: 0.75,
        limitations: [],
      },
      evidenceCueIds: [cue],
      successfulCueIds: [],
      conflictingCueIds: [],
      status: "TAUGHT",
    } as Parameters<typeof buildMemoryProposal>[0]["learningThread"],
    outcomeGateStatus: "COMPLETE",
    producerVersion: options.producer ?? "producer.v1",
    createdAt: "2026-08-30T00:00:01.000Z",
  });
}
function event(value: ReturnType<typeof proposal>, id: string): MemoryEvent {
  return {
    schemaVersion: "memory-event.v1",
    eventId: `event-${id}`,
    type: value.eventType,
    userId: "user-1",
    sessionId: value.origin.sessionId,
    demoContentHash: value.origin.demoContentHash,
    proposalId: value.proposalId,
    idempotencyKey: value.idempotencyKey,
    producerVersion: value.producerVersion,
    payload: { proposal: value },
    createdAt: value.createdAt,
  };
}

describe("SqliteMemoryRepository", () => {
  it("matches Postgres authorization conflict semantics", async () => {
    const h = await harness();
    await h.repository.setAuthorization("user-1", {
      userId: "user-1",
      memoryEnabled: false,
      consent: "REVOKED",
      consentVersion: 2,
      updatedAt: "2026-08-30T00:00:02.000Z",
    });

    await expect(
      h.repository.setAuthorization("user-1", {
        userId: "user-1",
        memoryEnabled: true,
        consent: "GRANTED",
        consentVersion: 1,
        updatedAt: "2026-08-30T00:00:03.000Z",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_AUTHORIZATION_CONFLICT" });
    await expect(
      h.repository.setAuthorization("user-1", {
        userId: "user-1",
        memoryEnabled: true,
        consent: "GRANTED",
        consentVersion: 2,
        updatedAt: "2026-08-30T00:00:03.000Z",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_AUTHORIZATION_CONFLICT" });
    await expect(
      h.repository.setAuthorization("user-1", {
        userId: "user-1",
        memoryEnabled: false,
        consent: "REVOKED",
        consentVersion: 2,
        updatedAt: "2026-08-30T00:00:04.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(await h.repository.getAuthorization("user-1")).toMatchObject({
      consent: "REVOKED",
      consentVersion: 2,
      memoryEnabled: false,
    });
  });

  it("migrates an empty database, persists across restart, and rejects checksum drift", async () => {
    const h = await harness();
    expect(h.owner.db.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "wal",
    });
    await h.service.ingestEvent("user-1", event(proposal("a"), "a"));
    await h.owner.close();
    const owner2 = new SqliteDatabaseOwner({ path: h.path });
    const repo2 = new SqliteMemoryRepository({ owner: owner2 });
    expect(
      await repo2.listMemories("user-1", { includeDeleted: true }),
    ).toHaveLength(1);
    owner2.db
      .prepare(
        "UPDATE desktop_schema_migrations SET checksum='drift' WHERE migration_id='desktop-memory-001'",
      )
      .run();
    await owner2.close();
    expect(() => new SqliteDatabaseOwner({ path: h.path })).toThrow(
      /SQLITE_MIGRATION_DRIFT/,
    );
  });
  it("serializes concurrent writes, keeps event and cue effects idempotent, and promotes only distinct demos", async () => {
    const h = await harness();
    const a = proposal("a", {
      session: "same-session",
      cue: "same-cue",
      producer: "producer.a",
    });
    const duplicate = proposal("b", {
      session: "same-session",
      cue: "same-cue",
      demo: "other-demo",
      producer: "producer.b",
    });
    const [first, second] = await Promise.all([
      h.service.ingestEvent("user-1", event(a, "a")),
      h.service.ingestEvent("user-1", event(duplicate, "b")),
    ]);
    expect(first.record?.revision).toBe(1);
    expect(second.record?.revision).toBe(1);
    expect(
      (await h.repository.listMemories("user-1"))[0]?.occurrenceCount,
    ).toBe(1);
    const repeated = await h.service.ingestEvent("user-1", event(a, "a"));
    expect(repeated.record?.revision).toBe(1);
  });
  it("supports confirmed profile, immutable correction, tombstone late-event defense, export and delete-all", async () => {
    const h = await harness();
    const profile = await h.service.setProfile("user-1", {
      role: "support",
      preferredMap: "Mirage",
    });
    expect(profile.record).toMatchObject({
      kind: "PROFILE",
      status: "CONFIRMED",
      revision: 1,
    });
    const seeded = await h.service.ingestEvent(
      "user-1",
      event(proposal("memory"), "memory"),
    );
    const corrected = await h.service.correct(
      "user-1",
      seeded.record!.memoryId,
      { correctionId: "correction-1", content: "用户纠正" },
    );
    expect(corrected).toMatchObject({
      revision: 2,
      status: "DISPUTED",
      content: "用户纠正",
    });
    expect(
      (
        await h.repository.getRecordVersion(
          "user-1",
          seeded.record!.memoryId,
          1,
        )
      )?.content,
    ).not.toBe("用户纠正");
    await h.service.delete("user-1", seeded.record!.memoryId, {
      reason: "privacy",
    });
    expect(
      await h.repository.getRecordVersion(
        "user-1",
        seeded.record!.memoryId,
        1,
        true,
      ),
    ).toBeUndefined();
    const late = proposal("late", {
      session: "late-session",
      cue: "late-cue",
      demo: "late-demo",
    });
    const lateForSame = { ...late, logicalKey: seeded.record!.logicalKey };
    const result = await h.service.ingestEvent(
      "user-1",
      event(lateForSame, "late"),
    );
    expect(result.record?.status).toBe("DELETED");
    const exported = await h.repository.exportUserData("user-1");
    expect(JSON.stringify(exported)).not.toMatch(
      /rawDemo|frames|prompt|secret/,
    );
    await h.repository.purgeUserMemoryResidue("user-1");
    expect(await h.repository.listMemoryIdsForDeletion("user-1")).toEqual([]);
  });
  it("uses canonical Float32 exact cosine and skips stale, invalid, and dimension-mismatched vectors", async () => {
    const h = await harness();
    const first = proposal("one");
    const secondBase = proposal("two");
    const second = {
      ...secondBase,
      logicalKey: `${secondBase.logicalKey}-other`,
      proposalId: `${secondBase.proposalId}-other`,
      idempotencyKey: `${secondBase.idempotencyKey}-other`,
    };
    const one = await h.service.ingestEvent("user-1", event(first, "one"));
    const two = await h.service.ingestEvent("user-1", event(second, "two"));
    await h.repository.saveEmbedding("user-1", {
      memoryId: one.record!.memoryId,
      embedding: [1, 0],
      contentHash: "one",
      model: "test",
      sourceRevision: one.record!.revision,
    });
    await h.repository.saveEmbedding("user-1", {
      memoryId: two.record!.memoryId,
      embedding: [0.5, 0.5],
      contentHash: "two",
      model: "test",
      sourceRevision: two.record!.revision,
    });
    expect(
      (
        await h.repository.retrieveSemantic("user-1", {
          text: "x",
          embedding: [1, 0],
        })
      ).map((record) => record.memoryId),
    ).toEqual([one.record!.memoryId, two.record!.memoryId]);
    h.owner.db
      .prepare(
        "UPDATE memory_embeddings SET source_revision=999 WHERE user_id=? AND memory_id=?",
      )
      .run("user-1", one.record!.memoryId);
    expect(
      (
        await h.repository.retrieveSemantic("user-1", {
          text: "x",
          embedding: [1, 0],
        })
      ).map((record) => record.memoryId),
    ).toEqual([two.record!.memoryId]);
    expect(
      await h.repository.retrieveSemantic("user-1", {
        text: "x",
        embedding: [1, 0, 0],
      }),
    ).toEqual([]);
  });
  it("backs up with integrity and detects corrupt copies", async () => {
    const h = await harness();
    await h.service.ingestEvent("user-1", event(proposal("backup"), "backup"));
    const target = join(h.directory, "backup.sqlite3");
    const manifest = await createSqliteBackup(h.owner, target);
    expect(manifest.migrationLedger).toHaveLength(DESKTOP_MIGRATIONS.length);
    expect(() => verifySqliteDatabase(target)).not.toThrow();
    const bytes = await readFile(target);
    bytes[0] = 0;
    await writeFile(target, bytes);
    expect(() => verifySqliteDatabase(target)).toThrow();
  });
  it("refuses every existing backup/restore target and validates the complete manifest ledger", async () => {
    const h = await harness();
    const backupPath = join(h.directory, "safe-backup.sqlite3");
    const manifest = await createSqliteBackup(h.owner, backupPath);
    const original = await readFile(backupPath);
    await expect(createSqliteBackup(h.owner, backupPath)).rejects.toThrow(
      "SQLITE_BACKUP_DESTINATION_EXISTS",
    );
    expect(await readFile(backupPath)).toEqual(original);

    const existingStage = join(h.directory, "existing-stage.sqlite3");
    await writeFile(existingStage, "do-not-overwrite");
    await expect(
      stageSqliteRestore(backupPath, existingStage, manifest),
    ).rejects.toThrow("SQLITE_RESTORE_STAGING_EXISTS");
    expect(await readFile(existingStage, "utf8")).toBe("do-not-overwrite");

    const wrongManifest = {
      ...manifest,
      migrationLedger: manifest.migrationLedger.slice(0, 1),
    };
    await expect(
      stageSqliteRestore(
        backupPath,
        join(h.directory, "manifest-stage.sqlite3"),
        wrongManifest,
      ),
    ).rejects.toThrow("SQLITE_BACKUP_LEDGER_MISMATCH");

    const validStage = join(h.directory, "valid-stage.sqlite3");
    await stageSqliteRestore(backupPath, validStage, manifest);
    const existingDestination = join(h.directory, "inactive.sqlite3");
    await writeFile(existingDestination, "do-not-overwrite");
    expect(() =>
      atomicReplaceSqliteFromStaging(validStage, existingDestination),
    ).toThrow("SQLITE_RESTORE_DESTINATION_EXISTS");
    expect(await readFile(existingDestination, "utf8")).toBe(
      "do-not-overwrite",
    );

    const incompletePath = join(h.directory, "incomplete-ledger.sqlite3");
    await stageSqliteRestore(backupPath, incompletePath, manifest);
    const incomplete = new DatabaseSync(incompletePath);
    incomplete
      .prepare(
        "DELETE FROM desktop_schema_migrations WHERE migration_id='desktop-checkpoint-002'",
      )
      .run();
    incomplete.close();
    expect(() => verifySqliteDatabase(incompletePath)).toThrow(
      "SQLITE_MIGRATION_LEDGER_INCOMPLETE",
    );
  });
  it("keeps the global deletion marker across re-opt-in and rejects old events", async () => {
    const h = await harness();
    await h.service.ingestEvent(
      "user-1",
      event(proposal("before-purge"), "before"),
    );
    await h.repository.purgeUserMemoryResidue("user-1");
    await h.service.setAuthorization("user-1", {
      userId: "user-1",
      memoryEnabled: false,
      consent: "REVOKED",
      consentVersion: 2,
      updatedAt: "2026-08-30T00:00:12.000Z",
    });
    await h.service.setAuthorization("user-1", {
      userId: "user-1",
      memoryEnabled: true,
      consent: "GRANTED",
      consentVersion: 3,
      updatedAt: "2026-08-30T00:00:13.000Z",
    });
    expect(
      (
        h.owner.db
          .prepare("SELECT memory_deleted_at FROM app_users WHERE user_id=?")
          .get("user-1") as { memory_deleted_at: string | null }
      ).memory_deleted_at,
    ).toBe("2026-08-30T00:00:10.000Z");

    const staleBase = proposal("stale-after-opt-in");
    const stale = {
      ...staleBase,
      logicalKey: `${staleBase.logicalKey}-stale-after-opt-in`,
    };
    await expect(
      h.service.ingestEvent("user-1", event(stale, "stale-after-opt-in")),
    ).resolves.toMatchObject({ accepted: false });
    expect(await h.repository.listMemories("user-1")).toEqual([]);

    const freshBase = proposal("fresh-after-opt-in");
    const fresh = {
      ...freshBase,
      logicalKey: `${freshBase.logicalKey}-fresh-after-opt-in`,
      createdAt: "2026-08-30T00:00:11.000Z",
    };
    await expect(
      h.service.ingestEvent("user-1", event(fresh, "fresh-after-opt-in")),
    ).resolves.toMatchObject({ accepted: true });
  });
  it("rolls back every tombstone and the deletion marker when delete-all fails", async () => {
    const h = await harness();
    const seeded = await h.service.ingestEvent(
      "user-1",
      event(proposal("atomic-delete-all"), "atomic-delete-all"),
    );
    const secondBase = proposal("atomic-delete-all-second");
    const secondProposal = {
      ...secondBase,
      logicalKey: `${secondBase.logicalKey}-second`,
      proposalId: `${secondBase.proposalId}-second`,
      idempotencyKey: `${secondBase.idempotencyKey}-second`,
    };
    const second = await h.service.ingestEvent(
      "user-1",
      event(secondProposal, "atomic-delete-all-second"),
    );
    h.owner.db
      .prepare(
        "INSERT INTO memory_events(user_id,event_id,idempotency_key,session_id,event_type,status,attempt_count,created_at,event_json) VALUES(?,?,?,?,?,'POSTED',0,?,'not-json')",
      )
      .run(
        "user-1",
        "unrelated-corrupt-event",
        "unrelated-corrupt-idempotency",
        "unrelated-session",
        "SESSION_COMPLETED",
        "2026-08-30T00:00:05.000Z",
      );

    await expect(
      h.repository.purgeUserMemoryResidue("user-1"),
    ).rejects.toThrow();
    expect(
      await h.repository.getRecordVersion(
        "user-1",
        seeded.record!.memoryId,
        undefined,
        true,
      ),
    ).toMatchObject({ status: "CANDIDATE" });
    expect(
      await h.repository.getRecordVersion(
        "user-1",
        second.record!.memoryId,
        undefined,
        true,
      ),
    ).toMatchObject({ status: "CANDIDATE" });
    expect(
      (
        h.owner.db
          .prepare("SELECT memory_deleted_at FROM app_users WHERE user_id=?")
          .get("user-1") as { memory_deleted_at: string | null }
      ).memory_deleted_at,
    ).toBeNull();
  });
  it("does not return a closed process owner when the same path is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cs-agent-owner-reopen-"));
    cleanup.push(directory);
    const path = join(directory, "owner.sqlite3");
    const first = getSqliteDatabaseOwner({ path });
    await first.close();
    const reopened = getSqliteDatabaseOwner({ path });
    expect(reopened).not.toBe(first);
    expect(reopened.isClosed).toBe(false);
    expect(reopened.db.prepare("PRAGMA integrity_check").get()).toMatchObject({
      integrity_check: "ok",
    });
    await reopened.close();
  });
  it("fails a queued write whose consent revoke wins first", async () => {
    const h = await harness();
    const revoke = h.repository.setAuthorization("user-1", {
      userId: "user-1",
      memoryEnabled: false,
      consent: "REVOKED",
      consentVersion: 2,
      updatedAt: "2026-08-30T00:00:02.000Z",
    });
    await revoke;
    await expect(
      h.service.ingestEvent("user-1", event(proposal("revoked"), "revoked")),
    ).resolves.toMatchObject({ accepted: false });
    expect(await h.repository.listMemories("user-1")).toEqual([]);
  });
});
