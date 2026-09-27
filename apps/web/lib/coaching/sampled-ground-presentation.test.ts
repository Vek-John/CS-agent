import { expect, it } from "vitest";
import { isGroundSampleEvidence, groundSampleText, type GroundSampleEvidence } from "@cs-coach/contracts";
import { buildCs2dAnalysisBundle, serializeCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, assertDecisionSnapshot } from "@cs-coach/cs2d-analysis-adapter";
import { TeachingDiagnosisInputSchema } from "@cs-coach/coach-agent";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import nativeSamples from "../../../../libs/cs2d-analysis-adapter/src/ground-sample-native-fixture.json";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "./cs2d-coaching-view";

// These three small objects were emitted by actual Rust GroundSampleEvidence serde tests.
// Synthetic frame times are not measured Demo ticks. No parser, model or network runs here.
function fixture(value: GroundSampleEvidence["value"] | "ABSENT" = "FLAG_SET") {
  const source = fireReplay("DEATH");
  const evidence = nativeSamples.find(item => item.value === value);
  if (value !== "ABSENT" && !isGroundSampleEvidence(evidence)) throw new Error("Native fixture invalid");
  const replay = { ...source, rounds: source.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame,
    players: frame.players.map(player => ({ ...player, ...(frame.tick === evidence?.sampledAtTick ? { groundEvidence: evidence as GroundSampleEvidence } : {}) })) })) })) };
  const analysis = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-ground" });
  return { analysis, replay };
}
function viewInput(analysis: ReturnType<typeof fixture>["analysis"]) {
  const cue = analysis.review_plan.cues[0], material = analysis.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const narration = deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set));
  return { narration, cue, tickRate: analysis.match_timeline.tick_rate, semantics: { ...material, ...cue }, decisionTick: cue.decision_tick,
    decisionFacts: buildCoachingCueView(cue, false).decisionFacts,
    decisionState: playerStateAtOrBefore(analysis.match_timeline.player_state_tracks ?? [], self, cue.decision_tick), outcomeFacts: [] };
}
it.each(["FLAG_SET", "FLAG_UNSET", null] as const)("preserves native %s through Adapter, runtime schema, stored JSON and real baseline view", value => {
  const { analysis } = fixture(value);
  const input = viewInput(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(analysis)));
  expect(input.decisionState?.ground_evidence?.value).toBe(value);
  const parsed = TeachingDiagnosisInputSchema.shape.decisionState.parse(input.decisionState);
  expect(parsed?.ground_evidence).toEqual(input.decisionState!.ground_evidence);
  expect(input.semantics.decisionSnapshot!.selectedPlayer.value!.groundEvidence).toEqual(parsed!.ground_evidence);
  expect(input.narration.currentSituation.text).toContain(groundSampleText(value));
  expect(buildThreeStageCoachingView(input).currentState.sampledGround).toEqual({ text: groundSampleText(value), refs: input.semantics.decisionSnapshot!.selectedPlayer.evidenceRefs });
});
it("keeps legacy absence, old narration and current gameplay qualifications unchanged", () => {
  const old = fixture("ABSENT").analysis;
  Object.assign(old.metadata, { adapter_version: "cs2d-analysis-adapter/1.12.0" });
  const restored = deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(old));
  expect(buildThreeStageCoachingView(viewInput(restored)).currentState.sampledGround).toBeUndefined();
  const current = fixture().analysis, currentInput = viewInput(current);
  expect(buildThreeStageCoachingView({ ...currentInput, narration: viewInput(old).narration }).currentState.sampledGround).toBeUndefined();
  const stable = (a: typeof current) => a.candidate_set.candidates.map(c => ({ decision: c.decisionTick, window: [c.preRollStart, c.revealTick, c.outcomeEnd], score: c.deterministicScore, kind: c.assessment?.kind, actions: c.actionRefs }));
  expect(stable(current)).toEqual(stable(old));
  expect(current.review_plan.cues.map(c => c.action_fact_refs)).toEqual(old.review_plan.cues.map(c => c.action_fact_refs));
});
it.each(["phase", "source", "value", "future", "player", "extra"])("rejects invalid source object across raw, stored timeline and actual runtime receiver: %s", mode => {
  const { analysis, replay } = fixture();
  const input = viewInput(analysis), state = input.decisionState!;
  const bad = { ...state.ground_evidence! } as Record<string, unknown>;
  if (mode === "phase") bad.phase = "TICK_END";
  if (mode === "source") bad.source = "UNVERIFIED";
  if (mode === "value") bad.value = false;
  if (mode === "future") bad.sampledAtTick = state.tick + 8;
  if (mode === "player") bad.playerId = "other";
  if (mode === "extra") bad.velocity = 0;
  const badState = { ...state, ground_evidence: bad };
  expect(TeachingDiagnosisInputSchema.shape.decisionState.safeParse(badState).success).toBe(false);
  const timelineBad = structuredClone(analysis);
  const sample = timelineBad.match_timeline.player_state_tracks!.find(p => p.tick === state.tick && p.player_id === self)!;
  Object.assign(sample, { ground_evidence: bad });
  expect(() => deserializeCs2dAnalysisBundle(JSON.stringify(timelineBad))).toThrow();
  const snap = structuredClone(input.semantics.decisionSnapshot!);
  Object.assign(snap.selectedPlayer.value!, { groundEvidence: bad });
  expect(() => assertDecisionSnapshot(snap)).toThrow();
  const frame = replay.rounds[0].frames.find(f => f.tick === state.tick)!;
  Object.assign(frame.players[0], { groundEvidence: bad });
  expect(() => buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-ground" })).toThrow();
});
it.each(["no-ref", "legacy-prose", "other-cue", "stale", "dead", "mismatch", "fact-conflict"])("does not render mismatched current evidence: %s", mode => {
  const input = structuredClone(viewInput(fixture().analysis));
  if (mode === "no-ref") input.narration.currentSituation.refs = [];
  if (mode === "legacy-prose") input.narration.currentSituation.text = "旧版已保存讲解。";
  if (mode === "other-cue") input.cue.id += "-other";
  if (mode === "stale") input.decisionState!.tick -= 64;
  if (mode === "dead") input.decisionState!.alive = false;
  if (mode === "mismatch") input.decisionState!.ground_evidence!.value = "FLAG_UNSET";
  if (mode === "fact-conflict") input.decisionFacts[0].observed_by_player = false;
  expect(buildThreeStageCoachingView(input).currentState.sampledGround).toBeUndefined();
});

it("projects nonliving source to explicit unknown and does not narrate a known ground claim", () => {
  const { replay } = fixture();
  for (const frame of replay.rounds[0].frames) if (frame.tick === 1400) Object.assign(frame.players[0], { alive: false, health: 0 });
  const analysis = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-ground" });
  const state = analysis.match_timeline.player_state_tracks!.find(p => p.tick === 1400)!;
  expect(state.ground_evidence?.value).toBeNull();
  const input = viewInput(deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(analysis)));
  expect(input.semantics.decisionSnapshot!.selectedPlayer.value!.groundEvidence?.value).toBeNull();
  expect(buildThreeStageCoachingView(input).currentState.sampledGround).toBeUndefined();
  expect(input.narration.currentSituation.text).not.toContain("地面接触");
});

it.each([{ alive: false }, { health: 0 }, { alive: undefined }])("rejects stored and runtime known ground on nonliving/unknown player %j", change => {
  const { analysis } = fixture(); const state = viewInput(analysis).decisionState!;
  Object.assign(state, change);
  expect(TeachingDiagnosisInputSchema.shape.decisionState.safeParse(state).success).toBe(false);
  const snapshot = structuredClone(viewInput(fixture().analysis).semantics.decisionSnapshot!);
  Object.assign(snapshot.selectedPlayer.value!, change);
  expect(() => assertDecisionSnapshot(snapshot)).toThrow();
  expect(() => deserializeCs2dAnalysisBundle(JSON.stringify(analysis))).toThrow();
  state.ground_evidence!.value = null;
  expect(TeachingDiagnosisInputSchema.shape.decisionState.safeParse(state).success).toBe(true);
});
