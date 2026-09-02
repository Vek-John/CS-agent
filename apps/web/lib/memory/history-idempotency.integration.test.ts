import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoachAgentEventSchema,
  CoachAgentIdentitySchema,
  diagnoseTeachingCue,
  type CoachAgentEvent,
  type CoachAgentResult,
} from "@cs-coach/coach-agent";
import { MemoryService } from "@cs-coach/memory";
import {
  SqliteDatabaseOwner,
  SqliteMemoryRepository,
} from "@cs-coach/memory-sqlite/server";
import { DesktopReviewLibrary } from "@cs-coach/review-library/server";
import {
  buildLocalAgentMemoryEvents,
  desktopBehaviorOpportunityClaim,
} from "./agent-events";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const DEMO_BYTES = Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(64, 7)]);
const DEMO_HASH = createHash("sha256").update(DEMO_BYTES).digest("hex");
const identity = CoachAgentIdentitySchema.parse({
  runId: "run-memory-history",
  sessionId: "session-memory-history",
  demoId: "analysis-demo-history",
  demoContentHash: DEMO_HASH,
  selectedPlayerId: "player-history",
  routeId: "route-history",
  routeHash: "route-history-v1",
});

function reflectionEvent(sessionSuffix: string): Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }> {
  const cueId = "cue-memory-history";
  return CoachAgentEventSchema.parse({
    version: "coach-agent-event.v2",
    type: "SUBMIT_REFLECTION",
    eventId: `reflection-${sessionSuffix}`,
    identity: {
      ...identity,
      runId: `run-${sessionSuffix}`,
      sessionId: `session-${sessionSuffix}`,
    },
    cueId,
    outcomeGateStatus: "COMPLETE",
    input: {
      cueId,
      candidateId: "candidate-stable-history-source",
      cue: { id: cueId, primary_focus_code: "POSITIONING", limitations: [] },
      decisionFacts: [],
      playerActionFacts: [],
      outcomeFacts: [],
      focusCode: "POSITIONING",
      limitations: [],
    },
    reflection: {
      cueId,
      rawText: "我想拿信息",
      selectedGoal: "GET_INFO",
      response: "ANSWERED",
      source: "USER",
      limitations: [],
    },
  }) as Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }>;
}

function resultFor(event: Extract<CoachAgentEvent, { type: "SUBMIT_REFLECTION" }>): CoachAgentResult {
  const diagnosis = diagnoseTeachingCue({
    ...(event.input as Parameters<typeof diagnoseTeachingCue>[0]),
    reflection: event.reflection,
  });
  return {
    identity: event.identity,
    state: {
      cueCases: { [event.cueId]: diagnosis.cueCase },
      learningThreads: [diagnosis.learningThread],
    },
  } as unknown as CoachAgentResult;
}

function playbackEvent(index: number): CoachAgentEvent {
  return {
    version: "coach-agent-event.v2",
    type: "PLAYBACK_CONFIRMED",
    eventId: `history-rewatch-${index}`,
    identity,
    playback: { canonicalTick: 100 + index, playing: false, speed: 1 },
  } as unknown as CoachAgentEvent;
}

describe("Review history Memory idempotency", () => {
  it("keeps one SQLite opportunity across five opens, five replays, and five resumed emissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "cs-agent-history-memory-"));
    cleanup.push(root);
    const owner = new SqliteDatabaseOwner({ path: join(root, "cs-agent.sqlite3") });
    const library = new DesktopReviewLibrary({ owner, dataRoot: root });
    await library.initialize();
    const repository = new SqliteMemoryRepository({ owner });
    const service = new MemoryService({
      repository,
      authorizationStore: repository,
      memoryEnabled: true,
    });
    const userId = "principal-history-idempotency";
    await service.setAuthorization(userId, {
      userId,
      memoryEnabled: true,
      consent: "GRANTED",
    });

    const capability = library.issueImportCapability({
      objectId: "history-memory-demo",
      originalFilename: "history.dem",
      expectedByteLength: DEMO_BYTES.byteLength,
    });
    const imported = await library.importDemo({
      authorization: capability.authorization,
      objectId: "history-memory-demo",
      stream: (async function* () { yield DEMO_BYTES; })(),
    });
    expect(imported.demo.contentHash).toBe(DEMO_HASH);
    const readyDemo = await library.finalizeDemoImport({
      authorization: imported.validationCapability!.authorization,
      demoId: imported.demo.demoId,
      valid: true,
      parserVersion: "integration-parser.v1",
    });
    expect(readyDemo.status).toBe("READY");
    const review = await library.createReview({
      demoId: imported.demo.demoId,
      selectedPlayerId: identity.selectedPlayerId,
      selectedPlayerName: "Player",
      title: "History idempotency",
    });

    const firstEvent = reflectionEvent("first");
    const firstMemoryEvent = buildLocalAgentMemoryEvents(firstEvent, resultFor(firstEvent), userId)[0]!;
    const firstClaim = desktopBehaviorOpportunityClaim(
      firstMemoryEvent,
      identity.selectedPlayerId,
      identity.routeHash,
    )!;
    const stableClaim = {
      ...firstClaim,
      sourceReviewId: review.reviewId,
    };
    expect(await library.claimMemoryOpportunity(stableClaim)).toMatchObject({ claimed: true });
    await service.ingestEvent(userId, firstMemoryEvent);

    const counts = () => owner.db.prepare(
      "SELECT (SELECT COUNT(*) FROM memory_opportunity_claims) claims,(SELECT COUNT(*) FROM memory_opportunity_evidence) evidence,(SELECT COUNT(*) FROM memory_events) events,(SELECT COUNT(*) FROM memory_records) records",
    ).get();
    expect(counts()).toEqual({ claims: 1, evidence: 1, events: 1, records: 1 });

    for (let index = 0; index < 5; index += 1) {
      expect((await library.loadReview(review.reviewId)).review.reviewId).toBe(review.reviewId);
      expect(buildLocalAgentMemoryEvents(
        playbackEvent(index),
        { identity, state: {} } as unknown as CoachAgentResult,
        userId,
      )).toEqual([]);
    }
    expect(counts()).toEqual({ claims: 1, evidence: 1, events: 1, records: 1 });

    for (let index = 0; index < 5; index += 1) {
      const resumedEvent = reflectionEvent(`resume-${index}`);
      const memoryEvent = buildLocalAgentMemoryEvents(resumedEvent, resultFor(resumedEvent), userId)[0]!;
      const claim = desktopBehaviorOpportunityClaim(
        memoryEvent,
        identity.selectedPlayerId,
        identity.routeHash,
      )!;
      const claimed = await library.claimMemoryOpportunity({
        ...claim,
        evidenceKey: stableClaim.evidenceKey,
        sourceReviewId: review.reviewId,
      });
      expect(claimed.claimed).toBe(false);
    }
    expect(counts()).toEqual({ claims: 1, evidence: 1, events: 1, records: 1 });
    const record = JSON.parse((owner.db.prepare("SELECT record_json FROM memory_records").get() as { record_json: string }).record_json) as {
      occurrenceCount: number;
      demoContentHashes: string[];
    };
    expect(record.occurrenceCount).toBe(1);
    expect(record.demoContentHashes).toEqual([DEMO_HASH]);
    await owner.close();
  });
});
