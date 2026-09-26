import { describe, expect, it, vi } from "vitest";
import type { CoachingRouteState, NarrationBundle } from "@cs-coach/contracts";
import { buildCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { assertValidNarrationBundle, buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachAgentRuntime, deterministicPolicyOutput, type PolicyInput } from "@cs-coach/coach-agent";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildStage3NarrationSummary, buildStage3StartCue, type Stage3HostAdapterInput } from "./coach-agent-stage3-host-adapter";
import { buildNarratorRequestContext } from "./narrator-contract";
import { parseProviderBundle } from "./narrator-validation";

const TAIL_CONDITION = "只有队友能够同步接触时才可讨论补枪；当前记录不能确认这个条件成立。";

function fixture(long: boolean, legacy: boolean) {
  const bundle = buildCs2dAnalysisBundle({ replay: fireReplay("DEATH"), selectedSteamId: self, demoId: "synthetic-policy-summary" });
  const sourceCue = bundle.review_plan.cues[0];
  // The legacy branch deliberately exercises the supported multi-capability path,
  // not a claim that the current default Compiler produces this focus.
  const cue = legacy ? { ...sourceCue, primary_focus_code: "ADVANTAGE_OVERPEEK" } : sourceCue;
  const plan = legacy ? { ...bundle.review_plan, cues: bundle.review_plan.cues.map(c => c.id === cue.id ? cue : c) } : bundle.review_plan;
  const baseCoaching = buildCoachingPackage(sourceCue, bundle.candidate_set, bundle.observation_evidence);
  const outcome = buildOutcomePackage(sourceCue, bundle.candidate_set);
  // Legal bounded canonical-fact fixture. Narration remains the full deterministic
  // projection and must pass the normal semantic validator, never checkSemantics=false.
  const first = baseCoaching.decisionContext.facts[0];
  const text = long ? `${first.text}${"这份记录只提供当前玩家状态，不能由结果反推当时的敌情。".repeat(9)}${TAIL_CONDITION}` : first.text;
  const coaching = { ...baseCoaching, primaryFocusCode: cue.primary_focus_code!, decisionContext: { ...baseCoaching.decisionContext,
    facts: [{ ...first, text }, ...baseCoaching.decisionContext.facts.slice(1)] } };
  const narration = deterministicNarrationBundle(coaching, outcome);
  assertValidNarrationBundle(narration, coaching, outcome);
  const anonymous = buildNarratorRequestContext(coaching, outcome).request;
  expect(() => parseProviderBundle(anonymous.approvedNarration, anonymous)).not.toThrow();
  expect(narration.currentSituation.text.length).toBeLessThanOrEqual(1600);
  const routeState: CoachingRouteState = {
    routeFrozen: true, routeFingerprint: "synthetic-route", candidateSetId: bundle.candidate_set.id, candidateSetHash: bundle.candidate_set.hash,
    selectedCueCount: plan.cues.length, readiness: { [cue.id]: "READY" }, cueOrder: plan.cues.map(c => c.id),
    cueBindings: { [cue.id]: { candidateId: cue.candidate_id!, primaryFocusCode: cue.primary_focus_code! } },
    startable: true, consumedCueIds: [], frozenCueIds: plan.cues.map(c => c.id),
  };
  const input: Stage3HostAdapterInput = {
    plan, cue, routeState, narration, analysis: bundle, demoContentHash: "b".repeat(64), selectedPlayerId: self,
    sessionId: "synthetic-session", runId: "synthetic-run", generation: 1, tickRate: 64,
    outcomeGate: { cueId: cue.id, outcomeEndTick: cue.outcome_end_tick, status: "COMPLETE", completedAtTick: cue.outcome_end_tick },
    currentSessionPhase: "PAUSED_FOR_COACHING", evidence: {
      candidate: bundle.candidate_set.candidates.find(c => c.candidateId === cue.candidate_id),
      material: bundle.candidate_set.materials.find(m => m.candidateId === cue.candidate_id),
    },
  };
  return input;
}

