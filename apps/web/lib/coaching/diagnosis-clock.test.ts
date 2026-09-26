import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { WinProbabilityTimelineV1 } from "@cs-coach/contracts";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildTeachingDiagnosisInput, buildTeachingDiagnosisSubmissionEvent } from "./teaching-diagnosis-host";
import { TeachingDiagnosisPanel } from "../../components/playback/teaching-diagnosis-panel";
function fixture(known = true, missingPlayer = false) {
  // Synthetic clock samples in a synthetic Replay, never measured Demo ticks.
  const original = fireReplay(missingPlayer ? "HP_CHANGE" : "DEATH", missingPlayer ? [] : undefined);
  const player = original.rounds[0].frames[0].players[0];
  const source = missingPlayer ? { ...original, rounds: original.rounds.map(round => ({ ...round, frames: [
    { tick: 1056, t: 0, players: [player] },
    { tick: 1064, t: 0, players: [] },
    { tick: 1408, t: 0, players: [player] },
  ] })) } : original;
  const replay = { ...source, rounds: source.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame,
    ...(known ? { clock: { source: "SOURCE2_GAMERULES" as const, sampledAtTick: frame.tick, serverTick: frame.tick, tickInterval: 1 / 64,
      roundStartTimeSeconds: round.startTick / 64, roundDurationSeconds: 115, roundsPlayed: 0, freeze: false, warmup: false,
      bombPlanted: false, roundWinStatus: 0, paused: false, totalPausedTicks: 0, pauseObserved: false, clockContinuous: true } } : {}),
  })) })) };
  // Independent nomination signal keeps a real uncertainty cue even without self state.
  // This is a supplied synthetic model result, not a CS-Net inference run.
  const probability: WinProbabilityTimelineV1 = {
    version: "win-probability-timeline.v1", status: "AVAILABLE", tickRate: 64,
    model: { provider: "CS_NET", revision: "synthetic", assetUrl: "/synthetic.onnx", assetSha256: "a".repeat(64), assetBytes: 1, quantization: "INT8", temperature: 1, sourceCommit: "synthetic", featureVersion: "synthetic" },
    rounds: [{ roundNumber: 1, startTick: 1000, endTick: 1800, winner: "CT", economy: { ct: "FULL", t: "FULL", ctValue: 20000, tValue: 20000 }, samples: [
      { tick: 1064, probability: 0.3, roundNumber: 1, side: "CT", source: "CS_NET" },
      { tick: 1408, probability: 0.6, roundNumber: 1, side: "CT", source: "CS_NET" },
    ] }],
    swings: [{ id: "synthetic-drop", tick: 1408, before: 0.3, after: 0.6, delta: 0.3, direction: "UP", cause: "PLAYER_DEATH", selectedPlayerDeath: false, victimSide: "T", economy: "FULL" }], limitations: [],
  };
  const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "clock-diagnosis", ...(missingPlayer ? { winProbabilityTimeline: probability } : {}) });
  const cue = bundle.review_plan.cues[0], material = bundle.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const context = { plan: bundle.review_plan, cue, material, timeline: bundle.match_timeline, selectedPlayerId: self };
  const reflection = { cueId: cue.id, selectedGoal: "DELAY" as const, response: "ANSWERED" as const, source: "USER" as const, limitations: [] };
  return { context, reflection };
}
it("carries the actual parsed clock projection through the strict event and shows it without judging timing", () => {
  const f = fixture();
  const input = buildTeachingDiagnosisInput(f.context, f.reflection);
  const remaining = f.context.material.decisionSnapshot!.clock.value!.remainingSeconds!;
  expect(remaining).toBeGreaterThan(0); expect(input.decisionClock).toMatchObject({ remainingSeconds: remaining });
  const event = buildTeachingDiagnosisSubmissionEvent(f.context, f.reflection, { eventType: "SUBMIT_REFLECTION", eventId: "clock-reflection",
    identity: { sessionId: "session", runId: "run", demoId: "clock-diagnosis", demoContentHash: "a".repeat(64), selectedPlayerId: self,
      routeId: f.context.plan.id, routeHash: "route-hash" } });
  expect(event.input.decisionClock).toEqual(input.decisionClock);
  expect(Object.keys(event.input.decisionClock!)).toEqual(["remainingSeconds", "evidenceRefs"]);
  const output = diagnoseTeachingCue(input);
  expect(output.cueCase.hinge?.kind).toBe("TIMING"); expect(output.cueCase.diagnosticResult?.status).toBe("UNVERIFIABLE");
  expect(output.cueCase.verdict?.type).toBe("INCONCLUSIVE");
  expect(output.cueCase.diagnosticResult?.measurements).toEqual([expect.objectContaining({ value: Math.ceil(remaining), evidenceRefs: input.decisionClock!.evidenceRefs })]);
  expect(output.cueCase.diagnosticResult?.explanation).toContain("不能代表 C4 倒计时");
  const html = renderToStaticMarkup(createElement(TeachingDiagnosisPanel, { cue: f.context.cue, decisionFacts: input.decisionFacts,
    cueCase: JSON.parse(JSON.stringify(output.cueCase)), hasTrustedDecisionContext: true, onSubmit() {}, onSkip() {}, onConfirm() {}, onDisagree() {} }));
  expect(html).toContain("回合剩余时间（约）"); expect(html).toContain("还缺少关键条件");
});
it("retains public clock context when the fresh frame has no selected player", () => {
  const f = fixture(true, true);
  const snapshot = f.context.material.decisionSnapshot!;
  expect(snapshot.selectedPlayer.value).toBeNull();
  expect(snapshot.clock.value?.remainingSeconds).toBeGreaterThan(0);
  const input = buildTeachingDiagnosisInput(f.context, f.reflection);
  expect(input.decisionResources).toBeUndefined();
  expect(input.decisionClock?.remainingSeconds).toBe(snapshot.clock.value!.remainingSeconds);
  const result = diagnoseTeachingCue(input);
  expect(result.cueCase.diagnosticResult?.measurements).toHaveLength(1);
  expect(result.cueCase.verdict?.type).toBe("INCONCLUSIVE");
});
it("keeps legacy/unknown clocks unknown rather than inventing zero seconds", () => {
  const f = fixture(false), input = buildTeachingDiagnosisInput(f.context, f.reflection);
  expect(input.decisionClock).toBeUndefined();
  expect(diagnoseTeachingCue(input).cueCase.diagnosticResult?.measurements).toEqual([]);
});
it.each(["future", "stale", "wrong-player", "wrong-decision", "hidden", "unknown", "not-live", "unobserved", "bad-ref", "outcome-ref"])("does not project %s clock context", kind => {
  const f = fixture(); const snapshot = structuredClone(f.context.material.decisionSnapshot!);
  if (kind === "future") snapshot.sampledAtTick = f.context.cue.decision_tick + 1;
  if (kind === "stale") snapshot.sampledAtTick = f.context.cue.decision_tick - f.context.timeline.tick_rate;
  if (kind === "not-live") snapshot.clock = { ...snapshot.clock, value: { ...snapshot.clock.value!, phase: "POST_ROUND" } };
  if (kind === "wrong-player") snapshot.selectedPlayerId = "other";
  if (kind === "wrong-decision") snapshot.decisionTick++;
  if (kind === "hidden") snapshot.clock = { ...snapshot.clock, boundary: "APPLICABILITY_ONLY" };
  if (kind === "unknown") snapshot.clock = { ...snapshot.clock, value: { ...snapshot.clock.value!, remainingSeconds: null } };
  if (kind === "bad-ref") snapshot.clock = { ...snapshot.clock, evidenceRefs: ["unbound-ref"] };
  if (kind === "outcome-ref") snapshot.clock = { ...snapshot.clock, evidenceRefs: [f.context.cue.outcome_facts![0].id] };
  const context = { ...f.context, material: { ...f.context.material, decisionSnapshot: snapshot, decisionFacts: kind === "unobserved" ? f.context.material.decisionFacts.map(fact => ({ ...fact, observed_by_player: false })) : f.context.material.decisionFacts } };
  expect(buildTeachingDiagnosisInput(context, f.reflection).decisionClock).toBeUndefined();
});
it("ignores compact clock measurements bound only to result facts", () => {
  const f = fixture(), input = buildTeachingDiagnosisInput(f.context, f.reflection);
  const invalid = { ...input, decisionClock: { remainingSeconds: 4, evidenceRefs: [input.outcomeFacts[0].id] } };
  const result = diagnoseTeachingCue(invalid);
  expect(result.cueCase.diagnosticResult?.measurements).toEqual([]);
  expect(result.cueCase.verdict?.type).toBe("INCONCLUSIVE");
});
