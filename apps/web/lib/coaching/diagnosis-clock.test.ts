import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildTeachingDiagnosisInput, buildTeachingDiagnosisSubmissionEvent } from "./teaching-diagnosis-host";
import { TeachingDiagnosisPanel } from "../../components/playback/teaching-diagnosis-panel";
function fixture(known = true) {
  // Synthetic clock samples in a synthetic Replay, never measured Demo ticks.
  const source = fireReplay("DEATH");
  const replay = { ...source, rounds: source.rounds.map(round => ({ ...round, frames: round.frames.map(frame => ({ ...frame,
    ...(known ? { clock: { source: "SOURCE2_GAMERULES" as const, sampledAtTick: frame.tick, serverTick: frame.tick, tickInterval: 1 / 64,
      roundStartTimeSeconds: round.startTick / 64, roundDurationSeconds: 115, roundsPlayed: 0, freeze: false, warmup: false,
      bombPlanted: false, roundWinStatus: 0, paused: false, totalPausedTicks: 0, pauseObserved: false, clockContinuous: true } } : {}),
  })) })) };
  const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: "clock-diagnosis" });
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
