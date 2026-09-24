import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateMaterial, CandidateSet, DecisionAssessmentPacket, DecisionCheck, TeachingCandidate } from "@cs-coach/contracts";
import { DECISION_ASSESSMENT_VERSIONS as V } from "@cs-coach/contracts";
import { assembleCandidateSet, ruleDecisionAssessment } from "@cs-coach/review-planner";
import { decisionSnapshotFixture } from "../../../../libs/review-planner/src/teaching-gate-fixtures";
import { requestDecisionAssessments } from "./decision-assessment-host";

/** Synthetic, author-created boundary test; fake answers are not model quality evidence. */
function syntheticSet(): CandidateSet {
  const t = 2350, id = "synthetic-candidate";
  const candidate: TeachingCandidate = { candidateId: id, roundNumber: 2, source: { kind: "DEATH", refs: ["source"] }, preRollStart: t - 64, decisionTick: t, revealTick: t + 100, outcomeEnd: t + 200, factRefs: ["fact-count", "fact-delay", "fact-trade", "fact-cover"], observableClaimRefs: [], actionRefs: ["action"], outcomeRefs: ["outcome"], evidenceRefs: ["evidence"], winRateSignalRefs: [], economySignalRefs: [], missingFields: [], limitations: [], deterministicScore: 5, resultSummary: { selectedPlayerDeath: true, economyClass: "FULL", concurrentEvents: false, missingFields: [], limitations: [] } };
  const snapshot = decisionSnapshotFixture(t, "fact-count"); snapshot.roundNumber = 2;
  snapshot.aliveCounts.value = { allies: 3, enemies: 2, includesSelectedPlayer: true };
  const check = (code: string, yes: boolean, ref: string): DecisionCheck => ({ code, status: yes ? "APPLICABLE" : "INAPPLICABLE", boundary: "OBSERVABLE", evidenceRefs: [ref], missingFields: [], reason: "synthetic condition" });
  snapshot.pressureChecks = [check("objectiveAllowsDelay", true, "fact-delay")]; snapshot.supportChecks = [check("tradeWindow", false, "fact-trade")]; snapshot.spatialChecks = [check("safeReachableCover", true, "fact-cover")];
  const material: CandidateMaterial = { candidateId: id, decisionSnapshot: snapshot, decisionFacts: candidate.factRefs.map((id) => ({ id, text: "已知条件。", availability: "DECISION", available_at_tick: t, source: "DEMO", observed_by_player: true })), playerActionFacts: [{ id: "action", text: "你再次探身。", actorPlayerId: "p-user", availableAtTick: t + 32, source: "DEMO", evidenceRefs: ["action-source"], limitations: [], decisionAction: { version: "decision-action.v1", kind: "REPEEK", startTick: t, endTick: t + 32, priorContactTick: t - 100, source: "SYNTHETIC_REGRESSION" } }], outcomeFacts: [{ id: "outcome", text: "随后阵亡。", availableAtTick: t + 100, source: "DEMO", outcomeKind: "DEATH", evidenceRefs: [], limitations: [] }], inferences: [], advice: [], evidence: [{ id: "evidence", source: "DEMO", label: "现场证据", fact_refs: [...candidate.factRefs] }], limitations: [], observableContext: { version: "observable-decision-context.v1", boundary: "OBSERVABLE", snapshotId: snapshot.snapshotId, source: "DEMO_OBSERVER_EVIDENCE", state: { id: "obs", demo_id: "demo-fixture-mirage-v1", timeline_version: "synthetic", observer_player_id: "p-user", at_tick: t, observation_version: "v1", claims: [], limitations: [] }, publicFacts: [], freshness: { sampledAtTick: t, ageTicks: 0 }, confidence: 1, missingFields: [], limitations: [] } };
  return assembleCandidateSet({ id: "synthetic-set", version: "synthetic-v1", demoId: "demo-fixture-mirage-v1", playerId: "p-user", candidates: [candidate], materials: [material], generationManifest: { timelineVersion: "synthetic", sceneIndexVersion: "synthetic", observationVersion: "synthetic", signalVersion: "synthetic", candidateGeneratorVersion: "synthetic" } });
}

function candidates(variants: number[]): CandidateSet {
  const base = syntheticSet();
  return { ...base,
    candidates: variants.map((_, i) => ({ ...structuredClone(base.candidates[0]!), candidateId: `candidate-${i}` })),
    materials: variants.map((variant, i) => {
      const material = structuredClone(base.materials[0]!);
      material.candidateId = `candidate-${i}`;
      const action = material.playerActionFacts[0]!;
      action.decisionAction!.endTick += variant;
      action.availableAtTick += variant;
      return material;
    })
  };
}
function success(packet: DecisionAssessmentPacket) {
  return { status: "SUCCEEDED", result: { ...ruleDecisionAssessment(packet), model: V.model }, latencyMs: 10, usage: { inputTokens: 20, outputTokens: 5, costUsd: 0.01 } };
}
function transport(delays: number[], options: { configDelay?: number; mode?: string; ignoreAbort?: boolean; hangJson?: boolean } = {}) {
  let active = 0, peak = 0;
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "POST") {
      if (options.configDelay) await new Promise(r => setTimeout(r, options.configDelay));
      return Response.json({ mode: options.mode ?? "JEV_EXPERIMENT", acceptance: "TEST_ONLY" });
    }
    const index = signals.length;
    const signal = init.signal!;
    signals.push(signal);
    active++; peak = Math.max(peak, active);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; active--; } signal.removeEventListener("abort", abort); };
      const abort = () => { if (!options.ignoreAbort) { clearTimeout(timer); finish(); reject(new DOMException("cancelled", "AbortError")); } };
      const timer = setTimeout(() => {
        finish();
        resolve(options.hangJson ? { ok: true, json: () => new Promise(() => {}) } as Response : Response.json(success(JSON.parse(String(init.body)))));
      }, delays[index] ?? 0);
      signal.addEventListener("abort", abort, { once: true });
    });
  });
  return { fetcher, signals, get peak() { return peak; }, get active() { return active; } };
}
const options = { mapName: "de_mirage", tickRate: 64 };
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { await vi.runAllTimersAsync(); vi.useRealTimers(); });

