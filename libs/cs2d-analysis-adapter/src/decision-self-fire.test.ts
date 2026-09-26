import { describe, expect, it } from "vitest";
import { assembleCandidateSet, compileReviewPlan, deterministicDirectorFallback, buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { buildDecisionSnapshot, assertDecisionSnapshot, deserializeCs2dAnalysisBundle, serializeCs2dAnalysisBundle, type Cs2dRound } from "./index";
import { analyzeFire, fireReplay, shot, self } from "./window-self-fire-fixtures";
import { decisionSelfFireText } from "./decision-self-fire";
import { matchesDecisionState, verifiedUtilityKindText } from "../../../apps/web/lib/coaching/utility-kind-evidence";

// Synthetic regression times, never presented as measured Demo ticks.
function prepared(tick = 1392, actor: string | null = self) {
  const source = fireReplay("DEATH", [shot(tick, actor)]);
  const replay = { ...source, rounds: source.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame, players: frame.players.map(player => ({ ...player, grenadeInventoryVersion: 1 as const, grenades: ["Flash"] })) })) })) };
  const bundle = analyzeFire(replay);
  const candidate = bundle.candidate_set.candidates.find(item => item.source.kind === "DEATH")!;
  const cue = bundle.review_plan.cues.find(item => item.candidate_id === candidate.candidateId)!;
  const material = bundle.candidate_set.materials.find(item => item.candidateId === candidate.candidateId)!;
  const coaching = buildCoachingPackage(cue, bundle.candidate_set, bundle.observation_evidence);
  const narration = deterministicNarrationBundle(coaching, buildOutcomePackage(cue, bundle.candidate_set));
  return { bundle, candidate, cue, material, coaching, narration };
}
function snapshot(round: Cs2dRound = fireReplay("DEATH", [shot(1392)]).rounds[0], decisionTick = 1400) {
  return buildDecisionSnapshot({ round, decisionTick, selectedPlayerId: self, tickRate: 64, snapshotId: "synthetic-prior-fire", rosterIds: [self] });
}

