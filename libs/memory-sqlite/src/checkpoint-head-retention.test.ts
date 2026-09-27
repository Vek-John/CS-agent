import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCoachAgentRuntime } from "@cs-coach/coach-agent";
import { DesktopReviewLibrary } from "../../review-library/src/server";
import { SqliteDatabaseOwner } from "./database";
import { SqliteCheckpointSaver } from "./checkpoint";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cs-head-retention-"));
  const path = join(directory, "test.sqlite3");
  const owner = new SqliteDatabaseOwner({ path });
  try {
    const library = new DesktopReviewLibrary({ owner, dataRoot: directory });
    await library.initialize();
    // Synthetic relational metadata only: no Demo bytes or user files.
    owner.db.prepare("INSERT INTO demo_assets(demo_id,content_hash,relative_path,original_filename,byte_size,status,imported_at,last_opened_at) VALUES('demo',?,'synthetic.dem','synthetic.dem',8,'READY','2026-09-27','2026-09-27')").run("a".repeat(64));
    const review = await library.createReview({ demoId: "demo", selectedPlayerId: "player", selectedPlayerName: "Synthetic", title: "Retention" });
    const revision = await library.startRevision({ reviewId: review.reviewId, analysisVersion: "synthetic", graphVersion: "synthetic", promptVersion: "synthetic", modelMetadata: {}, routeId: "route", routeHash: "hash" });
    const identity = { sessionId: "session", runId: "run", demoId: "demo", demoContentHash: "a".repeat(64), selectedPlayerId: "player", routeId: "route", routeHash: "hash" };
    const runtime = createCoachAgentRuntime({ checkpoint: "memory" });
    const ordinary = await runtime.dispatch({ version: "coach-agent-event.v2", type: "OBSERVE_SEGMENT", eventId: "observe", identity, segmentId: "ordinary", segmentIndex: 0, mode: "BRIEF", currentSessionPhase: "PLAYING" });
    const completed = await runtime.dispatch({ version: "coach-agent-event.v2", type: "COMPLETE_SESSION", eventId: "complete", identity });
    expect(completed.state.sessionStatus).toBe("COMPLETED");
    const saver = new SqliteCheckpointSaver({ owner });
    const config = { configurable: { thread_id: "thread", checkpoint_ns: "" } };
    const put = (id: string, complete = false, scope = config) => saver.put(scope, {
      v: 4, id, ts: "2026-09-27T00:00:00Z", channel_values: { agent: complete ? completed.state : ordinary.state }, channel_versions: {}, versions_seen: {},
    }, { source: "input", step: 0, parents: {} }, {});
    await put("pinned");
    const plan = { id: "route", cues: [], available_until_round: 1, segments: [{ id: "ordinary", mode: "BRIEF", cue_ids: [], round_number: 1, start_tick: 0, end_tick: 100 }] };
    const recovery = { ...identity, agentCheckpointId: "pinned", frozenReviewPlan: plan,
      boundary: { kind: "ORDINARY_SEGMENT", boundaryId: "ordinary-boundary", segmentId: "ordinary", segmentIndex: 0, sessionPhase: "PLAYING" },
      cueProgress: { completedCueIds: [], consumedCueIds: [], presentedCueIds: [], revealedCueIds: [] }, routeReadiness: {}, toolLedger: [], narrationArtifacts: [] };
    for (const [kind, key, payload] of [["ANALYSIS_BUNDLE", "analysis", {}], ["CANDIDATE_SET", "candidates", {}], ["REVIEW_PLAN", "route", plan], ["SESSION_RECOVERY", "ordinary-boundary", recovery]] as const) {
      await library.appendArtifact({ reviewRevisionId: revision.reviewRevisionId, artifactType: kind, artifactKey: key, artifactRevision: 1, schemaVersion: "synthetic", payload, idempotencyKey: key });
    }
    const input = { reviewId: review.reviewId, reviewRevisionId: revision.reviewRevisionId, recoveryArtifactKey: "ordinary-boundary", recoveryArtifactRevision: 1,
      ...identity, recoveryBoundary: "ORDINARY_SEGMENT" as const, checkpointThreadId: "thread", checkpointNamespace: "", checkpointId: "pinned", defaultRouteCursor: 0, completedCueCount: 0, totalCueCount: 0, stableProgress: {} };
    const head = await library.commitRuntimeHead(input);
    const exact = { configurable: { ...config.configurable, checkpoint_id: "pinned" } };
    await saver.putWrites(exact, [["held", { value: 1 }]], "pending-write");
    return { directory, path, owner, library, saver, config, put, exact, input, head, recovery };
  } catch (error) { await owner.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

it.each([false, true])("keeps head plus its writes under default retention (completed pressure: %s) and after reopening", async complete => {
  const f = await fixture();
  let reopened: SqliteDatabaseOwner | undefined;
  try {
    const keep = complete ? 3 : 20;
    await f.put("garbage", complete);
    await f.saver.putWrites({ configurable: { ...f.config.configurable, checkpoint_id: "garbage" } }, [["old", 1]], "garbage-write");
    for (let index = 1; index <= keep; index++) await f.put(`later-${index}`, complete);
    const tuple = await f.saver.getTuple(f.exact);
    expect(tuple?.checkpoint.id).toBe("pinned");
    expect(tuple?.pendingWrites).toEqual([["pending-write", "held", { value: 1 }]]);
    expect(f.owner.db.prepare("SELECT COUNT(*) AS n FROM agent_checkpoints").get()).toEqual({ n: keep + 1 });
    expect(f.owner.db.prepare("SELECT * FROM agent_checkpoint_writes WHERE checkpoint_id='garbage'").all()).toEqual([]);
    expect((await f.library.loadReview(f.input.reviewId)).runtimeHead).toEqual(f.head);
    await f.owner.close();
    reopened = new SqliteDatabaseOwner({ path: f.path });
    const restored = await new SqliteCheckpointSaver({ owner: reopened }).getTuple(f.exact);
    expect(restored?.checkpoint.id).toBe("pinned"); expect(restored?.pendingWrites).toEqual(tuple?.pendingWrites);
  } finally { await (reopened ?? f.owner).close(); await rm(f.directory, { recursive: true, force: true }); }
});

it.each(["moved", "deleted"])("reclaims an old pin on the next put when the head is %s", async mode => {
  const f = await fixture();
  try {
    for (let index = 1; index <= 20; index++) await f.put(`later-${index}`);
    expect((await f.saver.getTuple(f.exact))?.checkpoint.id).toBe("pinned");
    if (mode === "moved") {
      await f.library.appendArtifact({ reviewRevisionId: f.input.reviewRevisionId, artifactType: "SESSION_RECOVERY", artifactKey: f.input.recoveryArtifactKey,
        artifactRevision: 2, schemaVersion: "synthetic", payload: { ...f.recovery, agentCheckpointId: "later-20" }, idempotencyKey: "recovery-moved" });
      await f.library.commitRuntimeHead({ ...f.input, recoveryArtifactRevision: 2, checkpointId: "later-20", expectedRecoveryArtifactId: f.head.recoveryArtifactId });
    } else {
      await f.owner.enqueueWrite(db => { db.prepare("DELETE FROM review_runtime_heads WHERE review_id=?").run(f.input.reviewId); });
    }
    await f.put("later-21");
    expect(await f.saver.getTuple(f.exact)).toBeUndefined();
    expect(f.owner.db.prepare("SELECT * FROM agent_checkpoint_writes WHERE checkpoint_id='pinned'").all()).toEqual([]);
    expect(f.owner.db.prepare("SELECT COUNT(*) AS n FROM agent_checkpoints").get()).toEqual({ n: 20 });
  } finally { await f.owner.close(); await rm(f.directory, { recursive: true, force: true }); }
});

it("does not pin identical checkpoint IDs from a different thread or namespace", async () => {
  const f = await fixture();
  try {
    for (const configurable of [{ thread_id: "another-thread", checkpoint_ns: "" }, { thread_id: "thread", checkpoint_ns: "another-ns" }]) {
      const scope = { configurable };
      await f.put("pinned", false, scope);
      for (let index = 1; index <= 20; index++) await f.put(`later-${index}`, false, scope);
      expect(await f.saver.getTuple({ configurable: { ...configurable, checkpoint_id: "pinned" } })).toBeUndefined();
      expect((await f.saver.getTuple(scope))?.checkpoint.id).toBe("later-20");
    }
    expect((await f.saver.getTuple(f.exact))?.checkpoint.id).toBe("pinned");
  } finally { await f.owner.close(); await rm(f.directory, { recursive: true, force: true }); }
});
