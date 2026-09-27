// Synthetic Replay source preflight. No Parser, models, real Demo or external IO.
import { it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { buildCs2dAnalysisBundle } from "../libs/cs2d-analysis-adapter/src/index";
import { fireReplay, self, shot } from "../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "../libs/review-planner/src/index";
import { createCoachingSession, getCurrentCue, reduceCoachingSession } from "../libs/session/src/index";
import { currentDiagnosisResources, currentDiagnosisWindow } from "../apps/web/lib/coaching/diagnosis-decision-state";
import { buildTeachingDiagnosisInput, runTeachingDiagnosis } from "../apps/web/lib/coaching/teaching-diagnosis-host";
import { buildCoachingCueView, buildThreeStageCoachingView, playerStateAtOrBefore } from "../apps/web/lib/coaching/cs2d-coaching-view";
import { CurrentCueResourceCache, matchDisplayedCueResources } from "../apps/web/lib/coaching/current-cue-resource-source";
import { buildCurrentCueQuestionContext, answerGroundedCueQuestion } from "../apps/web/lib/coaching/current-cue-questions";
const question = "\u5F53\u65F6\u5F39\u5323\u8FD8\u6709\u51E0\u53D1\uFF1F";
let networkCalls = 0;
function run(mode) {
  const raw = fireReplay("DEATH", mode === "same-tick-shot" ? [shot(1400), shot(1404)] : [shot(1404)]);
  const replay = { ...raw, rounds: raw.rounds.map((round) => ({ ...round, frames: round.frames.map((frame) => ({ ...frame, players: frame.players.map((player) => ({ ...player, weapon: "AK-47", activeWeaponHandle: mode === "handle-mismatch" && frame.tick === 1400 ? 114698 : 114697, ammoSamplingVersion: 2, weaponAmmo: mode === "latest-missing" && frame.tick === 1400 ? void 0 : { source: "SOURCE2_ACTIVE_WEAPON", phase: "TICK_END", version: 2, sampledAtTick: frame.tick - 1, weapon: "AK-47", weaponHandle: 114697, clip: mode === "zero" ? 0 : 7 } })) })) })) };
  const analysis = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "synthetic-baseline-ammo-preflight" }), plan = analysis.review_plan;
  const candidate = analysis.candidate_set.candidates.find((c) => c.source.kind === "DEATH"), cue = plan.cues.find((c) => c.candidate_id === candidate.candidateId);
  const material = analysis.candidate_set.materials.find((m) => m.candidateId === candidate.candidateId);
  const origin = { plan, cue, material, timeline: analysis.match_timeline, selectedPlayerId: self };
  const resources = currentDiagnosisResources(origin, currentDiagnosisWindow(origin));
  const reflection = { cueId: cue.id, selectedGoal: "OTHER", response: "ANSWERED", source: "USER", limitations: [] };
  const diagnosisInput = buildTeachingDiagnosisInput(origin, reflection), diagnosis = runTeachingDiagnosis(origin, reflection);
  const narration = deterministicNarrationBundle(buildCoachingPackage(cue, analysis.candidate_set, analysis.observation_evidence), buildOutcomePackage(cue, analysis.candidate_set));
  const state = playerStateAtOrBefore(analysis.match_timeline.player_state_tracks ?? [], self, cue.decision_tick);
  const view = buildThreeStageCoachingView({ narration, decisionState: state, semantics: { ...material, ...cue }, decisionTick: cue.decision_tick, decisionFacts: buildCoachingCueView(cue, false).decisionFacts, outcomeFacts: [] });
  let session = reduceCoachingSession(plan, createCoachingSession(plan), { type: "START" });
  for (let i = 0; i < 30 && session.phase !== "PAUSED_FOR_COACHING"; i++) {
    const active = getCurrentCue(plan, session);
    session = reduceCoachingSession(plan, session, session.phase === "SKIPPING" ? { type: "SKIP_SEGMENT" } : active ? { type: "TICK", tick: active.outcome_end_tick } : { type: "ADVANCE_SEGMENT" });
  }
  assert.equal(session.current_cue_id, cue.id);
  assert.equal(session.outcome_completion?.status, "COMPLETE");
  const source = new CurrentCueResourceCache().read(origin), input = { plan, session, generation: 1, diagnosticsEnabled: false, presentableNarration: narration, busy: false, takenOver: false, resourceSource: source };
  const baseline = answerGroundedCueQuestion(buildCurrentCueQuestionContext(input), question);
  const diagnosticContext = buildCurrentCueQuestionContext({ ...input, diagnosticsEnabled: true, cueCase: diagnosis.cueCase });
  const diagnostic = answerGroundedCueQuestion(diagnosticContext, question);
  const known = mode === "positive" || mode === "zero";
  assert.equal(resources?.weaponAmmo?.clip, known ? mode === "zero" ? 0 : 7 : void 0);
  assert.equal(baseline.items.length, 0);
  if (known) {
    assert.equal(diagnosisInput.decisionResources?.weaponAmmo?.clip, resources.weaponAmmo.clip);
    assert(!JSON.stringify(diagnosisInput.decisionResources?.weaponAmmo).match(/weapon_handle|sampled_at_tick|player_id/));
  }
  return {
    mode,
    syntheticDecisionTick: cue.decision_tick,
    syntheticContainerTick: state.tick,
    syntheticAmmoTick: state.active_item?.ammo_evidence?.sampled_at_tick ?? null,
    currentHandle: state.active_item?.entity_handle ?? null,
    ammoHandle: state.active_item?.ammo_evidence?.weapon_handle ?? null,
    compact: resources?.weaponAmmo ?? null,
    canonicalStateRefs: material.decisionSnapshot.selectedPlayer.evidenceRefs,
    ammoRefsAreCanonicalState: (resources?.weaponAmmo?.evidenceRefs ?? []).some((ref) => material.decisionSnapshot.selectedPlayer.evidenceRefs.includes(ref)),
    ammoRefsAreCueFact: (resources?.weaponAmmo?.evidenceRefs ?? []).some((ref) => cue.facts.some((f) => f.id === ref)),
    baselineWeaponChip: view.currentState.chips.find((chip) => chip.kind === "weapon")?.text ?? null,
    directMatchedKinds: Object.keys(matchDisplayedCueResources(source, plan, cue, diagnosis.cueCase.diagnosticResult?.measurements ?? [])),
    baselineAnswerCount: baseline.items.length,
    diagnosticAnswerCount: diagnostic.items.length,
    diagnosticResourceKinds: Object.keys(diagnosticContext.resources),
    diagnosticAnswerSource: diagnostic.source,
    diagnosticStatus: diagnosis.cueCase.status,
    diagnosticClipMeasurement: diagnosis.cueCase.diagnosticResult?.measurements.filter((m) => m.id.endsWith("weapon-clip")) ?? []
  };
}
it("checks baseline display versus diagnostic answers using actual guarded ammo sources", () => {
  vi.stubGlobal("fetch", async () => {
    networkCalls++;
    throw Error("NETWORK_NOT_EXPECTED");
  });
  try {
    const rows = ["positive", "zero", "same-tick-shot", "latest-missing", "handle-mismatch"].map(run);
    for (const row of rows) {
      const known = row.mode === "positive" || row.mode === "zero";
      expect(row.diagnosticAnswerCount).toBe(known ? 1 : 0);
      expect(row.baselineAnswerCount).toBe(0);
      expect(row.ammoRefsAreCanonicalState).toBe(false);
      expect(row.ammoRefsAreCueFact).toBe(false);
      expect(row.compact?.clip).toBe(known ? row.mode === "zero" ? 0 : 7 : void 0);
    }
    expect(networkCalls).toBe(0);
    const output = process.env.CS_COACH_AMMO_PREFLIGHT_OUTPUT;
    if (output) {
      const path = resolve(output);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ synthetic: true, networkCalls, rows }, null, 2) + "\n", { flag: "wx" });
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
export {
  run
};
