import { expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachingSession } from "@cs-coach/session";
import { fireReplay, self, shot } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildNarratorRequestContext, requestNarrationBundle } from "./narrator-contract";
import { buildInitialCoachingRouteState } from "./cs2d-route-integration";
import { buildSessionRecoveryRecord, createRecoverySessionIdentity, restoreRecoveryArtifacts } from "../recovery/cs2d-session-recovery";

function fixture(mode: "live" | "unknown" | "paused" | "planted" = "live") {
  // Synthetic small events, roster and clock fields; not measured Demo ticks.
  const source = fireReplay("DEATH", [shot(1392)]);
  const players = Array.from({ length: 10 }, (_, i) => ({ steamId: i ? `synthetic-${i}` : self, name: `Synthetic ${i}`, startSide: i < 5 ? "T" as const : "CT" as const }));
  const replay = { ...source, players, rounds: source.rounds.map(round => ({ ...round,
    hurtEvents: [{ id: "synthetic-hurt-prior", tick: 1390, victimSteamId: self, reportedHealthAfter: 40 }],
    frames: round.frames.map(frame => ({ ...frame,
      clock: mode === "unknown" ? undefined : { source: "SOURCE2_GAMERULES" as const, sampledAtTick: frame.tick, serverTick: frame.tick + 1024, tickInterval: 1 / 64,
        roundStartTimeSeconds: (round.startTick + 1024) / 64, roundDurationSeconds: 115, roundsPlayed: 0, freeze: false, warmup: false,
        bombPlanted: mode === "planted", roundWinStatus: 0, paused: mode === "paused", totalPausedTicks: 0, pauseObserved: false, clockContinuous: true },
      players: players.map((p, i) => ({ ...frame.players[0], steamId: p.steamId, side: p.startSide, alive: i ? true : frame.players[0].alive, health: i ? 100 : frame.players[0].health })),
    })),
  })) };
  const analysis = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-clock-coverage" });
  const candidate = analysis.candidate_set.candidates.find(c => c.source.kind === "DEATH")!;
  const cue = analysis.review_plan.cues.find(c => c.candidate_id === candidate.candidateId)!;
  const material = analysis.candidate_set.materials.find(m => m.candidateId === candidate.candidateId)!;
  const coaching = buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence);
  const outcome = buildOutcomePackage(cue, analysis.candidate_set);
  return { analysis, cue, material, coaching, outcome };
}

