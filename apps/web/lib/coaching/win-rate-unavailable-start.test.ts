import { expect, it, vi } from "vitest";
import { buildCs2dAnalysisBundle, deserializeCs2dAnalysisBundle, serializeCs2dAnalysisBundle } from "@cs-coach/cs2d-analysis-adapter";
import { assertValidReviewPlan, buildCoachingPackage, buildOutcomePackage, deterministicNarrationBundle } from "@cs-coach/review-planner";
import { createCoachingSession, reduceCoachingSession } from "@cs-coach/session";
import { fireReplay, self } from "../../../../libs/cs2d-analysis-adapter/src/window-self-fire-fixtures";
import { buildInitialCoachingRouteState } from "./cs2d-route-integration";

it("starts a fact-based guided route without fabricating probabilities when the optional model is unavailable", () => {
  const fetch = vi.fn(() => { throw new Error("NETWORK_NOT_EXPECTED"); });
  vi.stubGlobal("fetch", fetch);
  try {
    // Synthetic event fixture, not measured Demo ticks or a model quality evaluation.
    const bundle = deserializeCs2dAnalysisBundle(serializeCs2dAnalysisBundle(buildCs2dAnalysisBundle({
      replay: fireReplay("DEATH"), selectedSteamId: self, demoId: "synthetic-no-winrate",
    })));
    expect(bundle.win_probability_timeline.status).toBe("UNAVAILABLE");
    expect(bundle.win_probability_timeline.rounds).toHaveLength(0);
    expect(bundle.win_probability_timeline.swings).toHaveLength(0);
    expect(bundle.candidate_set.candidates.some(candidate => candidate.source.kind === "WIN_RATE_DROP")).toBe(false);
    const plan = bundle.review_plan;
    assertValidReviewPlan(bundle.match_timeline, plan);
    expect(plan.cues.length).toBeGreaterThan(0);
    const narrationByCue = Object.fromEntries(plan.cues.map(cue => [cue.id, deterministicNarrationBundle(
      buildCoachingPackage(cue, bundle.candidate_set, bundle.observation_evidence),
      buildOutcomePackage(cue, bundle.candidate_set, bundle.outcome_impacts.find(impact => impact.cueId === cue.id)),
    )]));
    const route = buildInitialCoachingRouteState(plan, { narrationByCue });
    expect(route.startable).toBe(true); expect(route.routeFrozen).toBe(true);
    const started = reduceCoachingSession(plan, createCoachingSession(plan, "synthetic-no-winrate", route), { type: "START" });
    expect(started.phase).toBe("PLAYING");
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
