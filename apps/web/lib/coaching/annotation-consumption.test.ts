import { describe, expect, it } from "vitest";
import type { CoachingRouteState, WinProbabilityTimelineV1 } from "@cs-coach/contracts";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildStage2StartCue, selectFirstStage2Cue } from "./coach-agent-host-adapter";
import { buildStage3StartCue, type Stage3HostAdapterInput } from "./coach-agent-stage3-host-adapter";
import { buildTeachingDiagnosisInput } from "./teaching-diagnosis-host";
import { coachAgentEntryMode } from "../playback/cs2d-playback-host";

// Synthetic frame times and model measurements; no Demo or model invocation.
function fixture(mode: "stale" | "missing" | "fresh") {
  const source = fireReplay("HP_CHANGE", []), round = source.rounds[0];
  const oldTick = mode === "stale" ? 1008 : mode === "missing" ? 1056 : 1064;
  const player = { ...round.frames[0].players[0], x: 123, y: 456, lastPlaceName: "Connector" };
  const replay = { ...source, rounds: [{ ...round, frames: [
    { tick: oldTick, t: 0, players: [player] },
    ...(mode === "missing" ? [{ tick: 1064, t: 0, players: [] }] : []),
    { tick: 1408, t: 0, players: [player] },
  ] }] };
  const winProbabilityTimeline: WinProbabilityTimelineV1 = {
    version: "win-probability-timeline.v1", status: "AVAILABLE", tickRate: 64,
    model: { provider: "CS_NET", revision: "synthetic", assetUrl: "/synthetic.onnx", assetSha256: "a".repeat(64), assetBytes: 1, quantization: "INT8", temperature: 1, sourceCommit: "synthetic", featureVersion: "synthetic" },
    rounds: [{ roundNumber: 1, startTick: 1000, endTick: 1800, winner: "CT", economy: { ct: "FULL", t: "FULL", ctValue: 20000, tValue: 20000 }, samples: [
      { tick: 1064, probability: 0.3, roundNumber: 1, side: "CT", source: "CS_NET" },
      { tick: 1408, probability: 0.6, roundNumber: 1, side: "CT", source: "CS_NET" },
    ] }],
    swings: [{ id: "synthetic-drop", tick: 1408, before: 0.3, after: 0.6, delta: 0.3, direction: "UP", cause: "PLAYER_DEATH", selectedPlayerDeath: false, victimSide: "T", economy: "FULL" }], limitations: [],
  };
  const bundle = buildCs2dAnalysisBundle({ replay, selectedSteamId: self, demoId: `synthetic-annotations-${mode}`, winProbabilityTimeline });
  const plan = bundle.review_plan, cue = plan.cues[0];
  expect(cue).toBeDefined();
  const candidate = bundle.candidate_set.candidates.find(item => item.candidateId === cue.candidate_id)!;
  const material = bundle.candidate_set.materials.find(item => item.candidateId === cue.candidate_id)!;
  const outcomeImpact = bundle.outcome_impacts.find(item => item.cueId === cue.id);
  const narration = deterministicNarrationBundle(buildCoachingPackage(cue, bundle.candidate_set, bundle.observation_evidence), buildOutcomePackage(cue, bundle.candidate_set, outcomeImpact));
  const routeState: CoachingRouteState = {
    routeFrozen: true, routeFingerprint: "synthetic-frozen-route", candidateSetId: bundle.candidate_set.id, candidateSetHash: bundle.candidate_set.hash,
    selectedCueCount: plan.cues.length, readiness: { [cue.id]: "READY" }, cueOrder: plan.cues.map(c => c.id),
    cueBindings: { [cue.id]: { candidateId: cue.candidate_id!, primaryFocusCode: cue.primary_focus_code! } },
    startable: true, consumedCueIds: [], frozenCueIds: plan.cues.map(c => c.id),
  };
  const input: Stage3HostAdapterInput = {
    plan, cue, routeState, narration, analysis: bundle, demoContentHash: "b".repeat(64), selectedPlayerId: self,
    sessionId: "synthetic-session", runId: "synthetic-run", generation: 1, tickRate: 64,
    outcomeGate: { cueId: cue.id, outcomeEndTick: cue.outcome_end_tick, status: "COMPLETE", completedAtTick: cue.outcome_end_tick },
    currentSessionPhase: "PAUSED_FOR_COACHING", evidence: { candidate, material, outcomeImpact, winProbabilityTimeline },
  };
  return { input, bundle, material };
}

describe("actual uncertainty-cue annotation consumption gates", () => {
  it("keeps Stage3 as the default and Stage2 as an explicit entry", () => {
    expect(coachAgentEntryMode("")).toBe("STAGE3");
    expect(coachAgentEntryMode("?coachAgent=stage2")).toBe("STAGE2");
  });

  it.each(["stale", "missing", "fresh"] as const)("%s source annotation cannot bypass current-focus tool or diagnosis gates", mode => {
    const { input, bundle, material } = fixture(mode);
    // Keep the real Compiler focus and annotations, without rewriting a route.
    expect(input.cue.primary_focus_code).toBe("REVIEW_UNCERTAINTY");
    expect(material.decisionSnapshot?.selectedPlayer.value === null).toBe(mode !== "fresh");
    expect(input.cue.annotations).toContainEqual(expect.objectContaining({ type: "POINT", coordinate_space: "WORLD", point: { x: 123, y: 456, z: 0 } }));
    expect(selectFirstStage2Cue(input.plan, input.routeState)?.id).toBe(input.cue.id);
    for (const prepared of [buildStage2StartCue(input), buildStage3StartCue(input)]) {
      expect(prepared.capabilities.map(capability => capability.tool)).not.toContain("FOCUS_MAP_EVIDENCE");
      expect(prepared.capabilities).toEqual([]);
    }
    const diagnosis = buildTeachingDiagnosisInput({ plan: input.plan, cue: input.cue, material, timeline: bundle.match_timeline, selectedPlayerId: self },
      { cueId: input.cue.id, rawText: "我当时想保枪", source: "USER", limitations: [] });
    expect(diagnosis.material).not.toHaveProperty("annotations");
    expect(diagnosis.material).not.toHaveProperty("callout");
    expect(JSON.stringify(diagnosis)).not.toMatch(/"point"|"world_position"|"focusWorld"|决策位置/);
    if (mode !== "fresh") expect(diagnosis.decisionResources).toBeUndefined();
  });
});