describe("decision assessment preparation scheduling", () => {
  it("bounds shadow preparation to 6000ms after configuration, cancels in-flight work and marks unstarted candidates", async () => {
    const set = candidates(Array.from({ length: 10 }, (_, i) => i));
    const t = transport(Array(10).fill(10_000), { configDelay: 500, mode: "JEV_SHADOW" });
    let completed = false;
    const pending = requestDecisionAssessments(set, { ...options, fetcher: t.fetcher }).then(result => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(6499);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toBe(true);
    const result = await pending;
    expect(t.peak).toBe(2);
    expect(result.run.calls).toBe(4);
    expect(t.signals.every(s => s.aborted)).toBe(true);
    expect(result.run.records.slice(4).map(r => r.reason)).toEqual(Array(6).fill("SESSION_TIME_BUDGET"));
    expect(result.run.records.slice(2, 4).every(r => r.artifact?.rejectionReasons.includes("SESSION_TIME_BUDGET"))).toBe(true);
    expect(result.candidateSet).toBe(set);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains completed assessments in candidate order while stopping slow work", async () => {
    const set = candidates([0, 1, 2, 3, 4]), before = structuredClone(set);
    const t = transport([10_000, 10, 10_000, 10_000]);
    const pending = requestDecisionAssessments(set, { ...options, fetcher: t.fetcher, sessionTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.run.records.map(r => r.candidateId)).toEqual(set.candidates.map(c => c.candidateId));
    expect(result.run.accepted).toBe(1);
    expect(result.candidateSet.candidates[1]?.decisionAssessment?.status).toBe("ACCEPTED");
    expect(result.run.records.slice(3).map(r => r.reason)).toEqual(["SESSION_TIME_BUDGET", "SESSION_TIME_BUDGET"]);
    expect(set).toEqual(before);
    expect(t.active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates in-flight packets without sharing candidate bindings", async () => {
    const set = candidates([0, 0, 1]);
    const t = transport([20, 10]);
    const pending = requestDecisionAssessments(set, { ...options, fetcher: t.fetcher });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.run.calls).toBe(2);
    expect(t.signals).toHaveLength(2);
    expect(result.run.accepted).toBe(3);
    expect(result.run.records.map(r => r.artifact?.binding.candidateId)).toEqual(set.candidates.map(c => c.candidateId));
  });

  it("reuses completed requests and saved artifacts even after ten new requests", async () => {
    const set = candidates([...Array.from({ length: 11 }, (_, i) => i), 0, 11]);
    const seedSet = { ...set, candidates: [set.candidates[10]!], materials: [set.materials[10]!] };
    const seedTransport = transport([0]);
    const seeded = requestDecisionAssessments(seedSet, { ...options, fetcher: seedTransport.fetcher });
    await vi.runAllTimersAsync();
    set.materials[10]!.decisionAssessment = (await seeded).run.records[0]!.artifact;
    const before = structuredClone(set), t = transport(Array(10).fill(0));
    const pending = requestDecisionAssessments(set, { ...options, fetcher: t.fetcher });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.run.calls).toBe(10);
    expect(t.signals).toHaveLength(10);
    expect(t.peak).toBe(2);
    expect(result.run.records[10]?.reason).toBe("SAVED_ARTIFACT_REUSED");
    expect(result.run.records[11]?.artifact?.status).toBe("ACCEPTED");
    expect(result.run.records[12]?.reason).toBe("SESSION_REQUEST_BUDGET");
    expect(result.run.accepted).toBe(12);
    expect(set).toEqual(before);
  });

  it.each([false, true])("cancels user preparation and discards late transport/body responses (body=%s)", async (hangJson) => {
    const set = candidates([0, 1, 2]), before = structuredClone(set);
    const controller = new AbortController();
    const t = transport([50, 50], { ignoreAbort: true, hangJson });
    const pending = requestDecisionAssessments(set, { ...options, fetcher: t.fetcher, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(hangJson ? 50 : 1);
    controller.abort();
    await rejected;
    expect(t.signals.every(s => s.aborted)).toBe(true);
    await vi.runAllTimersAsync();
    expect(t.signals).toHaveLength(2);
    expect(set).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds the session while transport/body ignores abort (body=%s)", async (hangJson) => {
    const set = candidates([0, 1, 2]);
    const t = transport(hangJson ? [0, 0] : [150, 150], { ignoreAbort: true, hangJson });
    const pending = requestDecisionAssessments(set, { ...options, fetcher: t.fetcher, sessionTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending, before = structuredClone(result);
    expect(result.run.accepted).toBe(0);
    expect(result.run.records[2]?.reason).toBe("SESSION_TIME_BUDGET");
    expect(t.signals.every(s => s.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toEqual(before);
    expect(t.signals).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
