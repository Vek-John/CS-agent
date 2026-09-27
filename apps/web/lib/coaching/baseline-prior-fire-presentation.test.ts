import { expect, it } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { fireReplay, self, shot } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "./cs2d-coaching-view";

function fixture(actor: string | null = self, at = 1392) {
  // Synthetic occurrence and timestamps, not measured Demo ticks.
  const analysis = buildCs2dAnalysisBundle({ replay: fireReplay("DEATH", [shot(at, actor)]), selectedSteamId: self, demoId: "synthetic-prior-fire-view" });
  const cue = analysis.review_plan.cues[0], material = analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const narration = deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set));
  const input = { narration, cue, tickRate: analysis.match_timeline.tick_rate, semantics: { ...material, ...cue }, decisionTick: cue.decision_tick,
    decisionFacts: buildCoachingCueView(cue, false).decisionFacts,
    decisionState: playerStateAtOrBefore(analysis.match_timeline.player_state_tracks ?? [], self, cue.decision_tick), outcomeFacts: [] };
  return { analysis, cue, material, input };
}
it("keeps verified prior self fire visible alongside current resource chips", () => {
  const f = fixture();
  expect(f.material.decisionSnapshot!.selfFireEvents).toHaveLength(1);
  expect(f.input.narration.currentSituation.text).toContain("决策前近期记录到本人开火。");
  const before = JSON.stringify(f.analysis);
  const view = buildThreeStageCoachingView(f.input);
  expect(view.currentState.chips.length).toBeGreaterThan(0);
  expect(view.currentState.priorSelfFire).toEqual({ text: "决策前近期记录到本人开火。", refs: f.material.decisionSnapshot!.selectedPlayer.evidenceRefs });
  const without = buildThreeStageCoachingView({ ...f.input, cue: undefined, tickRate: undefined });
  expect(view.currentState.chips).toEqual(without.currentState.chips);
  expect(view.currentState.limitations).toEqual(without.currentState.limitations);
  expect(view.problem).toEqual(without.problem); expect(view.improvement).toEqual(without.improvement);
  expect(f.material.playerActionFacts).toEqual([]);
  expect(JSON.stringify(f.analysis)).toBe(before);
});


it.each([[null, 1392], ["other", 1392], [self, 1400], [self, 1404], [self, 700]] as const)("does not invent prior occurrence for actor %s at synthetic time %s", (actor, at) => {
  expect(buildThreeStageCoachingView(fixture(actor, at).input).currentState.priorSelfFire).toBeUndefined();
});

it.each(["legacy", "future", "expired", "wrong-player", "dead", "stale", "unknown-health", "invalid-source", "duplicate", "no-refs", "old-prose", "phrase-only", "other-cue", "other-candidate", "not-allowed", "cue-fact-conflict", "missing-rate"])("does not expose a current occurrence from mismatched provenance: %s", mode => {
  const input: Parameters<typeof buildThreeStageCoachingView>[0] = structuredClone(fixture().input);
  const snapshot = input.semantics!.decisionSnapshot!;
  if (mode === "legacy") delete snapshot.selfFireEvents;
  if (mode === "future") snapshot.selfFireEvents = [{ ...snapshot.selfFireEvents![0], tick: snapshot.decisionTick }];
  if (mode === "expired") snapshot.selfFireEvents = [{ ...snapshot.selfFireEvents![0], tick: snapshot.decisionTick - 641 }];
  if (mode === "wrong-player") snapshot.selectedPlayerId = "other";
  if (mode === "dead") { snapshot.selectedPlayer.value!.alive = false; input.decisionState!.alive = false; }
  if (mode === "stale") { snapshot.sampledAtTick = snapshot.decisionTick - 64; input.decisionState!.tick = snapshot.sampledAtTick; }
  if (mode === "unknown-health") snapshot.selectedPlayer.value!.health = null;
  if (mode === "invalid-source") Object.assign(snapshot.selfFireEvents![0], { source: "UNVERIFIED" });
  if (mode === "duplicate") snapshot.selfFireEvents = [...snapshot.selfFireEvents!, ...snapshot.selfFireEvents!];
  if (mode === "no-refs") input.narration.currentSituation.refs = [];
  if (mode === "old-prose") input.narration.currentSituation.text = input.narration.currentSituation.text.replace(" 决策前近期记录到本人开火。", "");
  if (mode === "phrase-only") input.narration.currentSituation.text = "决策前近期记录到本人开火。";
  if (mode === "other-cue") input.narration.cueId = "other";
  if (mode === "other-candidate") input.narration.candidateId = "other";
  if (mode === "not-allowed") input.cue!.observable_fact_refs = [];
  if (mode === "cue-fact-conflict") input.cue!.facts = input.cue!.facts.map(fact => ({ ...fact, observed_by_player: false }));
  if (mode === "missing-rate") input.tickRate = undefined;
  expect(buildThreeStageCoachingView(input).currentState.priorSelfFire).toBeUndefined();
});

it("rejects an event after the bound sample even if it remains before decision", () => {
  const input = structuredClone(fixture().input), snapshot = input.semantics.decisionSnapshot!;
  const sample = snapshot.decisionTick - 8;
  snapshot.sampledAtTick = sample; input.decisionState!.tick = sample;
  input.decisionFacts = input.decisionFacts.map(fact => ({ ...fact, available_at_tick: sample }));
  input.cue.facts = input.cue.facts.map(fact => fact.availability === "DECISION" ? { ...fact, available_at_tick: sample } : fact);
  snapshot.selfFireEvents = [{ ...snapshot.selfFireEvents![0], tick: sample + 4 }];
  expect(buildThreeStageCoachingView(input).currentState.priorSelfFire).toBeUndefined();
});

it("preserves new serialized evidence but never manufactures a note in an old saved narrative", () => {
  const current = fixture();
  const restored = JSON.parse(JSON.stringify(current.input));
  expect(buildThreeStageCoachingView(restored).currentState.priorSelfFire).toEqual(buildThreeStageCoachingView(current.input).currentState.priorSelfFire);
  restored.narration.currentSituation.text = restored.narration.currentSituation.text.replace(" 决策前近期记录到本人开火。", "");
  const before = JSON.stringify(restored);
  expect(buildThreeStageCoachingView(restored).currentState.priorSelfFire).toBeUndefined();
  expect(JSON.stringify(restored)).toBe(before);
});

it("rejects same-tick occurrence with explicit tick-start evidence but keeps legacy no-phase compatibility", () => {
  const input = structuredClone(fixture().input), snapshot = input.semantics.decisionSnapshot!;
  const sample = snapshot.selfFireEvents![0].tick;
  snapshot.sampledAtTick = sample; input.decisionState!.tick = sample;
  input.decisionFacts = input.decisionFacts.map(fact => ({ ...fact, available_at_tick: sample }));
  input.cue.facts = input.cue.facts.map(fact => fact.availability === "DECISION" ? { ...fact, available_at_tick: sample } : fact);
  expect(buildThreeStageCoachingView(input).currentState.priorSelfFire).toBeDefined();
  snapshot.selectedPlayer.value!.groundEvidence = { version: 1, source: "SOURCE2_PAWN_FLAGS", phase: "TICK_START", sampledAtTick: sample, playerId: self, value: null };
  input.decisionState!.ground_evidence = { ...snapshot.selectedPlayer.value!.groundEvidence };
  expect(buildThreeStageCoachingView(input).currentState.priorSelfFire).toBeUndefined();
});