it("keeps the first three facts and makes the legitimate fifth clock fact visible through actual zero-network narration", async () => {
  const f = fixture();
  const facts = f.coaching.decisionContext.facts;
  expect(facts).toHaveLength(5);
  expect(f.material.decisionSnapshot!.clock.evidenceRefs).toContain(facts[4].id);
  expect(f.material.decisionSnapshot!.clock.value?.remainingSeconds).toBe(109.75);
  const firstThree = facts.slice(0, 3).map(fact => fact.text).join(" ");
  expect(firstThree).not.toContain("约110秒");
  const fetcher = vi.fn(() => { throw Error("NETWORK_NOT_EXPECTED"); });
  const context = buildNarratorRequestContext(f.coaching, f.outcome);
  const result = await requestNarrationBundle(context, { fetcher });
  expect(result.bundle.currentSituation.text).toBe(facts.map(fact => fact.text).join(" "));
  expect(result.bundle.currentSituation.text.startsWith(firstThree)).toBe(true);
  expect(result.bundle.currentSituation.text).toContain("约110秒");
  expect(result.bundle.currentSituation.text.length).toBeLessThanOrEqual(1600);
  expect(result.bundle.currentSituation.refs).toEqual(facts.map(fact => fact.id));
  expect(result.manifest).toMatchObject({ provider: "DETERMINISTIC", promptVersion: "review-planner/deterministic-narration/1.3.0", reason: "CLOSED_SEMANTIC_PROJECTION" });
  expect(f.cue.assessment?.kind).toBe("INSUFFICIENT_EVIDENCE");
  expect(result.bundle.currentSituation.text).not.toMatch(/可以等|应该等|C4.*秒|接敌/);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["unknown", "paused", "planted"] as const)("does not invent a countdown for %s context", async mode => {
  const f = fixture(mode), fetcher = vi.fn(() => { throw Error("NETWORK_NOT_EXPECTED"); });
  expect(f.material.decisionSnapshot!.clock.value?.remainingSeconds).toBeNull();
  const result = await requestNarrationBundle(buildNarratorRequestContext(f.coaching, f.outcome), { fetcher });
  expect(result.bundle.currentSituation.text).toContain("剩余时间无法从记录确认");
  expect(result.bundle.currentSituation.text).not.toMatch(/约\d+秒|不足1秒|C4.*秒/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("presents no more than seven decision facts without inspecting IDs or text categories", () => {
  const f = fixture();
  f.coaching.decisionContext.facts = Array.from({ length: 8 }, (_, i) => ({ ...f.coaching.decisionContext.facts[0], id: `arbitrary-${i}`, text: `合成已知事实${i}。` }));
  f.coaching.allowedRefs.decision = f.coaching.decisionContext.facts.map(fact => fact.id);
  const result = deterministicNarrationBundle(f.coaching, f.outcome);
  expect(result.currentSituation.text).toBe(f.coaching.decisionContext.facts.slice(0, 7).map(fact => fact.text).join(" "));
  expect(result.currentSituation.text).not.toContain("事实7");
  expect(result.currentSituation.refs).toEqual(f.coaching.decisionContext.facts.slice(0, 7).map(fact => fact.id));
});

it("keeps fitting fourth/fifth facts when the sixth exceeds the limit, without cutting a sentence", () => {
  const f = fixture();
  f.coaching.decisionContext.facts = Array.from({ length: 6 }, (_, i) => ({ ...f.coaching.decisionContext.facts[0], id: `length-${i}`, text: String(i).repeat(300) }));
  f.coaching.allowedRefs.decision = f.coaching.decisionContext.facts.map(fact => fact.id);
  const result = deterministicNarrationBundle(f.coaching, f.outcome);
  expect(result.currentSituation.text).toBe(f.coaching.decisionContext.facts.slice(0, 5).map(fact => fact.text).join(" "));
  expect(result.currentSituation.text).toHaveLength(1504);
  expect(result.currentSituation.refs).toEqual(f.coaching.decisionContext.facts.slice(0, 5).map(fact => fact.id));
});

it("does not append an extra fact outside the existing decision reference namespace", () => {
  const f = fixture();
  f.coaching.allowedRefs.decision = f.coaching.decisionContext.facts.slice(0, 3).map(fact => fact.id);
  expect(deterministicNarrationBundle(f.coaching, f.outcome).currentSituation.text).toBe(f.coaching.decisionContext.facts.slice(0, 3).map(fact => fact.text).join(" "));
});

it("restores a saved three-fact narration unchanged instead of regenerating the new expanded projection", () => {
  const f = fixture(), plan = f.analysis.review_plan;
  const saved = { ...deterministicNarrationBundle(f.coaching, f.outcome), currentSituation: {
    text: f.coaching.decisionContext.facts.slice(0, 3).map(fact => fact.text).join(" "),
    refs: f.coaching.allowedRefs.decision, limitations: [],
  } };
  const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, cue.id === f.cue.id ? saved : deterministicNarrationBundle(
    buildCoachingPackage(cue, f.analysis.candidate_set, f.analysis.observation_evidence), buildOutcomePackage(cue, f.analysis.candidate_set),
  )]));
  const routeState = buildInitialCoachingRouteState(plan, { narrationByCue });
  const identity = createRecoverySessionIdentity(() => "00000000-0000-4000-8000-000000000003");
  const record = buildSessionRecoveryRecord({ identity, demoContentHash: "a".repeat(64), selectedPlayerId: self, plan, routeState,
    session: createCoachingSession(plan, identity.sessionId, routeState), boundaryKind: "ROUTE_START", narrationByCue, analysis: f.analysis, agentCheckpointId: null });
  const json = JSON.stringify(record);
  const restored = restoreRecoveryArtifacts(JSON.parse(json));
  expect(restored.narrationByCue[f.cue.id].currentSituation).toEqual(saved.currentSituation);
  expect(restored.narrationByCue[f.cue.id].currentSituation.text).not.toContain("约110秒");
  expect(JSON.stringify(record)).toBe(json);
});


it("preserves claim-only limited-context fallback without inventing a fact statement", () => {
  const f = fixture();
  f.coaching.decisionContext.facts = [];
  const refs = f.coaching.decisionContext.claims.map(claim => claim.id).filter(id => f.coaching.allowedRefs.decision.includes(id));
  expect(refs.length).toBeGreaterThan(0);
  const result = deterministicNarrationBundle(f.coaching, f.outcome);
  expect(result.currentSituation).toMatchObject({ text: "当前可用决策事实有限", refs });
});