describe("prior self fire remains decision context, not action or tactical judgment", () => {
  it("adds one sourced occurrence to actual Adapter/CoachingPackage/Narration without displacing existing facts or resource citations", () => {
    const current = prepared(), baseline = prepared(1392, null);
    expect(current.coaching.decisionContext.facts).toHaveLength(baseline.coaching.decisionContext.facts.length);
    expect(current.narration.currentSituation.text.split(decisionSelfFireText())).toHaveLength(2);
    expect(current.narration.currentSituation.text.replace(` ${decisionSelfFireText()}`, "")).toBe(baseline.narration.currentSituation.text);
    expect(current.narration.currentSituation.refs).toEqual(baseline.narration.currentSituation.refs);
    expect(current.coaching.decisionContext.facts.slice(1)).toEqual(baseline.coaching.decisionContext.facts.slice(1));
    const snap = current.material.decisionSnapshot!;
    expect(snap.selfFireEvents).toEqual([{ source: "DEMO_WEAPON_FIRE", sourceRef: "cs2d-r1-event-1", tick: 1392 }]);
    const state = current.bundle.match_timeline.player_state_tracks!.find(row => row.player_id === self && row.tick === snap.sampledAtTick)!;
    expect(matchesDecisionState(state, current.material, current.cue.decision_tick, current.coaching.decisionContext.facts)).toBe(true);
    expect(verifiedUtilityKindText(state, current.material, current.cue.decision_tick, current.coaching.decisionContext.facts)).toBe("闪光弹（数量未知）");
    expect(current.material.playerActionFacts).toEqual([]);
    const signature = (value: ReturnType<typeof prepared>) => ({
      candidates: value.bundle.candidate_set.candidates.map(c => ({ id: c.candidateId, decision: c.decisionTick, reveal: c.revealTick, end: c.outcomeEnd, score: c.deterministicScore, assessment: c.assessment?.kind, actionRefs: c.actionRefs })),
      route: value.bundle.review_plan.cues.map(c => ({ id: c.id, candidate: c.candidate_id, decision: c.decision_tick, reveal: c.reveal_tick, end: c.outcome_end_tick, assessment: c.assessment?.kind, actionRefs: c.action_fact_refs })),
    });
    expect(signature(current)).toEqual(signature(baseline));
  });
  it.each([[1392, null], [1392, "other"], [1400, self], [1404, self], [999, self], [1392.5, self], [NaN, self]] as const)("does not narrate prior self fire for tick %s / actor %s", (tick, actor) => {
    const current = prepared(tick, actor);
    expect(current.material.decisionSnapshot!.selfFireEvents).toEqual([]);
    expect(current.narration.currentSituation.text).not.toContain(decisionSelfFireText());
  });
  it("preserves new provenance on JSON restore and accepts legacy 1.11 snapshots without the new field", () => {
    const current = prepared();
    expect(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(current.bundle))).toEqual(current.bundle);
    const legacy = JSON.parse(JSON.stringify(prepared(1392, null).bundle, (key, value) => key === "selfFireEvents" ? undefined : value));
    legacy.metadata.adapter_version = "cs2d-analysis-adapter/1.11.0";
    // A legacy-shaped fixture is assembled before freezing; never mutate an immutable saved hash.
    legacy.candidate_set = assembleCandidateSet(legacy.candidate_set);
    legacy.review_plan = compileReviewPlan({ timeline: legacy.match_timeline, candidateSet: legacy.candidate_set,
      directorDecisionSet: deterministicDirectorFallback(legacy.candidate_set), planId: legacy.review_plan.id,
      observationVersion: legacy.candidate_set.generationManifest.observationVersion, signalVersion: legacy.candidate_set.generationManifest.signalVersion }).plan;
    expect(deserializeCs2dAnalysisBundle(JSON.stringify(legacy))).toEqual(legacy);
  });
  it("bounds recent parser references without claiming a count", () => {
    const snap = snapshot(fireReplay("DEATH", [shot(1360), shot(1370), shot(1380), shot(1390)]).rounds[0]);
    expect(snap.selfFireEvents?.map(event => event.sourceRef)).toEqual(["cs2d-r1-event-2", "cs2d-r1-event-3", "cs2d-r1-event-4"]);
    expect(decisionSelfFireText()).not.toMatch(/目标|命中|视线|意图|错误|\d/);
    expect(() => assertDecisionSnapshot(snap)).not.toThrow();
  });
  it("does not merge a shot newer than the bound state sample", () => {
    const original = fireReplay("DEATH", [shot(1396)]).rounds[0];
    const snap = snapshot({ ...original, frames: original.frames.filter(frame => frame.tick !== 1400) });
    expect(snap.sampledAtTick).toBe(1392); expect(snap.selfFireEvents).toEqual([]);
  });
  it.each(["stale", "missing-self", "zero-health", "outside-live", "expired"])("rejects unavailable context: %s", mode => {
    const original = fireReplay("DEATH", [shot(1392)]).rounds[0];
    const round = mode === "stale" ? { ...original, frames: original.frames.filter(frame => frame.tick < 1360) }
      : mode === "missing-self" ? { ...original, frames: original.frames.map(frame => ({ ...frame, players: [] })) }
      : mode === "zero-health" ? { ...original, frames: original.frames.map(frame => ({ ...frame, players: frame.players.map(player => ({ ...player, health: 0 })) })) }
      : mode === "outside-live" ? { ...original, startTick: 1396 }
      : { ...original, freezeStartTick: 0, startTick: 64, events: [shot(700)], frames: original.frames };
    expect(snapshot(round).selfFireEvents).toEqual([]);
  });
  it.each(["kill", "dead-frame", "fatal-hurt"] as const)("rejects prior or untimed self death: %s", kind => {
    for (const tick of [1380, NaN]) {
      const original = fireReplay("DEATH", [shot(1392)]).rounds[0];
      const round = kind === "kill" ? { ...original, events: [...original.events, { type: "kill" as const, tick, t: 0, victimSteamId: self, attackerSteamId: "other", assisterSteamId: null, assistedFlash: false, weapon: "ak47", headshot: false, x: 0, y: 0, z: 0 }] }
        : kind === "dead-frame" ? { ...original, frames: [...original.frames, { ...original.frames[0], tick, players: original.frames[0].players.map(player => ({ ...player, alive: false })) }] }
        : { ...original, hurtEvents: [{ id: "synthetic-fatal", tick, victimSteamId: self, reportedHealthAfter: 0 }] };
      expect(snapshot(round).selfFireEvents).toEqual([]);
    }
  });
  it("rejects malformed persisted source/timing/extra fields and duplicate references", () => {
    const original = snapshot();
    for (const modify of [
      (s: typeof original) => { s.selfFireEvents = [...s.selfFireEvents!, ...s.selfFireEvents!]; },
      (s: typeof original) => { s.selfFireEvents = [{ ...s.selfFireEvents![0], tick: s.decisionTick }]; },
      (s: typeof original) => { s.selfFireEvents = [{ ...s.selfFireEvents![0], sourceRef: "cs2d-r2-event-1" }]; },
      (s: typeof original) => { Object.assign(s.selfFireEvents![0], { actor: "invented" }); },
    ]) { const restored = structuredClone(original); modify(restored); expect(() => assertDecisionSnapshot(restored)).toThrow(); }
  });
});