async function dispatch(input: Stage3HostAdapterInput) {
  const prepared = buildStage3StartCue(input);
  const packets: PolicyInput[] = [];
  const selectCapability = vi.fn(async (packet: PolicyInput) => { packets.push(packet); return deterministicPolicyOutput(packet); });
  const runtime = createCoachAgentRuntime({ policy: { selectCapability } });
  for (let index = 0; index < (prepared.event.routeSegmentIndex ?? 0); index++) {
    await runtime.dispatch({ version: "coach-agent-event.v2", type: "OBSERVE_SEGMENT", eventId: `prior-${index}`,
      identity: prepared.event.identity, segmentId: input.plan.segments[index].id, segmentIndex: index, mode: "BRIEF", currentSessionPhase: "PLAYING" });
  }
  const result = await runtime.dispatch(prepared.event);
  return { prepared, packets, selectCapability, result };
}

function assertWholeOrExplicitlyOmitted(field: NonNullable<Awaited<ReturnType<typeof dispatch>>["result"]["state"]["activeNarrationPolicySummary"]>["fields"]["currentSituation"], original: NarrationBundle["currentSituation"]) {
  if (field.text === original.text) {
    expect(field.refs).toEqual(original.refs);
    expect(field.limitations).toEqual(original.limitations ?? []);
  } else {
    expect(field.text).toBe("");
    expect(field.refs).toEqual([]);
    expect(field.limitations.join(" ")).toMatch(/省略|超出|预算/);
  }
}

describe("narration conditions at the actual Stage3 and Graph policy boundaries", () => {
  // Host projection compatibility cases, not claims about today's generated prose.
  it.each(["references", "fifth qualification", "long qualification"])("omits a whole field when %s exceeds its existing budget", budget => {
    const input = fixture(false, false);
    if (budget === "references") input.narration.currentSituation.refs = Array.from({ length: 9 }, (_, i) => `fact-${i}`);
    if (budget === "fifth qualification") input.narration.currentSituation.limitations = ["未确认语音", "未确认战术", "缺少视线", "不清楚分工", TAIL_CONDITION];
    if (budget === "long qualification") input.narration.currentSituation.limitations = ["未确认条件。".repeat(28) + TAIL_CONDITION];
    const original = JSON.stringify(input.narration);
    const summary = buildStage3NarrationSummary(input.narration, "READY");
    expect(summary.fields.currentSituation.text).toBe("");
    expect(summary.fields.currentSituation.refs).toEqual([]);
    expect(summary.fields.currentSituation.limitations.join(" ")).toContain("省略");
    expect(summary.limitationCount).toBeGreaterThan(0);
    expect(summary.limitationCount).toBeLessThanOrEqual(8);
    expect(JSON.stringify(input.narration)).toBe(original);
  });

  it("keeps an exactly 240-character field and all its qualifications", () => {
    const input = fixture(false, false);
    input.narration.currentSituation = { text: "甲".repeat(240), refs: ["fact-one"], limitations: [TAIL_CONDITION] };
    expect(buildStage3NarrationSummary(input.narration, "READY").fields.currentSituation).toEqual(input.narration.currentSituation);
  });

  it("preserves a legal short deterministic field unchanged", async () => {
    const input = fixture(false, false), result = await dispatch(input);
    expect(input.narration.currentSituation.text.length).toBeLessThanOrEqual(240);
    expect(result.result.state.activeNarrationPolicySummary?.fields.currentSituation.text).toBe(input.narration.currentSituation.text);
    expect(result.result.state.activeNarrationPolicySummary?.fields.currentSituation.refs).toEqual(input.narration.currentSituation.refs);
    expect(result.selectCapability).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not present a long approved field prefix as its complete statement (legacy provider path=%s)", async legacy => {
    const input = fixture(true, legacy), result = await dispatch(input);
    expect(input.narration.currentSituation.text.indexOf(TAIL_CONDITION)).toBeGreaterThan(240);
    expect(input.narration.currentSituation.text.length).toBeLessThanOrEqual(1600);
    if (legacy) {
      expect(result.prepared.capabilities.length).toBeGreaterThan(1);
      expect(result.selectCapability).toHaveBeenCalledTimes(1);
      assertWholeOrExplicitlyOmitted(result.packets[0].narrationSummary.fields.currentSituation, input.narration.currentSituation);
    } else {
      expect(result.prepared.capabilities).toHaveLength(1);
      expect(result.selectCapability).not.toHaveBeenCalled();
      assertWholeOrExplicitlyOmitted(result.result.state.activeNarrationPolicySummary!.fields.currentSituation, input.narration.currentSituation);
    }
  });
});
